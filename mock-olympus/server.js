'use strict'

/**
 * Mock Olympus REST API server for TRACS development and testing.
 *
 * /olympus/units    — binary format decoded by server/src/decoder.js
 * /olympus/weapons  — binary format, same as /olympus/units (missiles only, see "fire" below)
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
 *   create <cs> [<type>] [<coal>] [H<hdg>] [S<spd>] [A<alt>]  — spawn unit (type defaults to FA-18C, coal defaults to BLU; <cs> may be "quoted" to keep spaces, | and case)
 *   fire <n> <hdg> [<weapon>]  — launch a missile from aircraft <n> on heading <hdg>, straight-line flight until
 *                                impact/timeout (weapon defaults to AGM_84A; must be a trackable entry — RCS >= 0.1 m^2 —
 *                                in client/public/units/weaponSensorDatabase.json to be visible to AIC/ABM)
 *   ident <n>              — squawk IDENT (blinks for a few seconds, then reverts to NORMAL)
 *   stby <n>                — transponder to STANDBY/OFF (blanks the squawk code, same as real SRS)
 *   norm <n>                — transponder to NORMAL (restores the unit's assigned squawk code)
 *   squawk <code> <n>       — set unit <n>'s squawk code (4 octal digits, e.g. "squawk 2000 1")
 *
 * Airfield surface traffic (for ASDE-X — current theatre's client/public/runways/<Theatre>.json):
 *   ground <cs> <airbase> [rwy <nn>] [<type>] [<coal>] [D<m>] [O<m>] [S<spd>] [H<hdg>]
 *                           — spawn on the ground at field elevation. Default position is the
 *                             runway threshold; D = metres down the runway, O = metres right of
 *                             centreline (negative = left). <airbase> is an ICAO code (e.g. "URKA")
 *                             or a case-insensitive name substring (e.g. "anapa"). Taxi with h/s.
 *   <n> takeoff [rwy <nn>]  — takeoff roll from current position (or snap to runway <nn>), climb out
 *   <n> land <airbase> [rwy <nn>] [at <nm>]
 *                           — 3° final (default 4 NM), touch down, roll out to taxi speed
 *   asdex <airbase> [rwy <nn>]
 *                           — preset: parked/taxiing/departing/arriving traffic, one transponder
 *                             on standby, one hovering helicopter
 *
 * Also serves a relay-compatible `/transponders` WebSocket on the same port (any password
 * accepted, matching the REST API) — point a real TRACS backend's "Relay Port" field at this
 * same host:port to receive live squawk data for correlation/Beaconator/IDENT testing without
 * a real SRS/relay/DCS session.
 */

const http     = require('http')
const readline = require('readline')
const fs       = require('fs')
const path     = require('path')
const { DI }   = require('../server/src/decoder.js')
const { WebSocketServer } = require('ws')

const PORT = 4001

// ─── Transponder (synthetic SRS/IFF) constants ─────────────────────────────────

const IFF_STATUS = { OFF: 0, NORMAL: 1, IDENT: 2 }
const IDENT_DURATION_MS = 8000

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

// Airfield surface traffic (ground/takeoff/land/asdex commands)
const M_PER_NM             = 1852
const GROUND_TURN_RATE_RPS = 20 * DEG_TO_RAD  // taxi turns, much tighter than standard rate
const TAXI_KTS             = 15
const ROTATE_KTS           = 140
const TAKEOFF_TARGET_KTS   = 160
const CLIMB_OUT_KTS        = 250
const CLIMB_OUT_FT_AGL     = 3000
const LANDING_SPD_KTS      = 140
const LANDING_GS_DEG       = 3.0
const LANDING_RANGE_NM     = 4
const HELO_TYPES           = new Set(['UH-1H', 'AH-64D_BLK_II', 'Mi-8MT', 'Mi-24P', 'Ka-50', 'SA342M', 'CH-47Fbl1', 'UH-60A', 'OH58D'])

// ─── Weapons (missile fire simulation) ─────────────────────────────────────────
// Straight-line flight only (no homing/target lock) — enough to exercise
// AIC/ABM missile detection/rendering/history trails end-to-end. Default
// weapon is AGM_84A (Harpoon, RCS 0.1 m^2 — right at the trackable threshold
// in server/src/weaponDatabase.js), a realistic real-world large air-launched
// missile; small AAMs like AIM-120 are deliberately NOT trackable (RCS 0.07),
// matching the real threshold's intent of excluding them.
const DEFAULT_MISSILE_NAME = 'AGM_84A'
const MISSILE_SPEED_KTS    = 550    // subsonic ASM cruise speed, ballpark
const MISSILE_LIFETIME_MS  = 25000  // time-of-flight before "impact"/removal

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
  'a-10': 'A-10C',          'a10':  'A-10C',
  'c-130':'C-130',          'c130': 'C-130',
  'uh-1': 'UH-1H',          'uh1':  'UH-1H',   'huey': 'UH-1H',
  'ah-64':'AH-64D_BLK_II',  'ah64': 'AH-64D_BLK_II',
  'yak-52':'Yak-52',        'yak52':'Yak-52',
}

const COALITION_MAP = { blu: 2, blue: 2, red: 1, neu: 0, neutral: 0 }

function resolveType(input) {
  return TYPE_ALIASES[input.toLowerCase()] ?? input
}

