import { latLngToCanvas } from '../../utils/projection.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { typeAbbrev } from './canvas/drawAbmContacts.js'

// Draw-command arg tokens (.line/.rect/.circ/.poly/.sect/.race/.text) must
// come from the ORIGINAL-case command text, not the lowercased `str`
// execCommand matches against — .text's label content needs to keep
// whatever case the controller typed. `str`/`raw.trim()` share the same
// length and whitespace positions (lowercasing doesn't change either), so
// the split point found in `str` is reused to slice the original-case raw.
export function drawCmdTokens(str, raw) {
  const trimmedRaw = raw.trim()
  const spaceIdx = str.indexOf(' ')
  return spaceIdx === -1 ? [] : trimmedRaw.slice(spaceIdx + 1).trim().split(/\s+/).filter(Boolean)
}

const AGL_FLOOR_M = 30  // ≈ 100 ft — suppress ground contacts, same floor AIC uses

// Same fog-of-war model as AIC (client/src/modules/aic/AicScope.jsx
// getAicVisibleUnits) — kept as a local copy rather than a shared import
// since it's a small, stable filter and AIC doesn't export it.
export function getAbmVisibleUnits(units, myCoalitionNum, rwrEverDetected) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if ((c.detectionMethod & 4) || (c.detectionMethod & 32)) detectedIds.add(String(c.ID))
      if (c.detectionMethod & 16) rwrEverDetected?.add(String(c.ID))
    }
  }

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    if (unit.alive === false) continue
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    if (unit.agl !== undefined && unit.agl < AGL_FLOOR_M) continue
    const c = unit.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = unit
  }

  return result
}

// Same fog-of-war rule as air — friendly ground/naval always shown,
// enemy only if in a friendly's contacts[] — but no AGL floor (ground units
// sit at/near 0 AGL by definition, so that filter doesn't apply here).
// Unlike air (RADAR/DLINK only), ground/naval detection counts any method —
// VISUAL(1)/OPTIC(2)/RADAR(4)/IRST(8)/RWR(16)/DLINK(32) — since a ground unit
// spotted visually or optically is just as "detected" as one painted by radar.
const GROUND_DETECTION_MASK = 1 | 2 | 4 | 8 | 16 | 32

export function getAbmVisibleGroundUnits(units, myCoalitionNum) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if (c.detectionMethod & GROUND_DETECTION_MASK) detectedIds.add(String(c.ID))
    }
  }

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    if (unit.alive === false) continue
    if (unit.category !== 'GroundUnit' && unit.category !== 'NavyUnit') continue
    const c = unit.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = unit
  }

  return result
}

// Bogey dope helper — ported from AIC's AicScope.jsx findNearestBogey as-is.
// Air contacts only, BOGEY/HOSTILE only (excludes FRIENDLY/NEUTRAL and
// ground/naval contacts — "bogey" means air).
// Declaration-only multi-select — local to ABM, not shared
// with resolveSlew (used everywhere else: BRAA, threat rings, bogey dope,
// leader-dir override) which always picks the single nearest hit. Dense
// ground/naval clusters can bury a unit behind closer neighbors so that
// "nearest wins" makes it unreachable no matter where in the cluster you
// click; F1-F4 + click instead declares every contact within the same
// click radius at once.
const DECLARE_CLICK_RADIUS_PX = 10

export function resolveDeclareTargets(canvasPos, units, view) {
  const hits = []
  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue
    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (Math.hypot(canvasPos.x - x, canvasPos.y - y) < DECLARE_CLICK_RADIUS_PX) {
      hits.push({ unitId: id, unit })
    }
  }
  return hits
}

const METERS_PER_NM = 1852
export function formatNmRange(meters, suffix) {
  return `${Math.round(meters / METERS_PER_NM)} NM ${suffix}`
}

// Cursor-proximity readout field list — pulled from the ground/navy unit
// databases (client/public/units/{ground,navy}unitdatabase.json), same
// dbEntry shape drawAbmGroundContacts.js keys off of (unit.name lookup).
// Empty string/null/0 fields are dropped per spec — a 0 acq/eng range means
// "no ring drawn" (see drawAbmGroundContacts.js), not "range is zero". No
// labels on the lines themselves — the acq/eng lines carry their own
// "acquisition"/"engagement" suffix instead.
export function buildReadoutFields(dbEntry) {
  if (!dbEntry) return []
  const fields = [
    dbEntry.label,
    dbEntry.type,
    dbEntry.acquisitionRange > 0 ? formatNmRange(dbEntry.acquisitionRange, 'acquisition') : null,
    dbEntry.engagementRange  > 0 ? formatNmRange(dbEntry.engagementRange,  'engagement')  : null,
    dbEntry.description,
  ]
  return fields.filter(v => v !== undefined && v !== null && v !== '')
}

// Friendly air-unit readout — built for a unit the caller has already
// determined is "friendly" for datablock/readout purposes (declaration or
// correlation-driven, see drawAbmContacts.js/AbmScope.jsx's
// getAbmEffectiveDeclaration + correlationEngine.js — no gating logic lives
// in this function itself, it just formats the field list).
// One line per ammo entry, no cap — a loaded-out jet just gets a long list.
export function buildFriendlyAirFields(unit) {
  const fields = [
    resolveCallsign(unit).toUpperCase(),
    typeAbbrev(unit),
    unit.fuel != null ? `${Math.round(unit.fuel)}% FUEL` : null,
    ...(unit.ammo ?? [])
      .filter(a => a.quantity > 0)
      .map(a => `${a.name} x ${a.quantity}`),
  ]
  return fields.filter(v => v !== undefined && v !== null && v !== '')
}

// Perpendicular distance from (px,py) to the segment (x1,y1)-(x2,y2), clamped
// to the segment itself (not the infinite line) — used to hit-test the
// cursor against runway centerlines for the airport readout below.
export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Average of every runway-strip endpoint at the named airbase — a good
// enough center point for a FRAG BASE .find-style marker, and reuses the
// same per-airbase strip tables airportStrips (below) already builds from
// runwayCenterlines rather than a separate lookup.
export function airbaseCenterFromStrips(strips, airbaseName) {
  const airport = strips.find(a => a.airbase === airbaseName)
  if (!airport) return null
  let latSum = 0, lngSum = 0, count = 0
  for (const s of airport.strips) {
    latSum += s.rwyEnd1.lat + s.rwyEnd2.lat
    lngSum += s.rwyEnd1.lng + s.rwyEnd2.lng
    count += 2
  }
  return count ? { lat: latSum / count, lng: lngSum / count } : null
}

// Standard aviation padding: single-digit runway numbers get a leading zero
// (e.g. "4" → "04"), the L/C/R parallel suffix (already resolved by
// useRunwaysStore) passes through unchanged.
export function padRunwayName(name) {
  const m = String(name).match(/^(\d+)([A-Za-z]?)$/)
  if (!m) return String(name)
  return `${m[1].padStart(2, '0')}${m[2].toUpperCase()}`
}

// Airport readout field list — DCS airbase name (line 1, every airport has
// one), ICAO (line 2, dropped if this airbase has no icaoMapping.json
// entry — not every airbase does), and every runway designator at the
// airport (line 3, physical strips comma-separated, each strip's reciprocal
// pair slash-joined — e.g. "04/22, 09L/27R").
export function buildAirportFields(airport) {
  const fields = [airport.airbase, airport.icao, airport.designators.join(', ')]
  return fields.filter(v => v !== undefined && v !== null && v !== '')
}
