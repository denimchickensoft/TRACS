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
 * Then connect TRACS to: http://localhost:4001  (any password accepted)
 *
 * Console commands:
 *   list              — print current unit list
 *   <n> tr <hdg>      — right turn to magnetic heading (e.g. "1 tr 090")
 *   <n> tl <hdg>      — left turn to magnetic heading
 *   <n> m <alt>       — climb/descend to altitude in hundreds of feet (e.g. "3 m 030" = 3000ft)
 *   <n> c <alt>       — climb only (ignored if already at or above target)
 *   <n> d <alt>       — descend only (ignored if already at or below target)
 *   <n> h <hdg>       — turn shortest direction to heading
 *   <n> s <spd>       — set speed in KTAS (e.g. "2 s 280")
 *   create <cs> [<type>] [<coal>] [H<hdg>] [S<spd>] [A<alt>]  — spawn unit (type defaults to FA-18C, coal defaults to BLU)
 */

const http     = require('http')
const readline = require('readline')
const fs       = require('fs')
const path     = require('path')

const PORT = 4001

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOTS_TO_MS = 0.514444
const FT_TO_M     = 0.3048
const NM_TO_FEET  = 6076.115
const NM_DEG      = 1 / 60
const NM_PER_SEC  = 1 / 3600
const DEG_TO_RAD  = Math.PI / 180
const RAD_TO_DEG  = 180 / Math.PI
const TWO_PI      = Math.PI * 2

const GS_TOL_DEG      = 0.7  // glideslope full-scale deflection
const AZ_TOL_DEG      = 2.5  // azimuth full-scale deflection

const TURN_RATE_RPS   = 3 * DEG_TO_RAD        // standard rate: 3°/s in radians
const CLIMB_RATE_MPS  = (1000 / 60) * FT_TO_M // 1000 fpm in m/s
const ACCEL_KTS_PER_S = 5                     // knots/s speed change rate

// Carrier deck metadata — mirrors client/src/utils/carriers.js
const CARRIER_META = {
  'Stennis':    { deckOffset: 9, deckHeightFt: 65 },
  'Forrestal':  { deckOffset: 9, deckHeightFt: 65 },
  'Kuznetsov':  { deckOffset: 0, deckHeightFt: 70 },
  'LHA_Tarawa': { deckOffset: 0, deckHeightFt: 70 },
  'CVN_71':     { deckOffset: 9, deckHeightFt: 65 },
  'CVN_72':     { deckOffset: 9, deckHeightFt: 65 },
  'CVN_73':     { deckOffset: 9, deckHeightFt: 65 },
  'CVN_74':     { deckOffset: 9, deckHeightFt: 65 },
  'CVN_75':     { deckOffset: 9, deckHeightFt: 65 },
}

// Aircraft type aliases → DCS internal name
const TYPE_ALIASES = {
  'f-16': 'F-16C_50',       'f16':  'F-16C_50',
  'f-15': 'F-15C',          'f15':  'F-15C',
  'f-14': 'F-14B',          'f14':  'F-14B',
  'f-18': 'FA-18C_hornet',  'f18':  'FA-18C_hornet',
  'fa-18':'FA-18C_hornet',  'fa18': 'FA-18C_hornet',
  'e-3':  'E-3A',            'e3':   'E-3A',
  'e-2':  'E-2C',            'e2':   'E-2C',
  'mig-29':'MiG-29A',        'mig29':'MiG-29A',
  'su-27':'Su-27',           'su27': 'Su-27',
  'su-33':'Su-33',           'su33': 'Su-33',
  'b-52': 'B-52H',          'b52':  'B-52H',
  'kc-135':'KC135MPRS',     'kc135':'KC135MPRS',
}

const COALITION_MAP = { blu: 2, blue: 2, red: 1, neu: 0, neutral: 0 }

function resolveType(input) {
  return TYPE_ALIASES[input.toLowerCase()] ?? input
}

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

