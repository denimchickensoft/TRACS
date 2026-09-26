'use strict'

// Keeps relay/tacviewCore.js in sync with server/src/tacviewCore.js.
//
// relay/ is deliberately excluded from this repo's npm workspaces
// (root package.json) so it stays a genuinely self-contained folder someone
// can copy onto a DCS server and run with nothing else from this monorepo
// present -- that rules out sharing the code via a workspace package the
// way packages/geo-math is shared between client/ and server/. Since
// relay/tacview.js needs the identical ACMI parsing/mapping logic
// server/src/tacview.js uses, relay/tacviewCore.js is instead a generated,
// verbatim copy of server/src/tacviewCore.js -- never edit it directly.
//
// server/src/tacviewCore.js is canonical. Edit that file, then run:
//   npm run sync:tacview-core
// `npm run check:tacview-core` (no write) fails if the two have diverged --
// wire that into CI/pre-commit (hand-syncing the two drifted more than
// once).

const fs   = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, '..', 'server', 'src', 'tacviewCore.js')
const TARGET = path.join(__dirname, '..', 'relay', 'tacviewCore.js')

const GENERATED_HEADER = `// AUTO-GENERATED -- DO NOT EDIT DIRECTLY.
// Verbatim copy of server/src/tacviewCore.js, produced by
// scripts/sync-tacview-core.js (see that file's own header for why this
// duplicate exists instead of a shared workspace package). To change this
// file's behavior, edit server/src/tacviewCore.js and run:
//   npm run sync:tacview-core

`

function buildTarget() {
  const source = fs.readFileSync(SOURCE, 'utf8')
  return GENERATED_HEADER + source
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const expected  = buildTarget()

  if (checkOnly) {
    const actual = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null
    if (actual !== expected) {
      console.error('[sync-tacview-core] relay/tacviewCore.js is out of sync with server/src/tacviewCore.js.')
      console.error('[sync-tacview-core] run: npm run sync:tacview-core')
      process.exit(1)
    }
    console.log('[sync-tacview-core] in sync.')
    return
  }

  fs.writeFileSync(TARGET, expected)
  console.log('[sync-tacview-core] relay/tacviewCore.js updated from server/src/tacviewCore.js.')
}

main()
