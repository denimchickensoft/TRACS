'use strict'

/**
 * Mock Olympus REST API server for TRACS development and testing.
 *
 * /olympus/units    — binary format decoded by server/src/decoder.js
 * /olympus/mission  — JSON
 * /olympus/airbases — JSON
 *
 * Usage:
 *   node mock-olympus/server.js
 * Then connect TRACS to: http://localhost:4000  (any password accepted)
 */

const http = require('http')

const PORT = 4000

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOTS_TO_MS = 0.514444
const NM_DEG = 1 / 60          // 1 nm ≈ 1/60 degree latitude
const NM_PER_SEC = 1 / 3600    // knots → nm/s (speed × this)

// DataIndex enum — must match server/src/decoder.js
const DI = {
  category:  1,
  alive:     2,
  coalition: 7,
  name:      9,
  unitName:  10,
  position:  18,
  speed:     19,
  heading:   22,
  track:     23,
  contacts:  44,
  airborne:  65,
  endOfData: 255,
}

// ─── World state ──────────────────────────────────────────────────────────────

// Caucasus theater — Blue coalition = 2, Red = 1
// hdg: radians, DCS convention (0 = North, clockwise)
// spd: knots (converted to m/s on encode)
// contacts[].ID: uint32, contacts[].detectionMethod: bitmask (bit 4 = 16 = RADAR)
const unitDefs = [
  {
    id: 1, unitName: 'Enfield 1-1', name: 'F-16C_50', category: 'Aircraft',
    coalition: 2, lat: 42.50, lng: 43.10, alt: 6096,
    hdg: Math.PI * 1.5, spd: 420, contacts: [],
  },
  {
    id: 2, unitName: 'Enfield 1-2', name: 'F-16C_50', category: 'Aircraft',
    coalition: 2, lat: 42.48, lng: 43.15, alt: 5944,
    hdg: Math.PI * 1.5, spd: 410, contacts: [],
  },
  {
    id: 3, unitName: 'Chevy 2-1', name: 'F-15C', category: 'Aircraft',
    coalition: 2, lat: 42.60, lng: 43.40, alt: 7620,
    hdg: Math.PI / 2, spd: 480,
    contacts: [
      { ID: 5, detectionMethod: 16 },
      { ID: 6, detectionMethod: 16 },
    ],
  },
  {
    id: 4, unitName: 'MAGIC', name: 'E-3A', category: 'Aircraft',
    coalition: 2, lat: 42.35, lng: 43.20, alt: 9144,
    hdg: Math.PI, spd: 340, contacts: [],
  },
  // Red — only visible because unit 3 has them in its contacts (RADAR detection)
  {
    id: 5, unitName: 'Bandit 01', name: 'MiG-29A', category: 'Aircraft',
    coalition: 1, lat: 42.70, lng: 43.80, alt: 4572,
    hdg: Math.PI * 1.17, spd: 500, contacts: [],
  },
  {
    id: 6, unitName: 'Bandit 02', name: 'MiG-29A', category: 'Aircraft',
    coalition: 1, lat: 42.72, lng: 43.85, alt: 4420,
    hdg: Math.PI * 1.17, spd: 490, contacts: [],
  },

  // ── Carrier group — Black Sea, ~50nm west of Batumi, heading north ────────
  // Carrier is a NavyUnit so it appears in CATCC carrier selection but not on air scopes
  {
    id: 7, unitName: 'STENNIS', name: 'CVN_74', category: 'NavyUnit',
    coalition: 2, lat: 41.50, lng: 40.50, alt: 0,
    hdg: 0, spd: 30, contacts: [],
  },
  // 15nm south on approach, heading north
  {
    id: 8, unitName: 'Tomcat 101', name: 'F-14B', category: 'Aircraft',
    coalition: 2, lat: 41.25, lng: 40.50, alt: 762,
    hdg: 0, spd: 180, contacts: [],
  },
  // 8nm north, heading south
  {
    id: 9, unitName: 'Tomcat 102', name: 'F-14B', category: 'Aircraft',
    coalition: 2, lat: 41.63, lng: 40.50, alt: 1524,
    hdg: Math.PI, spd: 220, contacts: [],
  },
  // 20nm east, heading west
  {
    id: 10, unitName: 'Hornet 201', name: 'FA-18C_hornet', category: 'Aircraft',
    coalition: 2, lat: 41.50, lng: 40.94, alt: 3658,
    hdg: Math.PI * 1.5, spd: 350, contacts: [],
  },
  // E-2 Hawkeye, 25nm west in orbit
  {
    id: 11, unitName: 'HAWKEYE', name: 'E-2C', category: 'Aircraft',
    coalition: 2, lat: 41.55, lng: 39.94, alt: 7620,
    hdg: Math.PI / 2, spd: 270, contacts: [],
  },
]

