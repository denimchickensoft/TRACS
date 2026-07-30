'use strict'

// Builds dist/TracsTerrainDataBuilder.exe — a standalone Windows console
// executable wrapping main.js, for distribution to machines that only have a
// DCS World install and no copy of this repo.
//
// Pipeline: regenerate the runway-data require map -> bundle main.js with
// esbuild (inlines the local navdata config JSON and runway JSON as JS
// objects) -> generate a Node SEA blob from the bundle -> copy the running
// node.exe -> inject the blob into the copy with postject.
//
// Usage: node server/scripts/terrainDataExe/build.js
// (or:   npm run build:terrain-exe --workspace=server)

const { execFileSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const DIR       = __dirname
const DIST_DIR  = path.join(DIR, '../../dist')
const EXE_NAME  = 'TracsTerrainDataBuilder.exe'
const BUNDLE    = path.join(DIR, 'main.bundle.js')
const BLOB      = path.join(DIR, 'main.blob')
const SEA_CONFIG = path.join(DIR, 'sea-config.json')

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: DIR })
}

function resolveBin(pkgName, binName) {
  const binPath = require.resolve(`${pkgName}/package.json`)
  const pkg = JSON.parse(fs.readFileSync(binPath, 'utf8'))
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binName]
  return path.join(path.dirname(binPath), rel)
}

function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true })
  const exePath = path.join(DIST_DIR, EXE_NAME)

  console.log('\n[1/5] Regenerating runway data map...')
  run(process.execPath, [path.join(DIR, 'genRunwayData.js')])

  console.log('\n[2/5] Bundling with esbuild...')
  run(process.execPath, [
    resolveBin('esbuild', 'esbuild'),
    path.join(DIR, 'main.js'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${BUNDLE}`,
  ])

  console.log('\n[3/5] Generating Node SEA blob...')
  if (fs.existsSync(BLOB)) fs.rmSync(BLOB)
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG])

  console.log('\n[4/5] Copying node.exe...')
  fs.copyFileSync(process.execPath, exePath)

  console.log('\n[5/5] Injecting blob with postject...')
  run(process.execPath, [
    resolveBin('postject', 'postject'),
    exePath,
    'NODE_SEA_BLOB',
    BLOB,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    '--overwrite',
  ])

  fs.rmSync(BUNDLE, { force: true })
  fs.rmSync(BLOB, { force: true })

  console.log(`\nBuilt ${path.relative(process.cwd(), exePath)}\n`)
}

main()
