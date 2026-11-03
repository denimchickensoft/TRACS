'use strict'

// Builds a standalone TRACS Relay executable — a Node SEA (Single Executable
// Application) wrapping relay/index.js, for distribution to a VPS or a DCS
// dedicated server with no Node install and no copy of this repo. Mirrors
// server/scripts/terrainDataExe/build.js's already-proven recipe almost
// verbatim: bundle with esbuild -> generate a Node SEA blob -> copy the
// running node executable -> inject the blob with postject.
//
// Native modules: relay/'s only runtime dependency is `ws`, which is pure
// JS — no sidecar-file handling is needed here. Re-check this comment if a native dependency is ever added.
//
// Usage: node relay/scripts/build.js
// (or:   npm run build --workspace=relay, once wired up)

const { execFileSync } = require('child_process')
const fs   = require('fs')
const crypto = require('crypto')
const path = require('path')

const DIR        = __dirname
const RELAY_DIR   = path.resolve(DIR, '..')
const DIST_DIR    = path.join(RELAY_DIR, 'dist')
const EXE_NAME    = process.platform === 'win32' ? 'TRACS-Relay.exe' : 'TRACS-Relay'
const BUNDLE      = path.join(DIR, 'index.bundle.js')
const BLOB        = path.join(DIR, 'index.blob')
const WORKER_BUNDLE = path.join(DIR, 'missionWorker.bundle.js')
const SEA_CONFIG  = path.join(DIR, 'sea-config.json')
const SEA_CONFIG_BUILD = path.join(DIR, 'sea-config.build.json')
const ICON_PNG    = path.join(RELAY_DIR, 'icon.png')

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

  // esbuild's JS API, not `node esbuild/bin/esbuild`: on Linux and macOS,
  // esbuild's installer replaces bin/esbuild with the native binary, which
  // Node can't run as a script.
  console.log('\n[1/5] Bundling with esbuild...')
  require('esbuild').buildSync({
    entryPoints: [path.join(RELAY_DIR, 'index.js')],
    bundle:      true,
    platform:    'node',
    format:      'cjs',
    outfile:     BUNDLE,
  })
  // The mission reader runs in a worker thread, which needs its own
  // self-contained script: embedded in the executable as an SEA asset
  // (sea-config.json) and started from it (missionFile.js).
  require('esbuild').buildSync({
    entryPoints: [path.join(RELAY_DIR, 'missionWorker.js')],
    bundle:      true,
    platform:    'node',
    format:      'cjs',
    outfile:     WORKER_BUNDLE,
  })

  // The exporter's DCS side (hook, entry.lua, tracs_exporter.dll) is
  // embedded in the executable too, and exporterInstall.js writes it into
  // Saved Games from there, so an auto-update (which replaces only the exe)
  // always brings the matching hook and DLL. Windows builds only: DCS runs on
  // Windows, the exporter talks to a relay on the same machine, and the DLL
  // only builds there.
  const seaConfig = JSON.parse(fs.readFileSync(SEA_CONFIG, 'utf8'))
  if (process.platform === 'win32') {
    console.log('\nBuilding tracs_exporter.dll...')
    execFileSync(process.execPath, [path.join(RELAY_DIR, 'native', 'build.js')], { stdio: 'inherit' })
    const { FILES, assetName } = require('../exporterInstall')
    for (const rel of FILES) seaConfig.assets[assetName(rel)] = path.join(RELAY_DIR, 'dcs', rel)
    const dll = fs.readFileSync(path.join(RELAY_DIR, 'dcs', FILES[0]))
    console.log(`tracs_exporter.dll SHA-256 (for the release notes): ${crypto.createHash('sha256').update(dll).digest('hex')}`)
  }
  fs.writeFileSync(SEA_CONFIG_BUILD, JSON.stringify(seaConfig, null, 2))

  console.log('\n[2/5] Generating Node SEA blob...')
  if (fs.existsSync(BLOB)) fs.rmSync(BLOB)
  run(process.execPath, ['--experimental-sea-config', SEA_CONFIG_BUILD])
  fs.rmSync(SEA_CONFIG_BUILD, { force: true })

  console.log('\n[3/5] Copying node executable...')
  fs.copyFileSync(process.execPath, exePath)

  // Windows only: resedit parses PE executables, and ELF binaries have no
  // embedded-icon convention to write to.
  if (process.platform === 'win32') {
    console.log('\n[4/5] Embedding icon...')
    await embedIcon(exePath)
  } else {
    console.log('\n[4/5] Embedding icon... skipped (not a Windows build)')
  }

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

  // The DCS files are inside the exe now; an older build's loose copy would
  // only go stale next to an auto-updated exe.
  fs.rmSync(path.join(DIST_DIR, 'dcs'), { recursive: true, force: true })

  console.log(`\nBuilt ${path.relative(process.cwd(), exePath)}\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
