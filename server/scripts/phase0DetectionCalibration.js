'use strict'

// Phase 0 live-calibration capture for tacviewDetection.js (see
// resources/specs/tacview-detection-spec.md, "What's NOT done yet"). This
// script does NOT exercise the synthetic Tacview detection model at all —
// that model never runs against an Olympus-sourced session. The point is the
// opposite: poll a live, Olympus-connected TRACS server's GET /api/debug
// (real DCS Controller:getDetectedTargets() contacts[], ground truth) while
// units spawn/maneuver in and out of various detectors' ranges, and log
// range/bearing/elevation alongside the real detected/not outcome for every
// cross-coalition pair — so the logged data can be compared, offline,
// against this module's cone angles, sensor ranges, and rwr.rangeMultiplier
// to see how close the synthetic model's assumptions are to DCS's real
// engine behavior.
//
// Usage:
//   node scripts/phase0DetectionCalibration.js
//     [--host=http://localhost:3000] [--interval=1500] [--out=calibration.jsonl]
//     [--maxRangeNm=300]
//
// Tracks EVERY cross-coalition (viewer, subject) pair with a known position
// and within --maxRangeNm (default 300nm, comfortably past any sensor range
// this project's synthetic model uses) automatically — no need to name units
// up front, since a real session has many detectors and targets moving at
// once. Every in-range pair's full geometry is appended to the JSONL log
// every tick regardless of outcome (for offline analysis); the console only
// prints a line when a pair's real radar/RWR detection status changes
// (rises or falls), to stay readable across dozens of simultaneous pairs
// over a long session.
//
// IMPORTANT — correlation id: contacts[].ID refers to a unit's `id` field
// (the real DCS object id / state.js Map key), NOT its `unitID` field.
// Confirmed against a live Olympus session 2026-09-08: `unitID` (e.g. 70001)
// is a separate, Olympus-assigned sequential number that never appears
// inside any contacts[] entry — `id` (e.g. 16778752) is the one that does.
// Both fields are present on every unit returned by /api/debug.

const fs = require('fs')

function parseArgs(argv) {
  const args = {}
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m) args[m[1]] = m[2]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const HOST = args.host ?? 'http://localhost:3000'
const INTERVAL_MS = args.interval ? parseInt(args.interval, 10) : 1500
const OUT_PATH = args.out ?? `calibration-${Date.now()}.jsonl`
const MAX_RANGE_NM = args.maxRangeNm ? parseFloat(args.maxRangeNm) : 300

const DETECTION_RADAR = 4
const DETECTION_RWR = 16
const METERS_PER_NM = 1852
const EARTH_RADIUS_NM = 3440.065

function toRad(deg) { return (deg * Math.PI) / 180 }
function toDeg(rad) { return (rad * 180) / Math.PI }

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

// Signed difference b - a in degrees, normalized to (-180, 180].
function signedAngleDiff(a, b) {
  return (((b - a + 540) % 360) + 360) % 360 - 180
}

function label(u) {
  return u.callsign || u.unitName || u.name || `#${u.id}`
}

// Range/bearing/elevation geometry from `viewer`'s perspective looking at
// `subject`, plus whether viewer's real contacts[] (ground truth from DCS)
// already reports subject as detected, radar and RWR bits checked separately.
function computeLeg(viewer, subject, rangeNm) {
  const bearing = bearingDeg(viewer.position, subject.position)
  const relBearingDeg = viewer.heading !== undefined ? signedAngleDiff(viewer.heading, bearing) : null
  const groundRangeM = rangeNm * METERS_PER_NM
  const altDeltaM = (subject.position.alt ?? 0) - (viewer.position.alt ?? 0)
  const elevationDeg = toDeg(Math.atan2(altDeltaM, groundRangeM))
  const relElevationDeg = viewer.pitch !== undefined ? signedAngleDiff(viewer.pitch, elevationDeg) : null

  const contacts = viewer.contacts ?? []
  const hit = contacts.find((c) => Number(c.ID) === Number(subject.id))
  const radar = !!hit && (hit.detectionMethod & DETECTION_RADAR) !== 0
  const rwr = !!hit && (hit.detectionMethod & DETECTION_RWR) !== 0

  return { bearingDeg: bearing, relBearingDeg, elevationDeg, relElevationDeg, radar, rwr }
}

