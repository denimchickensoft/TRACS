'use strict'

// Reads a DCS .miz for the mock: theatre, date/start time, bullseyes, and
// every plane/helicopter/vehicle/ship group with its units and route.
// Statics are skipped. The Lua parsing and DCS x/y -> lat/lng conversion are
// the client's own (client/src/utils), loaded as ES modules.

const fs   = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { unzipSync, strFromU8 } = require('fflate')

const CLIENT_UTILS = path.join(__dirname, '..', 'client', 'src', 'utils')
const PROJECTION_PARAMS = path.join(__dirname, '..', 'client', 'public', 'projection_params.json')
const AIRDROMES_DIR = path.join(__dirname, '..', 'client', 'public', 'airdromes')

const MS_TO_KTS = 1 / 0.514444

const COALITIONS = { blue: 2, red: 1, neutrals: 0 }
const CATEGORIES = [
  ['plane',      'Aircraft'],
  ['helicopter', 'Helicopter'],
  ['vehicle',    'GroundUnit'],
  ['ship',       'NavyUnit'],
]
// A first waypoint of one of these types starts the flight on the ground.
const GROUND_START_TYPES = new Set(['TakeOffParking', 'TakeOffParkingHot', 'TakeOffGround', 'TakeOff'])

let utils = null
async function loadUtils() {
  if (utils) return utils
  const imp = (f) => import(pathToFileURL(path.join(CLIENT_UTILS, f)).href)
  const [mission, coords, magvar] = await Promise.all([
    imp('parseMission.js'), imp('dcsCoords.js'), imp('magvar.js'),
  ])
  magvar.setProjectionParams(JSON.parse(fs.readFileSync(PROJECTION_PARAMS, 'utf8')))
  utils = { parseLua: mission.parseLua, dcsPointToLatLng: coords.dcsPointToLatLng }
  return utils
}

function toArray(val) {
  if (!val) return []
  return Array.isArray(val) ? val : Object.values(val)
}

function loadAirdromeNames(theatre) {
  try {
    return JSON.parse(fs.readFileSync(path.join(AIRDROMES_DIR, `${theatre}.json`), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Parses the .miz at `file`. Returns
 * { theatre, date: {Day, Month, Year}, startTimeS, bullseyes: [{coalition, lat, lng}],
 *   groups: [{ name, groupId, category, coalition, lateActivation, groundStart,
 *              homeBase, route: [{lat, lng, altM, altType, spdKts}],
 *              units: [{ unitId, name, type, lat, lng, altM, hdgRad, spdKts }] }] }
 * Positions the theatre's projection can't place are dropped.
 */
async function loadMiz(file) {
  const { parseLua, dcsPointToLatLng } = await loadUtils()
  const files = unzipSync(new Uint8Array(fs.readFileSync(file)))
  if (!files.mission) throw new Error('no mission file inside the .miz')
  const mission = parseLua(strFromU8(files.mission))

  const theatre = mission.theatre
  if (!theatre) throw new Error('mission has no theatre')
  const ll = (x, y) => dcsPointToLatLng(x, y, theatre)
  if (!ll(0, 0)) throw new Error(`no projection for theatre ${theatre}`)
  const airdromes = loadAirdromeNames(theatre)

  const bullseyes = []
  const groups = []
  for (const [coalName, coaData] of Object.entries(mission.coalition ?? {})) {
    const coalition = COALITIONS[coalName] ?? 0
    if (coaData.bullseye) {
      const at = ll(coaData.bullseye.x, coaData.bullseye.y)
      if (at && coalition) bullseyes.push({ coalition: coalName, ...at })
    }
    for (const country of toArray(coaData.country)) {
      for (const [key, category] of CATEGORIES) {
        for (const g of toArray(country[key]?.group)) {
          const points = toArray(g.route?.points)
          const route = points.map((p) => {
            const at = ll(p.x, p.y)
            return at && {
              ...at,
              altM:    p.alt ?? null,
              altType: p.alt_type ?? 'BARO',
              spdKts:  p.speed != null ? p.speed * MS_TO_KTS : null,
            }
          }).filter(Boolean)
          const wp1 = points[0]
          const isAir = category === 'Aircraft' || category === 'Helicopter'
          const units = toArray(g.units).map((u) => {
            const at = ll(u.x, u.y)
            return at && {
              unitId: u.unitId,
              name:   u.name ?? `${g.name}-${u.unitId}`,
              type:   u.type,
              ...at,
              altM:   u.alt ?? null,
              hdgRad: u.heading ?? 0,
              spdKts: u.speed != null ? u.speed * MS_TO_KTS : null,
            }
          }).filter(Boolean)
          if (!units.length) continue
          groups.push({
            name: g.name ?? `Group ${g.groupId}`,
            groupId: g.groupId,
            category,
            coalition,
            lateActivation: g.lateActivation === true,
            groundStart: isAir && (g.uncontrolled === true || GROUND_START_TYPES.has(wp1?.type)),
            homeBase: wp1?.airdromeId != null ? airdromes[wp1.airdromeId] ?? null : null,
            route,
            units,
          })
        }
      }
    }
  }

  return {
    theatre,
    date: mission.date ?? null,
    startTimeS: mission.start_time ?? 0,
    bullseyes,
    groups,
  }
}

module.exports = { loadMiz }
