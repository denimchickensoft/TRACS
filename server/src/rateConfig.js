'use strict'

// Radar scan-rate config — how often unit positions refresh and detection
// passes re-evaluate. Mirrors tacviewDetection.js's config-loading pattern
// exactly: a local file for direct-mode sources (olympus.js, tacview.js),
// a relay-pushed override for relay-hosted Tacview (tacviewRelayClient.js).
//
// Real mechanically-rotating search/EW/GCI radars run roughly 4-12rpm
// (~0.067-0.2Hz, 5-15s/sweep) — AWACS rotodomes and Buk/S-300 acquisition
// radars cluster around 6rpm (0.1Hz, 10s). TRACS's original 1000ms/1Hz
// cadence was a testing-fidelity choice, not a realism one; an operator who
// wants authentic scan behavior can set this file to something in that
// real-world range (server/rateConfig.example.json uses 4000ms/0.25Hz, at
// the brisk end of that range).

const fs = require('fs')
const path = require('path')
const { CONFIG_DIR } = require('./configDir')

const CONFIG_PATH = CONFIG_DIR
  ? path.join(CONFIG_DIR, 'rateConfig.json')
  : path.join(__dirname, '..', 'rateConfig.json')

function loadUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function localConfigFileExists() {
  return fs.existsSync(CONFIG_PATH)
}

const DEFAULTS = {
  unitUpdateMs: 1000,
  detectionMs: 1000,
  missileDetectionMs: 1000,
}

// Every value here becomes a setInterval/setTimeout period, and a bad one
// (null, NaN, 0, a string) makes Node fire the timer about every 1ms, pinning
// a CPU core. So each key must be a finite number, clamped to a sane range;
// anything else falls back to its default with a warning.
const MIN_MS = 100
const MAX_MS = 60000

function mergeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] === undefined) continue
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      console.warn(`[rateConfig] ${key}=${JSON.stringify(value)} is not a number - using ${DEFAULTS[key]}ms`)
      continue
    }
    const clamped = Math.min(Math.max(value, MIN_MS), MAX_MS)
    if (clamped !== value) console.warn(`[rateConfig] ${key}=${value}ms is outside ${MIN_MS}-${MAX_MS}ms - using ${clamped}ms`)
    merged[key] = clamped
  }
  return merged
}

let config = DEFAULTS

function setConfig(merged) {
  config = merged
}

// Direct mode's (olympus.js, tacview.js) authoritative source — re-reads the
// local file fresh from disk rather than reusing a module-load-time
// snapshot, same reasoning as tacviewDetection.js's resetToLocalConfig().
function resetToLocalConfig() {
  setConfig(mergeConfig(loadUserConfig()))
}

// Relay-hosted mode's (tacviewRelayClient.js) pre-connect baseline — plain
// DEFAULTS, no local-file influence at all. Called at the top of start(),
// before the relay's own rate config has arrived over the wire.
function resetToDefaults() {
  setConfig(DEFAULTS)
}

// Relay-hosted mode: the relay operator owns the rate instead of the
// connecting controller's own local file — see relay/index.js's config.json
// (unitUpdateMs/detectionMs/missileDetectionMs) and relay/tacview.js's
// tacviewRateConfig push.
function applyRelayConfig(rawConfig) {
  setConfig(mergeConfig(rawConfig))
}

module.exports = {
  resetToLocalConfig,
  resetToDefaults,
  applyRelayConfig,
  localConfigFileExists,
  get unitUpdateMs() { return config.unitUpdateMs },
  get detectionMs() { return config.detectionMs },
  get missileDetectionMs() { return config.missileDetectionMs },
}
