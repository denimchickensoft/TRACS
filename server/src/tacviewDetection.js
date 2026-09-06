'use strict'

// Synthetic radar-detection model for Tacview-sourced units. Tacview's ACMI
// format has no contacts[]/detection-method equivalent at all (confirmed
// absent from the full type/property taxonomy) — but contacts[] turns out to
// be the core visibility/fog-of-war gate for STARS, CATCC, AIC, and ABM, not
// a cosmetic indicator (confirmed by reading visibleUnits.js/AicScope.jsx/
// abmScopeHelpers.js). Real Olympus contacts[] is a direct passthrough of
// DCS's own closed-source Controller:getDetectedTargets() engine API
// (OlympusCommand.lua:1453-1469) — this module can only ever be a rough
// external approximation, never a faithful reproduction.
//
// Baseline only: range + altitude + line-of-sight (via elevation.js's
// terrain DB). Sensor capability is guessed from category alone. The
// detailed algorithm (sensor range/cone by airframe class, RCS
// approximation, jamming/EW, multiple detection methods) is explicitly
// deferred to a later pass — see
// resources/specs/data-sources/custom-datasource-tacview-spec.md §7.
//
// Output matches Olympus's exact wire shape (`contacts: [{ID, detectionMethod}]`,
// RADAR = 4 per client/src/modules/atc/stars/visibleUnits.js) so no
// client-side code changes are needed to consume it.

const elevation = require('./elevation')

const DETECTION_RADAR = 4

// Deliberately simple, not yet tuned against real DCS radar behavior.
const SENSOR_RANGE_NM = {
  Aircraft: 40,
  Helicopter: 15,
  GroundUnit: 30, // covers AAA/SAM sites indiscriminately for now — no per-system range yet
  NavyUnit: 35,
}

const MIN_DETECTABLE_AGL_M = 15 // ~50ft — below this, treat as ground clutter

const EARTH_RADIUS_NM = 3440.065
const LOS_SAMPLE_COUNT = 8 // points checked along the great-circle path between detector and target

function toRad(deg) {
  return (deg * Math.PI) / 180
}

function distanceNm(a, b) {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// Linear interpolation along the great-circle path (adequate for the short
// distances/sample counts here — not a proper geodesic intermediate-point
// formula, which isn't warranted for a baseline heuristic).
function interpolate(a, b, frac) {
  return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac }
}

// Returns true if terrain doesn't obstruct a straight line between the two
// positions' altitudes, sampled at LOS_SAMPLE_COUNT points along the path.
function hasLineOfSight(from, to) {
  for (let i = 1; i < LOS_SAMPLE_COUNT; i++) {
    const frac = i / LOS_SAMPLE_COUNT
    const point = interpolate(from, to, frac)
    const expectedAlt = from.alt + (to.alt - from.alt) * frac
    const terrain = elevation.getElevation(point.lat, point.lng)
    if (terrain !== null && terrain > expectedAlt) return false
  }
  return true
}

// units: { [id]: unitObject } — the full mission-wide canonical unit map (all
// coalitions — this function is always called with the omniscient internal
// truth, never the redacted public one, since it needs real enemy positions
// to know whether they're in range/LOS of a friendly sensor).
// Only `friendlyCoalitionId`-side units act as detectors — this is the actual
// fog-of-war computation, not a symmetric "who sees whom" pass, since the
// caller (createFogFilter) only ever cares about one side's view at a time
// per connected TRACS backend.
// Returns { [id]: { contacts: [{ID, detectionMethod}] } } — a state.js-shaped
// partial-update map, ready to merge via applyDelta alongside the parser's
// own output.
function computeContacts(units, friendlyCoalitionId) {
  const contactsById = new Map()

  const detectors = []
  for (const [id, unit] of Object.entries(units)) {
    if (unit.coalition !== friendlyCoalitionId) continue
    const rangeNm = SENSOR_RANGE_NM[unit.category]
    if (!rangeNm || !unit.position) continue
    detectors.push({ id, unit, rangeNm })
  }

  const targets = Object.entries(units).filter(([, u]) => u.position && u.coalition !== undefined)

  for (const detector of detectors) {
    for (const [targetId, target] of targets) {
      if (targetId === detector.id) continue
      if (target.coalition === friendlyCoalitionId) continue // only cross-coalition detection matters
      if (target.category !== 'Aircraft' && target.category !== 'Helicopter') continue // baseline: air targets only
      if (target.agl !== undefined && target.agl < MIN_DETECTABLE_AGL_M) continue

      const range = distanceNm(detector.unit.position, target.position)
      if (range > detector.rangeNm) continue

      if (!hasLineOfSight(detector.unit.position, target.position)) continue

      if (!contactsById.has(detector.id)) contactsById.set(detector.id, [])
      contactsById.get(detector.id).push({ ID: Number(targetId), detectionMethod: DETECTION_RADAR })
    }
  }

  const updated = {}
  for (const [id, contacts] of contactsById) {
    updated[id] = { contacts }
  }
  return updated
}

