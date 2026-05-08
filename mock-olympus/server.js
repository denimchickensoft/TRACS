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
 */

const http     = require('http')
const readline = require('readline')

const PORT = 4000

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOTS_TO_MS = 0.514444
const FT_TO_M     = 0.3048
const NM_DEG      = 1 / 60
const NM_PER_SEC  = 1 / 3600
const DEG_TO_RAD  = Math.PI / 180
const RAD_TO_DEG  = 180 / Math.PI
const TWO_PI      = Math.PI * 2

const TURN_RATE_RPS   = 3 * DEG_TO_RAD        // standard rate: 3°/s in radians
const CLIMB_RATE_MPS  = (1000 / 60) * FT_TO_M // 1000 fpm in m/s
const ACCEL_KTS_PER_S = 5                     // knots/s speed change rate

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

// Carrier turn cycle: 5 min straight → 180° left turn at 1°/s → repeat
const CARRIER_STRAIGHT_S = 300
const CARRIER_TURN_S     = 180
const CARRIER_CYCLE_S    = CARRIER_STRAIGHT_S + CARRIER_TURN_S
const serverStartWallMs  = Date.now()

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

function moveUnits() {
  const now     = Date.now()
  const dt      = Math.min((now - lastMovedAt) / 1000, 1.0)
  lastMovedAt   = now
  const elapsed = (now - serverStartWallMs) / 1000

  for (const unit of units.values()) {
    // Advance position along current heading
    const distDeg = unit.spd * dt * NM_PER_SEC * NM_DEG
    unit.lat += Math.cos(unit.hdg) * distDeg
    unit.lng += Math.sin(unit.hdg) * distDeg

    if (unit.category === 'NavyUnit') {
      // Carrier: 5-min straight then 180° left turn at 1°/s, repeat
      const phase = elapsed % CARRIER_CYCLE_S
      if (phase >= CARRIER_STRAIGHT_S) {
        unit.hdg = normalizeAngle(unit.hdg - 1 * DEG_TO_RAD * dt)
      }
    } else if (unit.targetHdg !== null) {
      // Under positive heading control — execute commanded turn, no drift
      applyTurn(unit, dt)
    } else {
      // Free flight — gentle random heading drift
      unit.hdg = normalizeAngle(unit.hdg + (Math.random() - 0.5) * 0.02)
    }

    applyClimb(unit, dt)
    applySpeed(unit, dt)
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

  json(res, {
    theater: 'Caucasus',
    commandMode: 'GAME_MASTER',
    bullseyes: [
      { coalition: 2, name: 'BULLSEYE', lat: 42.35, lon: 43.32 },
    ],
    mission: {
      theatre: 'Caucasus',
      dateAndTime: {
        date: { Day: 1, Month: 6, Year: 2025 },
        time: { h, m, s },
      },
    },
    time: Number(serverTime),
  })
}

function handleAirbases(req, res) {
  json(res, [
    { callsign: 'Anapa-Vityazevo',      coalition: 1, latitude: 45.002, longitude: 37.347, elevation: 141,  unitId: 0 },
    { callsign: 'Batumi',               coalition: 2, latitude: 41.610, longitude: 41.599, elevation: 33,   unitId: 0 },
    { callsign: 'Beslan',               coalition: 1, latitude: 43.205, longitude: 44.606, elevation: 1722, unitId: 0 },
    { callsign: 'Gelendzhik',           coalition: 1, latitude: 44.582, longitude: 38.012, elevation: 72,   unitId: 0 },
    { callsign: 'Gudauta',              coalition: 0, latitude: 43.103, longitude: 40.582, elevation: 69,   unitId: 0 },
    { callsign: 'Kobuleti',             coalition: 2, latitude: 41.920, longitude: 41.851, elevation: 69,   unitId: 0 },
    { callsign: 'Krasnodar-Center',     coalition: 1, latitude: 45.086, longitude: 38.974, elevation: 98,   unitId: 0 },
    { callsign: 'Krasnodar-Pashkovsky', coalition: 1, latitude: 45.034, longitude: 39.170, elevation: 112,  unitId: 0 },
    { callsign: 'Krymsk',               coalition: 1, latitude: 44.977, longitude: 37.998, elevation: 66,   unitId: 0 },
    { callsign: 'Kutaisi',              coalition: 2, latitude: 42.177, longitude: 42.482, elevation: 148,  unitId: 0 },
    { callsign: 'Maykop-Khanskaya',     coalition: 1, latitude: 44.682, longitude: 40.032, elevation: 591,  unitId: 0 },
    { callsign: 'Mineralnye Vody',      coalition: 1, latitude: 44.224, longitude: 43.082, elevation: 1050, unitId: 0 },
    { callsign: 'Mozdok',               coalition: 1, latitude: 43.789, longitude: 44.608, elevation: 507,  unitId: 0 },
    { callsign: 'Nalchik',              coalition: 1, latitude: 43.513, longitude: 43.637, elevation: 1411, unitId: 0 },
    { callsign: 'Novorossiysk',         coalition: 1, latitude: 44.671, longitude: 37.770, elevation: 131,  unitId: 0 },
    { callsign: 'Senaki-Kolkhi',        coalition: 2, latitude: 42.240, longitude: 42.056, elevation: 43,   unitId: 0 },
    { callsign: 'Sochi-Adler',          coalition: 1, latitude: 43.449, longitude: 39.956, elevation: 98,   unitId: 0 },
    { callsign: 'Soganlug',             coalition: 2, latitude: 41.728, longitude: 44.959, elevation: 1500, unitId: 0 },
    { callsign: 'Sukhumi-Babushara',    coalition: 0, latitude: 42.858, longitude: 41.128, elevation: 43,   unitId: 0 },
    { callsign: 'Tbilisi-Lochini',      coalition: 2, latitude: 41.669, longitude: 44.954, elevation: 1574, unitId: 0 },
    { callsign: 'Vaziani',              coalition: 2, latitude: 41.636, longitude: 45.033, elevation: 1524, unitId: 0 },
  ])
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
  console.log('\nUNITS:')
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

// ── create <type> <coalition> [H<hdg>] [S<spd>] [A<alt>] ─────────────────────

function cmdCreate(parts) {
  if (parts.length < 3) {
    console.log('  Usage: create <type> <coalition> [H<hdg>] [S<spd>] [A<alt>]')
    console.log('  e.g.   create F-16 BLU H210 S310 A250')
    return
  }

  const typeName  = resolveType(parts[1])
  const coalition = COALITION_MAP[parts[2].toLowerCase()]
  if (coalition === undefined) {
    console.log(`  Unknown coalition: ${parts[2]}  (valid: BLU RED NEU)`)
    return
  }

  let hdgDegNew = 0, spdKts = 300, altHundreds = 100
  for (let i = 3; i < parts.length; i++) {
    const p = parts[i].toUpperCase()
    if (p.startsWith('H')) hdgDegNew   = parseInt(p.slice(1), 10)
    if (p.startsWith('S')) spdKts      = parseInt(p.slice(1), 10)
    if (p.startsWith('A')) altHundreds = parseInt(p.slice(1), 10)
  }

  const newId    = Math.max(...units.keys()) + 1
  const coalStr  = coalition === 2 ? 'BLU' : coalition === 1 ? 'RED' : 'NEU'
  const callsign = `${typeName.split('_')[0].toUpperCase()}-${newId}`

  units.set(newId, {
    id:        newId,
    unitName:  callsign,
    name:      typeName,
    category:  'Aircraft',
    coalition,
    // Spawn near center of Caucasus action area with slight scatter
    lat:       42.5 + (Math.random() - 0.5) * 0.3,
    lng:       43.2 + (Math.random() - 0.5) * 0.3,
    alt:       altHundreds * 100 * FT_TO_M,
    hdg:       normalizeAngle(hdgDegNew * DEG_TO_RAD),
    spd:       spdKts,
    contacts:  [],
    turnDir:   null, targetHdg: null, targetAlt: null, targetSpd: null,
  })

  console.log(`  Created: ${callsign} (${typeName}) ${coalStr} HDG ${String(hdgDegNew).padStart(3,'0')} SPD ${spdKts}kt ALT ${altHundreds * 100}ft`)
  printList()
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

// ── Command dispatcher ────────────────────────────────────────────────────────

function parseCommand(line) {
  const parts = line.trim().split(/\s+/)
  if (!parts[0]) return

  switch (parts[0].toLowerCase()) {
    case 'list':
    case 'refresh':
      printList()
      break
    case 'create':
      cmdCreate(parts)
      break
    case 'delete':
      cmdDelete(parts)
      break
    case 'rename':
      cmdRename(parts)
      break
    default:
      cmdControl(parts)
  }
}

function startConsole() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  printList()
  console.log('Commands:')
  console.log('  <n> tr|tl <hdg>             turn right/left to heading')
  console.log('  <n> h <hdg>                 turn shortest direction to heading')
  console.log('  <n> m <alt>                 climb or descend (hundreds of feet, e.g. 050 = 5000ft)')
  console.log('  <n> c <alt>                 climb only — ignored if already at or above')
  console.log('  <n> d <alt>                 descend only — ignored if already at or below')
  console.log('  <n> s <spd>                 set speed (KTAS)')
  console.log('  create <type> <coal> [H S A]  e.g. create F-16 BLU H210 S310 A250')
  console.log('  delete <n>                  remove a unit')
  console.log('  rename <n> <callsign>       rename a unit')
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

  if (path === '/olympus/units')    return handleUnits(req, res)
  if (path === '/olympus/mission')  return handleMission(req, res)
  if (path === '/olympus/airbases') return handleAirbases(req, res)

  json(res, { error: 'Not found' }, 404)
})

server.listen(PORT, () => {
  console.log(`Mock Olympus running on http://localhost:${PORT}`)
  console.log(`Any password accepted\n`)
  startConsole()
})
