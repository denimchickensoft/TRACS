import { isOnGround } from '../../utils/visibleUnits.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { typeAbbrev, parseFlightElement } from './canvas/drawAbmContacts.js'
import { DECLARATION, getAbmEffectiveDeclaration } from '../../store/abm.js'

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
    if (isOnGround(unit)) continue
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

// FRAG route leg labels use the flight's group callsign (e.g. "COLT1" for
// "COLT11"), the same flight/element split Ato.jsx's CALLSIGN column and
// formation-datablock suppression already use — see parseFlightElement's
// header comment in drawAbmContacts.js. Falls back to the mission-editor
// group name when the lead unit's callsign doesn't parse.
export function flightRouteGroupLabel(flight) {
  if (!flight) return null
  return parseFlightElement(flight.units?.[0])?.flightKey ?? flight.name ?? null
}

// Collapses runway centerlines (two direction-entries per physical strip)
// into one strip per runway, grouped by airbase with its ICAO code and
// runway designators. Pure — AbmScope memoizes it.
export function buildAirportStrips(runwayCenterlines, icaoMap, theatre) {
  const theatreIcao = (theatre && icaoMap[theatre.toLowerCase()]) || {}
  const stripMap = new Map()
  for (const c of runwayCenterlines) {
    if (!c.rwyEnd1 || !c.rwyEnd2) continue
    // centerlines' public shape (store/runways.js) doesn't carry rwyName
    // directly — only rawCenterlines (an internal intermediate) does — but
    // id is `${airbase}__${rwyName}`, so pull it back out from there.
    const rwyName = c.id.slice(c.airbase.length + 2)
    const key = `${c.airbase}|${c.rwyEnd1.lat.toFixed(6)},${c.rwyEnd1.lng.toFixed(6)}|${c.rwyEnd2.lat.toFixed(6)},${c.rwyEnd2.lng.toFixed(6)}`
    const existing = stripMap.get(key)
    if (existing) existing.names.push(rwyName)
    else stripMap.set(key, { airbase: c.airbase, rwyEnd1: c.rwyEnd1, rwyEnd2: c.rwyEnd2, names: [rwyName] })
  }
  const byAirbase = new Map()
  for (const strip of stripMap.values()) {
    const designator = strip.names.map(padRunwayName).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join('/')
    if (!byAirbase.has(strip.airbase)) {
      byAirbase.set(strip.airbase, {
        airbase: strip.airbase, icao: theatreIcao[strip.airbase] ?? null, strips: [], designators: [],
      })
    }
    const entry = byAirbase.get(strip.airbase)
    entry.strips.push({ rwyEnd1: strip.rwyEnd1, rwyEnd2: strip.rwyEnd2 })
    entry.designators.push(designator)
  }
  return [...byAirbase.values()]
}

// Collapses cursor readout hits into display groups (see AbmScope's
// readout comment for the grouping rules). `correlatedUnitIds` and
// `rwrEverDetected` are the scope's current sets. Pure — AbmScope memoizes it.
export function groupReadoutHits(readoutHits, myCoalitionNum, correlatedUnitIds, rwrEverDetected, isOwnSide) {
  const groups = new Map()
  for (const hit of readoutHits) {
    if (hit.kind === 'airport') {
      groups.set(hit.unitId, { kind: 'airport', unitId: hit.unitId, airport: hit.airport, count: 1 })
      continue
    }
    if (hit.kind === 'air') {
      // Declaration-driven for a non-srsCapable contact; for an
      // srsCapable one, identity reveal is driven by CURRENT correlation
      // alone, independent of (possibly sticky) declaration — same
      // decoupling as drawAbmContacts.js's datablock, see its comment for
      // the full reasoning. getAbmEffectiveDeclaration still gates
      // whether an srsCapable contact gets an automatic FRIENDLY default
      // in the first place (no free pass for being same-coalition), but
      // decl itself no longer factors into reveal here.
      const decl = getAbmEffectiveDeclaration(hit.unitId, hit.unit, myCoalitionNum)
      // Never another side's aircraft, whatever it's declared.
      const isFriendly = (hit.unit.srsCapable
        ? correlatedUnitIds.has(String(hit.unitId))
        : decl === DECLARATION.FRIENDLY) && isOwnSide(hit.unit)
      if (isFriendly) {
        groups.set(`air:${hit.unitId}`, {
          kind: 'air', unitId: hit.unitId, unit: hit.unit, isFriendly: true, count: 1,
        })
        continue
      }
      const revealed  = rwrEverDetected.has(String(hit.unitId))
      const typeLabel = revealed ? typeAbbrev(hit.unit) : null
      const key       = `air-unknown:${typeLabel ?? 'UNKNOWN'}`
      const existing  = groups.get(key)
      if (existing) existing.count++
      else groups.set(key, {
        kind: 'air', unitId: hit.unitId, unit: hit.unit, isFriendly: false, revealed, typeLabel, count: 1,
      })
      continue
    }
    const key = `ground:${hit.unit.name}`
    const existing = groups.get(key)
    if (existing) existing.count++
    else groups.set(key, { kind: 'ground', unitId: hit.unitId, unit: hit.unit, count: 1 })
  }
  // Airfields always lead the list — Array#sort is stable, so this only
  // reorders across kinds and leaves same-kind relative order untouched.
  return [...groups.values()].sort((a, b) => (a.kind === 'airport' ? 0 : 1) - (b.kind === 'airport' ? 0 : 1))
}