// Caucasus theatre — Blue coalition = 2, Red = 1
// hdg: radians, DCS convention (0 = North, clockwise)
// spd: knots (converted to m/s on encode)
// contacts[].ID: uint32, contacts[].detectionMethod: bitmask (VISUAL=1, OPTIC=2, RADAR=4, IRST=8, RWR=16, DLINK=32)
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
      { ID: 5, detectionMethod: 4 },
      { ID: 6, detectionMethod: 4 },
      { ID: 13, detectionMethod: 4 },
      { ID: 14, detectionMethod: 4 },
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
  {
    id: 7, unitName: 'STENNIS', name: 'CVN_74', category: 'NavyUnit',
    coalition: 2, lat: 41.50, lng: 40.50, alt: 0,
    hdg: 0, spd: 30, contacts: [],
  },
  {
    id: 8, unitName: 'Tomcat11', name: 'F-14B', category: 'Aircraft',
    coalition: 2, lat: 41.25, lng: 40.50, alt: 762,
    hdg: 0, spd: 180, contacts: [],
  },
  {
    id: 9, unitName: 'Tomcat12', name: 'F-14B', category: 'Aircraft',
    coalition: 2, lat: 41.63, lng: 40.50, alt: 1524,
    hdg: Math.PI, spd: 220, contacts: [],
  },
  {
    id: 10, unitName: 'Hornet21', name: 'FA-18C_hornet', category: 'Aircraft',
    coalition: 2, lat: 41.50, lng: 40.94, alt: 3658,
    hdg: Math.PI * 1.5, spd: 350, contacts: [],
  },
  {
    id: 11, unitName: 'HAWKEYE', name: 'E-2C', category: 'Aircraft',
    coalition: 2, lat: 41.55, lng: 39.94, alt: 7620,
    hdg: Math.PI / 2, spd: 270, contacts: [],
  },

  // ── Ground/naval units — ABM Phase 5 (surface threat awareness) test fixtures ──
  {
    id: 12, unitName: 'Abrams 1', name: 'M-1 Abrams', category: 'GroundUnit',
    coalition: 2, lat: 42.55, lng: 43.05, alt: 0,
    hdg: 0, spd: 0, contacts: [],
  },
  // Red — acquisition-range-only (radar), only visible because unit 3 has it in contacts
  {
    id: 13, unitName: 'Kub Radar', name: 'Kub 1S91 str', category: 'GroundUnit',
    coalition: 1, lat: 42.68, lng: 43.75, alt: 0,
    hdg: 0, spd: 0, contacts: [],
  },
  // Red — engagement-range-only (launcher), same detection as above
  {
    id: 14, unitName: 'Kub Launcher', name: 'Kub 2P25 ln', category: 'GroundUnit',
    coalition: 1, lat: 42.685, lng: 43.755, alt: 0,
    hdg: 0, spd: 0, contacts: [],
  },
]

// Add flight control state to each unit
const units = new Map(unitDefs.map((u) => [u.id, {
  ...u,
  contacts:  [...u.contacts],
  turnDir:   null,   // 'r' | 'l' | null
  targetHdg: null,   // radians, null = no turn commanded
  targetAlt: null,   // meters, null = no altitude commanded
  targetSpd: null,   // knots, null = no speed commanded
}]))

let serverTime  = BigInt(Date.now())
let lastMovedAt = Date.now()
let rl          = null  // set by startConsole, used for re-prompting after async events
let magvarDeg   = 0     // magnetic variation used for BRC/FB ↔ true heading conversion
let theatre     = 'Caucasus'

// Default carrier position, heading, and bullseye for each DCS theatre
const THEATRE_DEFAULTS = {
  Caucasus:       { lat: 42.50,  lng: 43.20,  hdg: Math.PI / 2, bullseyeLat: 42.35,  bullseyeLng: 43.32  },
  Nevada:         { lat: 36.60,  lng: -115.10, hdg: 0,           bullseyeLat: 36.24,  bullseyeLng: -115.80 },
  PersianGulf:    { lat: 26.50,  lng: 56.30,  hdg: Math.PI / 2, bullseyeLat: 26.90,  bullseyeLng: 56.10  },
  Syria:          { lat: 35.20,  lng: 34.80,  hdg: Math.PI / 2, bullseyeLat: 35.40,  bullseyeLng: 37.10  },
  MarianaIslands: { lat: 15.10,  lng: 145.70, hdg: Math.PI / 2, bullseyeLat: 15.20,  bullseyeLng: 145.50 },
  SouthAtlantic:  { lat: -51.50, lng: -58.00, hdg: Math.PI / 2, bullseyeLat: -51.70, bullseyeLng: -57.80 },
  Sinai:          { lat: 30.00,  lng: 33.50,  hdg: Math.PI / 2, bullseyeLat: 30.50,  bullseyeLng: 34.00  },
  Kola:           { lat: 69.50,  lng: 33.00,  hdg: Math.PI / 2, bullseyeLat: 69.20,  bullseyeLng: 32.50  },
  Afghanistan:    { lat: 34.50,  lng: 69.00,  hdg: Math.PI / 2, bullseyeLat: 34.50,  bullseyeLng: 69.20  },
  Germany:        { lat: 51.50,  lng: 10.00,  hdg: Math.PI / 2, bullseyeLat: 51.30,  bullseyeLng: 10.50  },
}

const serverStartWallMs = Date.now()
const SESSION_HASH = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

// ─── Geometry helpers ─────────────────────────────────────────────────────────

// Planar approximation — accurate enough for <50 NM
function distNm(lat1, lng1, lat2, lng2) {
  const midLat = ((lat1 + lat2) / 2) * DEG_TO_RAD
  const dlat   = (lat2 - lat1) * 60
  const dlng   = (lng2 - lng1) * 60 * Math.cos(midLat)
  return Math.sqrt(dlat * dlat + dlng * dlng)
}

// Returns bearing in radians, 0 = North, π/2 = East (matches server heading convention)
function bearingRad(fromLat, fromLng, toLat, toLng) {
  const midLat = ((fromLat + toLat) / 2) * DEG_TO_RAD
  const dlat   = (toLat - fromLat) * 60
  const dlng   = (toLng - fromLng) * 60 * Math.cos(midLat)
  return normalizeAngle(Math.atan2(dlng, dlat))
}

// ─── Flight physics ───────────────────────────────────────────────────────────

