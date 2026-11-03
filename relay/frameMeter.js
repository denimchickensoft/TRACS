'use strict'

// Frame meter - with exporter.frameMeter on, the DCS side sends one line a
// second with every frame time of that second and the mission time, whether
// it's collecting or not. This writes them to a file per mission load in
// frame-meter/ next to the relay's config, for scripts/frameMeterReport.js
// to compare runs with different exporters (Olympus, Tacview, this one,
// none) at the same mission time.
//
// File format (JSON lines): a first line {mission: {theatre, side,
// missionFile, startedAt}}, then one {wall, t, frames, ms, p99Ms, maxMs,
// ourMs, ourMaxMs, slow, frameMs} per second.

const fs   = require('fs')
const path = require('path')

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function createFrameMeter(dir) {
  let stream = null
  let file = null
  let failed = false

  // A new mission: close the previous file and start another.
  function start(hello) {
    stop()
    failed = false
    const now = new Date()
    file = path.join(dir, `frame-meter-${stamp(now)}.jsonl`)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      console.error(`[relay:exporter] frame meter - could not create ${dir}: ${err.message}`)
      failed = true
      return
    }
    stream = fs.createWriteStream(file, { flags: 'a' })
    stream.on('error', (err) => {
      if (!failed) console.error(`[relay:exporter] frame meter - could not write ${file}: ${err.message}`)
      failed = true
    })
    stream.write(JSON.stringify({
      mission: { theatre: hello.theatre ?? null, side: hello.side ?? null, missionFile: hello.missionFile ?? null, startedAt: now.toISOString() },
    }) + '\n')
    console.log(`[relay:exporter] frame meter - writing ${file}`)
  }

  function record(msg) {
    if (!stream || failed || msg.group !== 'frames' || msg.kind !== 'second' || !Array.isArray(msg.frameMs)) return
    const { type, group, kind, v, ...fields } = msg
    stream.write(JSON.stringify({ wall: Date.now(), ...fields }) + '\n')
  }

  function stop() {
    stream?.end()
    stream = null
    file = null
  }

  return { start, record, stop }
}

module.exports = { createFrameMeter }
