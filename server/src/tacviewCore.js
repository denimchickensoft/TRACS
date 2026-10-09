'use strict'

// ACMI (Tacview Real-Time Telemetry) parsing/mapping core, used by
// server/src/tacview.js (direct-mode connection). Pure parsing/mapping, no
// socket I/O.
//
// relay/tacview.js (the relay-hosted connection mode) needs the identical
// parsing logic, but relay/ is a genuinely standalone-packaged app (its own
// package.json, no cross-directory requires anywhere in it) — so it can't
// require this file directly without breaking standalone deployment, and
// can't join this repo's npm workspaces (packages/geo-math's mechanism)
// without losing that same standalone-copy-anywhere deployment story.
// relay/tacviewCore.js is instead a generated, verbatim copy of this file —
// this file is canonical. After editing it, run `npm run sync:tacview-core`
// (see scripts/sync-tacview-core.js); `npm run check:tacview-core` (wired
// into `npm run lint`) fails if the two have drifted apart. This mirrors the
// project's existing posture for transponders.js/srs.js, which also produce
// a parallel shape without sharing a literal file.
//
// Detection/fog-of-war is handled separately, in tacviewDetection.js.

// unitId = tacviewObjectId + 0xFFFFFF — confirmed live against 34 real
// aircraft. Normalizing here
// means server/src/srs.js's existing merge-by-unitId logic works unchanged
// for Tacview-sourced units — no new SRS-correlation code needed anywhere.
const UNIT_ID_OFFSET = 0xFFFFFF

// Confirmed absolute-ish coalition value (map from Color,
// not the viewer-relative Coalition property). Anything not Blue/Red is
// treated as neutral (0) — the official Color enum doesn't even list `Grey`,
// which DCS uses for neutral in practice, so unknown values must not error.
const COLOR_TO_COALITION = { Blue: 2, Red: 1 }

// T= syntax field maps — index into a fixed 9-slot
// [lon, lat, alt, roll, pitch, yaw, u, v, heading] array. Which map applies
// is inferred from how many pipe-separated segments a given line's T= value
// has (confirmed consistent per-object for its lifetime).
const SYNTAX_SLOTS = {
  3: [0, 1, 2],
  5: [0, 1, 2, 6, 7],
  6: [0, 1, 2, 3, 4, 5],
  9: [0, 1, 2, 3, 4, 5, 6, 7, 8],
}

const NUMERIC_PROPS = new Set(['AGL', 'Health', 'IAS', 'CAS', 'TAS', 'HDM', 'Importance'])

// ACMI wire headings (T= trailing Heading / HDM / raw yaw) are degrees, but
// unit.heading is contractually radians everywhere else in the app —
// decoder.js's DI.heading reads DCS's native getHeading() (radians), and
// every client consumer (StatusBoard.jsx, CatccScope.jsx, Deck.jsx, Par.jsx,
// utils/bearing.js's documented contract) converts assuming radians.
const DEG_TO_RAD = Math.PI / 180

const HEX_ID_RE = /^[0-9a-fA-F]+$/

const EARTH_RADIUS_M = 6371008.8

// Great-circle distance (metres) between two ABSOLUTE lat/lng pairs (not
// tParts-space reference-relative deltas — see call site). The reference
// offset cancels in the dLat/dLon difference terms, but the haversine
// formula's cos(lat1)*cos(lat2) weighting term needs the true latitude: it
// corrects the longitude term for how far the point is from the equator.
// Feeding it a near-zero delta instead of the real latitude makes cos(lat)
// read as ~1 regardless of theatre, inflating any east/west distance
// component by ~1/cos(actualLat) — seen live as a Tacview groundspeed
// reading ~17% high (610kt vs Olympus's 520kt on the same
// aircraft) at a ~30-35°N theatre.
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
  // Static scenery (Building/Aerodrome/etc.) — confirmed present but not
  // consumed by any current TRACS feature from either source.
  if (tags.includes('Static')) return null
  if (tags.includes('Air')) return tags.includes('Rotorcraft') ? 'Helicopter' : 'Aircraft'
  if (tags.includes('Ground')) return 'GroundUnit'
  if (tags.includes('Sea')) return 'NavyUnit'
  // Confirmed against a real DCS export (not just the documented ACMI
  // taxonomy): a fired missile's Type is exactly "Weapon+Missile". Bombs/
  // shells (Weapon+Bomb, etc.) are deliberately excluded — only missiles are
  // tracked (AIC/ABM missile display). This still flows
  // through the same `updated` map as every other category below — callers
  // that need to treat missiles differently (tacview.js) split them out by
  // category afterward, same way olympus.js's pollWeapons() does.
  if (tags.includes('Weapon') && tags.includes('Missile')) return 'Missile'
  return null // Weapon+Bomb/Weapon+Shell/Sensor/Misc/non-bullseye Navaid — not tracked
}