// Aircraft + helicopters — everything with a transponder, controllable by number
function isAirframe(u) {
  return u.category === 'Aircraft' || u.category === 'Helicopter'
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

// ─── Synthetic transponder (SRS/IFF) state ─────────────────────────────────────
// Aircraft only — mirrors real SRS: mode1/mode2 unused for civilian correlation,
// mode3 is the 4-digit octal-style squawk (-1/blanked while OFF, same as real SRS
// resetting `iff` to a blank Transponder on status OFF), mode4 unused, status is
// 0 OFF / 1 NORMAL / 2 IDENT.

function randomSquawk() {
  return parseInt(Array.from({ length: 4 }, () => Math.floor(Math.random() * 8)).join(''), 10)
}

// The outgoing wire shape for a unit's transponder — squawk is remembered even
// while OFF so `norm` can restore it, but the transponder object itself blanks
// mode3 while OFF, matching real SRS's ServerState.cs behavior.
function transponderOf(unit) {
  if (unit.iffStatus === IFF_STATUS.OFF) {
    return { mode1: -1, mode2: -1, mode3: -1, mode4: false, status: IFF_STATUS.OFF }
  }
  return { mode1: -1, mode2: -1, mode3: unit.squawk, mode4: false, status: unit.iffStatus }
}

// Relay-compatible `/transponders` WebSocket clients (wired up near the HTTP
// server below) — same wire protocol as relay/transponders.js:
// {type:'transponders', data:{unitId: {...}}}.
const transponderClients = new Set()

function buildTransponderSnapshot() {
  const data = {}
  for (const u of units.values()) {
    if (!isAirframe(u)) continue
    data[String(u.id)] = transponderOf(u)
  }
  return data
}

function broadcastTransponders() {
  if (transponderClients.size === 0) return
  const payload = JSON.stringify({ type: 'transponders', data: buildTransponderSnapshot() })
  for (const ws of transponderClients) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
}

// Add flight control state to each unit
const units = new Map(unitDefs.map((u) => [u.id, {
  ...u,
  contacts:  [...u.contacts],
  turnDir:   null,   // 'r' | 'l' | null
  targetHdg: null,   // radians, null = no turn commanded
  targetAlt: null,   // meters, null = no altitude commanded
  targetSpd: null,   // knots, null = no speed commanded
  ...(isAirframe(u) ? { squawk: randomSquawk(), iffStatus: IFF_STATUS.NORMAL, identTimer: null } : {}),
}]))

// Fired missiles — keyed by synthetic weapon id (see cmdFire). Offset well
// above the unit id space (unitDefs/create both stay in the low thousands)
// so weapon ids can never collide with a unit id.
const weapons = new Map()
let nextWeaponId = 90000001

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
  Iraq:           { lat: 33.26,  lng: 44.23,  hdg: Math.PI / 2, bullseyeLat: 33.50,  bullseyeLng: 44.40  },
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
  const step   = (unit.onGround ? GROUND_TURN_RATE_RPS : TURN_RATE_RPS) * dt

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

// Straight-line advance + lifetime expiry — no homing, no terrain/impact
// detection, just enough to make a missile move and eventually disappear.
function moveWeapons(dt) {
  const now = Date.now()
  for (const [id, w] of weapons) {
    if (now - w.bornAt >= MISSILE_LIFETIME_MS) {
      weapons.delete(id)
      console.log(`\n  Weapon ${id} (${w.name}): impact/expired`)
      rl.prompt()
      continue
    }
    const distDeg = w.spd * dt * NM_PER_SEC * NM_DEG
    w.lat += Math.cos(w.hdg) * distDeg
    w.lng += Math.sin(w.hdg) * distDeg
  }
}

function moveUnits() {
  const now     = Date.now()
  const dt      = Math.min((now - lastMovedAt) / 1000, 1.0)
  lastMovedAt   = now

  const toDelete = []

  for (const unit of units.values()) {
    // PAR aircraft: stepParApproach controls position directly — skip generic advance
    // Longitude needs 1/cos(lat) — without it east/west motion covers too
    // little ground and the path disagrees with the reported track.
    if (!unit.parApproach) {
      const distDeg = unit.spd * dt * NM_PER_SEC * NM_DEG
      unit.lat += Math.cos(unit.hdg) * distDeg
      unit.lng += Math.sin(unit.hdg) * distDeg / Math.cos(unit.lat * DEG_TO_RAD)
    }

    if (unit.category === 'NavyUnit') {
      // Carrier: steady course unless a heading has been commanded
      if (unit.targetHdg !== null) applyTurn(unit, dt)
    } else if (unit.parApproach) {
      const onDeck = stepParApproach(unit, dt)
      if (onDeck && unit.parApproach.rollout) touchdown(unit)
      else if (onDeck) toDelete.push(unit.id)
    } else if (unit.onGround) {
      // Surface: no drift, no climb, pinned to field elevation
      applyTurn(unit, dt)
      applySpeed(unit, dt)
      unit.alt = unit.groundElevM
      if (unit.takeoffRoll && unit.spd >= unit.takeoffRoll.rotateKts) liftoff(unit)
    } else if (unit.targetHdg !== null) {
      // Under positive heading control — execute commanded turn, no drift
      applyTurn(unit, dt)
      applyClimb(unit, dt)
      applySpeed(unit, dt)
    } else {
      // Free flight — gentle random heading drift (not while hovering/stopped)
      if (unit.spd >= 1) unit.hdg = normalizeAngle(unit.hdg + (Math.random() - 0.5) * 0.02)
      applyClimb(unit, dt)
      applySpeed(unit, dt)
    }
  }

  if (toDelete.length) {
    for (const id of toDelete) {
      const u = units.get(id)
      units.delete(id)
      console.log(`\n  ${u?.unitName ?? id}: on deck - removed`)
      rl.prompt()
    }
    broadcastTransponders()
  }

  moveWeapons(dt)

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
    w.uint8(DI.airborne);  w.bool(!unit.onGround)

    w.uint8(DI.endOfData)
  }

  return w.build()
}

