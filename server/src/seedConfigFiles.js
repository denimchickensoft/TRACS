'use strict'

const path = require('path')
const { CONFIG_DIR } = require('./configDir')
const { copyIfStaleOrMissing } = require('./utils/seedFile')

// Bundled source -> userData/config destination filename. rateConfig and
// tacviewDetection are seeded from their tracked .example.json (a different
// filename than the destination — the destination name is what's gitignored/
// operator-owned). The two color files keep their filename unchanged.
// Explicit per-file list rather than a directory copy, since the bundled
// source dir for the color files (navdata/config) also holds
// theatres.json/airport_name_map.json/projection_params.json, which must
// NOT be seeded into userData/config — see parser.js's COLOR_CONFIG_DIR.
const SEED_FILES = [
  { src: path.join(__dirname, '..', 'rateConfig.example.json'),                   dest: 'rateConfig.json' },
  { src: path.join(__dirname, '..', 'tacviewDetectionConfig.example.json'),       dest: 'tacviewDetectionConfig.json' },
  { src: path.join(__dirname, '..', 'navdata', 'config', 'airspace_colors.json'), dest: 'airspace_colors.json' },
  { src: path.join(__dirname, '..', 'navdata', 'config', 'asdex_colors.json'),    dest: 'asdex_colors.json' },
]

// Runs once at server startup, before anything reads these files. No-ops
// when TRACS_CONFIG_DIR isn't set (dev/plain `npm start`) — mirrors
// navdata/parser.js's seedBundledCache() override-inactive no-op.
function seedUserConfigDir() {
  if (!CONFIG_DIR) return
  for (const { src, dest } of SEED_FILES) copyIfStaleOrMissing(src, path.join(CONFIG_DIR, dest))
}

module.exports = { seedUserConfigDir }