function normalizeAngle(a) {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function applyTurn(unit, dt) {
  if (unit.targetHdg === null) return

  const cur    = unit.hdg
  const target = unit.targetHdg
  const step   = TURN_RATE_RPS * dt

  // Angular distance remaining in the commanded direction
  const dist = unit.turnDir === 'r'
    ? normalizeAngle(target - cur)
    : normalizeAngle(cur - target)

  if (dist <= step) {
    unit.hdg       = target
    unit.targetHdg = null
    unit.turnDir   = null
  } else {
    unit.hdg = normalizeAngle(unit.turnDir === 'r' ? cur + step : cur - step)
  }
}

function applyClimb(unit, dt) {
  if (unit.targetAlt === null) return

  const delta = unit.targetAlt - unit.alt
  const step  = CLIMB_RATE_MPS * dt

  if (Math.abs(delta) <= step) {
    unit.alt       = unit.targetAlt
    unit.targetAlt = null
  } else {
    unit.alt += Math.sign(delta) * step
  }
}

function applySpeed(unit, dt) {
  if (unit.targetSpd === null) return

  const delta = unit.targetSpd - unit.spd
  const step  = ACCEL_KTS_PER_S * dt

  if (Math.abs(delta) <= step) {
    unit.spd       = unit.targetSpd
    unit.targetSpd = null
  } else {
    unit.spd += Math.sign(delta) * step
  }
}

function stepParApproach(unit, dt) {
  const pa = unit.parApproach

  // For carrier approaches, chase the carrier's current position as the threshold.
  const carrier   = pa.carrierId != null ? units.get(pa.carrierId) : null
  const threshLat = carrier ? carrier.lat : pa.threshLat
  const threshLng = carrier ? carrier.lng : pa.threshLng

  // Current range from threshold along the approach axis
  const dist        = distNm(unit.lat, unit.lng, threshLat, threshLng)
  const brgToUnit   = bearingRad(threshLat, threshLng, unit.lat, unit.lng)
  const outboundRad = normalizeAngle(pa.inboundHdgRad + Math.PI)
  const offAngle    = ((brgToUnit - outboundRad) + Math.PI * 3) % (Math.PI * 2) - Math.PI
  const rangeFinal  = Math.max(0, dist * Math.cos(offAngle))

  // Advance along glidepath by one tick
  const newRange = Math.max(0, rangeFinal - unit.spd * NM_PER_SEC * dt)

  // On deck
  if (unit.alt <= (pa.deckHeightFt + 20) * FT_TO_M) return true

  // Proportional tolerance at new range (angular — narrows toward threshold)
  const maxAltDev = pa.vertTolFt * (newRange / pa.rangeNm) * 0.85
  const maxLatDev = pa.latTolNm  * (newRange / pa.rangeNm) * 0.85

  // Altitude deviation: random walk scaled by devFactor; 0 = perfect approach
  if (pa.devFactor > 0) {
    pa.altDevFt += (Math.random() - 0.5) * 30 * pa.devFactor * dt
    pa.altDevFt *= (1 - dt * 0.4)
    pa.altDevFt  = Math.max(-maxAltDev, Math.min(maxAltDev, pa.altDevFt))
  } else {
    pa.altDevFt = 0
  }

  // Lateral deviation: same, direct cross-track offset (NM, +right of CL)
  if (pa.devFactor > 0) {
    pa.latDevNm += (Math.random() - 0.5) * 0.02 * pa.devFactor * dt
    pa.latDevNm *= (1 - dt * 0.4)
    pa.latDevNm  = Math.max(-maxLatDev, Math.min(maxLatDev, pa.latDevNm))
  } else {
    pa.latDevNm = 0
  }

  // GS altitude at new range
  const gsAltFt = pa.deckHeightFt + newRange * NM_TO_FEET * Math.tan(pa.gsAngleDeg * DEG_TO_RAD)

  // Place aircraft precisely: outbound from threshold by newRange, offset laterally.
  // Longitude requires cos(lat) scaling: 1 NM = NM_DEG / cos(lat) degrees of longitude.
  const cosLat       = Math.cos(threshLat * DEG_TO_RAD)
  const rightPerpRad = normalizeAngle(pa.inboundHdgRad + Math.PI / 2)
  unit.lat = threshLat
    + Math.cos(outboundRad)   * newRange    * NM_DEG
    + Math.cos(rightPerpRad)  * pa.latDevNm * NM_DEG
  unit.lng = threshLng
    + Math.sin(outboundRad)   * newRange    * NM_DEG / cosLat
    + Math.sin(rightPerpRad)  * pa.latDevNm * NM_DEG / cosLat
  unit.alt = Math.max(pa.deckHeightFt * FT_TO_M, (gsAltFt + pa.altDevFt) * FT_TO_M)
  unit.hdg = pa.inboundHdgRad

  // Hold approach speed
  const spdDelta = pa.approachSpd - unit.spd
  unit.spd += Math.sign(spdDelta) * Math.min(ACCEL_KTS_PER_S * dt, Math.abs(spdDelta))

  return false
}

function moveUnits() {
  const now     = Date.now()
  const dt      = Math.min((now - lastMovedAt) / 1000, 1.0)
  lastMovedAt   = now

  const toDelete = []

  for (const unit of units.values()) {
    // PAR aircraft: stepParApproach controls position directly — skip generic advance
    if (!unit.parApproach) {
      const distDeg = unit.spd * dt * NM_PER_SEC * NM_DEG
      unit.lat += Math.cos(unit.hdg) * distDeg
      unit.lng += Math.sin(unit.hdg) * distDeg
    }

    if (unit.category === 'NavyUnit') {
      // Carrier: steady course unless a heading has been commanded
      if (unit.targetHdg !== null) applyTurn(unit, dt)
    } else if (unit.parApproach) {
      const onDeck = stepParApproach(unit, dt)
      if (onDeck) toDelete.push(unit.id)
    } else if (unit.targetHdg !== null) {
      // Under positive heading control — execute commanded turn, no drift
      applyTurn(unit, dt)
      applyClimb(unit, dt)
      applySpeed(unit, dt)
    } else {
      // Free flight — gentle random heading drift
      unit.hdg = normalizeAngle(unit.hdg + (Math.random() - 0.5) * 0.02)
      applyClimb(unit, dt)
      applySpeed(unit, dt)
    }
  }

  for (const id of toDelete) {
    const u = units.get(id)
    units.delete(id)
    console.log(`\n  ${u?.unitName ?? id}: on deck — removed`)
    rl.prompt()
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
    this.float64(0)
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
    const out = Buffer.allocUnsafeSlow(total)
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
    w.uint8(DI.speed);     w.float64(unit.spd * KNOTS_TO_MS)
    w.uint8(DI.heading);   w.float64(unit.hdg)
    w.uint8(DI.track);     w.float64(unit.hdg)
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

const MISSION_START_H = 10
const MISSION_START_M = 0
const MISSION_START_S = 0

function handleMission(req, res) {
  const elapsedS = Math.floor((Date.now() - serverStartWallMs) / 1000)
  const totalS   = MISSION_START_H * 3600 + MISSION_START_M * 60 + MISSION_START_S + elapsedS
  const h = Math.floor(totalS / 3600) % 24
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60

  const td = THEATRE_DEFAULTS[theatre] ?? THEATRE_DEFAULTS.Caucasus
  json(res, {
    mission: {
      theatre: theatre,
      dateAndTime: {
        date: { Day: 1, Month: 6, Year: 2025 },
        time: { h, m, s },
      },
      commandModeOptions: { commandMode: 'Game master' },
    },
    sessionHash: SESSION_HASH,
    time: Number(serverTime),
    load: 5,
    frameRate: 60,
  })
}

function handleBullseyes(req, res) {
  const td = THEATRE_DEFAULTS[theatre] ?? THEATRE_DEFAULTS.Caucasus
  json(res, {
    bullseyes: {
      BULLSEYE: { latitude: td.bullseyeLat, longitude: td.bullseyeLng, coalition: 'blue' },
    },
    sessionHash: SESSION_HASH,
    time: Number(serverTime),
    load: 5,
    frameRate: 60,
  })
}

function handleAirbases(req, res) {
  const file = path.join(__dirname, '..', 'client', 'public', 'runways', `${theatre}.json`)
  try {
    const data   = JSON.parse(fs.readFileSync(file, 'utf8'))
    const result = (data.airbases ?? []).map((ab) => {
      const rwy = ab.runways?.[0]
      return {
        callsign:  ab.airbase,
        coalition: 0,
        latitude:  rwy?.lat            ?? 0,
        longitude: rwy?.lon            ?? 0,
        elevation: Math.round(rwy?.elevation_ft ?? 0),
        unitId:    0,
      }
    })
    json(res, result)
  } catch {
    json(res, [])
  }
}

// ─── Console control ──────────────────────────────────────────────────────────

// Dynamic numbered list — aircraft only, sorted by ID
function getAircraftIds() {
  return [...units.values()]
    .filter(u => u.category === 'Aircraft')
    .sort((a, b) => a.id - b.id)
    .map(u => u.id)
}

function hdgDeg(unit) {
  return Math.round(normalizeAngle(unit.hdg) * RAD_TO_DEG).toString().padStart(3, '0')
}

function altFt(unit) {
  return Math.round(unit.alt / FT_TO_M)
}

function unitStatus(unit) {
  const parts = []
  if (unit.targetHdg !== null) {
    const dir = unit.turnDir === 'r' ? '→' : '←'
    const tgt = Math.round(unit.targetHdg * RAD_TO_DEG).toString().padStart(3, '0')
    parts.push(`turn ${dir}${tgt}°`)
  }
  if (unit.targetAlt !== null) {
    const dir   = unit.targetAlt > unit.alt ? '↑' : '↓'
    const tgtFt = Math.round(unit.targetAlt / FT_TO_M)
    parts.push(`${dir}${tgtFt}ft`)
  }
  if (unit.targetSpd !== null) {
    const dir = unit.targetSpd > unit.spd ? '▲' : '▼'
    parts.push(`${dir}${unit.targetSpd}kt`)
  }
  return parts.length ? `  [${parts.join(', ')}]` : ''
}

function printList() {
  // Carriers
  for (const unit of units.values()) {
    if (unit.category !== 'NavyUnit') continue
    const meta     = CARRIER_META[unit.name]
    if (!meta) continue
    const trueHdg  = (unit.hdg * RAD_TO_DEG + 360) % 360
    const brc      = ((trueHdg - magvarDeg) % 360 + 360) % 360
    const fb       = ((brc - meta.deckOffset) % 360 + 360) % 360
    const brcStr   = Math.round(brc).toString().padStart(3, '0')
    const fbStr    = Math.round(fb).toString().padStart(3, '0')
    const spdStr   = Math.round(unit.spd).toString().padStart(2)
    console.log(`\nCARRIER  ${unit.unitName.padEnd(12)}  BRC ${brcStr}°  FB ${fbStr}°  SPD ${spdStr}kt${unitStatus(unit)}`)
  }

  // Aircraft
  console.log('\nAIRCRAFT:')
  getAircraftIds().forEach((id, i) => {
    const u    = units.get(id)
    const num  = String(i + 1).padStart(2)
    const name = u.unitName.padEnd(14)
    const type = u.name.padEnd(16)
    const hdg  = hdgDeg(u)
    const spd  = Math.round(u.spd).toString().padStart(3)
    const alt  = altFt(u).toString().padStart(6)
    const coal = u.coalition === 2 ? 'BLU' : u.coalition === 1 ? 'RED' : 'NEU'
    console.log(`  ${num}  ${name}  ${type}  ${coal}  HDG ${hdg}  SPD ${spd}kt  ALT ${alt}ft${unitStatus(u)}`)
  })
  console.log('')
}

// ── Unit control commands ─────────────────────────────────────────────────────

function cmdControl(parts) {
  // Join and re-tokenize so spacing is irrelevant: "tl240d050s210" = "tl 240 d 050 s 210"
  const tokens = parts.join('').match(/[a-zA-Z]+|\d+/g) ?? []

  const ids = getAircraftIds()
  const idx = parseInt(tokens[0], 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) {
    console.log(`  Unknown unit number: ${tokens[0]}`)
    return
  }

  if (tokens.length < 3) { console.log('  Usage: <n> tr|tl|h|m|c|d|s <value> [...]'); return }

  const unit = units.get(ids[idx])

  let i = 1
  while (i < tokens.length) {
    const cmd = tokens[i].toLowerCase()
    const arg = tokens[i + 1]
    i += 2

    switch (cmd) {
      case 'tr':
      case 'tl': {
        const deg = parseInt(arg, 10)
        if (isNaN(deg) || deg < 0 || deg > 360) { console.log(`  ${cmd}: heading must be 000–360`); break }
        unit.targetHdg = normalizeAngle(deg * DEG_TO_RAD)
        unit.turnDir   = cmd === 'tr' ? 'r' : 'l'
        const dir = cmd === 'tr' ? 'RIGHT' : 'LEFT'
        console.log(`  ${unit.unitName}: turning ${dir} to ${String(deg).padStart(3, '0')}°`)
        break
      }
      case 'm': {
        const hundreds = parseInt(arg, 10)
        if (isNaN(hundreds) || hundreds < 0) { console.log(`  m: altitude in hundreds of feet (e.g. 030 = 3000ft)`); break }
        const ft = hundreds * 100
        unit.targetAlt = ft * FT_TO_M
        const dir = unit.targetAlt > unit.alt ? 'Climbing' : unit.targetAlt < unit.alt ? 'Descending' : 'Maintaining'
        console.log(`  ${unit.unitName}: ${dir} to ${ft}ft`)
        break
      }
      case 's': {
        const kts = parseInt(arg, 10)
        if (isNaN(kts) || kts < 0) { console.log(`  s: speed in knots KTAS`); break }
        unit.targetSpd = kts
        const dir = kts > unit.spd ? 'Accelerating' : kts < unit.spd ? 'Decelerating' : 'Maintaining'
        console.log(`  ${unit.unitName}: ${dir} to ${kts}kt`)
        break
      }
      case 'c': {
        const hundreds = parseInt(arg, 10)
        if (isNaN(hundreds) || hundreds < 0) { console.log(`  c: altitude in hundreds of feet`); break }
        const targetM = hundreds * 100 * FT_TO_M
        if (unit.alt >= targetM) { console.log(`  ${unit.unitName}: already at or above ${hundreds * 100}ft, ignoring`); break }
        unit.targetAlt = targetM
        console.log(`  ${unit.unitName}: climbing to ${hundreds * 100}ft`)
        break
      }
      case 'd': {
        const hundreds = parseInt(arg, 10)
        if (isNaN(hundreds) || hundreds < 0) { console.log(`  d: altitude in hundreds of feet`); break }
        const targetM = hundreds * 100 * FT_TO_M
        if (unit.alt <= targetM) { console.log(`  ${unit.unitName}: already at or below ${hundreds * 100}ft, ignoring`); break }
        unit.targetAlt = targetM
        console.log(`  ${unit.unitName}: descending to ${hundreds * 100}ft`)
        break
      }
      case 'h': {
        const deg = parseInt(arg, 10)
        if (isNaN(deg) || deg < 0 || deg > 360) { console.log(`  h: heading must be 000–360`); break }
        const target   = normalizeAngle(deg * DEG_TO_RAD)
        const rightDist = normalizeAngle(target - unit.hdg)
        const leftDist  = normalizeAngle(unit.hdg - target)
        const turnDir   = rightDist <= leftDist ? 'r' : 'l'
        unit.targetHdg  = target
        unit.turnDir    = turnDir
        const dirLabel  = turnDir === 'r' ? 'RIGHT' : 'LEFT'
        console.log(`  ${unit.unitName}: turning ${dirLabel} to ${String(deg).padStart(3, '0')}°`)
        break
      }
      default:
        console.log(`  Unknown command: ${cmd}  (valid: tr tl h m c d s)`)
    }
  }
}

// ── create <callsign> [<type>] [<coalition>] [H<hdg>] [S<spd>] [A<alt>] ──────

function isOption(s) { return /^[HSA]\d/i.test(s) }

function cmdCreate(parts) {
  if (parts.length < 2) {
    console.log('  Usage: create <callsign> [<type>] [<coalition>] [H<hdg>] [S<spd>] [A<alt>]')
    console.log('  e.g.   create HORNET41 FA-18C BLU H210 S310 A250')
    return
  }

  const callsign = parts[1]
  let typeName   = 'FA-18C_hornet'
  let coalition  = 2  // default blue
  let optStart   = 2

  // parts[2]: optional type or coalition or option
  if (parts[2] && !isOption(parts[2])) {
    if (COALITION_MAP[parts[2].toLowerCase()] !== undefined) {
      coalition = COALITION_MAP[parts[2].toLowerCase()]
      optStart  = 3
    } else {
      typeName = resolveType(parts[2])
      optStart = 3
      // parts[3]: optional coalition or option
      if (parts[3] && !isOption(parts[3])) {
        if (COALITION_MAP[parts[3].toLowerCase()] !== undefined) {
          coalition = COALITION_MAP[parts[3].toLowerCase()]
          optStart  = 4
        }
      }
    }
  }

  let hdgDegNew = 0, spdKts = 300, altHundreds = 100
  for (let i = optStart; i < parts.length; i++) {
    const p = parts[i].toUpperCase()
    if (p.startsWith('H')) hdgDegNew   = parseInt(p.slice(1), 10)
    if (p.startsWith('S')) spdKts      = parseInt(p.slice(1), 10)
    if (p.startsWith('A')) altHundreds = parseInt(p.slice(1), 10)
  }

  const newId   = Math.max(...units.keys()) + 1
  const coalStr = coalition === 2 ? 'BLU' : coalition === 1 ? 'RED' : 'NEU'

  units.set(newId, {
    id:        newId,
    unitName:  callsign,
    name:      typeName,
    category:  'Aircraft',
    coalition,
    // Spawn near the current theatre's default carrier position with slight scatter
    lat:       (THEATRE_DEFAULTS[theatre] ?? THEATRE_DEFAULTS.Caucasus).lat + (Math.random() - 0.5) * 0.3,
    lng:       (THEATRE_DEFAULTS[theatre] ?? THEATRE_DEFAULTS.Caucasus).lng + (Math.random() - 0.5) * 0.3,
    alt:       altHundreds * 100 * FT_TO_M,
    hdg:       normalizeAngle(hdgDegNew * DEG_TO_RAD),
    spd:       spdKts,
    contacts:  [],
    turnDir:   null, targetHdg: null, targetAlt: null, targetSpd: null,
  })

  console.log(`  Created: ${callsign} (${typeName}) ${coalStr} HDG ${String(hdgDegNew).padStart(3,'0')} SPD ${spdKts}kt ALT ${altHundreds * 100}ft`)
  printList()
}

// ── theatre <name> ────────────────────────────────────────────────────────────

function cmdTheatre(parts) {
  const name = parts[1]
  if (!name) {
    console.log(`  Current theatre: ${theatre}`)
    console.log(`  Valid: ${Object.keys(THEATRE_DEFAULTS).join(', ')}`)
    return
  }
  const match = Object.keys(THEATRE_DEFAULTS).find(k => k.toLowerCase() === name.toLowerCase())
  if (!match) {
    console.log(`  Unknown theatre: ${name}`)
    console.log(`  Valid: ${Object.keys(THEATRE_DEFAULTS).join(', ')}`)
    return
  }
  theatre = match
  const defaults = THEATRE_DEFAULTS[match]
  const carrier  = findCarrier()
  if (carrier) {
    const dLat = defaults.lat - carrier.lat
    const dLng = defaults.lng - carrier.lng
    // Translate all aircraft by the same delta so relative positions are preserved
    for (const unit of units.values()) {
      if (unit.category !== 'Aircraft') continue
      unit.lat += dLat
      unit.lng += dLng
      // Cancel PAR approaches — their threshold coordinates are now wrong
      if (unit.parApproach) unit.parApproach = null
    }
    carrier.lat = defaults.lat
    carrier.lng = defaults.lng
    carrier.hdg = defaults.hdg
    carrier.targetHdg = null
    console.log(`  Theatre: ${theatre}  — carrier and ${[...units.values()].filter(u => u.category === 'Aircraft').length} aircraft translated`)
  } else {
    console.log(`  Theatre: ${theatre}`)
  }
}

// ── delete <n> ────────────────────────────────────────────────────────────────

function cmdDelete(parts) {
  const ids = getAircraftIds()
  const idx = parseInt(parts[1], 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) {
    console.log(`  Unknown unit number: ${parts[1]}`)
    return
  }
  const unit = units.get(ids[idx])
  units.delete(ids[idx])
  console.log(`  Deleted: ${unit.unitName}`)
  printList()
}

// ── rename <n> <callsign> ─────────────────────────────────────────────────────

function cmdRename(parts) {
  const ids = getAircraftIds()
  const idx = parseInt(parts[1], 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) {
    console.log(`  Unknown unit number: ${parts[1]}`)
    return
  }
  if (!parts[2]) { console.log('  Usage: rename <n> <callsign>'); return }
  const unit    = units.get(ids[idx])
  const oldName = unit.unitName
  unit.unitName = parts.slice(2).join(' ').toUpperCase()
  console.log(`  Renamed: ${oldName} → ${unit.unitName}`)
  printList()
}

// ── <n> par [at <nm>] [gs <°>] [spd <kt>] [dev <0-1>] ────────────────────────
// ── <n> par rwy <lat> <lng> <hdg> [at <nm>] [gs <°>] [spd <kt>] [dev <0-1>] ─

function cmdPar(parts) {
  const ids = getAircraftIds()
  const idx = parseInt(parts[0], 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) {
    console.log(`  Unknown unit number: ${parts[0]}`)
    return
  }
  const unit = units.get(ids[idx])

  // Defaults
  let rangeNm     = 10
  let gsAngleDeg  = 3.5
  let approachSpd = 150
  let devFactor   = 0
  let threshLat = null, threshLng = null, inboundHdgDeg = null, deckHeightFt = 65
  let modeName = 'carrier'
  let carrierId = null

  // Auto-detect carrier
  for (const u of units.values()) {
    if (u.category !== 'NavyUnit') continue
    const meta = CARRIER_META[u.name]
    if (!meta) continue
    const trueHdgDeg = (u.hdg * RAD_TO_DEG + 360) % 360
    inboundHdgDeg = (trueHdgDeg - meta.deckOffset + 360) % 360
    threshLat     = u.lat
    threshLng     = u.lng
    deckHeightFt  = meta.deckHeightFt
    carrierId     = u.id
    break
  }

  // Parse keyword options
  let i = 2
  while (i < parts.length) {
    const tok = parts[i].toLowerCase()
    if (tok === 'at')  { rangeNm     = parseFloat(parts[++i]) || rangeNm;     i++; continue }
    if (tok === 'gs')  { gsAngleDeg  = parseFloat(parts[++i]) || gsAngleDeg;  i++; continue }
    if (tok === 'spd') { approachSpd = parseInt(parts[++i], 10) || approachSpd; i++; continue }
    if (tok === 'dev') { devFactor   = Math.max(0, Math.min(1, parseFloat(parts[++i]) || 0)); i++; continue }
    if (tok === 'rwy' || tok === 'airfield') {
      threshLat     = parseFloat(parts[++i])
      threshLng     = parseFloat(parts[++i])
      inboundHdgDeg = parseFloat(parts[++i]) % 360
      deckHeightFt  = 0
      gsAngleDeg    = 3.0
      modeName      = 'airfield'
      i++; continue
    }
    i++
  }

  if (threshLat === null || inboundHdgDeg === null) {
    console.log('  No carrier found. Use: par <n> rwy <lat> <lng> <inbound-hdg-true>')
    return
  }

  const inboundHdgRad = normalizeAngle(inboundHdgDeg * DEG_TO_RAD)
  const outboundHdgRad = normalizeAngle(inboundHdgRad + Math.PI)

  // Place unit on the glideslope at the requested range
  const distDeg = rangeNm * NM_DEG
  unit.lat = threshLat + Math.cos(outboundHdgRad) * distDeg
  unit.lng = threshLng + Math.sin(outboundHdgRad) * distDeg
  unit.alt = (deckHeightFt + rangeNm * NM_TO_FEET * Math.tan(gsAngleDeg * DEG_TO_RAD)) * FT_TO_M
  unit.hdg = inboundHdgRad
  unit.spd = approachSpd
  unit.targetHdg = null
  unit.targetAlt = null
  unit.targetSpd = null

  unit.parApproach = {
    threshLat, threshLng, inboundHdgRad, gsAngleDeg, deckHeightFt, approachSpd,
    rangeNm,
    vertTolFt: rangeNm * NM_TO_FEET * Math.tan(GS_TOL_DEG * DEG_TO_RAD),
    latTolNm:  rangeNm * Math.tan(AZ_TOL_DEG * DEG_TO_RAD),
    devFactor,
    altDevFt: 0, latDevNm: 0, carrierId,
  }

  const fbStr = Math.round(inboundHdgDeg).toString().padStart(3, '0')
  const altFt = Math.round((unit.alt / FT_TO_M))
  console.log(`  ${unit.unitName}: PAR ${modeName}  FB ${fbStr}°  GS ${gsAngleDeg}°  ${rangeNm}NM  ${altFt}ft  ${approachSpd}kt`)
}

// ── Carrier heading commands ──────────────────────────────────────────────────

function findCarrier() {
  for (const unit of units.values()) {
    if (unit.category === 'NavyUnit' && CARRIER_META[unit.name]) return unit
  }
  return null
}

function turnCarrierToTrue(trueHdgDeg) {
  const carrier = findCarrier()
  if (!carrier) { console.log('  No carrier found'); return }
  const target    = normalizeAngle(trueHdgDeg * DEG_TO_RAD)
  const rightDist = normalizeAngle(target - carrier.hdg)
  const leftDist  = normalizeAngle(carrier.hdg - target)
  carrier.targetHdg = target
  carrier.turnDir   = rightDist <= leftDist ? 'r' : 'l'
  return carrier
}

function cmdBrc(parts) {
  const brc = parseFloat(parts[1])
  if (isNaN(brc) || brc < 0 || brc > 360) {
    console.log('  Usage: brc <magnetic-heading>  (e.g. brc 350)')
    return
  }
  const trueHdg  = (brc + magvarDeg + 360) % 360
  const carrier  = turnCarrierToTrue(trueHdg)
  if (!carrier) return
  const meta     = CARRIER_META[carrier.name]
  const fb       = ((brc - (meta?.deckOffset ?? 9)) % 360 + 360) % 360
  console.log(`  Carrier: BRC ${Math.round(brc).toString().padStart(3,'0')}°  FB ${Math.round(fb).toString().padStart(3,'0')}°  (true ${Math.round(trueHdg).toString().padStart(3,'0')}°)`)
}

function cmdFb(parts) {
  const fb = parseFloat(parts[1])
  if (isNaN(fb) || fb < 0 || fb > 360) {
    console.log('  Usage: fb <magnetic-heading>  (e.g. fb 341)')
    return
  }
  const carrier = findCarrier()
  if (!carrier) { console.log('  No carrier found'); return }
  const meta    = CARRIER_META[carrier.name]
  const brc     = (fb + (meta?.deckOffset ?? 9) + 360) % 360
  const trueHdg = (brc + magvarDeg + 360) % 360
  turnCarrierToTrue(trueHdg)
  console.log(`  Carrier: FB ${Math.round(fb).toString().padStart(3,'0')}°  BRC ${Math.round(brc).toString().padStart(3,'0')}°  (true ${Math.round(trueHdg).toString().padStart(3,'0')}°)`)
}

function cmdMagvar(parts) {
  if (!parts[1]) { console.log(`  Magvar: ${magvarDeg}°`); return }
  const deg = parseFloat(parts[1])
  if (isNaN(deg)) { console.log('  Usage: magvar <degrees>  (e.g. magvar 5.2)'); return }
  magvarDeg = deg
  console.log(`  Magvar set to ${deg}°`)
}

// ── Command dispatcher ────────────────────────────────────────────────────────

function parseCommand(line) {
  const parts = line.trim().split(/\s+/)
  if (!parts[0]) return

  const first  = parts[0].toLowerCase()
  const second = (parts[1] ?? '').toLowerCase()

  if (first === 'list' || first === 'refresh') { printList(); return }
  if (first === 'create')  { cmdCreate(parts);  return }
  if (first === 'theatre') { cmdTheatre(parts); return }
  if (first === 'delete')  { cmdDelete(parts);  return }
  if (first === 'rename')  { cmdRename(parts);  return }
  if (first === 'brc')     { cmdBrc(parts);     return }
  if (first === 'fb')      { cmdFb(parts);      return }
  if (first === 'magvar')  { cmdMagvar(parts);  return }
  if (second === 'par')    { cmdPar(parts);     return }
  cmdControl(parts)
}

function startConsole() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  printList()
  console.log('Commands:')
  console.log('  <n> tr|tl <hdg>             turn right/left to heading')
  console.log('  <n> h <hdg>                 turn shortest direction to heading')
  console.log('  <n> m <alt>                 climb or descend (hundreds of feet, e.g. 050 = 5000ft)')
  console.log('  <n> c <alt>                 climb only — ignored if already at or above')
  console.log('  <n> d <alt>                 descend only — ignored if already at or below')
  console.log('  <n> s <spd>                 set speed (KTAS)')
  console.log('  create <cs> [<type>] [<coal>] [H S A]  e.g. create HORNET41 FA-18C BLU H210 S310 A250')
  console.log('  delete <n>                  remove a unit')
  console.log('  rename <n> <callsign>       rename a unit')
  console.log('  theatre [name]              show or set theatre (translates carrier + aircraft to default position)')
  console.log('  <n> par [at <nm>] [gs <°>] [spd <kt>] [dev <0-1>]   fly PAR to carrier (dev=0 perfect)')
  console.log('  <n> par rwy <lat> <lng> <hdg> [...]                  fly PAR to airfield')
  console.log('  brc <hdg°mag>               turn carrier to BRC (shortest direction)')
  console.log('  fb  <hdg°mag>               turn carrier to FB  (shortest direction)')
  console.log('  magvar [degrees]            show or set magnetic variation')
  console.log('  list / refresh              reprint unit list')
  rl.setPrompt('> ')
  rl.prompt()

  rl.on('line', (line) => {
    if (line.trim()) parseCommand(line)
    rl.prompt()
  })

  rl.on('close', () => process.exit(0))
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`)
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

  if (path === '/olympus/units')      return handleUnits(req, res)
  if (path === '/olympus/mission')    return handleMission(req, res)
  if (path === '/olympus/airbases')   return handleAirbases(req, res)
  if (path === '/olympus/bullseyes')  return handleBullseyes(req, res)

  json(res, { error: 'Not found' }, 404)
})

server.listen(PORT, () => {
  console.log(`Mock Olympus running on http://localhost:${PORT}`)
  console.log(`Any password accepted\n`)
  startConsole()
})
