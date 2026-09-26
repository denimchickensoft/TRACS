'use strict'

// Pre-package build step: stages exactly the navdata files that are safe to
// redistribute (non-LNM/Navigraph-derived runtime files — Navigraph data is
// licensed per user and must never ship) into a clean staging directory for
// electron-builder's `extraResources` to pick up.
//
// Uses `git ls-files` as the authoritative list of what's actually committed
// under server/navdata/cache/, rather than a hand-maintained per-theatre file
// list — this is self-updating and can never drift from what's really
// tracked, so it can't accidentally bundle a developer's own locally-
// extracted (and legally non-redistributable) Navigraph data just because it
// happens to sit in the same cache directory on disk.
//
// Usage: node electron/scripts/stage-navdata.js
// (or:   npm run stage-navdata)

const { execFileSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const REPO_ROOT    = path.resolve(__dirname, '../..')
const STAGING_DIR  = path.join(__dirname, '../build-staging')
const ELEVATION_DB = path.join(REPO_ROOT, 'server/data/elevation.db')

function main() {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true })
  fs.mkdirSync(STAGING_DIR, { recursive: true })

  const trackedCacheFiles = execFileSync(
    'git', ['ls-files', 'server/navdata/cache'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).split('\n').filter(Boolean)

  console.log(`[stage-navdata] staging ${trackedCacheFiles.length} committed navdata files...`)
  for (const relPath of trackedCacheFiles) {
    const src = path.join(REPO_ROOT, relPath)
    const dst = path.join(STAGING_DIR, relPath)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }

  console.log('[stage-navdata] staging elevation.db...')
  const elevationDst = path.join(STAGING_DIR, 'server/data/elevation.db')
  fs.mkdirSync(path.dirname(elevationDst), { recursive: true })
  fs.copyFileSync(ELEVATION_DB, elevationDst)

  console.log(`[stage-navdata] done - staged to ${path.relative(REPO_ROOT, STAGING_DIR)}`)
}

main()
