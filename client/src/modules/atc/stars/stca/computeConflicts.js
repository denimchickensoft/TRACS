// Conflict alert (CA) and mode C intruder (MCI) detection.
//
// Candidates are this scope's visible, airborne aircraft. An SRS-fielded
// aircraft only counts while its transponder is squawking (standby/off has
// no altitude reply); aircraft with no transponder data (AI) always count.
// A track is *associated* when it has a flight plan or an owner.
//
//   CA   two associated tracks within 3 NM and 1,000 ft
//   MCI  an associated track and an unassociated one within 1.5 NM and
//        500 ft, unless the intruder squawks the code suppressed on the
//        associated track (CA M)
//
// Separation is tested on current positions only, and a pair that is
// diverging (see below) never alerts. A track with conflict alerts
// inhibited (CA K) is never the associated side of a pair.
//
// Once triggered, a conflict LATCHES: it stays active every tick until it's
// genuinely resolved — separation recovers past a margin wider than the
// trigger (clearLatNm/clearVertFt), the pair diverges, or a party drops out — not merely
// whenever this tick's tight trigger test happens to come back false.
// Without this, ordinary position noise flips the boundary test on/off tick
// to tick and the alert flickers. Acknowledgment (store/atc.js
// conflictAcks) is keyed off the same latch id, so acking silences/
// solidifies the alert but it keeps showing until resolved; a fresh
// recurrence after that gets a fresh, unacknowledged alert.
//
// Pure function except for `latched`, a caller-owned Map of the active
// pairs, read and mutated in place each call.

import { M_TO_FT, EARTH_RADIUS_NM } from '../../../../utils/units.js'
import { hasLiveSquawk, normalizeCode } from '../../../../utils/transponder.js'

const AIRBORNE = new Set(['Aircraft', 'Helicopter'])

const QUICK_OUT_NM = 10
const QUICK_OUT_FT = 5000

const CA  = { latNm: 3,   vertFt: 995, clearLatNm: 3.5,  clearVertFt: 1100 }
const MCI = { latNm: 1.5, vertFt: 495, clearLatNm: 1.75, clearVertFt: 600 }

// Two tracks whose paths cross behind at least one of them, heading at
// least this far apart, are diverging.
const DIVERGING_MIN_DEG = 15

