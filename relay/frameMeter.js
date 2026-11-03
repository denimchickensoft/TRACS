'use strict'

// Frame meter - with exporter.frameMeter on, the DCS side sends one line a
// second with every frame time of that second and the mission time, whether
// it's collecting or not. This writes them to a file per mission load in
// frame-meter/ next to the relay's config, for scripts/frameMeterReport.js
// to compare runs with different exporters (Olympus, Tacview, this one,
// none) at the same mission time.
//
// The folder is kept under MAX_BYTES (about 8 hours of mission), so the
// meter can be left on: the oldest files go first, and a single mission
// long enough to reach the cap on its own stops being recorded there.
//
// File format (JSON lines): a first line {mission: {theatre, side,
// missionFile, startedAt}}, then one {wall, t, frames, ms, p99Ms, maxMs,
// ourMs, ourMaxMs, slow, frameMs} per second.

const fs   = require('fs')
const path = require('path')

const MAX_BYTES = 200 * 1024 * 1024
const FILE_RE = /^frame-meter-\d{8}-\d{6}\.jsonl$/

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function createFrameMeter(dir, { maxBytes = MAX_BYTES } = {}) {
  let stream = null
  let file = null
  let failed = false
  let full = false
  let written = 0
  // Earlier meter files, oldest first ({ file, bytes }), and their total.
  let older = []
  let olderBytes = 0

  function listOlder() {
    older = fs.readdirSync(dir)
      .filter((name) => FILE_RE.test(name))
      .map((name) => ({ file: path.join(dir, name), name, bytes: fs.statSync(path.join(dir, name)).size }))
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    olderBytes = older.reduce((sum, f) => sum + f.bytes, 0)
  }

  // Deletes the oldest earlier files until everything fits under the cap.
  function prune() {
    while (older.length && olderBytes + written > maxBytes) {
      const oldest = older.shift()
      olderBytes -= oldest.bytes
      try { fs.unlinkSync(oldest.file) } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[relay:exporter] frame meter - could not delete ${oldest.file}: ${err.message}`)
      }
    }
  }

  function write(line) {
    written += Buffer.byteLength(line)
    stream.write(line)
    if (olderBytes + written > maxBytes) prune()
    if (written >= maxBytes) {
      full = true
      console.warn(`[relay:exporter] frame meter - ${file} reached ${Math.round(maxBytes / 1048576)} MB, no more frame times recorded for this mission`)
    }
  }

  // A new mission: close the previous file and start another.
  function start(hello) {
    stop()
    failed = full = false
    written = 0
    const now = new Date()
    file = path.join(dir, `frame-meter-${stamp(now)}.jsonl`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      listOlder()
    } catch (err) {
      console.error(`[relay:exporter] frame meter - could not use ${dir}: ${err.message}`)
      failed = true
      return
    }
    // A restart within the same second appends to the same file.
    const existing = older.findIndex((f) => f.file === file)
    if (existing >= 0) {
      written = older[existing].bytes
      olderBytes -= written
      older.splice(existing, 1)
    }
    prune()
    stream = fs.createWriteStream(file, { flags: 'a' })
    stream.on('error', (err) => {
      if (!failed) console.error(`[relay:exporter] frame meter - could not write ${file}: ${err.message}`)
      failed = true
    })
    write(JSON.stringify({
      mission: { theatre: hello.theatre ?? null, side: hello.side ?? null, missionFile: hello.missionFile ?? null, startedAt: now.toISOString() },
    }) + '\n')
    console.log(`[relay:exporter] frame meter - writing ${file}`)
  }

  function record(msg) {
    if (!stream || failed || full || msg.group !== 'frames' || msg.kind !== 'second' || !Array.isArray(msg.frameMs)) return
    const { type, group, kind, v, ...fields } = msg
    write(JSON.stringify({ wall: Date.now(), ...fields }) + '\n')
  }

  function stop() {
    stream?.end()
    stream = null
    file = null
  }

  return { start, record, stop }
}

module.exports = { createFrameMeter }
