'use strict'

// Installs the exporter's DCS side into the operator's Saved Games folders,
// and removes it again. Nothing is ever written there unless the operator
// opted in: exporter.enabled in config.json, or --install-exporter.
//
//   exporter.enabled true   at startup, every folder in exporter.savedGames
//                           gets this relay's own copy of the files, and an
//                           older or different copy is replaced, so the hook
//                           and DLL always match the relay (also right after
//                           an auto-update, which swaps only the exe).
//   exporter.enabled false  at startup, whatever this relay installed is
//                           removed.
//
// The files come from inside the relay (SEA assets, see scripts/build.js),
// or from relay/dcs/ on a plain `node index.js` run. Where they went is kept
// in exporter-install.json next to config.json, so removal only ever touches
// what this relay installed itself, even after exporter.savedGames changes
// or with a second relay using the same DCS folder. A file that is a link
// (a development setup) is left alone.
//
// DCS keeps the DLL open while it runs, and a new hook beside an old DLL
// wouldn't load, so a folder whose DLL can't be replaced or removed is left
// exactly as it is and tried again every minute.
//
// Everything here is synchronous: --install-exporter / --uninstall-exporter
// and the one-time folder prompt finish before the relay opens its ports.

const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const { RELAY_DIR, isSeaBinary } = require('./paths')

const LOG = '[relay:exporter]'
const RETRY_MS = 60_000

// Written in this order (the hook last, so DCS never finds the new hook with
// an old DLL) and removed in reverse.
const FILES = [
  'Mods/Services/TRACS/bin/tracs_exporter.dll',
  'Mods/Services/TRACS/entry.lua',
  'Scripts/Hooks/TRACS-Exporter.lua',
]
const DLL = FILES[0]
const OWN_DIRS = ['Mods/Services/TRACS/bin', 'Mods/Services/TRACS']

// The SEA asset names, shared with scripts/build.js.
const assetName = (rel) => `dcs/${rel}`

function bundledFiles() {
  if (isSeaBinary) {
    const sea = require('node:sea')
    return FILES.map((rel) => {
      try {
        return { rel, data: Buffer.from(sea.getRawAsset(assetName(rel))) }
      } catch {
        throw new Error('this relay was built without the exporter files (not a Windows build)')
      }
    })
  }
  return FILES.map((rel) => {
    const file = path.join(__dirname, 'dcs', rel)
    if (!fs.existsSync(file)) {
      throw new Error(`${path.relative(process.cwd(), file)} is missing - build the DLL first (node relay/native/build.js)`)
    }
    return { rel, data: fs.readFileSync(file) }
  })
}

// ── Where ────────────────────────────────────────────────────────────────────

