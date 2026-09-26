'use strict'

const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./configDir')

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

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Adds keys present in `defaults` but missing from `target`, recursing into
// nested plain objects. Never changes a value the operator already has
// (arrays and scalars are taken as-is). Returns true if anything was added.
function addMissingKeys(target, defaults) {
  let changed = false
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in target)) {
      target[key] = value
      changed = true
    } else if (isPlainObject(target[key]) && isPlainObject(value)) {
      changed = addMissingKeys(target[key], value) || changed
    }
  }
  return changed
}

// Operator-owned config: copy the bundled default only when the file is
// missing. An existing file is never replaced - at most, keys a newer
// bundled default introduced are added, so edits survive every update. A
// file that no longer parses is left untouched (with a warning) rather than
// being "repaired" over the operator's head.
function seedConfigFile(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) return
  if (!fs.existsSync(destPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.copyFileSync(srcPath, destPath)
    return
  }
  let current, defaults
  try {
    current  = JSON.parse(fs.readFileSync(destPath, 'utf8'))
    defaults = JSON.parse(fs.readFileSync(srcPath, 'utf8'))
  } catch (err) {
    console.warn(`[config] ${path.basename(destPath)} could not be read as JSON (${err.message}) - leaving it unchanged`)
    return
  }
  if (!isPlainObject(current) || !isPlainObject(defaults)) return
  if (addMissingKeys(current, defaults)) {
    fs.writeFileSync(destPath, JSON.stringify(current, null, 2) + '\n')
    console.log(`[config] added new default settings to ${path.basename(destPath)}`)
  }
}

// Runs once at server startup, before anything reads these files. No-ops
// when TRACS_CONFIG_DIR isn't set (dev/plain `npm start`), where the bundled
// files are used in place.
function seedUserConfigDir() {
  if (!CONFIG_DIR) return
  for (const { src, dest } of SEED_FILES) seedConfigFile(src, path.join(CONFIG_DIR, dest))
}

module.exports = { seedUserConfigDir }
