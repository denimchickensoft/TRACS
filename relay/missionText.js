'use strict'

// The running mission's `mission` file, as TRACS's .miz importers read it:
// taken out of a .miz (host) or a multiplayer .trk (client) - both are zip
// archives with the same `mission` entry - and cut down to what one
// audience may see. Pure functions; missionWorker.js runs them off the
// relay's main thread, since a big mission is several MB of Lua.

const zlib   = require('zlib')
const crypto = require('crypto')
const { parseLuaAssignment } = require('./luaTable')

const EOCD_SIG    = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG   = 0x04034b50

// One entry of a zip archive (a Buffer), uncompressed, or null if the
// archive has no entry of that name. Reads only that entry, whatever else
// the archive holds (a track's recorded data is never touched). Throws on
// an archive it can't read, e.g. one still being written.
function readZipEntry(buf, name) {
  // The end-of-central-directory record is within the last 64 KB + 22 bytes
  // (its comment is at most 65535 bytes).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('zip central directory is damaged')
    const method   = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen  = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const noteLen  = buf.readUInt16LE(p + 32)
    const local    = buf.readUInt32LE(p + 42)
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + noteLen
    if (entryName !== name) continue

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) throw new Error(`zip entry ${name} is damaged`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + compSize > buf.length) throw new Error(`zip entry ${name} is truncated`)
    const data = buf.subarray(start, start + compSize)
    if (method === 0) return Buffer.from(data)
    if (method === 8) return zlib.inflateRawSync(data)
    throw new Error(`zip entry ${name} uses unsupported compression method ${method}`)
  }
  return null
}

// What each audience gets. A coalition controller sees its own side's
// groups and the drawing layers meant for it (its own side's and Common),
// and none of the mission's trigger zones, which often mark the mission's
// script logic rather than anything shown to players. Game Master and
// Admin get the file as it is.
const SIDE_KEY   = { red: 'red', blue: 'blue' }
const SIDE_LAYER = { red: 'Red', blue: 'Blue' }
const SHARED_LAYERS = new Set(['Common'])

function audienceFor(coalition) {
  if (coalition === 'gm' || coalition === 'admin') return 'all'
  return SIDE_KEY[coalition] ? coalition : null
}

// A copy of the parsed mission cut down for one side ('red' or 'blue').
// Copies only the tables it changes; the rest is shared with `mission`.
function filterMission(mission, side) {
  const out = { ...mission }
  if (mission.coalition && typeof mission.coalition === 'object') {
    out.coalition = {}
    if (mission.coalition[SIDE_KEY[side]] !== undefined) out.coalition[SIDE_KEY[side]] = mission.coalition[SIDE_KEY[side]]
  }
  const layers = mission.drawings?.layers
  if (layers && typeof layers === 'object') {
    const kept = {}
    let n = 1
    for (const key of Object.keys(layers).sort((a, b) => Number(a) - Number(b))) {
      const layer = layers[key]
      if (layer?.name === SIDE_LAYER[side] || SHARED_LAYERS.has(layer?.name)) kept[String(n++)] = layer
    }
    out.drawings = { ...mission.drawings, layers: kept }
  }
  if (mission.triggers && typeof mission.triggers === 'object') {
    out.triggers = { ...mission.triggers, zones: {} }
  }
  return out
}

function luaString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
}

// Integer keys go out as [n], everything else as ["key"]: the parser turns
// both into string keys, so this is the only way to tell them apart again.
// A `key = nil` DCS wrote stays (the parsers keep it as null).
const isIntKey = (k) => /^-?\d+$/.test(k) && String(Number(k)) === k

function writeValue(v, parts) {
  if (typeof v === 'string') parts.push(luaString(v))
  // -0 is written as such (String(-0) is "0"), which DCS does write.
  else if (typeof v === 'number') parts.push(Object.is(v, -0) ? '-0' : Number.isFinite(v) ? String(v) : '0')
  else if (typeof v === 'boolean') parts.push(v ? 'true' : 'false')
  else if (v && typeof v === 'object') {
    parts.push('{\n')
    const keys = Object.keys(v)
    const ints = keys.filter(isIntKey).sort((a, b) => Number(a) - Number(b))
    const strs = keys.filter((k) => !isIntKey(k)).sort()
    for (const k of ints) {
      if (v[k] === undefined) continue
      parts.push(`[${k}] = `)
      writeValue(v[k], parts)
      parts.push(',\n')
    }
    for (const k of strs) {
      if (v[k] === undefined) continue
      parts.push(`[${luaString(k)}] = `)
      writeValue(v[k], parts)
      parts.push(',\n')
    }
    parts.push('}')
  } else parts.push('nil')
}

// `<name> = { ... }` in the layout DCS itself writes, which every TRACS
// mission parser reads.
function serializeLua(name, value) {
  const parts = [`${name} = `]
  writeValue(value, parts)
  parts.push('\n')
  return parts.join('')
}

// Everything the relay serves from one mission archive: an id (the mission
// text's hash, the same for every audience), the theatre, and the mission
// text per audience.
function buildMissionData(archive) {
  const entry = readZipEntry(archive, 'mission')
  if (!entry) throw new Error('no "mission" entry in the archive')
  let text = entry.toString('utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const mission = parseLuaAssignment(text, 'mission')
  if (!mission) throw new Error('the "mission" entry has no mission table')
  return {
    id:      crypto.createHash('sha256').update(text).digest('hex'),
    theatre: typeof mission.theatre === 'string' ? mission.theatre : null,
    bytes:   entry.length,
    texts: {
      all:  text,
      red:  serializeLua('mission', filterMission(mission, 'red')),
      blue: serializeLua('mission', filterMission(mission, 'blue')),
    },
  }
}

module.exports = { readZipEntry, filterMission, serializeLua, buildMissionData, audienceFor }