// The Saved Games folder, wherever Windows keeps it (it can be moved, e.g.
// into OneDrive).
function savedGamesRoot() {
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', '{4C5C32FF-BB9D-43b0-B5B4-2D72E54EAAA4}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out)
    if (m) return m[1].trim().replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`)
  } catch {
    // fall through to the default location
  }
  return path.join(os.homedir(), 'Saved Games')
}

// Why `folder` isn't a DCS Saved Games folder, or null when it is. DCS writes
// Config/options.lua on its first run, so a typo can't create a stray folder.
function invalidReason(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return 'not a folder path'
  if (!path.isAbsolute(folder)) return 'not a full path'
  let stat
  try { stat = fs.statSync(folder) } catch { return 'does not exist' }
  if (!stat.isDirectory()) return 'not a folder'
  if (!fs.existsSync(path.join(folder, 'Config', 'options.lua'))) {
    return 'not a DCS Saved Games folder (no Config\\options.lua - has DCS been run with it?)'
  }
  return null
}

// Every DCS* folder under Saved Games that DCS has used.
function detectFolders(root = savedGamesRoot()) {
  let names
  try { names = fs.readdirSync(root, { withFileTypes: true }) } catch { return [] }
  return names
    .filter((d) => d.isDirectory() && /^DCS/i.test(d.name))
    .map((d) => path.join(root, d.name))
    .filter((f) => invalidReason(f) === null)
}

// ── Install record ───────────────────────────────────────────────────────────

const recordFile = (dir) => path.join(dir, 'exporter-install.json')

function readRecord(dir = RELAY_DIR) {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(dir), 'utf8'))
    return Array.isArray(r?.folders) ? r.folders.filter((f) => typeof f === 'string') : []
  } catch {
    return []
  }
}

function writeRecord(folders, dir = RELAY_DIR) {
  const file = recordFile(dir)
  if (!folders.length) { fs.rmSync(file, { force: true }); return }
  fs.writeFileSync(file, JSON.stringify({ folders }, null, 2) + '\n')
}

const sameFolder = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// ── Install / remove one folder ──────────────────────────────────────────────

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')

function isLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink() } catch { return false }
}

// True while something (DCS) has the DLL open. Missing = not locked.
function dllLocked(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r+')
    return false
  } catch (err) {
    return err.code !== 'ENOENT'
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// Returns { result: 'current' | 'installed' | 'updated' | 'busy', skipped: [rel] }.
function installFolder(folder, files) {
  const skipped = []
  const pending = []
  let existing = 0
  for (const f of files) {
    const target = path.join(folder, f.rel)
    if (isLink(target)) { skipped.push(f.rel); continue }
    let current = null
    try { current = fs.readFileSync(target) } catch { /* not there */ }
    if (current) existing++
    if (!current || sha256(current) !== sha256(f.data)) pending.push(f)
  }
  if (!pending.length) return { result: 'current', skipped }
  if (pending.some((f) => f.rel === DLL) && dllLocked(path.join(folder, DLL))) return { result: 'busy', skipped }
  for (const f of pending) {
    const target = path.join(folder, f.rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = `${target}.tracs-new`
    fs.writeFileSync(tmp, f.data)
    fs.renameSync(tmp, target)
  }
  return { result: existing ? 'updated' : 'installed', skipped }
}

// Returns { result: 'removed' | 'busy', skipped: [rel] }.
function removeFolder(folder) {
  const skipped = []
  const dll = path.join(folder, DLL)
  if (!isLink(dll) && dllLocked(dll)) return { result: 'busy', skipped }
  for (const rel of [...FILES].reverse()) {
    const target = path.join(folder, rel)
    if (isLink(target)) { skipped.push(rel); continue }
    fs.rmSync(target, { force: true })
  }
  for (const rel of OWN_DIRS) {
    try { fs.rmdirSync(path.join(folder, rel)) } catch { /* not empty or gone */ }
  }
  return { result: 'removed', skipped }
}

// ── config.json ──────────────────────────────────────────────────────────────

// Sets exporter fields in config.json, keeping everything else.
function updateConfigFile(patch, dir = RELAY_DIR) {
  const file = path.join(dir, 'config.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`could not read ${file}: ${err.message}`, { cause: err })
  }
  cfg.exporter = { ...(cfg.exporter ?? {}), ...patch }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
}

// ── Choosing folders ─────────────────────────────────────────────────────────

function promptLine(question) {
  process.stdout.write(question)
  const buf = Buffer.alloc(1024)
  let text = ''
  for (;;) {
    let n
    try { n = fs.readSync(0, buf, 0, buf.length, null) } catch (err) {
      if (err.code === 'EAGAIN') continue
      return null
    }
    if (n === 0) return text || null
    text += buf.toString('utf8', 0, n)
    if (text.includes('\n')) return text.split(/\r?\n/)[0]
  }
}

const configLine = (folders) => `"savedGames": ${JSON.stringify(folders)}`

// The folders to install into: exporter.savedGames, each validated, or -
// when none are set - the operator's pick from the detected ones (saved to
// config.json). Returns [] when there's nothing to install into.
function chooseFolders(configured, { interactive = !!process.stdin.isTTY, detect = detectFolders, dir = RELAY_DIR } = {}) {
  if (configured.length) {
    return configured.filter((f) => {
      const why = invalidReason(f)
      if (why) console.error(`${LOG} exporter.savedGames: ${f} - ${why}; not installing there`)
      return !why
    })
  }
  const found = detect()
  if (!found.length) {
    console.error(`${LOG} no DCS Saved Games folder found under ${savedGamesRoot()} - set exporter.savedGames in config.json`)
    return []
  }
  if (!interactive) {
    console.error(`${LOG} exporter.savedGames is not set - not installing. DCS folders found: ${found.join(', ')}`)
    console.error(`${LOG}   add to the "exporter" section of config.json, e.g. ${configLine(found.slice(0, 1))}`)
    return []
  }
  console.log(`${LOG} Install the TRACS exporter into which DCS Saved Games folder(s)?`)
  found.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
  const answer = (promptLine('Numbers separated by commas, "all", or Enter for none: ') ?? '').trim().toLowerCase()
  const picked = answer === 'all'
    ? found
    : [...new Set(answer.split(/[\s,]+/).filter(Boolean).map(Number))]
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= found.length)
        .map((n) => found[n - 1])
  if (!picked.length) {
    console.log(`${LOG} nothing picked - not installing (set exporter.savedGames in config.json to choose later)`)
    return []
  }
  updateConfigFile({ savedGames: picked }, dir)
  console.log(`${LOG} saved to config.json: ${configLine(picked)}`)
  return picked
}

// ── Startup + commands ───────────────────────────────────────────────────────

function describe(folder, { result, skipped }) {
  const verb = { current: 'up to date in', installed: 'installed into', updated: 'updated in', removed: 'removed from' }[result]
  console.log(`${LOG} exporter ${verb} ${folder}`)
  for (const rel of skipped) console.log(`${LOG}   left ${rel} alone (it's a link)`)
}

