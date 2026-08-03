'use strict'

// Shared core for town/place label extraction (ABM map-context rendering).
// Reads DCS's own map/towns.lua (the same data ED uses for F10 map labels).
// Pure computation only — no output writing — so the same code runs from a
// dev checkout and from a bundled standalone executable.

const fs   = require('fs')
const path = require('path')

const LINE_RE = /^\["(.+)"\]\s*=\s*\{\s*latitude\s*=\s*(-?[0-9.]+),\s*longitude\s*=\s*(-?[0-9.]+),\s*display_name\s*=\s*_\(".*"\)\s*\},?$/

function buildTheatre({ theatre, terrainsDir, dcsFolder }) {
  const luaPath = path.join(terrainsDir, dcsFolder || theatre, 'map', 'towns.lua')
  if (!fs.existsSync(luaPath)) {
    return { status: 'skip', reason: 'towns.lua not found' }
  }

  const lines = fs.readFileSync(luaPath, 'utf8').split(/\r?\n/)
  const towns = []
  let skippedLines = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('local') || trimmed === 'towns = {' || trimmed === '}') continue
    const m = LINE_RE.exec(trimmed)
    if (!m) { skippedLines++; continue }
    towns.push({ name: m[1], lat: parseFloat(m[2]), lon: parseFloat(m[3]) })
  }

  towns.sort((a, b) => a.name.localeCompare(b.name))

  return { status: 'ok', towns, skippedLines }
}

module.exports = { buildTheatre }
