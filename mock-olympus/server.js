'use strict'

/**
 * Mock Olympus REST API server for TRACS development and testing.
 *
 * Simulates the three endpoints TRACS polls:
 *   GET /olympus/units?time=<ms>
 *   GET /olympus/mission
 *   GET /olympus/airbases
 *
 * Units move on each poll so you can verify the delta pipeline end-to-end.
 *
 * Usage:
 *   node mock-olympus/server.js
 *
 * Then connect TRACS to: http://localhost:4000
 * Any password is accepted.
 */

const http = require('http')

const PORT = 4000

// ─── World state ─────────────────────────────────────────────────────────────

// Caucasus theater, rough center
const THEATER_CENTER = { lat: 42.35, lon: 43.32 }
const NM_TO_DEG = 1 / 60  // 1 nautical mile ≈ 1/60 degree lat

// Starting unit definitions
const unitDefs = [
  // Blue friendlies
  { id: '1', name: 'Enfield 1-1', type: 'F-16C_50',  coalition: 2, lat: 42.50, lon: 43.10, alt: 20000, hdg: 270, spd: 420, contacts: [] },
  { id: '2', name: 'Enfield 1-2', type: 'F-16C_50',  coalition: 2, lat: 42.48, lon: 43.15, alt: 19500, hdg: 270, spd: 410, contacts: [] },
  { id: '3', name: 'Chevy 2-1',   type: 'F-15C',     coalition: 2, lat: 42.60, lon: 43.40, alt: 25000, hdg: 090, spd: 480, contacts: ['4', '5'] },
  { id: '4', name: 'MAGIC',       type: 'E-3A',       coalition: 2, lat: 42.35, lon: 43.20, alt: 30000, hdg: 180, spd: 340, contacts: [] },
  // Red — only visible if in a blue unit's contacts array
  { id: '5', name: 'Bandit 01',   type: 'MiG-29A',    coalition: 1, lat: 42.70, lon: 43.80, alt: 15000, hdg: 210, spd: 500, contacts: [] },
  { id: '6', name: 'Bandit 02',   type: 'MiG-29A',    coalition: 1, lat: 42.72, lon: 43.85, alt: 14500, hdg: 210, spd: 490, contacts: [] },
]

// Mutable runtime state — units move each poll
const units = new Map(unitDefs.map((u) => [u.id, { ...u }]))

// Track which unit IDs the client already has (keyed by "client token" from time param)
// In real Olympus, time=0 means full snapshot; time>0 means delta since that time.
let serverTime = Date.now()

function moveUnits() {
  const elapsed = 1  // simulate 1 second of movement per poll tick

  for (const unit of units.values()) {
    const hdgRad = (unit.hdg * Math.PI) / 180
    const distDeg = (unit.spd / 3600) * elapsed * NM_TO_DEG  // knots → nm/s → degrees
    unit.lat += Math.cos(hdgRad) * distDeg
    unit.lon += Math.sin(hdgRad) * distDeg

    // Gentle heading drift so units don't fly off screen
    unit.hdg = (unit.hdg + (Math.random() - 0.5) * 2 + 360) % 360
  }

  serverTime = Date.now()
}

// ─── Request helpers ──────────────────────────────────────────────────────────

function checkAuth(req, res) {
  const auth = req.headers['authorization'] ?? ''
  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Olympus"' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return false
  }
  // Accept any password — this is a mock
  return true
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleUnits(req, res, query) {
  const clientTime = parseInt(query.get('time') ?? '0', 10)
  moveUnits()

  // If client time is 0 or very old, send all units as a full snapshot.
  // Otherwise send all (mock doesn't track per-client deltas; simplification).
  const updated = Object.fromEntries(
    [...units.values()].map((u) => [
      u.id,
      {
        id: u.id,
        name: u.name,
        type: u.type,
        coalition: u.coalition,
        lat: u.lat,
        lon: u.lon,
        altitude: u.alt,
        heading: u.hdg,
        speed: u.spd,
        contacts: u.contacts.map((cid) => ({
          id: cid,
          // detection method 4 = RADAR
          detectionMethod: 4,
        })),
      },
    ])
  )

  json(res, { updated, removed: [], time: serverTime })
}

function handleMission(req, res) {
  json(res, {
    theater: 'Caucasus',
    commandMode: 'GAME_MASTER',
    bullseyes: [
      {
        coalition: 2,
        name: 'BULLSEYE',
        lat: THEATER_CENTER.lat,
        lon: THEATER_CENTER.lon,
      },
    ],
    time: serverTime,
  })
}

function handleAirbases(req, res) {
  json(res, [
    { id: 'UGKO', name: 'Kutaisi',    coalition: 2, lat: 42.177, lon: 42.482, elevation: 146 },
    { id: 'UGSS', name: 'Senaki',     coalition: 2, lat: 42.240, lon: 42.067, elevation: 42  },
    { id: 'UGSB', name: 'Batumi',     coalition: 2, lat: 41.610, lon: 41.600, elevation: 32  },
    { id: 'URMM', name: 'Mineralnye', coalition: 1, lat: 44.224, lon: 43.082, elevation: 459 },
  ])
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const query = url.searchParams

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization' })
    res.end()
    return
  }

  if (!checkAuth(req, res)) return

  if (path === '/olympus/units')    return handleUnits(req, res, query)
  if (path === '/olympus/mission')  return handleMission(req, res)
  if (path === '/olympus/airbases') return handleAirbases(req, res)

  json(res, { error: 'Not found' }, 404)
})

server.listen(PORT, () => {
  console.log(`Mock Olympus server running on http://localhost:${PORT}`)
  console.log(`  Units:    http://localhost:${PORT}/olympus/units`)
  console.log(`  Mission:  http://localhost:${PORT}/olympus/mission`)
  console.log(`  Airbases: http://localhost:${PORT}/olympus/airbases`)
  console.log()
  console.log(`Connect TRACS to: http://localhost:${PORT}`)
  console.log(`Any password is accepted.`)
})
