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
// Model: range + earth-curvature-aware line-of-sight (via elevation.js's
// terrain DB) + a forward scan-volume cone for airborne detectors, against
// real per-unit-type sensor ranges where the data exists (ground/naval, from
// client/public/units/*.json) and a small hand-authored tiered
// approximation where it doesn't (aircraft/helicopter — see
// aircraftSensorRangeNm()). Plus a synthetic RWR pass (computeRwrContacts).
// See resources/specs/data-sources/custom-datasource-tacview-spec.md §7 and
// resources/specs/tacview-detection-spec.md for the full design discussion,
// including numbers still pending live-calibration against real Olympus/DCS
// detection.
//
// Known, accepted limitation: DCS's real detection gates on whether a
// target's radar is actually transmitting. Tacview's ACMI export has no
// "radar on/off" field for any unit, so this model has no choice but to
// treat every sensor-capable unit as if its radar is always on. Not fixable
// without an upstream data source Tacview doesn't provide.
//
// Output matches Olympus's exact wire shape (`contacts: [{ID, detectionMethod}]`,
// RADAR = 4, RWR = 16, per client/src/modules/atc/stars/visibleUnits.js /
// abmScopeHelpers.js) so no client-side code changes are needed to consume it.

const fs = require('fs')
const path = require('path')
const elevation = require('./elevation')

const DETECTION_RADAR = 4
const DETECTION_RWR = 16

const METERS_PER_NM = 1852
const EARTH_RADIUS_NM = 3440.065
// 4/3-effective-Earth-radius approximation for standard atmospheric
// refraction — the same correction real radar-horizon calculations use —
// rather than the true geometric radius.
const EFFECTIVE_EARTH_RADIUS_M = 6371000 * (4 / 3)
const NM_PER_DEG_LAT = 60

// ---- Operator-tunable config (server/tacviewDetectionConfig.json, optional,
// gitignored — mirrors relay/index.js's config.json loading pattern: read
// once at startup, merge over hardcoded defaults, tolerate the file being
// entirely absent). ----
const CONFIG_PATH = path.join(__dirname, '..', 'tacviewDetectionConfig.json')

function loadUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const DEFAULTS = {
  sensorRangeNm: { Aircraft: 40, Helicopter: 15, GroundUnit: 30, NavyUnit: 35 },
  groundNavalDetectionEnabled: true,
  unitTypeRangeOverridesNm: {},
  minDetectableAglM: 15,
  losSampleCount: 8,
  azimuthConeHalfAngleDeg: 60,
  elevationConeHalfAngleDeg: 45,
  rwr: { enabled: true, rangeMultiplier: 1.75 },
}

const userConfig = loadUserConfig()
const config = {
  ...DEFAULTS,
  ...userConfig,
  sensorRangeNm: { ...DEFAULTS.sensorRangeNm, ...(userConfig.sensorRangeNm ?? {}) },
  unitTypeRangeOverridesNm: { ...DEFAULTS.unitTypeRangeOverridesNm, ...(userConfig.unitTypeRangeOverridesNm ?? {}) },
  rwr: { ...DEFAULTS.rwr, ...(userConfig.rwr ?? {}) },
}

const SENSOR_RANGE_NM = config.sensorRangeNm
const MIN_DETECTABLE_AGL_M = config.minDetectableAglM
const LOS_SAMPLE_COUNT = config.losSampleCount

// ---- Real per-unit-type sensor data (client/public/units/*.json) — same
// files, same `unit.name` correlation key, same `acquisitionRange` field
// drawAbmGroundContacts.js already trusts client-side for Olympus's range
// rings. Read once at startup; tolerate any file being absent. ----
const UNITS_DIR = path.join(__dirname, '..', '..', 'client', 'public', 'units')

function loadUnitDb(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(UNITS_DIR, filename), 'utf8'))
  } catch {
    return {}
  }
}

const groundUnitDb = loadUnitDb('groundunitdatabase.json')
const navyUnitDb = loadUnitDb('navyunitdatabase.json')
const aircraftUnitDb = loadUnitDb('aircraftdatabase.json')
const helicopterUnitDb = loadUnitDb('helicopterdatabase.json')

// Only these `type` values are actually air-search sensors. Tank/APC/
// Infantry/Artillery/Cargo-Transport also carry a nonzero acquisitionRange
// in the shipped DB, but it's a ground-spotting range (or, for one known
// naval outlier, an unverified/miscategorized value — see
// unitTypeRangeOverridesNm below), not an anti-air radar range.
const TRUSTED_GROUND_TYPES = new Set(['SAM Site', 'SAM Site Parts', 'AAA', 'AirDefence', 'Radar (EWR)'])
const TRUSTED_NAVAL_TYPES = new Set(['Aircraft Carrier', 'Combatants', 'Fast Attack Craft'])

