import { CARRIER_TYPES } from './carriers.js'
import { dcsPointToLatLng } from './dcsCoords.js'
import { M_TO_FT } from './units.js'

// ── Lua parser ────────────────────────────────────────────────────────────────

function skipWS(s) {
  while (s.i < s.src.length) {
    const c = s.src[s.i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { s.i++; continue }
    if (c === '-' && s.src[s.i + 1] === '-') {
      while (s.i < s.src.length && s.src[s.i] !== '\n') s.i++
      continue
    }
    break
  }
}

function parseStr(s) {
  s.i++ // opening "
  let out = ''
  while (s.i < s.src.length) {
    const c = s.src[s.i]
    if (c === '"') { s.i++; return out }
    if (c === '\\') {
      s.i++
      const e = s.src[s.i++]
      out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e
      continue
    }
    out += c; s.i++
  }
  return out
}

function parseNum(s) {
  const start = s.i
  if (s.src[s.i] === '-') s.i++
  while (s.i < s.src.length && /[\d.]/.test(s.src[s.i])) s.i++
  if (s.i < s.src.length && (s.src[s.i] === 'e' || s.src[s.i] === 'E')) {
    s.i++
    if (s.src[s.i] === '+' || s.src[s.i] === '-') s.i++
    while (s.i < s.src.length && /\d/.test(s.src[s.i])) s.i++
  }
  return parseFloat(s.src.slice(start, s.i))
}

function parseVal(s) {
  skipWS(s)
  const c = s.src[s.i]
  if (c === '{') return parseTable(s)
  if (c === '"') return parseStr(s)
  if (c === '-' || (c >= '0' && c <= '9')) return parseNum(s)
  if (s.src.startsWith('true',  s.i)) { s.i += 4; return true  }
  if (s.src.startsWith('false', s.i)) { s.i += 5; return false }
  if (s.src.startsWith('nil',   s.i)) { s.i += 3; return null  }
  throw new Error(`Unexpected '${c}' at position ${s.i}`)
}

// At an entry's start: `[key] =` or `name =` (keyed), or a bare value.
function isKeyedEntry(s) {
  if (s.src[s.i] === '[') return true
  let j = s.i
  if (!/[a-zA-Z_]/.test(s.src[j] ?? '')) return false
  while (j < s.src.length && /[a-zA-Z_0-9]/.test(s.src[j])) j++
  while (j < s.src.length && /\s/.test(s.src[j])) j++
  return s.src[j] === '=' && s.src[j + 1] !== '='
}

function parseTable(s) {
  s.i++ // {
  const obj = {}
  const intKeys = []

  while (true) {
    skipWS(s)
    if (s.i >= s.src.length || s.src[s.i] === '}') { s.i++; break }

    // Positional entry (`{ "a", "b" }`) - no key, just a value. DCS writes
    // some tables this way, e.g. a track's trig.actions. Lua numbers them
    // from 1 in order.
    if (!isKeyedEntry(s)) {
      const n = intKeys.length + 1
      intKeys.push(n)
      obj[String(n)] = parseVal(s)
      skipWS(s)
      if (s.i < s.src.length && s.src[s.i] === ',') s.i++
      continue
    }

    let key
    if (s.src[s.i] === '[') {
      s.i++ // [
      skipWS(s)
      if (s.src[s.i] === '"') {
        key = parseStr(s)
      } else {
        const n = parseNum(s)
        intKeys.push(n)
        key = String(n)
      }
      skipWS(s)
      s.i++ // ]
    } else {
      const start = s.i
      while (s.i < s.src.length && /[a-zA-Z_0-9]/.test(s.src[s.i])) s.i++
      key = s.src.slice(start, s.i)
    }

    skipWS(s)
    s.i++ // =
    skipWS(s)
    obj[key] = parseVal(s)

    skipWS(s)
    if (s.i < s.src.length && s.src[s.i] === ',') s.i++
  }

  // All-integer keys → sorted array
  if (intKeys.length > 0 && intKeys.length === Object.keys(obj).length) {
    return intKeys.sort((a, b) => a - b).map(k => obj[String(k)])
  }
  return obj
}

export function parseLua(src) {
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1)
  const s = { src, i: 0 }
  skipWS(s)
  while (s.i < s.src.length && /[a-zA-Z_0-9]/.test(s.src[s.i])) s.i++ // skip "mission"
  skipWS(s)
  s.i++ // =
  skipWS(s)
  return parseVal(s)
}

