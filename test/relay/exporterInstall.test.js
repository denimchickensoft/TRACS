import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import install from '../../relay/exporterInstall.js'

const { FILES, invalidReason, detectFolders, installFolder, removeFolder, syncFolders, readRecord, plan } = install
const DLL = FILES[0]

let tmp
const dcsFolder = (name) => {
  const f = path.join(tmp, 'Saved Games', name)
  fs.mkdirSync(path.join(f, 'Config'), { recursive: true })
  fs.writeFileSync(path.join(f, 'Config', 'options.lua'), 'options = {}')
  return f
}
const bundle = (tag) => FILES.map((rel) => ({ rel, data: Buffer.from(`${rel} ${tag}`) }))
const read = (folder, rel) => fs.readFileSync(path.join(folder, rel), 'utf8')

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracs-exporter-install-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('folder validation', () => {
  test('only an existing folder DCS has used counts', () => {
    expect(invalidReason(path.join(tmp, 'nope'))).toMatch(/does not exist/)
    expect(invalidReason('relative\\DCS')).toMatch(/full path/)
    fs.mkdirSync(path.join(tmp, 'Empty'))
    expect(invalidReason(path.join(tmp, 'Empty'))).toMatch(/not a DCS Saved Games folder/)
    expect(invalidReason(dcsFolder('DCS'))).toBe(null)
  })

  test('detection lists DCS* folders with a Config/options.lua', () => {
    const dcs = dcsFolder('DCS')
    const server = dcsFolder('DCS.release_server')
    fs.mkdirSync(path.join(tmp, 'Saved Games', 'DCS.openbeta'))   // never run
    dcsFolder('Other Game')
    expect(detectFolders(path.join(tmp, 'Saved Games')).sort()).toEqual([dcs, server].sort())
  })
})

describe('install and remove', () => {
  test('installs, reports current, then updates a different copy', () => {
    const dcs = dcsFolder('DCS')
    expect(installFolder(dcs, bundle('v1')).result).toBe('installed')
    expect(read(dcs, DLL)).toBe(`${DLL} v1`)
    expect(installFolder(dcs, bundle('v1')).result).toBe('current')
    expect(installFolder(dcs, bundle('v2')).result).toBe('updated')
    for (const rel of FILES) expect(read(dcs, rel)).toBe(`${rel} v2`)
  })

  test('a locked DLL leaves every file as it was', () => {
    const dcs = dcsFolder('DCS')
    installFolder(dcs, bundle('v1'))
    fs.chmodSync(path.join(dcs, DLL), 0o444)   // can't be opened for writing, like a DLL DCS has loaded
    try {
      expect(installFolder(dcs, bundle('v2')).result).toBe('busy')
      for (const rel of FILES) expect(read(dcs, rel)).toBe(`${rel} v1`)
      expect(removeFolder(dcs).result).toBe('busy')
      expect(fs.existsSync(path.join(dcs, FILES[2]))).toBe(true)
    } finally {
      fs.chmodSync(path.join(dcs, DLL), 0o644)
    }
  })

  test('removal takes only its own files and folders', () => {
    const dcs = dcsFolder('DCS')
    installFolder(dcs, bundle('v1'))
    fs.writeFileSync(path.join(dcs, 'Scripts', 'Hooks', 'SomeoneElse.lua'), '')
    expect(removeFolder(dcs).result).toBe('removed')
    expect(fs.existsSync(path.join(dcs, 'Mods', 'Services', 'TRACS'))).toBe(false)
    expect(fs.existsSync(path.join(dcs, FILES[2]))).toBe(false)
    expect(fs.existsSync(path.join(dcs, 'Scripts', 'Hooks', 'SomeoneElse.lua'))).toBe(true)
  })
})

describe('syncing against the install record', () => {
  test('records where it installed, and removes from there when no longer wanted', () => {
    const dir = path.join(tmp, 'relay'); fs.mkdirSync(dir)
    const a = dcsFolder('DCS'); const b = dcsFolder('DCS.release_server')
    syncFolders([a, b], bundle('v1'), { dir })
    expect(readRecord(dir)).toEqual([a, b])
    syncFolders([a], bundle('v1'), { dir })   // b taken out of exporter.savedGames
    expect(readRecord(dir)).toEqual([a])
    expect(fs.existsSync(path.join(b, DLL))).toBe(false)
    syncFolders([], [], { dir })               // exporter disabled
    expect(readRecord(dir)).toEqual([])
    expect(fs.existsSync(path.join(a, DLL))).toBe(false)
  })

  test('a busy folder stays recorded so a later pass can finish', () => {
    const dir = path.join(tmp, 'relay'); fs.mkdirSync(dir)
    const a = dcsFolder('DCS')
    syncFolders([a], bundle('v1'), { dir })
    fs.chmodSync(path.join(a, DLL), 0o444)
    try {
      expect(syncFolders([], [], { dir })).toEqual([a])
      expect(readRecord(dir)).toEqual([a])
    } finally {
      fs.chmodSync(path.join(a, DLL), 0o644)
    }
    expect(syncFolders([], [], { dir })).toEqual([])
    expect(readRecord(dir)).toEqual([])
  })

  test('never touches a folder another relay installed into', () => {
    const mine = path.join(tmp, 'relay1'); const theirs = path.join(tmp, 'relay2')
    fs.mkdirSync(mine); fs.mkdirSync(theirs)
    const a = dcsFolder('DCS')
    syncFolders([a], bundle('v1'), { dir: theirs })
    syncFolders([], [], { dir: mine })         // this relay has the exporter off
    expect(fs.existsSync(path.join(a, DLL))).toBe(true)
  })
})

describe('plan', () => {
  test('a configured folder that is unreachable now is held, not removed', () => {
    const dir = path.join(tmp, 'relay'); fs.mkdirSync(dir)
    const a = dcsFolder('DCS')
    syncFolders([a], bundle('v1'), { dir })
    fs.renameSync(path.join(a, 'Config'), path.join(a, 'Config.away'))
    const p = plan({ savedGames: [a] }, { dir, interactive: false })
    expect(p).toEqual({ wanted: [], hold: [a] })
    syncFolders(p.wanted, [], { hold: p.hold, dir })
    expect(readRecord(dir)).toEqual([a])
    expect(fs.existsSync(path.join(a, DLL))).toBe(true)
  })

  test('with nothing configured it keeps the recorded folders, else installs nowhere without a choice', () => {
    const dir = path.join(tmp, 'relay'); fs.mkdirSync(dir)
    const a = dcsFolder('DCS')
    expect(plan({ savedGames: [] }, { dir, interactive: false, detect: () => [a] })).toEqual({ wanted: [], hold: [] })
    syncFolders([a], bundle('v1'), { dir })
    expect(plan({ savedGames: [] }, { dir, interactive: false, detect: () => [a] })).toEqual({ wanted: [a], hold: [] })
  })
})