// pairId -> last known { radar, rwr } for change-detection between ticks.
const lastState = new Map()

const fmt = (v, digits = 1) => (v === null || v === undefined ? 'n/a' : v.toFixed(digits))

async function tick(out) {
  let debug
  try {
    const res = await fetch(`${HOST}/api/debug`)
    debug = await res.json()
  } catch (err) {
    console.error(`[fetch error] ${err.message}`)
    return
  }

  const units = debug.units.filter((u) => u.position && u.coalition !== undefined && u.category)
  const t = new Date().toISOString()
  let loggedCount = 0

  for (const viewer of units) {
    for (const subject of units) {
      if (viewer.id === subject.id) continue
      if (viewer.coalition === subject.coalition) continue

      const rangeNm = distanceNm(viewer.position, subject.position)
      if (rangeNm > MAX_RANGE_NM) continue

      const leg = computeLeg(viewer, subject, rangeNm)
      loggedCount++

      const row = {
        t,
        viewer: { id: viewer.id, name: viewer.name, label: label(viewer), category: viewer.category, position: viewer.position, heading: viewer.heading, pitch: viewer.pitch, acquisitionRange: viewer.acquisitionRange },
        subject: { id: subject.id, name: subject.name, label: label(subject), category: subject.category, position: subject.position },
        rangeNm,
        ...leg,
      }
      out.write(JSON.stringify(row) + '\n')

      const pairId = `${viewer.id}->${subject.id}`
      const prev = lastState.get(pairId)
      // On the pair's first-ever observation there is no prior state to
      // transition from, so label it a plain baseline ("on"/"off") rather
      // than a spurious ACQUIRED/LOST — only announce that baseline at all
      // if something is already actively detected, otherwise a
      // never-been-in-range pair would print noise the instant it first
      // comes within --maxRangeNm.
      const isNew = !prev
      const changed = prev && (prev.radar !== leg.radar || prev.rwr !== leg.rwr)
      if (changed || (isNew && (leg.radar || leg.rwr))) {
        const arrow = (was, now) => {
          if (isNew) return now ? 'on' : 'off'
          return was === now ? (now ? 'on' : 'off') : now ? 'ACQUIRED' : 'LOST'
        }
        console.log(
          `[${t}] ${label(viewer)} (${viewer.category}) -> ${label(subject)} (${subject.category})  ` +
          `range=${fmt(rangeNm)}nm az=${fmt(leg.relBearingDeg)} el=${fmt(leg.relElevationDeg)}  ` +
          `radar:${arrow(prev?.radar, leg.radar)} rwr:${arrow(prev?.rwr, leg.rwr)}`
        )
      }
      lastState.set(pairId, { radar: leg.radar, rwr: leg.rwr })
    }
  }

  if (loggedCount === 0) console.log(`[${t}] no cross-coalition pairs within ${MAX_RANGE_NM}nm`)
}

async function main() {
  const out = fs.createWriteStream(OUT_PATH, { flags: 'a' })
  out.on('error', (err) => {
    console.error(`[fatal] cannot write to ${OUT_PATH}: ${err.message}`)
    process.exit(1)
  })
  console.log(`Polling ${HOST}/api/debug every ${INTERVAL_MS}ms, tracking all cross-coalition pairs within ${MAX_RANGE_NM}nm`)
  console.log(`Logging every in-range pair to ${OUT_PATH} (JSON Lines) each tick; console prints only on radar/RWR status changes. Ctrl+C to stop.`)
  while (true) {
    await tick(out)
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }
}

main()
