'use strict'

const fs   = require('fs')
const path = require('path')

const STATE_DIR = path.join(__dirname, '../state')

const FILES = {
  atc:     path.join(STATE_DIR, 'atc.json'),
  catcc:   path.join(STATE_DIR, 'catcc.json'),
  session: path.join(STATE_DIR, 'session.json'),
}

const DEFAULTS = {
  atc: {
    flightPlans:    {},
    trackOwnership: {},
    handoffs:       {},
    pointOuts:      {},
  },
  catcc: {
    statusBoard: {
      entries:        [],
      eventHeader:    {},
      recoveryStatus: {},
    },
    trackOwnership: {},
    handoffs:       {},
    pointOuts:      {},
  },
  session: {
    clientList:       [],
    olympusAddress:   '',
    intentionalReset: false,
  },
}

const VALID_KEYS = new Set(['atc', 'catcc', 'session'])

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })
}

function read(key) {
  try {
    return JSON.parse(fs.readFileSync(FILES[key], 'utf8'))
  } catch {
    return structuredClone(DEFAULTS[key])
  }
}

// Atomic write: write to .tmp then rename over the target.
// fs.renameSync is atomic on the same filesystem (POSIX rename(2)).
function write(key, data) {
  ensureDir()
  const tmp = FILES[key] + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, FILES[key])
}

function patch(key, updates) {
  write(key, { ...read(key), ...updates })
}

function setIntentionalReset(value) {
  patch('session', { intentionalReset: value })
}

function isValidKey(key) {
  return VALID_KEYS.has(key)
}

module.exports = { read, write, patch, setIntentionalReset, isValidKey, DEFAULTS }
