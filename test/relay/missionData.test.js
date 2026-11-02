import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import missionText from '../../relay/missionText.js'
import missionFile from '../../relay/missionFile.js'
import luaTable from '../../relay/luaTable.js'

const { readZipEntry, filterMission, serializeLua, buildMissionData, audienceFor } = missionText
const { findMissionFile, loadMission, newestTrack } = missionFile
const { parseLuaAssignment } = luaTable

// A minimal zip writer: each entry stored (method 0) or deflated (method 8).
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, deflate } of entries) {
    const raw = Buffer.from(data)
    const body = deflate ? zlib.deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, body)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const MISSION = `mission =
{
    ["theatre"] = "Caucasus",
    ["coalition"] =
    {
        ["blue"] = { ["name"] = "blue", ["country"] = { [1] = { ["name"] = "USA" } } },
        ["red"] = { ["name"] = "red", ["country"] = { [1] = { ["name"] = "Russia" } } },
        ["neutrals"] = { ["name"] = "neutrals", ["country"] = {} },
    },
    ["drawings"] =
    {
        ["layers"] =
        {
            [1] = { ["name"] = "Red", ["objects"] = { [1] = { ["name"] = "r" } } },
            [2] = { ["name"] = "Blue", ["objects"] = { [1] = { ["name"] = "b" } } },
            [3] = { ["name"] = "Neutral", ["objects"] = {} },
            [4] = { ["name"] = "Common", ["objects"] = { [1] = { ["name"] = "c" } } },
            [5] = { ["name"] = "Author", ["objects"] = {} },
        },
    },
    ["triggers"] = { ["zones"] = { [1] = { ["name"] = "z" } } },
    ["odd"] = { ["text"] = "a \\"quoted\\" \\\\ line\\nnext", ["gone"] = nil, ["neg"] = -0, ["n"] = 1.5e-7, [-2] = true },
}
`

describe('readZipEntry', () => {
  test('reads a stored and a deflated entry by name', () => {
    const zip = makeZip([{ name: 'options', data: 'x' }, { name: 'mission', data: 'hello', deflate: true }])
    expect(readZipEntry(zip, 'mission').toString()).toBe('hello')
    expect(readZipEntry(zip, 'options').toString()).toBe('x')
  })

  test('null for a missing entry, throws for a non-zip', () => {
    expect(readZipEntry(makeZip([{ name: 'options', data: 'x' }]), 'mission')).toBeNull()
    expect(() => readZipEntry(Buffer.from('not a zip at all, just some text bytes here'), 'mission')).toThrow(/not a zip/)
  })
})

describe('serializeLua', () => {
  test('parses back to the same table, keeping nil, -0 and integer keys', () => {
    const m = parseLuaAssignment(MISSION, 'mission')
    const again = parseLuaAssignment(serializeLua('mission', m), 'mission')
    expect(again).toStrictEqual(m)
    expect(Object.is(again.odd.neg, -0)).toBe(true)
    expect(again.odd.gone).toBeNull()
    expect(again.odd.text).toBe('a "quoted" \\ line\nnext')
  })
})

describe('filterMission', () => {
  const m = parseLuaAssignment(MISSION, 'mission')

  test('keeps own side and the Red/Blue + Common layers, drops trigger zones', () => {
    const red = filterMission(m, 'red')
    expect(Object.keys(red.coalition)).toEqual(['red'])
    expect(Object.values(red.drawings.layers).map((l) => l.name)).toEqual(['Red', 'Common'])
    expect(red.triggers.zones).toEqual({})
    const blue = filterMission(m, 'blue')
    expect(Object.keys(blue.coalition)).toEqual(['blue'])
    expect(Object.values(blue.drawings.layers).map((l) => l.name)).toEqual(['Blue', 'Common'])
  })

  test('leaves the original untouched', () => {
    filterMission(m, 'red')
    expect(Object.keys(m.coalition)).toEqual(['blue', 'red', 'neutrals'])
    expect(Object.keys(m.drawings.layers)).toHaveLength(5)
  })
})