// Weapons — deliberately a narrower field set than encodeUnitsBuffer (no
// unitName/contacts/airborne — real Olympus's /olympus/weapons response is
// sparser too), but decodeUnits() is fully field-tagged so this is fine.
function encodeWeaponsBuffer() {
  const w = new Writer()
  w.uint64(serverTime)

  for (const weapon of weapons.values()) {
    w.uint32(weapon.id)

    w.uint8(DI.category);  w.string(weapon.category)
    w.uint8(DI.alive);     w.bool(true)
    w.uint8(DI.coalition); w.uint8(weapon.coalition)
    w.uint8(DI.name);      w.string(weapon.name)
    w.uint8(DI.position);  w.coords(weapon.lat, weapon.lng, weapon.alt)
    w.uint8(DI.speed);     w.float64(weapon.spd * KNOTS_TO_MS)
    w.uint8(DI.heading);   w.float64(weapon.hdg)
    w.uint8(DI.track);     w.float64(weapon.hdg)

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

// Always a full snapshot, matching real Olympus's own /olympus/weapons
// quirk that server/src/olympus.js's pollWeapons() already works around by
// always fetching with time=0 — see that function's header comment.
function handleWeapons(req, res) {
  moveUnits()
  const body = encodeWeaponsBuffer()
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

function loadAirbases() {
  const file = path.join(__dirname, '..', 'client', 'public', 'runways', `${theatre}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).airbases ?? []
  } catch {
    return []
  }
}

function handleAirbases(req, res) {
  try {
    const result = loadAirbases().map((ab) => {
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
    .filter(isAirframe)
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
  if (unit.takeoffRoll)          parts.push('T/O ROLL')
  else if (unit.onGround)        parts.push('GND')
  if (unit.parApproach?.rollout) parts.push(`FINAL ${unit.parApproach.airbase}`)
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

function sqkStr(unit) {
  if (unit.iffStatus === undefined) return ''
  if (unit.iffStatus === IFF_STATUS.OFF) return 'SQK OFF '
  const code = String(unit.squawk).padStart(4, '0')
  return unit.iffStatus === IFF_STATUS.IDENT ? `SQK ${code}*` : `SQK ${code} `
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
    const sqk  = sqkStr(u).padEnd(9)
    console.log(`  ${num}  ${name}  ${type}  ${coal}  ${sqk} HDG ${hdg}  SPD ${spd}kt  ALT ${alt}ft${unitStatus(u)}`)
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
    squawk: randomSquawk(), iffStatus: IFF_STATUS.NORMAL, identTimer: null,
  })

  console.log(`  Created: ${callsign} (${typeName}) ${coalStr} HDG ${String(hdgDegNew).padStart(3,'0')} SPD ${spdKts}kt ALT ${altHundreds * 100}ft`)
  printList()
  broadcastTransponders()
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
    console.log(`  Theatre: ${theatre}  - carrier and ${[...units.values()].filter(u => u.category === 'Aircraft').length} aircraft translated`)
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
  clearTimeout(unit.identTimer)
  units.delete(ids[idx])
  console.log(`  Deleted: ${unit.unitName}`)
  printList()
  broadcastTransponders()
}

// ── fire <n> <hdg> [<weapon>] ─────────────────────────────────────────────────

function cmdFire(parts) {
  const ids = getAircraftIds()
  const idx = parseInt(parts[1], 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) {
    console.log(`  Unknown unit number: ${parts[1]}`)
    return
  }

  const hdgVal = parseInt(parts[2], 10)
  if (isNaN(hdgVal) || hdgVal < 0 || hdgVal > 360) {
    console.log('  Usage: fire <n> <hdg> [<weapon>]  (e.g. fire 3 090 AGM_84A)')
    return
  }

  const shooter    = units.get(ids[idx])
  const weaponName = parts[3] || DEFAULT_MISSILE_NAME
  const id         = nextWeaponId++

  weapons.set(id, {
    id,
    name:      weaponName,
    category:  'Missile',
    coalition: shooter.coalition,
    lat:       shooter.lat,
    lng:       shooter.lng,
    alt:       shooter.alt,
    hdg:       normalizeAngle(hdgVal * DEG_TO_RAD),
    spd:       MISSILE_SPEED_KTS,
    bornAt:    Date.now(),
  })

  console.log(`  ${shooter.unitName}: ${weaponName} away, heading ${String(hdgVal).padStart(3, '0')}°`)
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
  unit.unitName = parts.quoted.has(2) ? parts[2] : parts.slice(2).join(' ').toUpperCase()
  console.log(`  Renamed: ${oldName} → ${unit.unitName}`)
  printList()
}

// ── ident/stby/norm <n>, squawk <code> <n> — synthetic transponder control ───

function resolveAircraft(idxStr) {
  const ids = getAircraftIds()
  const idx = parseInt(idxStr, 10) - 1
  if (isNaN(idx) || idx < 0 || idx >= ids.length) return null
  return units.get(ids[idx])
}

function cmdIdent(parts) {
  const unit = resolveAircraft(parts[1])
  if (!unit) { console.log(`  Unknown unit number: ${parts[1]}`); return }
  if (unit.iffStatus === undefined) { console.log(`  ${unit.unitName}: no transponder`); return }

  clearTimeout(unit.identTimer)
  unit.iffStatus = IFF_STATUS.IDENT
  console.log(`  ${unit.unitName}: IDENT (squawk ${String(unit.squawk).padStart(4, '0')})`)
  broadcastTransponders()

  unit.identTimer = setTimeout(() => {
    if (unit.iffStatus !== IFF_STATUS.IDENT) return // manually changed during the hold — don't clobber
    unit.iffStatus = IFF_STATUS.NORMAL
    console.log(`\n  ${unit.unitName}: IDENT ended`)
    broadcastTransponders()
    rl.prompt()
  }, IDENT_DURATION_MS)
}

function cmdStby(parts) {
  const unit = resolveAircraft(parts[1])
  if (!unit) { console.log(`  Unknown unit number: ${parts[1]}`); return }
  if (unit.iffStatus === undefined) { console.log(`  ${unit.unitName}: no transponder`); return }

  clearTimeout(unit.identTimer)
  unit.iffStatus = IFF_STATUS.OFF
  console.log(`  ${unit.unitName}: transponder STANDBY (squawk blanked)`)
  broadcastTransponders()
}

function cmdNorm(parts) {
  const unit = resolveAircraft(parts[1])
  if (!unit) { console.log(`  Unknown unit number: ${parts[1]}`); return }
  if (unit.iffStatus === undefined) { console.log(`  ${unit.unitName}: no transponder`); return }

  clearTimeout(unit.identTimer)
  unit.iffStatus = IFF_STATUS.NORMAL
  console.log(`  ${unit.unitName}: transponder NORMAL (squawk ${String(unit.squawk).padStart(4, '0')})`)
  broadcastTransponders()
}

function cmdSquawk(parts) {
  if (!/^[0-7]{1,4}$/.test(parts[1] ?? '')) {
    console.log('  Usage: squawk <code> <n>  - code is 1-4 octal digits (0-7), e.g. squawk 2000 1')
    return
  }
  const unit = resolveAircraft(parts[2])
  if (!unit) { console.log(`  Unknown unit number: ${parts[2]}`); return }
  if (unit.iffStatus === undefined) { console.log(`  ${unit.unitName}: no transponder`); return }

  unit.squawk = parseInt(parts[1], 10)
  console.log(`  ${unit.unitName}: squawk set to ${String(unit.squawk).padStart(4, '0')}`)
  broadcastTransponders()
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

  startApproach(unit, {
    threshLat, threshLng, inboundHdgRad: normalizeAngle(inboundHdgDeg * DEG_TO_RAD),
    gsAngleDeg, deckHeightFt, approachSpd, rangeNm, devFactor, carrierId,
  })

  const fbStr = Math.round(inboundHdgDeg).toString().padStart(3, '0')
  const altFt = Math.round((unit.alt / FT_TO_M))
  console.log(`  ${unit.unitName}: PAR ${modeName}  FB ${fbStr}°  GS ${gsAngleDeg}°  ${rangeNm}NM  ${altFt}ft  ${approachSpd}kt`)
}

// Put a unit on a glidepath <rangeNm> out from the threshold and hand it to
// stepParApproach. Shared by `par` (carrier/airfield PAR) and `land`.
// opts.rollout: on touchdown, convert to a ground unit instead of deleting.
function startApproach(unit, opts) {
  const { threshLat, threshLng, inboundHdgRad, gsAngleDeg, deckHeightFt, approachSpd, rangeNm } = opts
  const outboundHdgRad = normalizeAngle(inboundHdgRad + Math.PI)

  const cosLat = Math.cos(threshLat * DEG_TO_RAD)
  unit.lat = threshLat + Math.cos(outboundHdgRad) * rangeNm * NM_DEG
  unit.lng = threshLng + Math.sin(outboundHdgRad) * rangeNm * NM_DEG / cosLat
  unit.alt = (deckHeightFt + rangeNm * NM_TO_FEET * Math.tan(gsAngleDeg * DEG_TO_RAD)) * FT_TO_M
  unit.hdg = inboundHdgRad
  unit.spd = approachSpd
  unit.targetHdg   = null
  unit.targetAlt   = null
  unit.targetSpd   = null
  unit.onGround    = false
  unit.takeoffRoll = null

  unit.parApproach = {
    threshLat, threshLng, inboundHdgRad, gsAngleDeg, deckHeightFt, approachSpd,
    rangeNm,
    vertTolFt: rangeNm * NM_TO_FEET * Math.tan(GS_TOL_DEG * DEG_TO_RAD),
    latTolNm:  rangeNm * Math.tan(AZ_TOL_DEG * DEG_TO_RAD),
    devFactor: opts.devFactor ?? 0,
    altDevFt: 0, latDevNm: 0, carrierId: opts.carrierId ?? null,
    rollout:  !!opts.rollout,
    airbase:  opts.airbase ?? null,
  }
}

// ─── Airfield surface traffic ─────────────────────────────────────────────────

// Same DCS-name -> ICAO mapping the client uses (client/public/icaoMapping.json)
function loadIcaoMap() {
  const file = path.join(__dirname, '..', 'client', 'public', 'icaoMapping.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))[theatre.toLowerCase()] ?? {}
  } catch {
    return {}
  }
}

// <name> is an ICAO code (e.g. URKA) or a case-insensitive DCS-name substring (e.g. anapa)
function findAirbase(name) {
  const q   = (name ?? '').toLowerCase()
  const abs = loadAirbases()
  if (!q) return null
  const icaoMap = loadIcaoMap()
  const byIcao  = Object.keys(icaoMap).find(dcsName => icaoMap[dcsName].toLowerCase() === q)
  return (byIcao && abs.find(a => a.airbase === byIcao))
      ?? abs.find(a => a.airbase.toLowerCase() === q)
      ?? abs.find(a => a.airbase.toLowerCase().includes(q))
      ?? null
}

function printAirbaseNames() {
  const icaoMap = loadIcaoMap()
  const names   = loadAirbases().map(a => icaoMap[a.airbase] ? `${icaoMap[a.airbase]} (${a.airbase})` : a.airbase)
  console.log(names.length ? `  Airbases in ${theatre}: ${names.join(', ')}` : `  No runway data for ${theatre}`)
}

function angDistDeg(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360)
  return d > 180 ? 360 - d : d
}

// Every landing/takeoff direction at an airbase, same convention as the
// client's STARS centerlines (client/src/store/runways.js): rwy.name is the
// primary designator; its landing direction is -course_true_deg oriented to
// within 90° of name*10; the threshold is whichever end that direction
// departs from. Headings use the end1/end2 geometry.
function runwayDirections(ab) {
  const dirs = []
  const seen = new Set()
  for (const r of ab.runways ?? []) {
    if (r.end1?.lat == null || r.end2?.lat == null || r.course_true_deg == null) continue

    const primName  = r.name
    const recipName = ((r.name + 18) % 36) || 36
    let primHdgDeg  = ((-r.course_true_deg) % 360 + 360) % 360
    if (angDistDeg(primHdgDeg - magvarDeg, primName * 10) > 90) primHdgDeg = (primHdgDeg + 180) % 360

    const e2ToE1   = bearingRad(r.end2.lat, r.end2.lon, r.end1.lat, r.end1.lon)
    const fromEnd2 = angDistDeg(primHdgDeg, e2ToE1 * RAD_TO_DEG) <= 90
    const primThr  = fromEnd2 ? r.end2 : r.end1
    const recipThr = fromEnd2 ? r.end1 : r.end2
    const primHdg  = fromEnd2 ? e2ToE1 : normalizeAngle(e2ToE1 + Math.PI)

    const elevFt = r.elevation_ft ?? 0
    const lenM   = distNm(r.end1.lat, r.end1.lon, r.end2.lat, r.end2.lon) * M_PER_NM
    const add = (name, thr, hdgRad) => {
      const ident = String(name).padStart(2, '0')
      if (seen.has(ident)) return // DCS lists some strips once per direction
      seen.add(ident)
      dirs.push({ ident, threshLat: thr.lat, threshLng: thr.lon, hdgRad, elevFt, lenM })
    }
    add(primName,  primThr,  primHdg)
    add(recipName, recipThr, normalizeAngle(primHdg + Math.PI))
  }
  return dirs
}

// Runway direction by designator (e.g. "22"), or the first one if none given.
function pickRunway(ab, ident) {
  const dirs = runwayDirections(ab)
  if (!dirs.length) return null
  if (ident == null) return dirs[0]
  const n = parseInt(ident, 10)
  const match = dirs.find(d => parseInt(d.ident, 10) === n)
  if (!match) console.log(`  ${ab.airbase}: no runway ${ident} (have ${dirs.map(d => d.ident).join(', ')})`)
  return match ?? null
}

// Point <alongM> metres down the runway heading and <rightM> metres right of it
function offsetPoint(lat, lng, hdgRad, alongM, rightM) {
  const along  = alongM / M_PER_NM
  const right  = rightM / M_PER_NM
  const rh     = hdgRad + Math.PI / 2
  const cosLat = Math.cos(lat * DEG_TO_RAD)
  return {
    lat: lat + (Math.cos(hdgRad) * along + Math.cos(rh) * right) * NM_DEG,
    lng: lng + (Math.sin(hdgRad) * along + Math.sin(rh) * right) * NM_DEG / cosLat,
  }
}

function spawnGroundUnit({ callsign, typeName, coalition, lat, lng, elevFt, hdgRad, spd, airbase }) {
  const id = Math.max(...units.keys()) + 1
  const groundElevM = elevFt * FT_TO_M
  const unit = {
    id,
    unitName:  callsign,
    name:      typeName,
    category:  HELO_TYPES.has(typeName) ? 'Helicopter' : 'Aircraft',
    coalition,
    lat, lng,
    alt:       groundElevM,
    hdg:       normalizeAngle(hdgRad),
    spd,
    contacts:  [],
    turnDir:   null, targetHdg: null, targetAlt: null, targetSpd: null,
    squawk: randomSquawk(), iffStatus: IFF_STATUS.NORMAL, identTimer: null,
    onGround:  true, groundElevM, homeBase: airbase, takeoffRoll: null,
  }
  units.set(id, unit)
  return unit
}

function liftoff(unit) {
  unit.onGround    = false
  unit.takeoffRoll = null
  unit.targetAlt   = unit.groundElevM + CLIMB_OUT_FT_AGL * FT_TO_M
  unit.targetSpd   = CLIMB_OUT_KTS
  console.log(`\n  ${unit.unitName}: airborne - climbing to ${Math.round(unit.targetAlt / FT_TO_M)}ft`)
  rl?.prompt()
}

function touchdown(unit) {
  const pa = unit.parApproach
  unit.parApproach = null
  unit.onGround    = true
  unit.groundElevM = pa.deckHeightFt * FT_TO_M
  unit.alt         = unit.groundElevM
  unit.hdg         = pa.inboundHdgRad
  unit.homeBase    = pa.airbase
  unit.targetSpd   = TAXI_KTS
  console.log(`\n  ${unit.unitName}: touchdown at ${pa.airbase} - rolling out to ${TAXI_KTS}kt`)
  rl?.prompt()
}

// ground <cs> <airbase> [rwy <nn>] [<type>] [<coal>] [D<m>] [O<m>] [S<spd>] [H<hdg>]
function cmdGround(parts) {
  if (parts.length < 3) {
    console.log('  Usage: ground <cs> <airbase> [rwy <nn>] [<type>] [<coal>] [D<m>] [O<m>] [S<spd>] [H<hdg>]')
    console.log('  e.g.   ground AAL101 URKA rwy 04 C-130 O120 D300 S15')
    return
  }
  const callsign = parts[1]
  const ab = findAirbase(parts[2])
  if (!ab) { console.log(`  Unknown airbase: ${parts[2]}`); printAirbaseNames(); return }

  let ident = null, typeName = 'FA-18C_hornet', coalition = 2
  let alongM = 0, rightM = 0, spd = 0, hdgOverride = null
  for (let i = 3; i < parts.length; i++) {
    const tok = parts[i]
    const opt = tok.match(/^([DOSH])(-?\d+)$/i)
    if (tok.toLowerCase() === 'rwy') { ident = parts[++i]; continue }
    if (opt) {
      const v = parseInt(opt[2], 10)
      const k = opt[1].toUpperCase()
      if (k === 'D') alongM      = v
      if (k === 'O') rightM      = v
      if (k === 'S') spd         = v
      if (k === 'H') hdgOverride = v
      continue
    }
    if (COALITION_MAP[tok.toLowerCase()] !== undefined) { coalition = COALITION_MAP[tok.toLowerCase()]; continue }
    typeName = resolveType(tok)
  }

  const rw = pickRunway(ab, ident)
  if (!rw) return
  const pos    = offsetPoint(rw.threshLat, rw.threshLng, rw.hdgRad, alongM, rightM)
  const hdgRad = hdgOverride != null ? hdgOverride * DEG_TO_RAD : rw.hdgRad
  spawnGroundUnit({
    callsign, typeName, coalition, lat: pos.lat, lng: pos.lng,
    elevFt: rw.elevFt, hdgRad, spd, airbase: ab.airbase,
  })
  console.log(`  Created on ground: ${callsign} (${typeName}) at ${ab.airbase} rwy ${rw.ident}  ${spd}kt  elev ${Math.round(rw.elevFt)}ft`)
  printList()
  broadcastTransponders()
}

// <n> takeoff [rwy <nn>]
function cmdTakeoff(parts) {
  const unit = resolveAircraft(parts[0])
  if (!unit) { console.log(`  Unknown unit number: ${parts[0]}`); return }
  if (!unit.onGround) { console.log(`  ${unit.unitName}: not on the ground`); return }

  const rwyIdx = parts.findIndex(p => p.toLowerCase() === 'rwy')
  if (rwyIdx >= 0) {
    const ab = unit.homeBase ? findAirbase(unit.homeBase) : null
    if (!ab) { console.log(`  ${unit.unitName}: unknown home airbase`); return }
    const rw = pickRunway(ab, parts[rwyIdx + 1])
    if (!rw) return
    unit.lat = rw.threshLat
    unit.lng = rw.threshLng
    unit.hdg = rw.hdgRad
    unit.spd = 0
    unit.groundElevM = rw.elevFt * FT_TO_M
  }
  unit.targetHdg   = null
  unit.turnDir     = null
  unit.takeoffRoll = { rotateKts: ROTATE_KTS }
  unit.targetSpd   = TAKEOFF_TARGET_KTS
  console.log(`  ${unit.unitName}: takeoff roll, heading ${hdgDeg(unit)}`)
}

// <n> land <airbase> [rwy <nn>] [at <nm>]
function cmdLand(parts) {
  const unit = resolveAircraft(parts[0])
  if (!unit) { console.log(`  Unknown unit number: ${parts[0]}`); return }
  const ab = findAirbase(parts[2])
  if (!ab) { console.log(`  Unknown airbase: ${parts[2] ?? ''}`); printAirbaseNames(); return }

  let ident = null, rangeNm = LANDING_RANGE_NM
  for (let i = 3; i < parts.length; i++) {
    const tok = parts[i].toLowerCase()
    if (tok === 'rwy') ident = parts[++i]
    else if (tok === 'at') rangeNm = parseFloat(parts[++i]) || rangeNm
  }
  const rw = pickRunway(ab, ident)
  if (!rw) return

  startApproach(unit, {
    threshLat: rw.threshLat, threshLng: rw.threshLng, inboundHdgRad: rw.hdgRad,
    gsAngleDeg: LANDING_GS_DEG, deckHeightFt: rw.elevFt, approachSpd: LANDING_SPD_KTS,
    rangeNm, rollout: true, airbase: ab.airbase,
  })
  console.log(`  ${unit.unitName}: ${rangeNm}NM final ${ab.airbase} rwy ${rw.ident}`)
}

// asdex <airbase> [rwy <nn>] — one-shot ASDE-X test scenario
function cmdAsdex(parts) {
  const ab = findAirbase(parts[1])
  if (!ab) { console.log(`  Usage: asdex <airbase> [rwy <nn>]  - unknown airbase: ${parts[1] ?? ''}`); printAirbaseNames(); return }
  const rwyIdx = parts.findIndex(p => p.toLowerCase() === 'rwy')
  const rw = pickRunway(ab, rwyIdx >= 0 ? parts[rwyIdx + 1] : null)
  if (!rw) return

  const SIDE   = 120 // metres right of centreline — "beside the runway"
  const facing = normalizeAngle(rw.hdgRad - Math.PI / 2) // parked, nose toward the runway
  const at     = (alongM, rightM) => offsetPoint(rw.threshLat, rw.threshLng, rw.hdgRad, alongM, rightM)
  const spawn  = (callsign, typeName, p, hdgRad) => spawnGroundUnit({
    callsign, typeName, coalition: 2, lat: p.lat, lng: p.lng,
    elevFt: rw.elevFt, hdgRad, spd: 0, airbase: ab.airbase,
  })

  const park1 = spawn('AAL101', 'C-130',         at(150, SIDE),           facing)
  const park2 = spawn('DAL202', 'KC135MPRS',     at(rw.lenM - 150, SIDE), facing)
  const taxi  = spawn('UAL303', 'F-16C_50',      at(300, SIDE),           rw.hdgRad)
  taxi.targetSpd = TAXI_KTS
  const dep   = spawn('SWA404', 'FA-18C_hornet', at(0, 0),                rw.hdgRad)
  const stby  = spawn('N123AB', 'Yak-52',        at(600, SIDE),           facing)
  stby.iffStatus = IFF_STATUS.OFF
  // Same code as the taxiing F-16 — associate either one to see DUP BCN
  park2.squawk = taxi.squawk

  const helo  = spawn('LIFE1', 'UH-1H', at(rw.lenM / 2, SIDE * 2), rw.hdgRad)
  helo.onGround = false
  helo.alt      = (rw.elevFt + 50) * FT_TO_M

  // Arrival: put straight onto final, rolls out on touchdown
  const arr = spawn('JBU505', 'A-10C', at(0, 0), rw.hdgRad)
  startApproach(arr, {
    threshLat: rw.threshLat, threshLng: rw.threshLng, inboundHdgRad: rw.hdgRad,
    gsAngleDeg: LANDING_GS_DEG, deckHeightFt: rw.elevFt, approachSpd: LANDING_SPD_KTS,
    rangeNm: LANDING_RANGE_NM, rollout: true, airbase: ab.airbase,
  })

  setTimeout(() => {
    if (!units.has(dep.id) || !dep.onGround || dep.takeoffRoll) return
    dep.takeoffRoll = { rotateKts: ROTATE_KTS }
    dep.targetSpd   = TAKEOFF_TARGET_KTS
    console.log(`\n  ${dep.unitName}: takeoff roll`)
    rl?.prompt()
  }, 5000)

  const sq = (u) => String(u.squawk).padStart(4, '0')
  console.log(`  ASDE-X scenario at ${ab.airbase} rwy ${rw.ident} (elev ${Math.round(rw.elevFt)}ft):`)
  console.log(`    ${park1.unitName}  parked near the threshold`)
  console.log(`    ${park2.unitName}  parked near the far end, squawking ${sq(park2)} (same as ${taxi.unitName})`)
  console.log(`    ${taxi.unitName}  taxiing at ${TAXI_KTS}kt beside the runway, squawking ${sq(taxi)}`)
  console.log(`    ${dep.unitName}  lined up - takeoff roll in 5s`)
  console.log(`    ${arr.unitName}  on ${LANDING_RANGE_NM}NM final - lands and rolls out`)
  console.log(`    ${stby.unitName}  parked, transponder STANDBY (Unknown Target)`)
  console.log(`    ${helo.unitName}   helicopter hovering 50ft AGL`)
  console.log(`  Log in to TRACS with facility "${ab.airbase}" and open ASDEX.`)
  console.log(`  Point TRACS's Relay Port at this server for SRS/transponder behaviour (Unknown Target, beacon codes, DUP BCN).`)
  console.log(`  DUP BCN also needs ${taxi.unitName} or ${park2.unitName} associated: file a plan for it with code ${sq(taxi)}.`)
  printList()
  broadcastTransponders()
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

// Splits on whitespace, but a "double" or 'single' quoted run is one token,
// kept verbatim (spaces, pipes, case), so pilot-style names like
// "203 | COLT 1-1 | DENIM" can be given to create/rename. The quoted tokens'
// indices are returned in `parts.quoted`.
function tokenize(line) {
  const parts = []
  parts.quoted = new Set()
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(line)) !== null) {
    if (m[3] === undefined) parts.quoted.add(parts.length)
    parts.push(m[1] ?? m[2] ?? m[3])
  }
  return parts
}

function parseCommand(line) {
  const parts = tokenize(line.trim())
  if (!parts[0]) return

  const first  = parts[0].toLowerCase()
  const second = (parts[1] ?? '').toLowerCase()

  if (first === 'list' || first === 'refresh') { printList(); return }
  if (first === 'create')  { cmdCreate(parts);  return }
  if (first === 'theatre') { cmdTheatre(parts); return }
  if (first === 'delete')  { cmdDelete(parts);  return }
  if (first === 'fire')    { cmdFire(parts);    return }
  if (first === 'rename')  { cmdRename(parts);  return }
  if (first === 'ident')   { cmdIdent(parts);   return }
  if (first === 'stby')    { cmdStby(parts);    return }
  if (first === 'norm')    { cmdNorm(parts);    return }
  if (first === 'squawk')  { cmdSquawk(parts);  return }
  if (first === 'brc')     { cmdBrc(parts);     return }
  if (first === 'fb')      { cmdFb(parts);      return }
  if (first === 'magvar')  { cmdMagvar(parts);  return }
  if (first === 'ground')  { cmdGround(parts);  return }
  if (first === 'asdex')   { cmdAsdex(parts);   return }
  if (second === 'par')    { cmdPar(parts);     return }
  if (second === 'takeoff') { cmdTakeoff(parts); return }
  if (second === 'land')   { cmdLand(parts);    return }
  cmdControl(parts)
}

function startConsole() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  printList()
  console.log('Commands:')
  console.log('  <n> tr|tl <hdg>             turn right/left to heading')
  console.log('  <n> h <hdg>                 turn shortest direction to heading')
  console.log('  <n> m <alt>                 climb or descend (hundreds of feet, e.g. 050 = 5000ft)')
  console.log('  <n> c <alt>                 climb only - ignored if already at or above')
  console.log('  <n> d <alt>                 descend only - ignored if already at or below')
  console.log('  <n> s <spd>                 set speed (KTAS)')
  console.log('  create <cs> [<type>] [<coal>] [H S A]  e.g. create HORNET41 FA-18C BLU H210 S310 A250')
  console.log('                              <cs> may be quoted: create "203 | COLT 1-1 | DENIM" FA-18C BLU')
  console.log('  delete <n>                  remove a unit')
  console.log('  rename <n> <callsign>       rename a unit ("quoted names" keep spaces, | and case)')
  console.log('  fire <n> <hdg> [<weapon>]   launch a missile from <n> on heading <hdg> (default AGM_84A)')
  console.log('  ident <n>                   squawk IDENT (blinks a few seconds, then reverts to NORMAL)')
  console.log('  stby <n>                    transponder to STANDBY/OFF (blanks squawk)')
  console.log('  norm <n>                    transponder to NORMAL (restores squawk)')
  console.log('  squawk <code> <n>           set squawk code (4 octal digits, e.g. squawk 2000 1)')
  console.log('  theatre [name]              show or set theatre (translates carrier + aircraft to default position)')
  console.log('  <n> par [at <nm>] [gs <°>] [spd <kt>] [dev <0-1>]   fly PAR to carrier (dev=0 perfect)')
  console.log('  <n> par rwy <lat> <lng> <hdg> [...]                  fly PAR to airfield')
  console.log('  ground <cs> <airbase> [rwy <nn>] [<type>] [<coal>] [D<m>] [O<m>] [S<spd>] [H<hdg>]')
  console.log('                              spawn on the ground (D = m down runway, O = m right of centreline)')
  console.log('                              <airbase> = ICAO (URKA) or part of the DCS name (anapa)')
  console.log('  <n> takeoff [rwy <nn>]      takeoff roll and climb out')
  console.log('  <n> land <airbase> [rwy <nn>] [at <nm>]   3 deg final, touch down, roll out to taxi speed')
  console.log('  asdex <airbase> [rwy <nn>]  ASDE-X test scenario (parked/taxi/departure/arrival/standby/helo)')
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
  if (path === '/olympus/weapons')    return handleWeapons(req, res)
  if (path === '/olympus/mission')    return handleMission(req, res)
  if (path === '/olympus/airbases')   return handleAirbases(req, res)
  if (path === '/olympus/bullseyes')  return handleBullseyes(req, res)

  json(res, { error: 'Not found' }, 404)
})

// ─── Relay-compatible `/transponders` WebSocket ────────────────────────────────
// Same wire protocol as relay/transponders.js (client sends {type:'auth',password},
// server replies with a snapshot then pushes updates) — any password accepted,
// same posture as the REST API above. Point a real TRACS backend's "Relay Port"
// at this same host:port to test transponder correlation/Beaconator/IDENT without
// a real SRS/relay/DCS session.
const transpondersWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`)
  if (pathname !== '/transponders') { socket.destroy(); return }
  transpondersWss.handleUpgrade(req, socket, head, (ws) => transpondersWss.emit('connection', ws))
})

transpondersWss.on('connection', (ws) => {
  ws.once('message', () => {
    // Any auth message is accepted — mirrors the REST API's "any password accepted".
    transponderClients.add(ws)
    console.log(`\n[transponders] client authenticated (total: ${transponderClients.size})`)
    rl?.prompt()
    ws.send(JSON.stringify({ type: 'transponders', data: buildTransponderSnapshot() }))
  })

  ws.on('close', () => {
    if (transponderClients.delete(ws)) {
      console.log(`\n[transponders] client disconnected (total: ${transponderClients.size})`)
      rl?.prompt()
    }
  })

  ws.on('error', (err) => {
    if (err.code === 'ECONNRESET') return
    console.error('[transponders] client socket error:', err.message)
  })
})

server.listen(PORT, () => {
  console.log(`Mock Olympus running on http://localhost:${PORT}`)
  console.log(`Any password accepted`)
  console.log(`Transponder relay (for correlation testing) at ws://localhost:${PORT}/transponders\n`)
  startConsole()
})
