'use strict'

// electron-builder afterPack hook: flips Electron's fuses in the packaged
// binary so the installed app can't be repurposed as a general Node runtime
// (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect). TRACS never re-spawns its
// own binary as Node - the server runs in-process - so nothing needs these.
//
// The asar-integrity fuses are left alone: they require `asar: true`, and the
// app is packaged unpacked.
//
// On macOS universal builds electron-builder packs an x64 and an arm64 copy
// (in `<appOutDir>-x64-temp` / `-arm64-temp`), runs this hook on each, merges
// them, then runs it again on the merged app. The per-arch copies are
// skipped: resetting their signatures rewrites each copy's framework
// _CodeSignature/CodeResources differently, and the merge then refuses
// ("Expected all non-binary files to have identical SHAs"). Only the merged
// app is flipped; @electron/fuses writes both slices of its universal binary.
// The ad-hoc signature is reset afterwards because editing the binary
// invalidates it, and arm64 macOS refuses to launch an unsigned binary; real
// signing (when configured) happens after this hook.

const path = require('path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

function electronBinaryPath(context) {
  const { appOutDir, electronPlatformName, packager } = context
  const name = packager.appInfo.productFilename
  switch (electronPlatformName) {
    case 'win32':  return path.join(appOutDir, `${name}.exe`)
    case 'darwin':
    case 'mas':    return path.join(appOutDir, `${name}.app`)
    default:       return path.join(appOutDir, packager.executableName)
  }
}

module.exports = async function flipElectronFuses(context) {
  const binary = electronBinaryPath(context)
  const isMac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas'

  if (isMac && /-(x64|arm64)-temp$/.test(context.appOutDir)) {
    console.log(`[flip-fuses] skipping per-arch copy ${path.relative(process.cwd(), context.appOutDir)}; fuses are set on the merged universal app`)
    return
  }

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: isMac,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })
  console.log(`[flip-fuses] fuses set on ${path.relative(process.cwd(), binary)}`)
}