describe('buildMissionData / audienceFor', () => {
  test('one id for every audience, GM gets the file as it is', () => {
    const d = buildMissionData(makeZip([{ name: 'mission', data: MISSION, deflate: true }]))
    expect(d.theatre).toBe('Caucasus')
    expect(d.id).toMatch(/^[0-9a-f]{64}$/)
    expect(d.texts.all).toBe(MISSION)
    expect(Object.keys(parseLuaAssignment(d.texts.blue, 'mission').coalition)).toEqual(['blue'])
  })

  test('audiences by coalition', () => {
    expect(audienceFor('blue')).toBe('blue')
    expect(audienceFor('red')).toBe('red')
    expect(audienceFor('gm')).toBe('all')
    expect(audienceFor('admin')).toBe('all')
    expect(audienceFor('neutral')).toBeNull()
    expect(audienceFor(undefined)).toBeNull()
  })
})

describe('findMissionFile / loadMission', () => {
  let dir
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracs-mission-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('host: the .miz, unless modified after the load', async () => {
    const miz = path.join(dir, 'a.miz')
    fs.writeFileSync(miz, 'x')
    const mtime = fs.statSync(miz).mtimeMs
    expect(await findMissionFile({ side: 'server', missionFile: miz, loadTimeMs: mtime + 1000 })).toEqual({ file: miz })
    expect((await findMissionFile({ side: 'server', missionFile: miz, loadTimeMs: mtime - 60000 })).error).toMatch(/modified after/)
    expect((await findMissionFile({ side: 'server', missionFile: null, loadTimeMs: 1 })).error).toMatch(/no mission file/)
  })

  test('client: the newest track created since the join, never an older one', async () => {
    const tracks = path.join(dir, 'Tracks', 'Multiplayer')
    fs.mkdirSync(tracks, { recursive: true })
    const fake = (files) => ({
      readdirSync: () => Object.keys(files),
      statSync: (f) => ({ birthtimeMs: files[path.basename(f)], mtimeMs: files[path.basename(f)] }),
    })
    const files = { 'old.trk': 1000, 'new.trk': 50000, 'newer.trk': 60000, 'notes.txt': 70000 }
    expect(newestTrack(tracks, 40000, fake(files))).toBe(path.join(tracks, 'newer.trk'))
    expect(newestTrack(tracks, 65000, fake(files))).toBeNull()
    const r = await findMissionFile({ side: 'client', savedGames: dir, loadTimeMs: 100000 }, { fsImpl: fake({ 'old.trk': 1000 }), timeoutMs: 0 })
    expect(r.error).toMatch(/no multiplayer track/)
  })

  test('reads the mission in a worker thread', async () => {
    const miz = path.join(dir, 'm.miz')
    fs.writeFileSync(miz, makeZip([{ name: 'mission', data: MISSION, deflate: true }]))
    const r = await loadMission({ side: 'server', missionFile: miz, loadTimeMs: Date.now() + 10000 })
    expect(r.ok).toBe(true)
    expect(r.theatre).toBe('Caucasus')
    expect(r.file).toBe(miz)
  })

  test('retries a failed read, then reports it', async () => {
    const miz = path.join(dir, 'm.miz')
    fs.writeFileSync(miz, 'x')
    let calls = 0
    const parse = async () => (++calls < 2 ? { ok: false, error: 'busy' } : { ok: true, id: 'i', texts: {} })
    const ok = await loadMission({ side: 'server', missionFile: miz, loadTimeMs: Date.now() + 10000 }, { parse, retryMs: 0 })
    expect(ok.ok).toBe(true)
    expect(calls).toBe(2)
    const bad = await loadMission({ side: 'server', missionFile: miz, loadTimeMs: Date.now() + 10000 }, { parse: async () => ({ ok: false, error: 'busy' }), retryMs: 0 })
    expect(bad.error).toMatch(/^busy/)
  })
})