const units = new Map(unitDefs.map((u) => [u.id, { ...u, contacts: [...u.contacts] }]))
let serverTime  = BigInt(Date.now())
let lastMovedAt = Date.now()

// Carrier turn cycle: 5 min straight → 180° left turn at 1°/s → repeat
const CARRIER_STRAIGHT_S = 300   // seconds straight
const CARRIER_TURN_S     = 180   // 180° / 1°/s
const CARRIER_CYCLE_S    = CARRIER_STRAIGHT_S + CARRIER_TURN_S
const DEG_TO_RAD         = Math.PI / 180

function moveUnits() {
  const now     = Date.now()
  const dt      = Math.min((now - lastMovedAt) / 1000, 1.0)  // seconds, capped at 1s
  lastMovedAt   = now
  const elapsed = (now - serverStartWallMs) / 1000

  for (const unit of units.values()) {
    const distDeg = unit.spd * dt * NM_PER_SEC * NM_DEG
    unit.lat += Math.cos(unit.hdg) * distDeg
    unit.lng += Math.sin(unit.hdg) * distDeg

    if (unit.category === 'NavyUnit') {
      // 5-min straight, then 180° left turn at 1°/s, repeat
      const phase = elapsed % CARRIER_CYCLE_S
      if (phase >= CARRIER_STRAIGHT_S) {
        unit.hdg = ((unit.hdg - 1 * DEG_TO_RAD * dt) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
      }
    } else {
      // Gentle random heading drift for non-carrier units
      unit.hdg = (unit.hdg + (Math.random() - 0.5) * 0.02 + Math.PI * 2) % (Math.PI * 2)
    }
  }

  serverTime = BigInt(now)
}

// ─── Binary encoder ───────────────────────────────────────────────────────────

class Writer {
  constructor() { this.chunks = [] }

  uint8(v)   { const b = Buffer.alloc(1); b.writeUInt8(v & 0xFF); this.chunks.push(b) }
  uint16(v)  { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0); this.chunks.push(b) }
  uint32(v)  { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.chunks.push(b) }
  uint64(v)  { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.chunks.push(b) }
  float64(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.chunks.push(b) }
  bool(v)    { this.uint8(v ? 1 : 0) }

  string(s) {
    const enc = Buffer.from(s, 'utf-8')
    this.uint16(enc.length)
    this.chunks.push(enc)
  }

  coords(lat, lng, alt) {
    this.float64(lat)
    this.float64(lng)
    this.float64(alt)
    this.float64(0)  // threshold — internal to Olympus, always 0
  }

  contactVector(contacts) {
    this.uint16(contacts.length)
    for (const c of contacts) {
      this.uint32(c.ID)
      this.uint8(c.detectionMethod)
    }
  }

  build() {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0)
    const out = Buffer.allocUnsafeSlow(total)  // non-pooled: byteOffset always 0
    let pos = 0
    for (const c of this.chunks) { c.copy(out, pos); pos += c.length }
    return out
  }
}

function encodeUnitsBuffer() {
  const w = new Writer()
  w.uint64(serverTime)

  for (const unit of units.values()) {
    w.uint32(unit.id)

    w.uint8(DI.category);  w.string(unit.category)
    w.uint8(DI.alive);     w.bool(true)
    w.uint8(DI.coalition); w.uint8(unit.coalition)
    w.uint8(DI.name);      w.string(unit.name)
    w.uint8(DI.unitName);  w.string(unit.unitName)
    w.uint8(DI.position);  w.coords(unit.lat, unit.lng, unit.alt)
    w.uint8(DI.speed);     w.float64(unit.spd * KNOTS_TO_MS)  // m/s
    w.uint8(DI.heading);   w.float64(unit.hdg)                // radians
    w.uint8(DI.track);     w.float64(unit.hdg)                // radians
    w.uint8(DI.contacts);  w.contactVector(unit.contacts)
    w.uint8(DI.airborne);  w.bool(true)

    w.uint8(DI.endOfData)
  }

  return w.build()
}

// ─── Request helpers ──────────────────────────────────────────────────────────

function checkAuth(req, res) {
  const auth = req.headers['authorization'] ?? ''
  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Olympus"' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return false
  }
  return true  // accept any password
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

