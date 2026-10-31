'use strict'

// Builds tracs_exporter.dll (x64) with MSVC into
// relay/dcs/Mods/Services/TRACS/bin/, where the relay build picks it up with
// the rest of relay/dcs/. Windows only: DCS is.
//
// The import library for DCS's lua.dll is generated from lua51.def, and the
// Lua headers are the official 5.1.5 ones in lua-5.1.5/, so building needs
// no DCS install.
//
// MSVC is found with vswhere (any install with the x64 C++ build tools whose
// headers are actually present) and the newest Windows 10/11 SDK; the
// environment is set up directly rather than through vcvars.
//
// Usage: node relay/native/build.js [--install "<Saved Games>/DCS"]
//   --install also copies Mods/Services/TRACS into that Saved Games folder.
//   DCS must not be running then: it keeps the DLL open.

const { execFileSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const NATIVE_DIR = __dirname
const RELAY_DIR  = path.resolve(NATIVE_DIR, '..')
const BUILD_DIR  = path.join(NATIVE_DIR, 'build')
const MOD_DIR    = path.join(RELAY_DIR, 'dcs', 'Mods', 'Services', 'TRACS')
const OUT_DLL    = path.join(MOD_DIR, 'bin', 'tracs_exporter.dll')

const VSWHERE = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
const KITS = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10')

function newestDir(dir, accept) {
  if (!fs.existsSync(dir)) return null
  const names = fs.readdirSync(dir)
    .filter((n) => accept(path.join(dir, n)))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return names[0] ? path.join(dir, names[0]) : null
}

function findMsvc() {
  if (!fs.existsSync(VSWHERE)) throw new Error(`vswhere not found at ${VSWHERE} - install Visual Studio or the Build Tools with "Desktop development with C++"`)
  const installs = execFileSync(VSWHERE, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  for (const install of installs) {
    const tools = newestDir(path.join(install, 'VC', 'Tools', 'MSVC'),
      (d) => fs.existsSync(path.join(d, 'include', 'excpt.h')) && fs.existsSync(path.join(d, 'bin', 'Hostx64', 'x64', 'cl.exe')))
    if (tools) return tools
  }
  throw new Error('no MSVC x64 toolset with its C headers found')
}

function findSdk() {
  const include = newestDir(path.join(KITS, 'Include'),
    (d) => fs.existsSync(path.join(d, 'ucrt', 'stdio.h')) && fs.existsSync(path.join(d, 'um', 'windows.h')))
  if (!include) throw new Error(`no Windows SDK found under ${KITS}`)
  return path.basename(include)
}

function run(cmd, args, env) {
  console.log(`$ ${path.basename(cmd)} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: BUILD_DIR, env })
}

function main() {
  if (process.platform !== 'win32') throw new Error('tracs_exporter.dll builds on Windows only')
  const installIdx = process.argv.indexOf('--install')
  const installTo = installIdx > 0 ? process.argv[installIdx + 1] : null
  if (installIdx > 0 && !installTo) throw new Error('--install needs a Saved Games folder, e.g. "%USERPROFILE%\\Saved Games\\DCS"')

  const msvc = findMsvc()
  const sdk = findSdk()
  const { version } = require(path.join(RELAY_DIR, 'package.json'))
  console.log(`MSVC ${path.basename(msvc)}, Windows SDK ${sdk}, version ${version}`)

  const env = {
    ...process.env,
    PATH: [path.join(msvc, 'bin', 'Hostx64', 'x64'), path.join(KITS, 'bin', sdk, 'x64'), process.env.PATH].join(';'),
    INCLUDE: [path.join(msvc, 'include'), ...['ucrt', 'um', 'shared'].map((d) => path.join(KITS, 'Include', sdk, d))].join(';'),
    LIB: [path.join(msvc, 'lib', 'x64'), ...['ucrt', 'um'].map((d) => path.join(KITS, 'Lib', sdk, d, 'x64'))].join(';'),
  }
  const bin = (exe) => path.join(msvc, 'bin', 'Hostx64', 'x64', exe)

  fs.mkdirSync(BUILD_DIR, { recursive: true })
  fs.mkdirSync(path.dirname(OUT_DLL), { recursive: true })
  run(bin('lib.exe'), ['/nologo', `/def:${path.join(NATIVE_DIR, 'lua51.def')}`, '/machine:x64', '/out:lua.lib'], env)
  // /MT: the C runtime is linked in, so the DLL doesn't depend on which
  // runtime DLLs a given DCS install happens to ship.
  run(bin('cl.exe'), ['/nologo', '/O2', '/W4', '/WX', '/MT', '/LD',
    `/I${path.join(NATIVE_DIR, 'lua-5.1.5')}`, `/DTRACS_VERSION="${version}"`,
    path.join(NATIVE_DIR, 'tracs_exporter.c'), 'lua.lib',
    '/link', `/out:${OUT_DLL}`, `/implib:${path.join(BUILD_DIR, 'tracs_exporter.lib')}`], env)
  console.log(`\nBuilt ${path.relative(process.cwd(), OUT_DLL)}`)

  if (installTo) {
    const dest = path.join(installTo, 'Mods', 'Services', 'TRACS')
    fs.cpSync(MOD_DIR, dest, { recursive: true })
    console.log(`Installed to ${dest}`)
  }
}

try {
  main()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
