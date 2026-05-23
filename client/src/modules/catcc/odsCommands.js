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
