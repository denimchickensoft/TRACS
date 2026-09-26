'use strict'

// Hand-rolled auto-update for the packaged Relay SEA binary. No off-the-shelf
// equivalent exists for a standalone Node SEA the way electron-updater covers
// TRACS itself.
//
// Mechanism: within the configured mode/window, check GitHub Releases for a
// newer relay-vX.Y.Z tag (the repo is public, so no token is needed),
// download the new binary, swap it onto disk
// at the existing launch path, log a clear message, then exit cleanly.
// Deliberately supervisor-agnostic — it never tries to manage its own
// process lifecycle beyond that clean exit; an external supervisor
// (pm2 --interpreter none, systemd, NSSM) is expected to notice the exit and
// relaunch it, now running the new binary. Only ever invoked from
// relay/index.js's isSeaBinary guard — a plain `node index.js` dev run has
// no standalone executable to swap out from under itself.

const fs    = require('fs')
const path  = require('path')
const https = require('https')
const { version: CURRENT_VERSION } = require('./package.json')

const REPO = 'denimchickensoft/TRACS'
// Re-checks periodically (not just at startup) so a "window" mode config
// actually gets applied on a long-running, continuously-supervised process,
// not only on the rare occasion it happens to be restarted inside the window.
const CHECK_INTERVAL_MS = 15 * 60 * 1000

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'tracs-relay-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGetJson(res.headers.location))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`GitHub API returned ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (err) { reject(err) }
      })
    }).on('error', reject)
  })
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'tracs-relay-updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadFile(res.headers.location, destPath))
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`download failed: ${res.statusCode}`))
        return
      }
      const file = fs.createWriteStream(destPath)
      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', reject)
    }).on('error', reject)
  })
}

// Parses "relay-vX.Y.Z" -> "X.Y.Z"; returns null for anything that isn't a
// Relay release tag (e.g. a tracs-vX.Y.Z release from the *other* app, which
// /releases lists right alongside Relay's own since both share one repo).
function parseRelayTag(tag) {
  const m = /^relay-v(\d+\.\d+\.\d+)$/.exec(tag)
  return m ? m[1] : null
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return false
}

async function findLatestRelayRelease() {
  const releases = await httpsGetJson(`https://api.github.com/repos/${REPO}/releases`)
  for (const release of releases) {
    const version = parseRelayTag(release.tag_name)
    if (version) return { version, release }
  }
  return null
}

function assetNameForPlatform() {
  return process.platform === 'win32' ? 'TRACS-Relay.exe' : 'TRACS-Relay'
}

// Intl.DateTimeFormat gives the current time-of-day in the configured
// timezone directly, without a date-math library.
function inWindow(windowCfg) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: windowCfg.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date())
  const nowMinutes = Number(parts.find((p) => p.type === 'hour').value) * 60
                    + Number(parts.find((p) => p.type === 'minute').value)

  const [startH, startM] = windowCfg.start.split(':').map(Number)
  const [endH, endM]     = windowCfg.end.split(':').map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes   = endH * 60 + endM

  return startMinutes <= endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes // window spans midnight
}

async function applyUpdate(latest, { exePath, exeDir }) {
  const assetName = assetNameForPlatform()
  const asset = latest.release.assets?.find((a) => a.name === assetName)
  if (!asset) throw new Error(`no ${assetName} asset on release ${latest.release.tag_name}`)

  const tmpPath = path.join(exeDir, `${assetName}.download`)
  const oldPath = `${exePath}.old`

  // Clean up a stale .old left by a PREVIOUS update cycle — safe here, since
  // by the time this process is running a new cycle, the supervisor has long
  // since relaunched from that cycle's new binary and nothing still has the
  // old one open.
  fs.rmSync(oldPath, { force: true })

  console.log(`[relay:update] downloading ${latest.release.tag_name}...`)
  await downloadFile(asset.browser_download_url, tmpPath)
  const { size } = fs.statSync(tmpPath)
  if (size === 0) throw new Error('downloaded file is empty')

  // Windows won't let you overwrite (or reliably delete) a running exe's
  // bytes directly — renaming it aside is permitted where deleting/
  // overwriting it isn't. The just-renamed .old is left in place and cleaned
  // up lazily on the *next* update cycle (above), not here — this process is
  // still executing from that file at the moment of this rename.
  fs.renameSync(exePath, oldPath)
  fs.renameSync(tmpPath, exePath)
  if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755)

  console.log(`[relay:update] restarting to apply update v${latest.version}`)
  process.exit(0)
}

async function checkOnce(autoUpdateCfg, ctx) {
  const latest = await findLatestRelayRelease()
  if (!latest || !isNewer(latest.version, CURRENT_VERSION)) return

  const { mode, window } = autoUpdateCfg
  if (mode === 'notify') {
    console.log(`[relay:update] v${latest.version} available (current: v${CURRENT_VERSION}) - mode=notify, not applying automatically`)
    return
  }
  if (mode === 'window' && !inWindow(window)) {
    console.log(`[relay:update] v${latest.version} available - waiting for maintenance window (${window.start}-${window.end} ${window.timezone})`)
    return
  }

  await applyUpdate(latest, ctx)
}

async function checkAndApplyUpdate(autoUpdateCfg, ctx) {
  await checkOnce(autoUpdateCfg, ctx)
  setInterval(() => {
    checkOnce(autoUpdateCfg, ctx).catch((err) => console.error('[relay:update] check failed:', err.message))
  }, CHECK_INTERVAL_MS).unref()
}

module.exports = { checkAndApplyUpdate }
