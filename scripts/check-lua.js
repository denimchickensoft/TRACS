'use strict'

// Syntax-checks every Lua file TRACS ships into DCS (relay/dcs/) against
// Lua 5.1, the version DCS embeds. Catches typos before they only show up as
// an error in dcs.log; it can't check DCS's own APIs or runtime behaviour.
// Run via `npm run check:lua` (part of `npm run lint`).

const fs = require('fs')
const path = require('path')
const luaparse = require('luaparse')

const ROOT = path.join(__dirname, '..', 'relay', 'dcs')

function luaFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return luaFiles(full)
    return entry.name.endsWith('.lua') ? [full] : []
  })
}

let failed = 0
const files = luaFiles(ROOT)
for (const file of files) {
  try {
    luaparse.parse(fs.readFileSync(file, 'utf8'), { luaVersion: '5.1' })
  } catch (err) {
    failed++
    console.error(`${path.relative(process.cwd(), file)}: ${err.message}`)
  }
}

if (failed) {
  console.error(`check:lua - ${failed} of ${files.length} file(s) failed to parse`)
  process.exit(1)
}
console.log(`check:lua - ${files.length} file(s) OK`)
