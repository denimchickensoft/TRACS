// Short-Term Conflict Alert (STCA) detection engine.
//
// For each associated (owned) track, predicts its position 5 seconds into
// the future and compares against every other airborne track's current and
// predicted position. Flags a conflict when current-or-predicted separation
// drops under 3 NM horizontally and 1,000 ft vertically, and separation
// isn't increasing — mirrors the reference app's rule the user described.
//
// Once triggered, a conflict LATCHES: it stays active (and returned) every
// tick until it's genuinely resolved (current separation clearly recovers
// past a wider margin — see CLEAR_* below), not merely whenever this tick's
// tight trigger test happens to come back false. Without this, ordinary
// telemetry noise or a curving flight path flips the tight boundary test on
// on/off tick to tick, making the alert flicker instead of persisting
// the way real STCA does. Acknowledgment (store/atc.js conflictAcks) is
// keyed off the same latch id, so acking silences/solidifies the alert but
// it keeps showing until the pair is actually resolved — a fresh
// recurrence after that gets a fresh, unacknowledged alert.
//
// Pure function except for `vertRates` and `latched`, caller-owned state
// the engine reads and mutates in place each call:
//   - `vertRates` derives vertical rate from consecutive altitude samples
//     (position data has no reported vertical speed — the same approach
//     store/units.js already uses to derive unit.track from consecutive
//     position samples, just done here since it's STCA-specific).
//   - `latched` is the set of currently-active conflict pairs (see above).

import { destinationPoint } from '../../../../utils/bearing.js'

const AIRBORNE       = new Set(['Aircraft', 'Helicopter'])
const M_PER_S_TO_KT  = 1.94384
const M_TO_FT        = 3.28084
const MIN_SAMPLE_MS  = 100  // guard against near-zero dt when called back-to-back

const LOOKAHEAD_S        = 5
const LAT_THRESHOLD_NM   = 3
const VERT_THRESHOLD_FT  = 1000

// Wider-than-trigger margins a latched conflict must clear (on *current*
// separation only — predicted position is left out here since a stale
// unit.track can jump it around, which would just reintroduce the same
// flicker on the resolving side) before it's considered actually resolved.
const CLEAR_LAT_THRESHOLD_NM  = 3.5
const CLEAR_VERT_THRESHOLD_FT = 1100

