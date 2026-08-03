'use strict'

// Seeds dist/manifest/ from the current repo config — theatres.json,
// projection_params.json, airport_name_map.json, and every runway JSON
// under client/public/runways/. This is what a fresh terrainDataExe build
// ships as its starting manifest for the standalone .exe to read.
//
// build.js calls this automatically only when dist/manifest doesn't exist
// yet (a fresh checkout), so a first build works out of the box. It's
// deliberately NOT run on every build: rebuilding the engine for a logic
// change shouldn't silently clobber a manifest someone has since hand-edited
// (added a theatre, fixed projection params, dropped in new runway data).
// Run this file directly whenever you want to explicitly refresh
// dist/manifest to match current repo state.
//
// Usage: node server/scripts/terrainDataExe/seedManifest.js

const fs   = require('fs')
const path = require('path')

const ROOT         = path.join(__dirname, '../../..')
const CONFIG_DIR   = path.join(ROOT, 'server/navdata/config')
const RUNWAYS_SRC  = path.join(ROOT, 'client/public/runways')
const MANIFEST_DIR = path.join(ROOT, 'server/dist/manifest')

const CONFIG_FILES = ['theatres.json', 'projection_params.json', 'airport_name_map.json']

function seed() {
  fs.mkdirSync(path.join(MANIFEST_DIR, 'runways'), { recursive: true })

  for (const f of CONFIG_FILES) {
    fs.copyFileSync(path.join(CONFIG_DIR, f), path.join(MANIFEST_DIR, f))
  }

  const runwayFiles = fs.readdirSync(RUNWAYS_SRC).filter(f => f.endsWith('.json'))
  for (const f of runwayFiles) {
    fs.copyFileSync(path.join(RUNWAYS_SRC, f), path.join(MANIFEST_DIR, 'runways', f))
  }

  console.log(`Seeded ${path.relative(ROOT, MANIFEST_DIR)}: ${CONFIG_FILES.length} config files + ${runwayFiles.length} runway datasets`)
}

module.exports = { seed, MANIFEST_DIR }

if (require.main === module) seed()