// Real per-unit-type acquisitionRange, falling back to the flat per-category
// default for anything unmatched (mods not in the shipped DB, or a shipped
// entry whose `type` isn't a trusted air-search sensor).
// config.unitTypeRangeOverridesNm is checked first — covers mods *and* known
// DB miscategorizations (e.g. Type_071, a real ~20,000t amphibious warship
// filed under `Cargo/Transport` instead of `Combatants`) without editing the
// shipped database file, which a future data re-sync would just undo.
function lookupGroundNavalRangeNm(unit) {
  const override = config.unitTypeRangeOverridesNm[unit.name]
  if (override) return override

  const db = unit.category === 'NavyUnit' ? navyUnitDb : groundUnitDb
  const trustedTypes = unit.category === 'NavyUnit' ? TRUSTED_NAVAL_TYPES : TRUSTED_GROUND_TYPES
  const entry = db[unit.name]
  if (entry && trustedTypes.has(entry.type) && entry.acquisitionRange > 0) {
    return entry.acquisitionRange / METERS_PER_NM
  }
  return SENSOR_RANGE_NM[unit.category]
}

// Aircraft/helicopter radar-range tiers — no per-unit sensor data exists
// anywhere in this repo's databases for aircraft (aircraftdatabase.json/
// helicopterdatabase.json carry loadouts/liveries/description only), so this
// is a small, one-time hand-authored approximation, not a per-airframe
// table — grouped by role using the `roles` array those files already ship
// (no new curated list to maintain). PROVISIONAL pending the Phase 0 live-
// calibration capture against real Olympus/DCS detection (see
// resources/specs/tacview-detection-spec.md) — treat these as a starting
// point, not a researched constant.
const AWACS_RANGE_NM = 200
const FIGHTER_RANGE_NM = 55

const unitRolesCache = new Map()
function unitRoles(unit, db) {
  if (unitRolesCache.has(unit.name)) return unitRolesCache.get(unit.name)
  const entry = db[unit.name]
  const roles = new Set()
  for (const loadout of entry?.loadouts ?? []) {
    for (const role of loadout.roles ?? []) roles.add(role)
  }
  unitRolesCache.set(unit.name, roles)
  return roles
}

function aircraftSensorRangeNm(unit) {
  const db = unit.category === 'Helicopter' ? helicopterUnitDb : aircraftUnitDb
  const roles = unitRoles(unit, db)
  if (roles.has('AWACS')) return AWACS_RANGE_NM
  if (roles.has('CAP')) return FIGHTER_RANGE_NM
  return SENSOR_RANGE_NM[unit.category]
}

function sensorRangeNm(unit) {
  if (unit.category === 'Aircraft' || unit.category === 'Helicopter') return aircraftSensorRangeNm(unit)
  if (unit.category === 'GroundUnit' || unit.category === 'NavyUnit') return lookupGroundNavalRangeNm(unit)
  return null
}

function isValidTargetCategory(category) {
  if (category === 'Aircraft' || category === 'Helicopter') return true
  return config.groundNavalDetectionEnabled && (category === 'GroundUnit' || category === 'NavyUnit')
}

function toRad(deg) {
  return (deg * Math.PI) / 180
}

function toDeg(rad) {
  return (rad * 180) / Math.PI
}

function distanceNm(a, b) {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)))
}

// True initial bearing from a to b, in degrees [0, 360).
function bearingDeg(a, b) {
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

// Smallest absolute difference between two compass angles, 0-180.
function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// Cheap bounding-box reject before the real haversine/LOS work — matters
// once real per-unit ranges (up to ~250nm for large EWRs) multiply the
// detector×target cross product far beyond the old flat-category scale.
// Widened by 1/cos(lat) on longitude since a degree of longitude compresses
// toward the poles — erring toward not rejecting a valid pair costs a little
// extra compute; erring the other way would silently drop real detections.
function quickReject(a, b, maxRangeNm) {
  const maxDeltaLat = maxRangeNm / NM_PER_DEG_LAT
  if (Math.abs(a.lat - b.lat) > maxDeltaLat) return true
  const lngCompression = Math.max(Math.cos(toRad(a.lat)), 0.1)
  const maxDeltaLng = maxRangeNm / (NM_PER_DEG_LAT * lngCompression)
  return Math.abs(a.lng - b.lng) > maxDeltaLng
}

// Linear interpolation along the great-circle path (adequate for the short
// distances/sample counts here — not a proper geodesic intermediate-point
// formula, which isn't warranted for a baseline heuristic).
function interpolate(a, b, frac) {
  return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac }
}

