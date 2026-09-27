'use strict'

// electron-builder afterPack hook: flips Electron's fuses in the packaged
// binary so the installed app can't be repurposed as a general Node runtime
// (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect). TRACS never re-spawns its
// own binary as Node - the server runs in-process - so nothing needs these.
//
// The asar-integrity fuses are left alone: they require `asar: true`, and the
// app is packaged unpacked.
//
// On macOS universal builds this runs once per arch slice and again on the
// merged app; flipping is idempotent, and @electron/fuses writes both slices
// of a universal binary. The ad-hoc signature is reset afterwards because
// editing the binary invalidates it, and arm64 macOS refuses to launch an
// unsigned binary; real signing (when configured) happens after this hook.

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
