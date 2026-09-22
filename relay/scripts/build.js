'use strict'

// Builds a standalone TracsRelay executable — a Node SEA (Single Executable
// Application) wrapping relay/index.js, for distribution to a VPS or a DCS
// dedicated server with no Node install and no copy of this repo. Mirrors
// server/scripts/terrainDataExe/build.js's already-proven recipe almost
// verbatim: bundle with esbuild -> generate a Node SEA blob -> copy the
// running node executable -> inject the blob with postject.
//
// Native modules: relay/'s only runtime dependency is `ws`, which is pure
// JS — no sidecar-file handling (per resources/specs/production-spec.md §1)
// is needed here. Re-check this comment if a native dependency is ever added.
//
// Usage: node relay/scripts/build.js
// (or:   npm run build --workspace=relay, once wired up)

const { execFileSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const DIR        = __dirname
const RELAY_DIR   = path.resolve(DIR, '..')
const DIST_DIR    = path.join(RELAY_DIR, 'dist')
const EXE_NAME    = process.platform === 'win32' ? 'TracsRelay.exe' : 'TracsRelay'
const BUNDLE      = path.join(DIR, 'index.bundle.js')
const BLOB        = path.join(DIR, 'index.blob')
const SEA_CONFIG  = path.join(DIR, 'sea-config.json')
const ICON_PNG    = path.join(RELAY_DIR, '..', 'resources', 'art', 'TRACS-Relay-icon.png')

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: DIR })
}

function resolveBin(pkgName, binName) {
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`)
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binName]
  return path.join(path.dirname(pkgJsonPath), rel)
}

// Embeds ICON_PNG into exePath as the exe's icon (RT_ICON_GROUP id 1, the
// convention Explorer looks at). Runs on the plain copied node.exe, BEFORE
// postject injects the SEA blob -- postject is purpose-built and tested
// against Node's own SEA workflow, and resedit's full PE regenerate could
// risk not round-tripping a section postject already added.
async function embedIcon(exePath) {
  const { default: pngToIco } = await import('png-to-ico')
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit')

  const icoBuffer = await pngToIco(ICON_PNG)
  // The copied node.exe ships Authenticode-signed; editing resources
  // invalidates that signature regardless (same as postject's own blob
  // injection right after this step), so ignoreCert just lets pe-library
  // parse it rather than refusing on principle.
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true })
  const res = NtExecutableResource.from(exe)
  const iconFile = Data.IconFile.from(icoBuffer)

  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    1,
    1033,
    iconFile.icons.map((item) => item.data),
  )

  res.outputResource(exe)
  fs.writeFileSync(exePath, Buffer.from(exe.generate()))
}

async function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true })
  const exePath = path.join(DIST_DIR, EXE_NAME)

  console.log('\n[1/5] Bundling with esbuild...')
  run(process.execPath, [
    resolveBin('esbuild', 'esbuild'),
    path.join(RELAY_DIR, 'index.js'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${BUNDLE}`,
  ])

  console.log('\n[2/5] Generating Node SEA blob...')
  if (fs.existsSync(BLOB)) fs.rmSync(BLOB)
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG])

  console.log('\n[3/5] Copying node executable...')
  fs.copyFileSync(process.execPath, exePath)

  console.log('\n[4/5] Embedding icon...')
  await embedIcon(exePath)

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

  // config.json is deliberately NOT bundled or embedded — it's read from disk
  // (relative to the running executable's cwd) at startup, same as today, so
  // an operator can edit it without rebuilding. Copy the example alongside
  // the exe as a starting point if one doesn't already exist in dist/.
  const distConfigExample = path.join(DIST_DIR, 'config.example.json')
  if (!fs.existsSync(distConfigExample)) {
    fs.copyFileSync(path.join(RELAY_DIR, 'config.example.json'), distConfigExample)
  }

  console.log(`\nBuilt ${path.relative(process.cwd(), exePath)}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
