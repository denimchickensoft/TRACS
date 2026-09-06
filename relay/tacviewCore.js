'use strict'

// ACMI (Tacview Real-Time Telemetry) parsing/mapping core — relay-hosted
// copy. This is a deliberate duplicate of server/src/tacviewCore.js, not a
// shared import: relay/ is a genuinely standalone-packaged app (own
// package.json, no cross-directory requires anywhere in it), so it can't
// require a file from ../server/src/ without breaking standalone
// deployment. Keep the two in sync by hand — mirrors this project's existing
// posture for transponders.js/srs.js, which also produce a parallel shape
// without sharing a literal file.
//
// See resources/specs/data-sources/custom-datasource-tacview-spec.md for the
// full protocol research this implements.

const UNIT_ID_OFFSET = 0xFFFFFF

const COLOR_TO_COALITION = { Blue: 2, Red: 1 }

const SYNTAX_SLOTS = {
  3: [0, 1, 2],
  5: [0, 1, 2, 6, 7],
  6: [0, 1, 2, 3, 4, 5],
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8],
}

const NUMERIC_PROPS = new Set(['AGL', 'Health', 'IAS', 'CAS', 'TAS', 'HDM', 'Importance'])

const HEX_ID_RE = /^[0-9a-fA-F]+$/

const EARTH_RADIUS_M = 6371008.8

// Great-circle distance (metres) between two tParts-space lat/lng pairs. Both
// points share the same additive ReferenceLatitude/ReferenceLongitude offset
// (§2.1), which cancels out in a distance calculation, so raw tParts values
// (never offset-adjusted) are fine to use directly here.
function distanceM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function classify(typeTag) {
  if (!typeTag) return null
  const tags = typeTag.split('+')
  if (tags.includes('Bullseye')) return 'bullseye'
  if (tags.includes('Static')) return null
  if (tags.includes('Air')) return tags.includes('Rotorcraft') ? 'Helicopter' : 'Aircraft'
  if (tags.includes('Ground')) return 'GroundUnit'
  if (tags.includes('Sea')) return 'NavyUnit'
  return null
}

function splitProps(rest) {
  const parts = []
  let current = ''
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '\\' && rest[i + 1] === ',') { current += ','; i++; continue }
    if (rest[i] === ',') { parts.push(current); current = ''; continue }
    current += rest[i]
  }
  if (current) parts.push(current)

  return parts.map((part) => {
    const eq = part.indexOf('=')
    if (eq === -1) return { key: part, value: '' }
    return { key: part.slice(0, eq), value: part.slice(eq + 1) }
  })
}

function coercePropValue(key, value) {
  if (!NUMERIC_PROPS.has(key)) return value
  const n = parseFloat(value)
  return Number.isNaN(n) ? undefined : n
}

// Widened from 1 to 3, 2026-09-06 — see server/src/tacviewCore.js's
// identical constant for the full account (a short window was sensitive to
// a beat/aliasing pattern against real flight's micro-variation, showing up
// as the displayed speed hovering between two adjacent tens-of-knots values
// even for a steady real aircraft).
const SPEED_SAMPLE_INTERVAL_S = 3

// ≈100ft — matches client/src/modules/abm/abmScopeHelpers.js's AGL_FLOOR_M,
// the existing ground-contact-suppression threshold. Used to derive
// `airborne` (see buildCanonicalUnit) since Tacview has no OnGround-
// equivalent signal.
const AIRBORNE_AGL_THRESHOLD_M = 30