// Returns true if terrain and earth curvature together don't obstruct a
// straight line between the two positions' altitudes, sampled at
// LOS_SAMPLE_COUNT points along the path.
//
// The curvature term matters once ranges realistically reach 100-250nm
// (real EWR/SAM acquisitionRange data) — a naive flat-altitude interpolation
// overstates detectability at range, since the earth's surface curves away
// beneath a straight sightline. At each sample point the effective sightline
// altitude is reduced by the standard chord/arc curvature-drop formula
// (d1*d2)/(2*Re), using the 4/3-effective-Earth-radius approximation for
// atmospheric refraction.
function hasLineOfSight(from, to) {
  const totalDistM = distanceNm(from, to) * METERS_PER_NM
  for (let i = 1; i < LOS_SAMPLE_COUNT; i++) {
    const frac = i / LOS_SAMPLE_COUNT
    const point = interpolate(from, to, frac)
    const expectedAlt = from.alt + (to.alt - from.alt) * frac
    const d1 = totalDistM * frac
    const d2 = totalDistM * (1 - frac)
    const curvatureDropM = (d1 * d2) / (2 * EFFECTIVE_EARTH_RADIUS_M)
    const terrain = elevation.getElevation(point.lat, point.lng)
    if (terrain !== null && terrain > expectedAlt - curvatureDropM) return false
  }
  return true
}