// ── Weather extraction ────────────────────────────────────────────────────────

// DCS cloud preset → has a BKN/OVC layer (ceiling)?
// Presets 1-6 are FEW/SCT; 7+ are BKN or OVC.
// RainyPresets are always OVC.
// Source: DCS community tooling (DCS-ATIS, SRS-ATIS, LotATC).
const PRESET_CEILING = (() => {
  const m = {}
  for (let i = 1;  i <= 6;  i++) m[`Preset${i}`] = false
  for (let i = 7;  i <= 28; i++) m[`Preset${i}`] = true
  m['RainyPreset1'] = true
  m['RainyPreset2'] = true
  m['RainyPreset3'] = true
  return m
})()

export function extractWeather(mission) {
  const w = mission?.weather
  if (!w) return null

  // QNH: mmHg → inHg (×0.03937008), formatted as 4-digit integer string ("2992")
  const qnh = w.qnh != null
    ? String(Math.round(w.qnh * 0.03937008 * 100)).padStart(4, '0')
    : ''

  // Visibility: metres → statute miles, capped at 10
  const visSM = w.visibility?.distance != null
    ? Math.min(10, Math.round(w.visibility.distance / 1609.344))
    : null
  const vis = visSM != null ? String(visSM) : ''

  // Ceiling
  let clg = ''
  let ceilingNote = null
  const clouds = w.clouds
  if (clouds) {
    const preset = clouds.preset ?? null
    let isCeiling = false
    let known = true

    if (preset) {
      if (PRESET_CEILING[preset] != null) {
        isCeiling = PRESET_CEILING[preset]
      } else {
        known = false
        ceilingNote = `Unknown preset ${preset} — verify manually`
      }
    } else {
      // Legacy density-based weather: 0–4 = FEW/SCT, 5–10 = BKN/OVC
      isCeiling = typeof clouds.density === 'number' && clouds.density >= 5
    }

    if (known) {
      const baseFt = Math.round((clouds.base ?? 0) * M_TO_FT)
      if (isCeiling) {
        clg = String(Math.round(baseFt / 100)).padStart(3, '0')
        ceilingNote = `${preset ?? `density ${clouds.density}`} — BKN/OVC at ${baseFt.toLocaleString()} ft`
      } else {
        ceilingNote = `${preset ?? `density ${clouds.density}`} — FEW/SCT, no ceiling`
      }
    }
  }

  // Surface wind ("at 10 m" in the editor), as { fromDeg (true), speedMs }.
  // The mission stores the direction the wind blows towards, per community
  // ATIS tooling (not yet checked against DCS itself), so it's turned around.
  const g = w.wind?.atGround
  const wind = typeof g?.speed === 'number' && typeof g?.dir === 'number'
    ? { fromDeg: ((g.dir + 180) % 360 + 360) % 360, speedMs: g.speed }
    : null

  return { qnh, vis, clg, ceilingNote, wind }
}

// ── Aircraft extraction ───────────────────────────────────────────────────────

// Aircraft whose own cockpit numbers waypoints starting at 0, one behind the
// mission editor's route order — confirmed in-sim: ME waypoint 1
// (the launch point) shows as WP0 in the jet, ME waypoint 2 as WP1, etc. Not
// the same as the Hornet's separate "WP0 = spawn position" DTC concept (that
// one is additive and doesn't shift ME numbering). Other aircraft keep the
// natural 1-based ME numbering (WP1 = route.points[0]) until verified
// otherwise — don't add to this set without an in-sim check.
export const ZERO_INDEXED_WAYPOINT_TYPES = new Set([
  'FA-18C_hornet',
])

// DCS unit type → 4-char display abbreviation
export const TYPE_ABBREV = {
  'FA-18C_hornet':  'F18C',
  'F-14A-135-GR':   'F14A',
  'F-14B':          'F14B',
  'AV8BNA':         'AV8B',
  'S-3B_Tanker':    'S3BT',
  'E-2C':           'E-2C',
  'SH-60B':         'SH60',
  'UH-60A':         'UH60',
  'Ka-27':          'KA27',
  'SA342M':         'SA34',
  'C-2A':           'C-2A',
  'MH-60R':         'MH60',
}

