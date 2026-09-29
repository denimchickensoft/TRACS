'use strict'

// Regenerates the files relay/ (and the client) share with server/.
//
// relay/ is deliberately excluded from this repo's npm workspaces
// (root package.json) so it stays a genuinely self-contained folder someone
// can copy onto a DCS server and run with nothing else from this monorepo
// present -- that rules out sharing the code via a workspace package the
// way packages/geo-math is shared between client/ and server/. Instead, each
// shared file has one canonical copy under server/, and the copies listed in
// TARGETS below are generated from it -- never edit a generated copy directly.
//
// Edit the canonical file, then run:
//   npm run sync:tacview-core
// `npm run check:tacview-core` (no write) fails if any copy has diverged;
// `npm run lint` and CI run it. `--staged` (used by the pre-commit hook)
// works on the git index instead of the working tree: it generates each copy
// from the *staged* source and writes it straight into the index, so a
// partial stage (`git add -p`) commits a matching pair and unstaged work is
// left alone.

const fs   = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')

function jsHeader(source) {
  return `// AUTO-GENERATED -- DO NOT EDIT DIRECTLY.
// Generated from ${source} by scripts/sync-tacview-core.js
// (see that file's header for why this copy exists). To change it, edit
// ${source} and run:
//   npm run sync:tacview-core

`
}

// The client is ESM, so it gets just the constant rather than a verbatim
// copy of the CommonJS module.
function protocolVersionEsm(source) {
  const match = source.match(/^const PROTOCOL_VERSION = (\d+)$/m)
  if (!match) throw new Error('PROTOCOL_VERSION not found in server/src/protocolVersion.js')
  return `export const PROTOCOL_VERSION = ${match[1]}\n`
}

const TARGETS = [
  {
    source: 'server/src/tacviewCore.js',
    target: 'relay/tacviewCore.js',
    build:  (src) => jsHeader('server/src/tacviewCore.js') + src,
  },
  {
    source: 'server/src/protocolVersion.js',
    target: 'relay/protocolVersion.js',
    build:  (src) => jsHeader('server/src/protocolVersion.js') + src,
  },
  {
    source: 'server/src/protocolVersion.js',
    target: 'client/src/webrtc/protocolVersion.js',
    build:  (src) => jsHeader('server/src/protocolVersion.js') + protocolVersionEsm(src),
  },
  {
    // JSON can't carry a generated-file header; the copy is verbatim.
    source: 'server/tacviewDetectionConfig.example.json',
    target: 'relay/tacviewDetectionConfig.example.json',
    build:  (src) => src,
  },
]

const git = (args, input) => execFileSync('git', args, { cwd: ROOT, input, encoding: 'utf8' })

// Staged content of a path, or null if it isn't in the index.
function readStaged(file) {
  try { return git(['show', `:${file}`]) } catch { return null }
}

function syncStaged() {
  for (const { source, target, build } of TARGETS) {
    const staged = readStaged(source)
    if (staged === null) continue
    const expected = build(staged)
    if (readStaged(target) === expected) continue
    const blob = git(['hash-object', '-w', '--stdin'], expected).trim()
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${target}`])
    console.log(`[sync-tacview-core] staged ${target} regenerated from staged ${source}.`)
  }
}

function main() {
  if (process.argv.includes('--staged')) return syncStaged()
  const checkOnly = process.argv.includes('--check')
  let stale = 0

  for (const { source, target, build } of TARGETS) {
    const expected   = build(fs.readFileSync(path.join(ROOT, source), 'utf8'))
    const targetPath = path.join(ROOT, target)
    const actual     = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null
    if (actual === expected) continue

    if (checkOnly) {
      console.error(`[sync-tacview-core] ${target} is out of sync with ${source}.`)
      stale++
    } else {
      fs.writeFileSync(targetPath, expected)
      console.log(`[sync-tacview-core] ${target} updated from ${source}.`)
    }
  }

  if (stale) {
    console.error('[sync-tacview-core] run: npm run sync:tacview-core')
    process.exit(1)
  }
  if (checkOnly) console.log('[sync-tacview-core] in sync.')
}

main()
