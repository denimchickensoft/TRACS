/**
 * CATCC ODS command processor.
 *
 * Each command handler receives (parts, context) and returns an array of
 * output line strings. An empty array means success (no output, like STARS).
 *
 * context: { visibleUnits, correlations, view, fb, marshalBearing,
 *             windowSettings, positionName }
 *
 * Aircraft are identified by correlated side number OR callsign.
 */

import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../../store/atc.js'
import { useSessionStore }     from '../../store/session.js'
import { useControllersStore } from '../../store/controllers.js'
import { useDisplayStore }     from '../../store/display.js'
import { saveCatccPrefs }      from '../../store/catccPrefs.js'
import { sendWebrtcEvent, sendWebrtcSessionEvent } from '../../webrtc/client.js'
import { resolveCallsign }     from '../../utils/callsign.js'
import { applyCallsignChange } from '../../utils/callsignRename.js'

const WINDOW_ID = 'catcc-main'

const COMMANDS = {}

function register(verb, fn) {
  COMMANDS[verb] = fn
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMyControllerId() {
  const pos = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[pos]?.controllerId ?? null
}

function findUnit(id, { visibleUnits, correlations }) {
  // Side number first
  for (const [unitId, sideNum] of Object.entries(correlations)) {
    if (sideNum === id) {
      const unit = visibleUnits[unitId]
      if (unit) return { unitId, unit }
    }
  }
  // Callsign fallback
  for (const [unitId, unit] of Object.entries(visibleUnits)) {
    if (resolveCallsign(unit) === id) return { unitId, unit }
  }
  return null
}

// ── Commands ──────────────────────────────────────────────────────────────────

// IT <callsign|side> — initiate track
register('IT', (parts, ctx) => {
  const id = parts[1]
  if (!id) return ['IT <callsign|side>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const { ownership, claimTrack } = useAtcStore.getState()
  if (ownership[target.unitId]) return ['ILL TRK']
  const controllerId = getMyControllerId()
  claimTrack(target.unitId, controllerId)
  sendWebrtcEvent('TRACK_CLAIMED', { unitId: target.unitId, controllerId })
  return []
})

// DT <callsign|side> — drop track
register('DT', (parts, ctx) => {
  const id = parts[1]
  if (!id) return ['DT <callsign|side>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const { ownership, dropTrack, clearHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  if (ownership[target.unitId] !== controllerId) return ['ILL TRK']
  clearHandoff(target.unitId)
  dropTrack(target.unitId)
  sendWebrtcEvent('TRACK_DROPPED', { unitId: target.unitId })
  return []
})

// HO <callsign|side> <tcp> — handoff to controller
register('HO', (parts, ctx) => {
  const id  = parts[1]
  const tcp = parts[2]
  if (!id || !tcp) return ['HO <callsign|side> <tcp>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const { ownership, setHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  if (ownership[target.unitId] !== controllerId) return ['ILL TRK']
  if (tcp === controllerId) return ['ILL POS']
  const knownIds = new Set(
    Object.values(useControllersStore.getState().registry)
      .map((e) => e.controllerId)
      .filter(Boolean)
  )
  if (!knownIds.has(tcp)) return [`ILL POS: ${tcp}`]
  setHandoff(target.unitId, { state: HANDOFF_STATE.INITIATED, from: controllerId, to: tcp })
  sendWebrtcEvent('HANDOFF_INITIATED', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  return []
})

// PO <callsign|side> <tcp> — point out to controller
register('PO', (parts, ctx) => {
  const id  = parts[1]
  const tcp = parts[2]
  if (!id || !tcp) return ['PO <callsign|side> <tcp>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const controllerId = getMyControllerId()
  if (tcp === controllerId) return ['ILL POS']
  useAtcStore.getState().setPointOut(target.unitId, { state: POINTOUT_STATE.SENT, from: controllerId, to: tcp })
  sendWebrtcEvent('POINT_OUT_SENT', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  return []
})

// RN <callsign|side> [newCallsign] — rename or reset (no second arg = reset)
register('RN', (parts, ctx) => {
  const id = parts[1]
  if (!id) return ['RN <callsign|side> [newCallsign]']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const newCallsign = parts[2]?.toUpperCase() ?? null
  const { oldCallsign } = applyCallsignChange(target.unitId, target.unit, newCallsign)
  sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(target.unitId), oldCallsign, newCallsign })
  return []
})

// .HISTORY — toggle history trails on/off
register('.HISTORY', () => {
  const ws = useDisplayStore.getState().windows[WINDOW_ID]
  const current = ws?.showHistory ?? true
  useDisplayStore.getState().updateWindow(WINDOW_ID, { showHistory: !current })
  return []
})

// .LL [0-99] — set leader line length in pixels (omit to query current)
register('.LL', (parts) => {
  const val = parts[1]
  if (!val) {
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    return [`LL: ${ws?.catccLeaderLen ?? 16}`]
  }
  const n = parseInt(val, 10)
  if (isNaN(n) || n < 0 || n > 99) return ['ILL VAL']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { catccLeaderLen: n })
  return []
})

// .LD [N|NE|E|SE|S|SW|W|NW|1-9|OFF] — set global default leader direction (OFF to reset)
const DIR_MAP = { N: '8', NE: '9', E: '6', SE: '3', S: '2', SW: '1', W: '4', NW: '7' }
const NUMPAD_DIRS = new Set(['1','2','3','4','6','7','8','9'])

register('.LD', (parts) => {
  const val = parts[1]
  if (!val || val === 'OFF') {
    useDisplayStore.getState().updateWindow(WINDOW_ID, { globalLeaderDir: null })
    return []
  }
  const key = DIR_MAP[val] ?? (NUMPAD_DIRS.has(val) ? val : null)
  if (!key) return ['ILL DIR']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { globalLeaderDir: key })
  return []
})

// .DBCA — toggle datablock collision avoidance (on by default for CATCC)
register('.DBCA', () => {
  const ws = useDisplayStore.getState().windows[WINDOW_ID]
  const next = !(ws?.dbca ?? true)
  useDisplayStore.getState().updateWindow(WINDOW_ID, { dbca: next })
  saveCatccPrefs({ dbca: next })
  return [`DBCA ${next ? 'ON' : 'OFF'}`]
})

// ── Dispatcher ────────────────────────────────────────────────────────────────
export function processOdsCommand(raw, context) {
  const parts = raw.trim().toUpperCase().split(/\s+/)
  const verb  = parts[0]
  if (!verb) return []
  const handler = COMMANDS[verb]
  if (!handler) return [`INVALID: ${verb}`]
  try {
    return handler(parts, context) ?? []
  } catch (err) {
    return [`ERROR: ${err.message}`]
  }
}
