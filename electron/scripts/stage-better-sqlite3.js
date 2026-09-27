'use strict'

// Pre-package build step: rebuilds better-sqlite3's native addon against
// Electron's bundled Node ABI into an isolated staging copy. electron-
// builder's `files` config (package.json) then swaps that staged copy in
// over the plain node_modules/better-sqlite3 that the general
// "node_modules/**/*" glob would otherwise package as-is (built for
// system Node, since that's what `npm install`/`npm rebuild` target).
//
// A staged copy - not an in-place rebuild, and not an afterPack hook - is
// necessary:
//  - server/src/index.js runs in-process inside Electron's main process
//    (see electron/main.js's startServer()), so the shipped addon needs
//    Electron's ABI, not system Node's.
//  - electron-builder's built-in `npmRebuild` option rebuilds native
//    modules in place in the SOURCE TREE's node_modules (app-builder-lib's
//    util/yarn.js passes `buildPath: appDir`, the project root). Turning
//    it on would leave `npm run dev` broken (wrong ABI) after every
//    `npm run dist:electron` - hence it stays `false` in package.json and
//    this script rebuilds an isolated copy instead, never touching the
//    dev tree's node_modules/better-sqlite3.
//  - Rebuilding after packaging (an afterPack hook) doesn't work: by
//    default electron-builder's node_modules packaging strips native
//    build inputs (binding.gyp, src/**, deps/**) since npmRebuild:false
//    signals nothing there will ever need a from-source rebuild - so by
//    the time afterPack runs there's nothing left to compile against.
//    Confirmed by trying it: the packaged better-sqlite3 folder had no
//    binding.gyp at all.
//
// Usage: node electron/scripts/stage-better-sqlite3.js
// (or:   npm run stage-better-sqlite3)

const fs   = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { rebuild } = require('@electron/rebuild')

const REPO_ROOT    = path.resolve(__dirname, '../..')
const SRC_MODULE   = path.join(REPO_ROOT, 'node_modules/better-sqlite3')
const STAGING_ROOT = path.join(__dirname, '../build-staging-node')
const DST_MODULE   = path.join(STAGING_ROOT, 'node_modules/better-sqlite3')

async function main() {
  fs.rmSync(STAGING_ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(DST_MODULE), { recursive: true })
  fs.cpSync(SRC_MODULE, DST_MODULE, { recursive: true })

  // module-walker.js needs a package.json at buildPath declaring the
  // dependency to discover it - this staging root isn't a real project,
  // so it gets the minimal manifest that satisfies that lookup.
  fs.writeFileSync(
    path.join(STAGING_ROOT, 'package.json'),
    JSON.stringify({ name: 'tracs-better-sqlite3-staging', dependencies: { 'better-sqlite3': '*' } }),
  )

  const electronVersion = require(path.join(REPO_ROOT, 'node_modules/electron/package.json')).version
  const rebuildFor = (arch) => rebuild({
    buildPath:       STAGING_ROOT,
    electronVersion,
    onlyModules:     ['better-sqlite3'],
    force:           true,
    buildFromSource: true,
    ...(arch ? { arch } : {}),
  })

  if (process.platform === 'darwin') {
    // The macOS app is one universal build (package.json's mac targets), so
    // the addon must hold both architectures: build it for x64 and arm64,
    // then merge them into a single fat binary with lipo. electron-builder's
    // mac.x64ArchFiles marks this file as already universal.
    const addon = path.join(DST_MODULE, 'build', 'Release', 'better_sqlite3.node')
    const slices = []
    for (const arch of ['x64', 'arm64']) {
      console.log(`[stage-better-sqlite3] rebuilding for electron ${electronVersion} (${arch})...`)
      await rebuildFor(arch)
      const slice = path.join(STAGING_ROOT, `better_sqlite3-${arch}.node`)
      fs.copyFileSync(addon, slice)
      slices.push(slice)
    }
    execFileSync('lipo', ['-create', ...slices, '-output', addon])
    for (const slice of slices) fs.rmSync(slice)
    console.log(`[stage-better-sqlite3] ${execFileSync('lipo', ['-archs', addon], { encoding: 'utf8' }).trim()} merged`)
  } else {
    console.log(`[stage-better-sqlite3] rebuilding for electron ${electronVersion}...`)
    await rebuildFor()
  }
  pruneBuildOutputs()
  console.log('[stage-better-sqlite3] done')
}

// A from-source build leaves ~57 MB of compiler intermediates (obj/, .pdb,
// .lib, .iobj, test_extension) plus the SQLite sources in deps/ and src/.
// At runtime better-sqlite3 needs only lib/, package.json and the compiled
// build/Release/better_sqlite3.node (found via the `bindings` package), so
// drop everything else from the staged copy.
function pruneBuildOutputs() {
  const KEEP_TOP = new Set(['lib', 'build', 'package.json', 'LICENSE', 'README.md'])
  for (const entry of fs.readdirSync(DST_MODULE)) {
    if (!KEEP_TOP.has(entry)) fs.rmSync(path.join(DST_MODULE, entry), { recursive: true, force: true })
  }
  const buildDir   = path.join(DST_MODULE, 'build')
  const releaseDir = path.join(buildDir, 'Release')
  const addon      = path.join(releaseDir, 'better_sqlite3.node')
  if (!fs.existsSync(addon)) throw new Error(`rebuilt addon not found at ${addon}`)
  for (const entry of fs.readdirSync(buildDir)) {
    if (entry !== 'Release') fs.rmSync(path.join(buildDir, entry), { recursive: true, force: true })
  }
  for (const entry of fs.readdirSync(releaseDir)) {
    if (entry !== 'better_sqlite3.node') fs.rmSync(path.join(releaseDir, entry), { recursive: true, force: true })
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