// 'blue'/'red' → Olympus's numeric coalition convention, matching
// client/src/modules/atc/stars/visibleUnits.js's own mapping exactly. 'gm'/
// 'admin'/anything else → null, meaning "no redaction" — visibleUnits.js
// already grants those roles unfiltered visibility client-side, and Tacview
// has no per-role backend concept of its own to restrict against, so the
// only correct behavior is to pass everything through untouched, same as
// Olympus does for those roles today.
function coalitionId(coalition) {
  if (coalition === 'blue') return 2
  if (coalition === 'red') return 1
  return null
}

// Fog-of-war redaction — the actual privacy boundary Tacview's omniscient
// feed needs and Olympus doesn't (Olympus's own backend already restricts
// what a coalition-authenticated session ever receives; Tacview's RTT
// protocol has no such concept, so TRACS must enforce it itself before
// anything reaches `state`/the browser). See
// custom-datasource-tacview-spec.md §7's fog-of-war note.
//
// One instance per active Tacview connection (direct or relay-hosted),
// holding just the running set of currently-exposed non-friendly unit IDs —
// everything else needed (the omniscient truth) lives in the caller's own
// internal unit map, never in this module.
function createFogFilter(friendlyCoalitionId) {
  let exposedEnemyIds = new Set()

  return {
    // Called on every incoming frame update (tacview.js's processIncoming /
    // tacviewRelayClient.js's applyTacviewData) — friendly units always pass
    // through; non-friendly units only if already exposed from the last
    // detection pass. The caller is responsible for still merging the full
    // `updated` map into its own internal omniscient store regardless of
    // what this returns.
    filterFrameUpdate(updated) {
      const publicUpdated = {}
      for (const [id, unit] of Object.entries(updated)) {
        if (unit.coalition === friendlyCoalitionId || exposedEnemyIds.has(id)) {
          publicUpdated[id] = unit
        }
      }
      return publicUpdated
    },

    // Called on the periodic detection-pass timer with the full internal
    // omniscient unit map. Returns the contacts update (for friendly units)
    // plus which previously-hidden enemies just became visible (need their
    // full current data pushed, since filterFrameUpdate was dropping their
    // updates while hidden) and which previously-visible enemies just
    // dropped out of detection (need an explicit removal — the raw Tacview
    // stream won't emit one, since the object hasn't actually left the
    // mission, just this coalition's detection range).
    computeVisibility(internalUnits) {
      const contactsUpdate = computeContacts(internalUnits, friendlyCoalitionId)

      const nowVisible = new Set()
      for (const { contacts } of Object.values(contactsUpdate)) {
        for (const { ID } of contacts) nowVisible.add(String(ID))
      }

      const revealed = {}
      for (const id of nowVisible) {
        if (!exposedEnemyIds.has(id) && internalUnits[id]) revealed[id] = internalUnits[id]
      }
      const hidden = [...exposedEnemyIds].filter((id) => !nowVisible.has(id))

      exposedEnemyIds = nowVisible
      return { contactsUpdate, revealed, hidden }
    },

    // Internal bookkeeping cleanup when the raw stream truly removes an
    // object (destroyed/left area) — distinct from computeVisibility's
    // "hidden" (still exists, just out of detection range).
    forget(id) {
      exposedEnemyIds.delete(id)
    },
  }
}

module.exports = { computeContacts, coalitionId, createFogFilter, DETECTION_RADAR }