function handleUnits(req, res) {
  moveUnits()
  const body = encodeUnitsBuffer()
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

// Mission start: 10:00:00, 1 June 2025. Advances in real time from server start.
const MISSION_START_H = 10
const MISSION_START_M = 0
const MISSION_START_S = 0
const serverStartWallMs = Date.now()

function handleMission(req, res) {
  const elapsedS  = Math.floor((Date.now() - serverStartWallMs) / 1000)
  const totalS    = MISSION_START_H * 3600 + MISSION_START_M * 60 + MISSION_START_S + elapsedS
  const h = Math.floor(totalS / 3600) % 24
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60

  json(res, {
    theater: 'Caucasus',        // top-level: Login.jsx ICAO lookup
    commandMode: 'GAME_MASTER',
    bullseyes: [
      { coalition: 2, name: 'BULLSEYE', lat: 42.35, lon: 43.32 },
    ],
    mission: {
      theatre: 'Caucasus',      // nested British spelling: AtcScope / CatccScope
      dateAndTime: {
        date: { Day: 1, Month: 6, Year: 2025 },
        time: { h, m, s },
      },
    },
    time: Number(serverTime),
  })
}

function handleAirbases(req, res) {
  // Field names must match what Login.jsx expects: latitude, longitude, callsign, unitId
  // Coalition: 2 = blue (Georgia), 1 = red (Russia), 0 = neutral
  json(res, [
    { callsign: 'Anapa-Vityazevo',     coalition: 1, latitude: 45.002, longitude: 37.347, elevation: 141,  unitId: 0 },
    { callsign: 'Batumi',              coalition: 2, latitude: 41.610, longitude: 41.599, elevation: 33,   unitId: 0 },
    { callsign: 'Beslan',              coalition: 1, latitude: 43.205, longitude: 44.606, elevation: 1722, unitId: 0 },
    { callsign: 'Gelendzhik',          coalition: 1, latitude: 44.582, longitude: 38.012, elevation: 72,   unitId: 0 },
    { callsign: 'Gudauta',             coalition: 0, latitude: 43.103, longitude: 40.582, elevation: 69,   unitId: 0 },
    { callsign: 'Kobuleti',            coalition: 2, latitude: 41.920, longitude: 41.851, elevation: 69,   unitId: 0 },
    { callsign: 'Krasnodar-Center',    coalition: 1, latitude: 45.086, longitude: 38.974, elevation: 98,   unitId: 0 },
    { callsign: 'Krasnodar-Pashkovsky',coalition: 1, latitude: 45.034, longitude: 39.170, elevation: 112,  unitId: 0 },
    { callsign: 'Krymsk',              coalition: 1, latitude: 44.977, longitude: 37.998, elevation: 66,   unitId: 0 },
    { callsign: 'Kutaisi',             coalition: 2, latitude: 42.177, longitude: 42.482, elevation: 148,  unitId: 0 },
    { callsign: 'Maykop-Khanskaya',    coalition: 1, latitude: 44.682, longitude: 40.032, elevation: 591,  unitId: 0 },
    { callsign: 'Mineralnye Vody',     coalition: 1, latitude: 44.224, longitude: 43.082, elevation: 1050, unitId: 0 },
    { callsign: 'Mozdok',              coalition: 1, latitude: 43.789, longitude: 44.608, elevation: 507,  unitId: 0 },
    { callsign: 'Nalchik',             coalition: 1, latitude: 43.513, longitude: 43.637, elevation: 1411, unitId: 0 },
    { callsign: 'Novorossiysk',        coalition: 1, latitude: 44.671, longitude: 37.770, elevation: 131,  unitId: 0 },
    { callsign: 'Senaki-Kolkhi',       coalition: 2, latitude: 42.240, longitude: 42.056, elevation: 43,   unitId: 0 },
    { callsign: 'Sochi-Adler',         coalition: 1, latitude: 43.449, longitude: 39.956, elevation: 98,   unitId: 0 },
    { callsign: 'Soganlug',            coalition: 2, latitude: 41.728, longitude: 44.959, elevation: 1500, unitId: 0 },
    { callsign: 'Sukhumi-Babushara',   coalition: 0, latitude: 42.858, longitude: 41.128, elevation: 43,   unitId: 0 },
    { callsign: 'Tbilisi-Lochini',     coalition: 2, latitude: 41.669, longitude: 44.954, elevation: 1574, unitId: 0 },
    { callsign: 'Vaziani',             coalition: 2, latitude: 41.636, longitude: 45.033, elevation: 1524, unitId: 0 },
  ])
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization',
    })
    res.end()
    return
  }

  if (!checkAuth(req, res)) return

  if (path === '/olympus/units')    return handleUnits(req, res)
  if (path === '/olympus/mission')  return handleMission(req, res)
  if (path === '/olympus/airbases') return handleAirbases(req, res)

  json(res, { error: 'Not found' }, 404)
})

server.listen(PORT, () => {
  console.log(`Mock Olympus running on http://localhost:${PORT}`)
  console.log(`  Units endpoint returns binary (decoder-compatible)`)
  console.log(`  Any password accepted`)
})
