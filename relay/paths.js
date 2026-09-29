'use strict'

// The one place the relay resolves where its files live (config.json,
// sessions.json, tacviewDetectionConfig.json). __dirname inside a Node SEA
// binary (see scripts/build.js) doesn't correspond to a real directory on
// disk, so a packaged relay reads and writes relative to the running
// executable instead, mirroring the isSeaBinary/exeDir pattern in
// server/scripts/terrainDataExe/main.js. A plain `node index.js` run uses
// this folder.

const path = require('path')

let isSeaBinary = false
try { isSeaBinary = require('node:sea').isSea() } catch { /* Node < 21, or not built as SEA */ }

const RELAY_DIR = isSeaBinary ? path.dirname(process.execPath) : __dirname

module.exports = { isSeaBinary, RELAY_DIR }