function createParser() {
  const objects = new Map()
  let refLon = 0
  let refLat = 0
  let currentTime = 0
  let referenceTimeMs = null
  const bullseyes = {}

  function updateTParts(obj, rawT) {
    const segs = rawT.split('|')
    const slots = SYNTAX_SLOTS[segs.length] ?? SYNTAX_SLOTS[9]
    if (!obj.tParts) obj.tParts = new Array(9).fill(null)
    segs.forEach((seg, i) => {
      if (seg === '') return
      const slot = slots[i]
      if (slot === undefined) return
      const n = parseFloat(seg)
      if (!Number.isNaN(n)) obj.tParts[slot] = n
    })
  }

  function buildCanonicalUnit(obj, unitID) {
    const unit = { unitID }
    const p = obj.props
    if (p.Name !== undefined) unit.name = p.Name
    if (p.Pilot !== undefined) unit.unitName = p.Pilot
    if (p.CallSign !== undefined) unit.callsign = p.CallSign
    // `Group` is free text (e.g. "Iran Mig-29 1"), not a numeric ID — real
    // captured evidence confirms flight-mates DO share the same string
    // (custom-datasource-tacview-spec.md §2), so it correctly identifies
    // formations for STARS' formations.js (a plain Map key, string works
    // identically to a number). It will never equal ABM's real numeric
    // mission-group IDs (AddAtoFlight.jsx/Ato.jsx/Frag.jsx's `===` matches
    // against .miz-derived groupId), so that correlation stays unavailable —
    // safely, since a string can never strictly-equal a number, not a
    // regression risk.
    if (p.Group !== undefined) unit.groupID = p.Group
    if (p.Color !== undefined) unit.coalition = COLOR_TO_COALITION[p.Color] ?? 0
    if (p.AGL !== undefined) {
      unit.agl = p.AGL
      // Olympus's `airborne` is a genuine boolean DCS reports directly —
      // never set here at all, which silently broke ABM's Ato.jsx/Frag.jsx
      // status column (always falling through to groundState() for every
      // Tacview unit, which only distinguishes TAXI/GROUND by speed — a
      // fast airborne jet reads as "moving fast on the ground" = TAXI).
      // ACMI's documented OnGround property would be the direct equivalent,
      // but DCS's exporter doesn't populate it (same pattern as Squawk/
      // Registration/CallSign), so this derives it from AGL instead.
      unit.airborne = p.AGL > AIRBORNE_AGL_THRESHOLD_M
    }
    if (p.Health !== undefined) unit.health = p.Health
    // `unit.speed` is contractually metres/second, matching Olympus (see
    // client/src/modules/atc/stars/DatablockOverlay.jsx's fmtSpd(mps) and its
    // M_PER_S_TO_KNOTS conversion) — NOT knots. An earlier version of this
    // stored knots directly, which fmtSpd then converted *again*, inflating
    // the displayed speed by ~1.94x (confirmed live, 2026-09-06: a real
    // 474kt aircraft displayed near STARS' 990kt display cap).
    if (obj.groundSpeedMps !== undefined) unit.speed = obj.groundSpeedMps
    if (obj.category) unit.category = obj.category

    const t = obj.tParts
    if (t && t[0] !== null && t[1] !== null) {
      unit.position = { lat: refLat + t[1], lng: refLon + t[0], alt: t[2] ?? 0 }
    }
    const heading = t?.[8] ?? (p.HDM !== undefined ? p.HDM : t?.[5])
    if (heading !== undefined && heading !== null) unit.heading = heading

    return unit
  }

  function bullseyeColorName(color) {
    const c = COLOR_TO_COALITION[color]
    if (c === 2) return 'blue'
    if (c === 1) return 'red'
    return 'neutral'
  }

  function parseLines(lines) {
    const updated = {}
    const removed = []
    const positions = []

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '')
      if (!line || line.startsWith('//')) continue

      if (line[0] === '#') {
        const t = parseFloat(line.slice(1))
        if (!Number.isNaN(t)) currentTime = t
        continue
      }

      if (line[0] === '-') {
        const rawId = line.slice(1).trim()
        const obj = objects.get(rawId)
        if (obj?.emitted) removed.push(String(parseInt(rawId, 16) + UNIT_ID_OFFSET))
        objects.delete(rawId)
        continue
      }

      const commaIdx = line.indexOf(',')
      const rawId = commaIdx === -1 ? line : line.slice(0, commaIdx)
      if (!HEX_ID_RE.test(rawId)) continue
      const rest = commaIdx === -1 ? '' : line.slice(commaIdx + 1)
      const props = splitProps(rest)

      if (rawId === '0') {
        for (const prop of props) {
          if (prop.key === 'ReferenceLongitude') refLon = parseFloat(prop.value) || 0
          else if (prop.key === 'ReferenceLatitude') refLat = parseFloat(prop.value) || 0
          else if (prop.key === 'ReferenceTime') {
            const ms = Date.parse(prop.value)
            if (!Number.isNaN(ms)) referenceTimeMs = ms
          }
        }
        continue
      }

      let obj = objects.get(rawId)
      if (!obj) {
        obj = {
          tParts: null, props: {}, category: null, emitted: false,
          groundSpeedMps: undefined,
          speedSampleLat: null, speedSampleLon: null, speedSampleTime: null,
        }
        objects.set(rawId, obj)
      }

      for (const prop of props) {
        if (prop.key === 'T') {
          // Groundspeed for EVERY object is derived from consecutive position
          // samples, never read from a wire field — `IAS` (indicated airspeed,
          // not groundspeed) is confirmed present only on whichever aircraft
          // belongs to the DCS client hosting the export (custom-datasource-
          // tacview-spec.md §5 item 2/9), an arbitrary aircraft from a
          // controller's perspective, and using it just for that one aircraft
          // while deriving for everyone else would be an inconsistent
          // "airspeed vs. groundspeed" mix on the same field. Matches
          // Olympus's own `speed` field, which is always groundspeed for
          // every unit.
          //
          // Sampled over SPEED_SAMPLE_INTERVAL_S of ACMI stream time (not
          // wall-clock — multiple frames can arrive in a single TCP chunk,
          // which would otherwise timestamp real, seconds-apart samples only
          // milliseconds apart by wall-clock and divide by a near-zero
          // delta), not every frame: the reference sample only advances once
          // that much time has actually elapsed, so `groundSpeedMps` holds
          // its last value in between rather than recomputing on every delta
          // line.
          updateTParts(obj, prop.value)
          const newLat = obj.tParts?.[1]
          const newLon = obj.tParts?.[0]
          if (newLat != null && newLon != null) {
            if (obj.speedSampleTime === null) {
              obj.speedSampleLat = newLat
              obj.speedSampleLon = newLon
              obj.speedSampleTime = currentTime
            } else {
              const dt = currentTime - obj.speedSampleTime
              if (dt >= SPEED_SAMPLE_INTERVAL_S) {
                if (dt > 0) obj.groundSpeedMps = distanceM(obj.speedSampleLat, obj.speedSampleLon, newLat, newLon) / dt
                obj.speedSampleLat = newLat
                obj.speedSampleLon = newLon
                obj.speedSampleTime = currentTime
              }
            }
          }
          continue
        }
        if (prop.key === 'Type') {
          obj.category = classify(prop.value)
          continue
        }
        const coerced = coercePropValue(prop.key, prop.value)
        if (coerced !== undefined) obj.props[prop.key] = coerced
      }

      if (obj.category === 'bullseye') {
        const t = obj.tParts
        if (t && t[0] !== null && t[1] !== null) {
          const coalition = bullseyeColorName(obj.props.Color)
          bullseyes[coalition] = { coalition, latitude: refLat + t[1], longitude: refLon + t[0] }
        }
        continue
      }

      if (!obj.category) continue

      const unitID = parseInt(rawId, 16) + UNIT_ID_OFFSET
      const canonical = buildCanonicalUnit(obj, unitID)
      if (canonical.position) positions.push(canonical.position)
      updated[String(unitID)] = canonical
      obj.emitted = true
    }

    const hasBullseyes = Object.keys(bullseyes).length > 0
    return { updated, removed, bullseyes: hasBullseyes ? { bullseyes: { ...bullseyes } } : null, positions }
  }

  function getCurrentMissionUtcMs() {
    return referenceTimeMs === null ? null : referenceTimeMs + currentTime * 1000
  }

  return { parseLines, getCurrentMissionUtcMs }
}

