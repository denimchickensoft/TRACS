'use strict'

// Finds and reads the file of the mission DCS is running, from what the
// exporter DLL's hello says (savedGames, missionFile, loadTimeMs):
//   host    the .miz DCS loaded (DCS.getMissionFilename). If it was modified
//           after the mission loaded it no longer matches the running
//           mission, and nothing is served.
//   client  the multiplayer track DCS starts writing in
//           <Saved Games>\Tracks\Multiplayer at the join; only its `mission`
//           entry is read, never the recorded track data. It appears about
//           a second after the join, so this waits for it.
// Reading and parsing happen in a worker thread (missionWorker.js).

const fs   = require('fs')
const path = require('path')
const { Worker } = require('worker_threads')

// A file system's timestamps can lag the clock slightly; a .miz saved just
// before loading must not count as modified after it.
const STALE_SLACK_MS = 2000
// A track created this long before the DLL's load time still counts as this
// join's (DCS may create it just before the hook's mission-load callback).
const TRACK_EARLY_MS = 15000
const FIND_TIMEOUT_MS = 30000
const POLL_MS = 1000
const READ_ATTEMPTS = 3
const WORKER_TIMEOUT_MS = 60000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The newest .trk in dir created at or after `since`, or null.
function newestTrack(dir, since, fsImpl = fs) {
  let names
  try { names = fsImpl.readdirSync(dir) } catch { return null }
  let best = null
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.trk')) continue
    const file = path.join(dir, name)
    let st
    try { st = fsImpl.statSync(file) } catch { continue }
    const created = st.birthtimeMs || st.mtimeMs
    if (created < since) continue
    if (!best || created > best.created) best = { file, created }
  }
  return best?.file ?? null
}

// { file } or { error }. `isCancelled()` stops a client's wait early.
async function findMissionFile(hello, { isCancelled = () => false, fsImpl = fs, timeoutMs = FIND_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  if (hello?.side === 'server') {
    if (!hello.missionFile) return { error: 'DCS gave no mission file name' }
    let st
    try { st = fsImpl.statSync(hello.missionFile) } catch { return { error: `mission file not found: ${hello.missionFile}` } }
    if (hello.loadTimeMs && st.mtimeMs > hello.loadTimeMs + STALE_SLACK_MS) {
      return { error: `mission file was modified after the mission loaded, so it may not match the running mission: ${hello.missionFile}` }
    }
    return { file: hello.missionFile }
  }
  if (hello?.side !== 'client') return { error: 'unknown DCS side' }
  if (!hello.savedGames || !hello.loadTimeMs) return { error: 'the DLL sent no Saved Games folder or load time' }
  const dir = path.join(hello.savedGames, 'Tracks', 'Multiplayer')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (isCancelled()) return { error: 'cancelled' }
    const file = newestTrack(dir, hello.loadTimeMs - TRACK_EARLY_MS, fsImpl)
    if (file) return { file }
    if (Date.now() >= deadline) {
      return { error: `no multiplayer track appeared in ${dir} within ${Math.round(timeoutMs / 1000)} s of the mission loading`, code: 'no_track' }
    }
    await sleep(pollMs)
  }
}

// A worker for missionWorker.js: from the relay folder when running from
// source or in Docker, from the executable's embedded copy in the packaged
// relay (a single executable has no files next to it).
function startWorker(file) {
  let sea = null
  try { sea = require('node:sea') } catch { /* Node without SEA support */ }
  if (sea?.isSea?.()) {
    return new Worker(sea.getAsset('missionWorker.js', 'utf8'), { eval: true, workerData: { file } })
  }
  return new Worker(path.join(__dirname, 'missionWorker.js'), { workerData: { file } })
}

function parseInWorker(file) {
  return new Promise((resolve) => {
    const worker = startWorker(file)
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'reading the mission took too long' }), WORKER_TIMEOUT_MS)
    worker.once('message', finish)
    worker.once('error', (err) => finish({ ok: false, error: err.message }))
    worker.once('exit', (code) => finish({ ok: false, error: `mission reader stopped (exit code ${code})` }))
  })
}

// Finds and reads the running mission: { ok: true, file, id, theatre, bytes,
// texts } or { ok: false, error, code? } (code 'no_track': a client with no
// multiplayer track to read). A client's track may still be mid-write
// when first read, so a failed read is retried a few times.
async function loadMission(hello, { isCancelled = () => false, parse = parseInWorker, retryMs = 2000, ...findOpts } = {}) {
  const found = await findMissionFile(hello, { isCancelled, ...findOpts })
  if (found.error) return { ok: false, error: found.error, code: found.code }
  let last = null
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    if (isCancelled()) return { ok: false, error: 'cancelled' }
    last = await parse(found.file)
    if (last.ok) return { ...last, file: found.file }
    if (attempt < READ_ATTEMPTS) await sleep(retryMs)
  }
  return { ok: false, error: `${last.error} (${found.file})` }
}

module.exports = { findMissionFile, loadMission, newestTrack }
