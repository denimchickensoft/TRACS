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
// Usage: node relay/native/build.js [--install "<Saved Games>/DCS"] [--harness]
//   --install also copies Mods/Services/TRACS into that Saved Games folder.
//   DCS must not be running then: it keeps the DLL open.
//   --harness also builds a real Lua 5.1.5 (lua.dll + lua.exe, from lua.org's
//   source, checksum-verified) into build/harness/ next to a copy of the DLL,
//   for test/relay/exporterDll.test.js to run the DLL outside DCS.

const { execFileSync } = require('child_process')
const fs   = require('fs')
const path = require('path')

const NATIVE_DIR = __dirname
const RELAY_DIR  = path.resolve(NATIVE_DIR, '..')
const BUILD_DIR  = path.join(NATIVE_DIR, 'build')
const MOD_DIR    = path.join(RELAY_DIR, 'dcs', 'Mods', 'Services', 'TRACS')
const OUT_DLL    = path.join(MOD_DIR, 'bin', 'tracs_exporter.dll')
const SOURCES    = ['tracs_exporter.c', 'sched.c', 'client.c', 'server.c', 'serverlow.c', 'net.c', 'common.c']

const HARNESS_DIR = path.join(BUILD_DIR, 'harness')
const LUA_URL     = 'https://www.lua.org/ftp/lua-5.1.5.tar.gz'
const LUA_SHA256  = '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333'
// Lua 5.1.5's library sources (everything in src/ but the lua and luac mains).
const LUA_LIB_SOURCES = ['lapi', 'lcode', 'ldebug', 'ldo', 'ldump', 'lfunc', 'lgc', 'llex', 'lmem', 'lobject',
  'lopcodes', 'lparser', 'lstate', 'lstring', 'ltable', 'ltm', 'lundump', 'lvm', 'lzio', 'lauxlib', 'lbaselib',
  'ldblib', 'liolib', 'lmathlib', 'loslib', 'ltablib', 'lstrlib', 'loadlib', 'linit']

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

function run(cmd, args, env, cwd = BUILD_DIR) {
  console.log(`$ ${path.basename(cmd)} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd, env })
}

// lua.dll (named as DCS's, so tracs_exporter.dll's import resolves to it) and
// a lua.exe using it, built from the official source. Re-extracting over an
// earlier build just overwrites it.
async function buildHarness(bin, env) {
  const tarball = path.join(BUILD_DIR, 'lua-5.1.5.tar.gz')
  if (!fs.existsSync(tarball)) {
    console.log(`Downloading ${LUA_URL}`)
    const res = await fetch(LUA_URL)
    if (!res.ok) throw new Error(`${LUA_URL}: HTTP ${res.status}`)
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
  }
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')
  if (sha !== LUA_SHA256) {
    fs.unlinkSync(tarball)
    throw new Error(`lua-5.1.5.tar.gz checksum mismatch (${sha})`)
  }
  fs.mkdirSync(HARNESS_DIR, { recursive: true })
  // Windows' own tar: a GNU tar earlier on PATH (Git's) reads "C:" as a host.
  run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xzf', tarball, '-C', HARNESS_DIR], env)
  const src = path.join(HARNESS_DIR, 'lua-5.1.5', 'src')
  const flags = ['/nologo', '/O2', '/MT', '/W3', '/DLUA_BUILD_AS_DLL', '/D_CRT_SECURE_NO_WARNINGS']
  run(bin('cl.exe'), [...flags, '/c', ...LUA_LIB_SOURCES.map((f) => path.join(src, `${f}.c`))], env, HARNESS_DIR)
  run(bin('link.exe'), ['/nologo', '/DLL', '/out:lua.dll', '/implib:lua.lib', ...LUA_LIB_SOURCES.map((f) => `${f}.obj`)],
    env, HARNESS_DIR)
  run(bin('cl.exe'), [...flags, path.join(src, 'lua.c'), 'lua.lib', '/link', '/out:lua.exe'], env, HARNESS_DIR)
  fs.copyFileSync(OUT_DLL, path.join(HARNESS_DIR, 'tracs_exporter.dll'))
  console.log(`Built ${path.relative(process.cwd(), HARNESS_DIR)}`)
}

async function main() {
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
  // runtime DLLs a given DCS install happens to ship. Our own sources build
  // warning-free at /W4; the vendored cJSON is compiled as its author ships it.
  const common = ['/nologo', '/O2', '/MT', '/c',
    `/I${path.join(NATIVE_DIR, 'lua-5.1.5')}`, `/I${path.join(NATIVE_DIR, 'cjson-1.7.18')}`]
  run(bin('cl.exe'), [...common, '/W3', path.join(NATIVE_DIR, 'cjson-1.7.18', 'cJSON.c')], env)
  run(bin('cl.exe'), [...common, '/W4', '/WX', `/DTRACS_VERSION="${version}"`,
    ...SOURCES.map((f) => path.join(NATIVE_DIR, f))], env)
  run(bin('link.exe'), ['/nologo', '/DLL', `/out:${OUT_DLL}`, `/implib:${path.join(BUILD_DIR, 'tracs_exporter.lib')}`,
    ...SOURCES.map((f) => f.replace(/\.c$/, '.obj')), 'cJSON.obj', 'lua.lib', 'ws2_32.lib'], env)
  console.log(`\nBuilt ${path.relative(process.cwd(), OUT_DLL)}`)

  if (process.argv.includes('--harness')) await buildHarness(bin, env)

  if (installTo) {
    const dest = path.join(installTo, 'Mods', 'Services', 'TRACS')
    fs.cpSync(MOD_DIR, dest, { recursive: true })
    console.log(`Installed to ${dest}`)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