// Standard CRC-32 (IEEE 802.3 / zlib polynomial 0xEDB88320, reflected,
// init/xorout 0xFFFFFFFF) — NOT the CRC-64/WE the current public RTT
// protocol docs describe. Confirmed live, 2026-09-06, against a real DCS
// dedicated server with an RTT password set: CRC-64/WE (in every hex-string
// framing tried: padded/unpadded, upper/lower, 0x-prefixed, decimal) was
// rejected every time, while plain 32-bit CRC-32 of the UTF-16LE password
// text, lowercase hex, was accepted immediately. This matches an
// independently-found community note that DCS's bundled Tacview exporter
// ("DCS2ACMI") still uses the older 32-bit CRC scheme Tacview's own
// documentation says it falls back to for legacy exporters — the public
// docs describe the *current* protocol, not what this exporter actually
// implements. See custom-datasource-tacview-spec.md §1 for the full story.
function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : (crc >>> 1)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// Handshake password line — CRC-32 of the UTF-16 password text, or of the
// UTF-16 string "0" when no password is set (mirroring the documented "hash
// the UTF-16 string 0" convention for the no-password case, just with the
// actually-correct algorithm). Hex-encoded, lowercase, zero-padded to 8
// digits — confirmed accepted live; uppercase of the identical value was
// confirmed REJECTED in the same test, so case is load-bearing, not cosmetic.
function hashPassword(password) {
  return crc32(Buffer.from(password || '0', 'utf16le')).toString(16).padStart(8, '0')
}

// Client handshake per §1 — three lines + password-hash line + null
// terminator.
function buildClientHandshake(clientName, password = '') {
  return `XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\n${clientName}\n${hashPassword(password)}\0`
}

module.exports = { createParser, buildClientHandshake, UNIT_ID_OFFSET }