// DCS group task → MISSION field abbreviation (max 6 chars)
export const TASK_ABBREV = {
  'Pinpoint Strike':  'STRIKE',
  'CAS':              'CAS',
  'CAP':              'CAP',
  'SEAD':             'SEAD',
  'Antiship Strike':  'AI',
  'Ground Attack':    'AI',
  'Escort':           'ESCORT',
  'Intercept':        'DCA',
  'Refueling':        'AR',
  'AWACS':            'AEW',
  'Fighter Sweep':    'SWEEP',
  'Transport':        'AIRLIFT',
  'Reconnaissance':   'RECCE',
  'Runway Attack':    'OCA',
  'Nothing':          'NONE',
  'Без задачи':       'NONE',  // Russian-localized "no task"
}

const DEPARTURE_ACTIONS = new Set([
  'From Parking Area',
  'From Parking Area Hot',
  'From Runway',
])

function toArray(val) {
  if (!val) return []
  return Array.isArray(val) ? val : Object.values(val)
}

function firstWP(group) {
  const pts = group.route?.points
  if (!pts) return null
  return Array.isArray(pts) ? pts[0] : (pts['1'] ?? null)
}

function collectCarriers(mission) {
  const carriers = []
  for (const coaData of Object.values(mission.coalition ?? {})) {
    for (const country of toArray(coaData.country)) {
      for (const group of toArray(country.ship?.group)) {
        for (const unit of toArray(group.units)) {
          if (CARRIER_TYPES[unit.type]) {
            carriers.push({
              unitId:   unit.unitId,
              type:     unit.type,
              display:  CARRIER_TYPES[unit.type].displayName,
              abbrev:   CARRIER_TYPES[unit.type].facilityId,
            })
          }
        }
      }
    }
  }
  return carriers
}

export function findCarriersAndAircraft(mission) {
  const carriers = collectCarriers(mission)

  if (carriers.length === 0) return { carriers, aircraft: [] }

  const carrierIds = new Set(carriers.map(c => c.unitId))
  const aircraft = []

  for (const coaData of Object.values(mission.coalition ?? {})) {
    for (const country of toArray(coaData.country)) {
      for (const group of [...toArray(country.plane?.group), ...toArray(country.helicopter?.group)]) {
        const wp1 = firstWP(group)
        if (!wp1 || !DEPARTURE_ACTIONS.has(wp1.action) || !carrierIds.has(wp1.linkUnit)) continue

        const carrierUnitId = wp1.linkUnit
        const task = TASK_ABBREV[group.task] ?? (group.task ?? '').slice(0, 6).toUpperCase()

        for (const unit of toArray(group.units)) {
          aircraft.push({
            carrierUnitId,
            callsign: (unit.name ?? '').replace(/[-\s]/g, '').toUpperCase(),
            type:     TYPE_ABBREV[unit.type] ?? (unit.type ?? '').slice(0, 4).toUpperCase(),
            modex:    String(unit.onboard_num ?? ''),
            task,
            skill:    unit.skill ?? '',
          })
        }
      }
    }
  }

  return { carriers, aircraft }
}

// ── ATO/FRAG extraction ─────────────────────────────────────────────────────
// Every plane and helicopter group across all coalitions/countries, split
// into flights (see findAtoFlights), with route,
// payload, radio and Link16 detail — built only from structural mission data
// (no trig/trigrules/l10n dictionary).

function buildRoute(group, theatre) {
  return toArray(group.route?.points).map((p) => {
    const ll = dcsPointToLatLng(p.x, p.y, theatre)
    return {
      name:   p.name || null,  // DCS sometimes writes an explicit "" instead of omitting the key — both mean "unnamed"
      lat:    ll?.lat ?? null,
      lng:    ll?.lng ?? null,
      alt:    p.alt ?? null,
      speed:  p.speed ?? null,
      action: p.action ?? null,
      beacon: waypointBeacon(p),
    }
  })
}

// A TACAN the waypoint switches on: an "Activate Beacon" action, which the
// mission editor writes as a WrappedAction inside the waypoint's task list
// (usually a ComboTask). { channel, mode, callsign } e.g. 31 / 'Y' / 'TKR',
// or null.
function waypointBeacon(point) {
  const task = point.task
  const tasks = task?.id === 'ComboTask' ? toArray(task.params?.tasks) : (task ? [task] : [])
  for (const t of tasks) {
    const action = t?.id === 'WrappedAction' ? t.params?.action : null
    const p = action?.id === 'ActivateBeacon' ? action.params : null
    if (p?.channel == null) continue
    return { channel: p.channel, mode: p.modeChannel ?? 'X', callsign: p.callsign ?? '' }
  }
  return null
}