function nmBetween(lat1, lng1, lat2, lng2) {
  const R  = EARTH_RADIUS_NM
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Diverging: the lines along each track (unit.track, radians true) meet
// behind at least one of the aircraft, and the tracks differ by at least
// DIVERGING_MIN_DEG. Parallel tracks or a missing track are not diverging.
function diverging(a, b) {
  const ta = a.unit.track, tb = b.unit.track
  if (ta == null || tb == null) return false
  const cosLat = Math.cos(a.unit.position.lat * Math.PI / 180)
  // Flat NM coordinates, a at the origin
  const bx = (b.unit.position.lng - a.unit.position.lng) * 60 * cosLat
  const by = (b.unit.position.lat - a.unit.position.lat) * 60
  const dax = Math.sin(ta), day = Math.cos(ta)
  const dbx = Math.sin(tb), dby = Math.cos(tb)
  const denom = dax * dby - day * dbx
  if (Math.abs(denom) < 1e-9) return false
  // a + s·da = b + u·db
  const s = (bx * dby - by * dbx) / denom
  const u = (bx * day - by * dax) / denom
  if (s > 0 && u > 0) return false   // paths cross ahead of both
  let diff = Math.abs(ta - tb) * 180 / Math.PI % 360
  if (diff > 180) diff = 360 - diff
  return diff >= DIVERGING_MIN_DEG
}

function separation(a, b) {
  return {
    nm: nmBetween(a.unit.position.lat, a.unit.position.lng, b.unit.position.lat, b.unit.position.lng),
    ft: Math.abs(a.altFt - b.altFt),
  }
}

/**
 * @param {Object} params
 * @param {Object} params.units             this scope's visible units
 * @param {(uid: string) => boolean} params.isAssociated  has a flight plan or an owner
 * @param {(uid: string) => boolean} params.caDisabled    CA K inhibit
 * @param {(uid: string) => string}  params.mciSuppressedCode  CA M code, '' for none
 * @param {Array}  params.suppressionZones  from suppressionZones.buildSuppressionZones()
 * @param {Function} params.isSuppressed    suppressionZones.isSuppressed
 * @param {Set<string>} params.wingmanIds   simulated wingmen — excluded entirely
 * @param {Map} params.latched              caller-owned, mutated in place — pairId -> { unitAId, unitBId, type, start }
 * @param {number} [params.now]
 * @returns {Array<{id, unitAId, unitBId, type, start}>}
 */
export function computeConflicts({ units, isAssociated, caDisabled, mciSuppressedCode, suppressionZones, isSuppressed, wingmanIds, latched, now = Date.now() }) {
  const candidates = []
  for (const [id, unit] of Object.entries(units)) {
    if (!AIRBORNE.has(unit.category) || !unit.position) continue
    if (unit.airborne === false) continue
    if (unit.srsCapable && !hasLiveSquawk(unit)) continue
    if (wingmanIds?.has(id)) continue
    candidates.push({
      id, unit,
      altFt: unit.position.alt * M_TO_FT,
      assoc: isAssociated(id),
      code:  unit.srsCapable ? normalizeCode(unit.transponder.mode3) : null,
    })
  }
  const byId = new Map(candidates.map((c) => [c.id, c]))

  // The pair's type, or null when it no longer qualifies at all (no
  // associated side, inhibited, or suppressed). For MCI, `a` is returned
  // as the associated side.
  function classify(x, y) {
    if (x.assoc && y.assoc) {
      return caDisabled(x.id) || caDisabled(y.id) ? null : { type: 'CA', a: x, b: y }
    }
    const [a, b] = x.assoc ? [x, y] : [y, x]
    if (!a.assoc || caDisabled(a.id)) return null
    const suppressed = mciSuppressedCode(a.id)
    if (suppressed && b.code === suppressed) return null
    return { type: 'MCI', a, b }
  }

  // ── 1. Re-evaluate latched pairs: keep them until genuinely resolved ──
  for (const [pairId, entry] of latched) {
    const x = byId.get(entry.unitAId)
    const y = byId.get(entry.unitBId)
    if (!x || !y) { latched.delete(pairId); continue }
    const cls = classify(x, y)
    if (!cls) { latched.delete(pairId); continue }
    const lim = cls.type === 'CA' ? CA : MCI
    const sep = separation(x, y)
    const resolved = sep.nm >= lim.clearLatNm || sep.ft >= lim.clearVertFt || diverging(x, y) ||
      isSuppressed(x.unit.position, suppressionZones) || isSuppressed(y.unit.position, suppressionZones)
    if (resolved) latched.delete(pairId)
    else {
      entry.type = cls.type
      entry.unitAId = cls.a.id
      entry.unitBId = cls.b.id
    }
  }

  // ── 2. New conflicts: every pair with an associated side ──
  for (let i = 0; i < candidates.length; i++) {
    const x = candidates[i]
    for (let j = i + 1; j < candidates.length; j++) {
      const y = candidates[j]
      if (!x.assoc && !y.assoc) continue
      const pairId = x.id < y.id ? `${x.id}_${y.id}` : `${y.id}_${x.id}`
      if (latched.has(pairId)) continue

      // Cheap quick-out before the exact distance
      if (Math.abs(x.altFt - y.altFt) > QUICK_OUT_FT) continue
      if (Math.abs(x.unit.position.lat - y.unit.position.lat) * 60 > QUICK_OUT_NM) continue

      const cls = classify(x, y)
      if (!cls) continue
      const lim = cls.type === 'CA' ? CA : MCI
      const sep = separation(x, y)
      if (sep.nm > lim.latNm || sep.ft > lim.vertFt) continue
      if (diverging(x, y)) continue
      if (isSuppressed(x.unit.position, suppressionZones) || isSuppressed(y.unit.position, suppressionZones)) continue

      latched.set(pairId, { unitAId: cls.a.id, unitBId: cls.b.id, type: cls.type, start: now })
    }
  }

  return [...latched.entries()].map(([id, e]) => ({ id, unitAId: e.unitAId, unitBId: e.unitBId, type: e.type, start: e.start }))
}
