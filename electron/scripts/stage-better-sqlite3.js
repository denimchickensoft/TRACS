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
  console.log(`[stage-better-sqlite3] rebuilding for electron ${electronVersion}...`)
  await rebuild({
    buildPath:       STAGING_ROOT,
    electronVersion,
    onlyModules:     ['better-sqlite3'],
    force:           true,
    buildFromSource: true,
  })
  console.log('[stage-better-sqlite3] done')
}

main().catch((err) => { console.error(err); process.exit(1) })