// ACMI properties are comma-separated; text values may contain
// backslash-escaped commas (e.g. `Briefing=Text\, more text`), so split only
// on unescaped commas.
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

// Minimum ACMI stream time (seconds, per the `#<offset>` frame markers, NOT
// wall-clock) between two position samples before groundspeed is recomputed.
// Using stream time rather than Date.now() is load-bearing, not cosmetic —
// multiple ACMI frames can arrive in a single TCP chunk (network/processing
// jitter), which would otherwise timestamp two real, seconds-apart position
// samples only milliseconds apart by wall-clock and divide by a near-zero
// delta, producing wildly inflated speeds (confirmed live).
// 3s rather than 1s: at 1s, a steady real aircraft's displayed
// speed visibly hovered between two adjacent tens-of-knots values — the
// window's actual length varies (~1.0-1.1s, tied to the ~9Hz frame cadence,
// not exactly 1.000s), and real flight isn't perfectly constant at that
// timescale (physics-tick numerics, autopilot/trim micro-corrections), so a
// short window is sensitive to a beat/aliasing pattern against that
// micro-variation. A longer window averages more of it out, the same role a
// real instrument's needle damping plays — trades responsiveness (the
// computed value itself only changes roughly every 3s now, though it still
// gets rebroadcast at the existing ~1Hz cadence in between) for a steadier
// displayed value.
const SPEED_SAMPLE_INTERVAL_S = 3

// ≈100ft — matches abmScopeHelpers.js's AGL_FLOOR_M, the existing
// ground-contact-suppression threshold. Used to derive `airborne` (see
// buildCanonicalUnit) since Tacview has no OnGround-equivalent signal.
const AIRBORNE_AGL_THRESHOLD_M = 30