function nmBetween(lat1, lng1, lat2, lng2) {
  const R  = 3440.065
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Same flat-earth forward projection drawContacts.js's PTL feature already
// uses (track: radians true, 0=N clockwise; speed: m/s).
function predictLatLng(lat, lng, trackRad, speedMps, seconds) {
  const distNm = (speedMps * M_PER_S_TO_KT * seconds) / 3600
  return destinationPoint(lat, lng, trackRad * 180 / Math.PI, distNm)
}

function updateVertRate(vertRates, id, altFt, now) {
  const prev = vertRates.get(id)
  let rate = prev?.rate ?? 0
  if (prev && now - prev.t > MIN_SAMPLE_MS) {
    rate = (altFt - prev.altFt) / ((now - prev.t) / 1000)
  }
  vertRates.set(id, { altFt, t: now, rate })
  return rate
}

/**
 * @param {Object} params
 * @param {Object} params.units           useUnitsStore().units
 * @param {Object} params.ownership       useAtcStore().ownership
 * @param {Array}  params.suppressionZones  from suppressionZones.buildSuppressionZones()
 * @param {Function} params.isSuppressed    suppressionZones.isSuppressed
 * @param {Set<string>} params.wingmanIds   from formations.computeWingmanIds() — excluded entirely
 * @param {Set<string>} [params.inhibitedIds] CA K per-track inhibits — excluded entirely
 * @param {Map} params.vertRates          caller-owned, mutated in place
 * @param {Map} params.latched            caller-owned, mutated in place — pairId -> { unitAId, unitBId, type }
 * @returns {Array<{id, unitAId, unitBId, type}>}
 */
export function computeConflicts({ units, ownership, suppressionZones, isSuppressed, wingmanIds, inhibitedIds, vertRates, latched }) {
  const now = Date.now()
  const airborne = []

  for (const [id, unit] of Object.entries(units)) {
    if (!AIRBORNE.has(unit.category) || !unit.position) continue
    if (wingmanIds?.has(id)) continue
    if (inhibitedIds?.has(id)) continue

    const altFt = unit.position.alt * M_TO_FT
    const rate  = updateVertRate(vertRates, id, altFt, now)
    const predicted = (unit.track != null && unit.speed)
      ? predictLatLng(unit.position.lat, unit.position.lng, unit.track, unit.speed, LOOKAHEAD_S)
      : { lat: unit.position.lat, lng: unit.position.lng }

    airborne.push({ id, unit, altFt, rate, predAltFt: altFt + rate * LOOKAHEAD_S, predicted })
  }

  const byId = new Map(airborne.map((a) => [a.id, a]))

  // ── 1. Re-evaluate every already-latched pair: clear it only once
  //    current separation genuinely recovers past the wider CLEAR_*
  //    margins (or a party is gone/now suppressed); otherwise keep it —
  //    this is what makes an active alert stop flickering on/off.
  for (const [pairId, entry] of latched) {
    const a = byId.get(entry.unitAId)
    const b = byId.get(entry.unitBId)
    if (!a || !b) { latched.delete(pairId); continue }

    const curSepNm = nmBetween(a.unit.position.lat, a.unit.position.lng, b.unit.position.lat, b.unit.position.lng)
    const curSepFt = Math.abs(a.altFt - b.altFt)
    const suppressedNow = isSuppressed(a.unit.position, suppressionZones) || isSuppressed(b.unit.position, suppressionZones)
    const resolved = suppressedNow || curSepNm >= CLEAR_LAT_THRESHOLD_NM || curSepFt >= CLEAR_VERT_THRESHOLD_FT

    if (resolved) {
      latched.delete(pairId)
    } else {
      // Re-derive type in case ownership changed since latching (e.g. the
      // controller associated the previously-untracked MCI intruder).
      entry.type = ownership[entry.unitBId] !== undefined ? 'CA' : 'MCI'
    }
  }

  // ── 2. Scan for brand-new conflicts among pairs not already latched,
  //    using the tight trigger test (unchanged from before).
  const triggerIds = airborne
    .map((a) => a.id)
    .filter((id) => ownership[id] !== undefined)
  const scanned = new Set()

  for (const triggerId of triggerIds) {
    const a = byId.get(triggerId)
    for (const b of airborne) {
      if (b.id === triggerId) continue
      const pairId = a.id < b.id ? `${a.id}_${b.id}` : `${b.id}_${a.id}`
      if (latched.has(pairId) || scanned.has(pairId)) continue
      scanned.add(pairId)

      const curSepNm  = nmBetween(a.unit.position.lat, a.unit.position.lng, b.unit.position.lat, b.unit.position.lng)
      const curSepFt  = Math.abs(a.altFt - b.altFt)
      const predSepNm = nmBetween(a.predicted.lat, a.predicted.lng, b.predicted.lat, b.predicted.lng)
      const predSepFt = Math.abs(a.predAltFt - b.predAltFt)

      const curInConflict  = curSepNm  < LAT_THRESHOLD_NM && curSepFt  < VERT_THRESHOLD_FT
      const predInConflict = predSepNm < LAT_THRESHOLD_NM && predSepFt < VERT_THRESHOLD_FT
      const notIncreasing  = predSepNm <= curSepNm

      if (!((curInConflict || predInConflict) && notIncreasing)) continue
      if (isSuppressed(a.unit.position, suppressionZones) || isSuppressed(b.unit.position, suppressionZones)) continue

      const type = ownership[b.id] !== undefined ? 'CA' : 'MCI'
      latched.set(pairId, { unitAId: a.id, unitBId: b.id, type })
    }
  }

  return [...latched.entries()].map(([id, entry]) => ({ id, unitAId: entry.unitAId, unitBId: entry.unitBId, type: entry.type }))
}