// "31Y TKR" / "31Y"
export function formatTacan(beacon, withCallsign = true) {
  if (!beacon) return ''
  const chan = `${beacon.channel}${beacon.mode}`
  return withCallsign && beacon.callsign ? `${chan} ${beacon.callsign}` : chan
}

// A waypoint referencing a carrier or airbase — resolved to a name
// client-side via /airdromes/<theatre>.json (see utils/airdromes.js) for the
// airbase case: DCS's own numeric airdrome ID space, transcribed per-theatre
// from pydcs (github.com/pydcs/dcs), the community source for this since DCS
// has no officially published id->name table.
function resolveAirfieldRef(point, carriersById, theatre) {
  if (!point) return null
  if (point.linkUnit != null && carriersById.has(point.linkUnit)) {
    return {
      type: 'carrier', carrierUnitId: point.linkUnit,
      carrierName:   carriersById.get(point.linkUnit).display,
      carrierAbbrev: carriersById.get(point.linkUnit).abbrev,
    }
  }
  if (point.airdromeId != null) {
    return { type: 'airbase', airdromeId: point.airdromeId, theatre }
  }
  return null
}

function buildLaunch(wp1, carriersById, theatre) {
  // If the first waypoint isn't a departure from a carrier/airbase, the
  // mission genuinely never recorded a takeoff point — the flight spawns
  // already airborne (e.g. an on-station tanker/CAP orbit). That's a known
  // state, not a parse failure, so it gets its own type rather than 'unknown'.
  return resolveAirfieldRef(wp1, carriersById, theatre) ?? { type: 'airstart' }
}

// Last route point that references a carrier/airbase (typically the final
// "Landing" waypoint) — the flight's recovery point, which may be captured
// even when the launch point wasn't (air-start flights still often land
// somewhere real).
function buildRecovery(points, carriersById, theatre) {
  for (let i = points.length - 1; i >= 0; i--) {
    const ref = resolveAirfieldRef(points[i], carriersById, theatre)
    if (ref) return ref
  }
  return { type: 'unknown' }
}

// A Mission Editor static template (.stm) is one squadron's flight package,
// saved on its own and pasted into the real mission later. Its group and
// unit IDs are local to that file (every template restarts at 1) and get
// renumbered on paste, so they can neither identify a flight across files
// nor match a live unit. Its flights are identified by coalition + group
// name instead, hashed into a range real DCS group IDs never reach (and
// positive, unlike manual flights' negative IDs). Deterministic, so every
// controller loading the same file gets the same ID and FRAG edits synced
// by groupId still line up.
const TEMPLATE_GROUP_ID_BASE = 1e9

export function templateGroupId(coalition, groupName) {
  const key = `${coalition}\u0000${groupName ?? ''}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return TEMPLATE_GROUP_ID_BASE + (h % TEMPLATE_GROUP_ID_BASE)
}

// A DCS group can hold several flights (group North_CAP: ELVIS-5-1,
// ELVIS-5-2, HAWK-1-1, HAWK-1-2). A group with one flight keeps the DCS
// group ID as its flight ID; each flight of a split group gets this hash of
// coalition + group ID + base name instead, in a range of its own (above
// templateGroupId's). Deterministic, so every controller splitting the same
// mission gets the same IDs and synced FRAG edits line up.
const SPLIT_FLIGHT_ID_BASE = 2e9

export function splitFlightId(coalition, groupId, base) {
  const key = `${coalition}\u0000${groupId ?? ''}\u0000${base}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return SPLIT_FLIGHT_ID_BASE + (h % 1e9)
}

// A unit name's flight base and aircraft position. Two trailing numbers make
// the last one the position ("RMD-1-2" -> RMD-1 / 2, "Elvis5-1" -> Elvis5 /
// 1). Anything else is a flight of its own with no position ("Warden-1",
// "VOLVO-1", "F/A-18C Lot 20"): a single trailing number can't be told apart
// from a flight number, so it never merges units.
export function splitUnitName(name) {
  const trimmed = (name ?? '').trim()
  const m = trimmed.match(/^(.*\d)[\s_-]+(\d+)$/)
  if (m) return { base: m[1], position: Number(m[2]) }
  return { base: trimmed, position: null }
}

const flightKeyOf = (base) => base.replace(/[^A-Za-z0-9]/g, '').toUpperCase()

// Text-level check, since parseLua discards the leading variable name.
export function isStaticTemplateText(src) {
  return /^\uFEFF?\s*staticTemplate\s*=/.test(src)
}

