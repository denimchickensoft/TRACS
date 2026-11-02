'use strict'

// Worker thread: reads one mission archive and builds what the relay serves
// from it (missionText.js's buildMissionData), so parsing a big mission never
// holds up the relay's sync and data traffic. Started by missionFile.js with
// workerData { file }; posts back { ok: true, ...data } or { ok: false, error }
// and exits.

const fs = require('fs')
const { parentPort, workerData } = require('worker_threads')
const { buildMissionData } = require('./missionText')

try {
  parentPort.postMessage({ ok: true, ...buildMissionData(fs.readFileSync(workerData.file)) })
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message })
}