// Restricts Aircraft/Helicopter sensors to a plausible forward radar scan
// cone (azimuth off the nose, elevation off the pitch axis) instead of an
// omnidirectional bubble. Ground/naval search radars stay omnidirectional —
// real EWR/SAM search radars conventionally rotate. Falls back to "always
// within volume" if heading/pitch are missing (degrades to the old
// omnidirectional behavior rather than breaking detection outright).
//
// heading/pitch are populated for every unit including AI aircraft never
// connected as the exporting client — confirmed against a real capture
// (resources/tacview-stream.txt shows distinct pitch/roll values across many
// simultaneous AI flights), unlike cockpit-instrument fields (IAS/AoA/wind/
// fuel) that turned out restricted to the connecting client's own aircraft.
//
// rangeNm is the already-computed detector-target distance, passed in to
// avoid a second haversine call for the same pair.
function isWithinScanVolume(detectorUnit, targetPosition, rangeNm) {
  if (detectorUnit.category !== 'Aircraft' && detectorUnit.category !== 'Helicopter') return true
  if (detectorUnit.heading === undefined || detectorUnit.pitch === undefined) return true

  const bearing = bearingDeg(detectorUnit.position, targetPosition)
  if (angleDiff(bearing, detectorUnit.heading) > config.azimuthConeHalfAngleDeg) return false

  const groundRangeM = rangeNm * METERS_PER_NM
  const altDeltaM = (targetPosition.alt ?? 0) - (detectorUnit.position.alt ?? 0)
  const lookAngleDeg = toDeg(Math.atan2(altDeltaM, groundRangeM))
  return angleDiff(lookAngleDeg, detectorUnit.pitch) <= config.elevationConeHalfAngleDeg
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
    if (!unit.position) continue
    const rangeNm = sensorRangeNm(unit)
    if (!rangeNm) continue
    detectors.push({ id, unit, rangeNm })
  }

  const targets = Object.entries(units).filter(([, u]) => u.position && u.coalition !== undefined)

  for (const detector of detectors) {
    for (const [targetId, target] of targets) {
      if (targetId === detector.id) continue
      if (target.coalition === friendlyCoalitionId) continue // only cross-coalition detection matters
      if (!isValidTargetCategory(target.category)) continue

      const isAir = target.category === 'Aircraft' || target.category === 'Helicopter'
      if (isAir && target.agl !== undefined && target.agl < MIN_DETECTABLE_AGL_M) continue

      if (quickReject(detector.unit.position, target.position, detector.rangeNm)) continue

      const range = distanceNm(detector.unit.position, target.position)
      if (range > detector.rangeNm) continue

      if (!isWithinScanVolume(detector.unit, target.position, range)) continue

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

// RWR — inverted data flow from computeContacts above: the ENEMY-coalition
// unit acts as the emitter (using its own detection range as a proxy for how
// far its emissions carry), and only friendly Aircraft/Helicopter act as
// receivers (real RWR is airframe avionics — ground/naval units don't get
// one here). Range uses the emitter's own range times config.rwr.
// rangeMultiplier, since one-way passive reception genuinely outranges what
// the same radar needs for a two-way return — treated as an approximate,
// operator-tunable number, not a researched constant. isWithinScanVolume
// gates the emitter side when it's Aircraft/Helicopter (a fighter whose
// radar cone doesn't reach you shouldn't paint your RWR either).
//
// Contacts are pushed onto the *receiving* friendly unit's contacts[], same
// shape as radar contacts but DETECTION_RWR (16) — matches the client's
// existing rwrEverDetected handling (AicScope.jsx/abmScopeHelpers.js), which
// does not grant visibility from this bit alone; it only reveals an
// already-visible (RADAR/DLINK-detected) contact's type persistently. See
// createFogFilter's computeVisibility() for why that means RWR contacts must
// NOT feed the server-side fog-exposure set on their own.
function computeRwrContacts(units, friendlyCoalitionId) {
  const rwrById = new Map()
  if (!config.rwr.enabled) return {}

  const receivers = []
  for (const [id, unit] of Object.entries(units)) {
    if (unit.coalition !== friendlyCoalitionId) continue
    if (!unit.position) continue
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    receivers.push({ id, unit })
  }
  if (receivers.length === 0) return {}

  const emitters = Object.entries(units).filter(
    ([, u]) => u.position && u.coalition !== undefined && u.coalition !== friendlyCoalitionId
  )

  for (const receiver of receivers) {
    for (const [emitterId, emitter] of emitters) {
      if (emitterId === receiver.id) continue
      const baseRangeNm = sensorRangeNm(emitter)
      if (!baseRangeNm) continue
      const rwrRangeNm = baseRangeNm * config.rwr.rangeMultiplier

      if (quickReject(receiver.unit.position, emitter.position, rwrRangeNm)) continue

      const range = distanceNm(receiver.unit.position, emitter.position)
      if (range > rwrRangeNm) continue

      if (!isWithinScanVolume(emitter, receiver.unit.position, range)) continue

      if (!hasLineOfSight(emitter.position, receiver.unit.position)) continue

      if (!rwrById.has(receiver.id)) rwrById.set(receiver.id, [])
      rwrById.get(receiver.id).push({ ID: Number(emitterId), detectionMethod: DETECTION_RWR })
    }
  }

  const updated = {}
  for (const [id, contacts] of rwrById) {
    updated[id] = { contacts }
  }
  return updated
}

// Merges partial-update maps of the same { [id]: { contacts: [...] } } shape,
// concatenating contacts[] when the same unit id appears in more than one
// (e.g. a friendly aircraft with both a radar contact and an RWR contact in
// the same pass).
function mergeContactMaps(...maps) {
  const merged = {}
  for (const map of maps) {
    for (const [id, { contacts }] of Object.entries(map)) {
      if (!merged[id]) merged[id] = { contacts: [] }
      merged[id].contacts.push(...contacts)
    }
  }
  return merged
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
    // omniscient unit map. Returns the contacts update (for friendly units,
    // radar + RWR merged) plus which previously-hidden enemies just became
    // visible (need their full current data pushed, since filterFrameUpdate
    // was dropping their updates while hidden) and which previously-visible
    // enemies just dropped out of detection (need an explicit removal — the
    // raw Tacview stream won't emit one, since the object hasn't actually
    // left the mission, just this coalition's detection range).
    //
    // Exposure (`nowVisible`, which decides filterFrameUpdate's pass-through
    // set) is deliberately built from radarUpdate ONLY, not the merged
    // contactsUpdate — an RWR-only hit must not itself leak an enemy's real
    // position over the wire, matching the client's own treatment of the RWR
    // bit (it never grants visibility by itself, only reveals an
    // already-visible contact's type). An RWR contact entry still reaches
    // the client fine either way, since it's attached to the friendly
    // receiver's own contacts[], and friendly units are always exposed.
    computeVisibility(internalUnits) {
      const radarUpdate = computeContacts(internalUnits, friendlyCoalitionId)
      const rwrUpdate = computeRwrContacts(internalUnits, friendlyCoalitionId)
      const contactsUpdate = mergeContactMaps(radarUpdate, rwrUpdate)

      const nowVisible = new Set()
      for (const { contacts } of Object.values(radarUpdate)) {
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

module.exports = { computeContacts, computeRwrContacts, coalitionId, createFogFilter, DETECTION_RADAR, DETECTION_RWR }