// One parser instance per live connection — holds per-object delta/frame
// state (ACMI lines only carry properties changed since that object's last
// frame) and the global reference-point offset.
function createParser() {
  const objects = new Map() // rawHexId → { tParts, props, category, emitted }
  let refLon = 0
  let refLat = 0
  let currentTime = 0 // most recent `#<offset>` frame marker — ACMI's own relative clock
  // The mission's actual simulated date/time (UTC — confirmed by the real
  // wire's trailing 'Z', e.g. "2011-06-25T09:30:01Z"), NOT RecordingTime
  // (real-world wall-clock time the connection happened, unrelated). Set
  // once from the global object; `currentTime` seconds past it gives the
  // live current mission moment — see getCurrentMissionUtcMs().
  let referenceTimeMs = null
  const bullseyes = {} // 'blue' | 'red' | 'neutral' → { coalition, latitude, longitude }

  function updateTParts(obj, rawT) {
    const segs = rawT.split('|')
    const slots = SYNTAX_SLOTS[segs.length] ?? SYNTAX_SLOTS[9]
    if (!obj.tParts) obj.tParts = new Array(9).fill(null)
    segs.forEach((seg, i) => {
      if (seg === '') return // unchanged — keep prior value
      const slot = slots[i]
      if (slot === undefined) return
      const n = parseFloat(seg)
      if (!Number.isNaN(n)) obj.tParts[slot] = n
    })
  }

  // unitID: an INLINE property on the unit object, separate from the outer
  // map key — Olympus's decoder.js sets both (decoder.js:236), and real
  // client code reads unit.unitID directly (ABM's AddAtoFlight.jsx/Ato.jsx/
  // Frag.jsx carrier correlation, STARS' formations.js tiebreaker); without
  // it, carrier/ATO correlation silently breaks for every Tacview-sourced
  // unit. Keep this field-for-field in step with Olympus's decoder.
  //
  // id: the unit's key in the units map, as on an Olympus unit. Client code
  // looks per-track state up by unit.id (callsign overrides from .rename,
  // the unit-ID callsign fallback). An ACMI object has only one ID, so id and
  // unitID hold the same number here. id makes no claim that it matches
  // DCS's own unit ID.
  function buildCanonicalUnit(obj, unitID) {
    const unit = { id: unitID, unitID }
    const p = obj.props
    if (p.Name !== undefined) unit.name = p.Name
    if (p.Pilot !== undefined) unit.unitName = p.Pilot
    if (p.CallSign !== undefined) unit.callsign = p.CallSign
    // `Group` is free text (e.g. "Iran Mig-29 1"), not a numeric ID — real
    // captured evidence confirms flight-mates DO share the same string,
    // so it correctly identifies
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
      // Olympus's `airborne` is a genuine boolean DCS reports directly
      // (decoder.js:289) — never set here at all, which silently broke
      // ABM's Ato.jsx/Frag.jsx status column (`lu.airborne ? 'AIR' :
      // groundState(...)`, always falling through to groundState() for
      // every Tacview unit, which only distinguishes TAXI/GROUND by speed —
      // a fast airborne jet reads as "moving fast on the ground" = TAXI).
      // ACMI's documented `OnGround` property would be the direct
      // equivalent, but — same pattern as `Squawk`/`Registration`/
      // `CallSign` — DCS's exporter doesn't populate it (zero occurrences
      // in the real capture), so this derives it from AGL instead, same
      // threshold already used for ground-contact suppression elsewhere
      // (abmScopeHelpers.js's AGL_FLOOR_M).
      unit.airborne = p.AGL > AIRBORNE_AGL_THRESHOLD_M
    }
    if (p.Health !== undefined) unit.health = p.Health
    // `unit.speed` is contractually metres/second, matching Olympus (see
    // client/src/modules/atc/stars/DatablockOverlay.jsx's fmtSpd(mps) and its
    // M_PER_S_TO_KNOTS conversion) — NOT knots. An earlier version of this
    // stored knots directly, which fmtSpd then converted *again*, inflating
    // the displayed speed by ~1.94x (a real 474kt aircraft displayed near
    // STARS' 990kt display cap).
    if (obj.groundSpeedMps !== undefined) unit.speed = obj.groundSpeedMps
    if (obj.category) unit.category = obj.category

    const t = obj.tParts
    if (t && t[0] !== null && t[1] !== null) {
      unit.position = { lat: refLat + t[1], lng: refLon + t[0], alt: t[2] ?? 0 }
    }
    // Which heading field DCS's exporter populates isn't fully pinned down —
    // prefer the T= trailing Heading field (Syntax #4), fall back
    // to HDM, then raw yaw as a last resort. Converted to radians here (see
    // DEG_TO_RAD) to match unit.heading's app-wide contract.
    const heading = t?.[8] ?? (p.HDM !== undefined ? p.HDM : t?.[5])
    if (heading !== undefined && heading !== null) unit.heading = heading * DEG_TO_RAD
    // Pitch (nose up/down, degrees) — needed by tacviewDetection.js's
    // elevation scan-volume check. Unlike cockpit-instrument fields
    // (IAS/AoA/wind/fuel, confirmed restricted to the connecting client's
    // own aircraft), pitch/roll are part of the object transform every ACMI
    // recording must carry for every object to render correctly in replay —
    // confirmed populated for many distinct AI aircraft simultaneously in a
    // real capture (resources/tacview-stream.txt), not just one.
    if (t?.[4] !== undefined && t[4] !== null) unit.pitch = t[4]

    return unit
  }

  function bullseyeColorName(color) {
    const c = COLOR_TO_COALITION[color]
    if (c === 2) return 'blue'
    if (c === 1) return 'red'
    return 'neutral'
  }

  // Parses one chunk of raw ACMI text (may contain any number of complete or
  // partial lines — callers are expected to buffer until a newline boundary;
  // see tacview.js's line-buffering wrapper). Returns:
  //   updated    — { [unitId]: partialUnit } for state.js's applyDelta
  //   removed    — [unitId, ...]
  //   bullseyes  — { bullseyes: {...} } (Login.jsx/AicScope.jsx shape) or null
  //   positions  — [{lat,lng}, ...] every real unit position seen this chunk,
  //                for theatre bbox-vote sampling (tacview.js's job to use)
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
      if (!HEX_ID_RE.test(rawId)) continue // header lines (FileType=/FileVersion=) etc.
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
          // belongs to the DCS client hosting the export, an arbitrary
          // aircraft from a
          // controller's perspective, and using it just for that one aircraft
          // while deriving for everyone else would be an inconsistent
          // "airspeed vs. groundspeed" mix on the same field. Matches
          // Olympus's own `speed` field, which is always groundspeed for
          // every unit.
          //
          // Sampled over SPEED_SAMPLE_INTERVAL_S of ACMI stream time (not
          // wall-clock — see that constant's comment for why), not every
          // frame: the reference sample only advances once that much time
          // has actually elapsed, so `groundSpeedMps` holds its last value
          // in between rather than recomputing on every delta line.
          //
          // If an object stops moving enough for ACMI to stop emitting `T`
          // updates for it at all (e.g. parked, no further deltas), this
          // branch never re-fires and `groundSpeedMps` freezes forever at
          // its last real in-motion value instead of decaying to 0 —
          // confirmed live: a parked aircraft held a stale
          // ~2.0 m/s reading. Downstream consumers of `unit.speed` (e.g.
          // ASDE-X's PTL) can't treat "nonzero" as proof of current motion
          // when the source is Tacview.
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
                // distanceM needs absolute lat/lng, not the raw reference-relative
                // deltas stored in speedSampleLat/Lon and newLat/Lon — see distanceM's
                // comment.
                if (dt > 0) {
                  obj.groundSpeedMps = distanceM(
                    refLat + obj.speedSampleLat, refLon + obj.speedSampleLon,
                    refLat + newLat, refLon + newLon,
                  ) / dt
                }
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

      if (!obj.category) continue // weapon/sensor/static/etc. — not a tracked unit

      const unitID = parseInt(rawId, 16) + UNIT_ID_OFFSET
      const canonical = buildCanonicalUnit(obj, unitID)
      if (canonical.position) positions.push(canonical.position)
      updated[String(unitID)] = canonical
      obj.emitted = true
    }

    const hasBullseyes = Object.keys(bullseyes).length > 0
    return { updated, removed, bullseyes: hasBullseyes ? { bullseyes: { ...bullseyes } } : null, positions }
  }

  // The mission's live current simulated UTC moment (ms since epoch), or
  // null if the wire hasn't sent a ReferenceTime yet (or ever — some
  // exporters might omit it, though real DCS captures have always
  // included it). tacview.js calls this once, at theatre-finalization time,
  // to synthesize the dateAndTime payload Login.jsx/useMissionClock expect.
  function getCurrentMissionUtcMs() {
    return referenceTimeMs === null ? null : referenceTimeMs + currentTime * 1000
  }

  return { parseLines, getCurrentMissionUtcMs }
}

// Standard CRC-32 (IEEE 802.3 / zlib polynomial 0xEDB88320, reflected,
// init/xorout 0xFFFFFFFF) — NOT the CRC-64/WE the current public RTT
// protocol docs describe. Confirmed live against a real DCS
// dedicated server with an RTT password set: CRC-64/WE (in every hex-string
// framing tried: padded/unpadded, upper/lower, 0x-prefixed, decimal) was
// rejected every time, while plain 32-bit CRC-32 of the UTF-16LE password
// text, lowercase hex, was accepted immediately. This matches an
// independently-found community note that DCS's bundled Tacview exporter
// ("DCS2ACMI") still uses the older 32-bit CRC scheme Tacview's own
// documentation says it falls back to for legacy exporters — the public
// docs describe the *current* protocol, not what this exporter actually
// implements.
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

// Client handshake — three lines + password-hash line + null
// terminator.
function buildClientHandshake(clientName, password = '') {
  return `XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\n${clientName}\n${hashPassword(password)}\0`
}

module.exports = { createParser, buildClientHandshake, UNIT_ID_OFFSET }