function buildUnits(group, template) {
  return toArray(group.units).map((unit) => ({
    // A template's unitId is file-local (see templateGroupId), so it must
    // never reach the live unitId match tier.
    unitId:   template ? null : (unit.unitId ?? null),
    // The unit name, not the DCS editor callsign: it is what live data
    // reports for the unit and is unique mission-wide, while editor
    // callsigns repeat and rarely mean anything.
    unitName: (unit.name ?? '').trim(),
    position: splitUnitName(unit.name).position,
    type:     TYPE_ABBREV[unit.type] ?? (unit.type ?? '').slice(0, 4).toUpperCase(),
    rawType:  unit.type ?? '',
    modex:    String(unit.onboard_num ?? ''),
    skill:    unit.skill ?? '',
    livery:   unit.livery_id ?? '',
    radios: toArray(unit.Radio).map((r) => ({
      channels:    r?.channels ?? {},
      modulations: r?.modulations ?? {},
    })),
    payload: {
      fuel:  unit.payload?.fuel ?? null,
      chaff: unit.payload?.chaff ?? null,
      flare: unit.payload?.flare ?? null,
      gun:   unit.payload?.gun ?? null,
      // Station numbers on non-contiguous pylon tables are lost by the Lua
      // parser's integer-key-table -> array collapse; index+1 is a
      // best-effort label, not necessarily the true DCS station number.
      pylons: toArray(unit.payload?.pylons).map((p, idx) => ({
        station: idx + 1,
        clsid:   p?.CLSID ?? null,
      })),
    },
    link16: {
      stn:     unit.AddPropAircraft?.STN_L16 ?? null,
      network: unit.datalinks?.Link16?.network ?? null,
    },
  }))
}

// `template`: the mission is a static template (.stm) -- see templateGroupId.
export function findAtoFlights(mission, { template = false } = {}) {
  const theatre = mission?.theatre ?? null
  const carriers = collectCarriers(mission)
  const carriersById = new Map(carriers.map((c) => [c.unitId, c]))

  const flights = []

  for (const [coalition, coaData] of Object.entries(mission.coalition ?? {})) {
    for (const country of toArray(coaData.country)) {
      for (const group of [...toArray(country.plane?.group), ...toArray(country.helicopter?.group)]) {
        // Every aircraft group is listed: a group-level task of "Nothing"
        // does NOT mean inert/scenery. DCS mission designers commonly leave
        // it unset on AI wingmen whose tasking instead comes from
        // per-waypoint actions or trigger scripting (confirmed against a
        // real mission where an active, uncontrolled=false, 2-ship flight
        // had task="Nothing" and was being silently dropped here).
        const task = group.task ?? 'Nothing'
        const isReserve = group.lateActivation === true

        const points = toArray(group.route?.points)
        const wp1 = firstWP(group)
        const route = buildRoute(group, theatre)
        const groupId = template ? templateGroupId(coalition, group.name) : (group.groupId ?? null)

        const shared = {
          ...(template && { source: 'stm', templateName: mission.name ?? null }),
          coalition,
          dcsGroupId:     template ? null : (group.groupId ?? null),
          groupName:      (group.name ?? '').trim(),
          task:           TASK_ABBREV[task] ?? (task ?? '').slice(0, 6).toUpperCase(),
          rawTask:        task,
          frequency:      group.frequency ?? null,
          lateActivation: isReserve,
          uncontrolled:   group.uncontrolled === true,
          launch:         buildLaunch(wp1, carriersById, theatre),
          recovery:       buildRecovery(points, carriersById, theatre),
          route,
          // The first TACAN the route switches on (tankers, mostly); FRAG's
          // route list shows any later change at its waypoint.
          tacan:          route.find((wp) => wp.beacon)?.beacon ?? null,
        }

        // A flight is the units of one group sharing a base unit name
        // (splitUnitName); a group never merges with another.
        const byBase = new Map()
        for (const unit of buildUnits(group, template)) {
          const key = flightKeyOf(splitUnitName(unit.unitName).base) || flightKeyOf(group.name ?? '')
          if (!byBase.has(key)) byBase.set(key, [])
          byBase.get(key).push(unit)
        }
        if (byBase.size === 0) byBase.set(flightKeyOf(group.name ?? ''), [])
        for (const [key, units] of byBase) {
          flights.push({
            flightId: byBase.size === 1 ? groupId : splitFlightId(coalition, groupId, key),
            name:     key,
            ...shared,
            units,
          })
        }
      }
    }
  }

  return flights
}