// One pass over every folder: install into `wanted`, remove from what this
// relay installed before but no longer wants. `hold` folders (configured but
// unreachable right now, e.g. an unplugged drive) are left as they are and
// stay recorded. Returns the folders still busy.
function syncFolders(wanted, files, { hold = [], dir = RELAY_DIR } = {}) {
  const record = readRecord(dir)
  const recorded = (folder) => record.some((f) => sameFolder(f, folder))
  const busy = []
  const keep = record.filter((f) => hold.some((h) => sameFolder(h, f)))
  for (const folder of wanted) {
    try {
      const r = installFolder(folder, files)
      if (r.result === 'busy') {
        busy.push(folder)
        console.warn(`${LOG} DCS is using the exporter in ${folder} - close DCS to update it (retrying every minute)`)
        if (recorded(folder)) keep.push(folder)
      } else {
        describe(folder, r)
        keep.push(folder)
      }
    } catch (err) {
      console.error(`${LOG} could not install into ${folder}: ${err.message}`)
      if (recorded(folder)) keep.push(folder)
    }
  }
  for (const folder of record) {
    if (wanted.some((f) => sameFolder(f, folder)) || hold.some((h) => sameFolder(h, folder))) continue
    try {
      const r = removeFolder(folder)
      if (r.result === 'busy') {
        busy.push(folder); keep.push(folder)
        console.warn(`${LOG} DCS is using the exporter in ${folder} - close DCS to remove it (retrying every minute)`)
      } else describe(folder, r)
    } catch (err) {
      keep.push(folder)
      console.error(`${LOG} could not remove the exporter from ${folder}: ${err.message}`)
    }
  }
  writeRecord(keep, dir)
  return busy
}

// What an enabled exporter installs into: the configured folders that are
// valid now (invalid ones this relay installed into before are held, not
// removed); with none configured, the folders it installed into before;
// with neither, the operator's pick (chooseFolders).
function plan(exporterCfg, opts = {}) {
  const dir = opts.dir ?? RELAY_DIR
  const record = readRecord(dir)
  const configured = exporterCfg.savedGames ?? []
  if (configured.length) {
    const wanted = chooseFolders(configured, opts)
    const hold = configured.filter((f) => !wanted.includes(f) && record.some((r) => sameFolder(r, f)))
    return { wanted, hold }
  }
  if (record.length) return { wanted: record, hold: [] }
  return { wanted: chooseFolders([], opts), hold: [] }
}

function onWindows() {
  return process.platform === 'win32'
}

// Relay startup: install or remove according to exporter.enabled, then keep
// retrying any folder DCS has locked.
function syncAtStartup(exporterCfg) {
  if (!onWindows()) return
  const { wanted, hold } = exporterCfg.enabled ? plan(exporterCfg) : { wanted: [], hold: [] }
  if (!wanted.length && !readRecord().length) return
  let files = []
  if (wanted.length) {
    try { files = bundledFiles() } catch (err) {
      console.error(`${LOG} cannot install the exporter: ${err.message}`)
      return
    }
  }
  const retry = () => {
    if (syncFolders(wanted, files, { hold }).length) setTimeout(retry, RETRY_MS).unref()
  }
  retry()
}

const CLI = { '--install-exporter': 'install', '--uninstall-exporter': 'uninstall' }

function cliCommand(argv = process.argv) {
  return argv.map((a) => CLI[a]).find(Boolean) ?? null
}

// --install-exporter / --uninstall-exporter. Also sets exporter.enabled to
// match, so the next normal start doesn't undo it. Returns the exit code.
function runCli(command, exporterCfg) {
  if (!onWindows()) {
    console.error(`${LOG} the exporter runs inside DCS, which is Windows only - nothing to ${command}`)
    return 1
  }
  try {
    if (command === 'install') {
      const { wanted, hold } = plan(exporterCfg)
      if (!wanted.length) return 1
      const busy = syncFolders(wanted, bundledFiles(), { hold })
      updateConfigFile({ enabled: true })
      console.log(`${LOG} exporter.enabled set to true in config.json`)
      if (busy.length) { console.error(`${LOG} close DCS and run --install-exporter again to finish`); return 1 }
      return 0
    }
    const hadAny = readRecord().length > 0
    const busy = syncFolders([], [])
    updateConfigFile({ enabled: false })
    console.log(`${LOG} exporter.enabled set to false in config.json`)
    if (!hadAny) console.log(`${LOG} the exporter is not installed anywhere by this relay`)
    if (busy.length) { console.error(`${LOG} close DCS and run --uninstall-exporter again to finish`); return 1 }
    return 0
  } catch (err) {
    console.error(`${LOG} ${command} failed: ${err.message}`)
    return 1
  }
}

module.exports = {
  FILES, assetName, cliCommand, runCli, syncAtStartup,
  // for tests
  invalidReason, detectFolders, installFolder, removeFolder, syncFolders, readRecord, chooseFolders, plan,
}
