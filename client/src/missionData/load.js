// Loading the running mission into TRACS: the settings, the per-mission
// "ignore" choice, and the one function every load goes through.

import { runSharedLoad } from './guard.js'
import { parseMissionText } from '../utils/missionFile.js'
import { useSessionStore } from '../store/session.js'

const MODE_KEY    = 'tracs.settings.missionAutoLoad'
const IGNORED_KEY = 'tracs.missionAutoLoad.ignored'
export const AUTO_LOAD_MODES = ['ask', 'always', 'never']

// After a load, the lock is held this much longer so the other windows on
// this machine have the change (BroadcastChannel / IndexedDB) before one of
// them works out what's still missing.
const LOCAL_SETTLE_MS = 500

export function getAutoLoadMode() {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return AUTO_LOAD_MODES.includes(v) ? v : 'ask'
  } catch { return 'ask' }
}

export function setAutoLoadMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode) } catch { /* private mode: session only */ }
}

// "Ignore" holds for one mission (by id) until a different one loads.
export function isIgnored(id) {
  try { return localStorage.getItem(IGNORED_KEY) === id } catch { return false }
}

export function setIgnored(id) {
  try { localStorage.setItem(IGNORED_KEY, id) } catch { /* nothing to keep it in */ }
}

// Everything an area needs about the mission (see areas.js).
export function buildContext(data) {
  const mission = parseMissionText(data.text)
  const session = useSessionStore.getState()
  return {
    id: data.id,
    text: data.text,
    mission,
    theatre: session.mission?.mission?.theatre ?? mission?.theatre ?? null,
    coalition: session.coalition,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// One window on this machine at a time per area (two main windows signed
// into positions share these stores).
function withLocalLock(key, fn) {
  if (!navigator.locks?.request) return fn()
  return navigator.locks.request(`tracs-mission-${key}`, async () => {
    const result = await fn()
    await sleep(LOCAL_SETTLE_MS)
    return result
  })
}

/**
 * Loads one area: when it's this controller's turn (shared areas), works out
 * what's still missing and adds it. Resolves to how much was added.
 */
export function loadArea(area, ctx) {
  const run = async () => {
    const d = await area.diff(ctx)
    if (d.count > 0) await area.apply(d, ctx)
    return d.count
  }
  return withLocalLock(area.key, () => (area.shared ? runSharedLoad(area.key, run) : run()))
}
