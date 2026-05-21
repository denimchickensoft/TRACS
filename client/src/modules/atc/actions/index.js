/**
 * STARS action library.
 *
 * Every controller action is implemented here, invoked identically
 * regardless of which interaction model triggered it.
 *
 * Each action receives:
 *   captures   — named captures from the command parser
 *   slewTarget — { unitId, unit } | null  (null for ENTER-triggered commands)
 *   context    — { positionName, ownership, handoffs, pointOuts }
 *
 * Returns a string to display as the system response, or null on success.
 */

import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../../../store/atc.js'
import { usePreviewStore } from '../../../store/preview.js'
import { useDisplayStore } from '../../../store/display.js'
import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { useStripsStore, STRIP_HIGHLIGHT } from '../../../store/strips.js'
import { useFpeStore } from '../../../store/fpe.js'
import { useSessionStore } from '../../../store/session.js'
import { useControllersStore } from '../../../store/controllers.js'
import { resolveCallsign } from '../../../utils/callsign.js'
import { applyCallsignChange } from '../../../utils/callsignRename.js'
import { sendWebrtcEvent, sendWebrtcSessionEvent } from '../../../webrtc/client.js'

const WINDOW_ID = 'atc-main'

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok()          { usePreviewStore.getState().clearAfterCommand() }
function err(msg)      { usePreviewStore.getState().setResponse(msg) }
function clearBuffer() { usePreviewStore.getState().clear() }

function getAtc()     { return useAtcStore.getState() }
function getDisplay() { return useDisplayStore.getState() }

function getMyControllerId() {
  const positionName = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[positionName]?.controllerId ?? null
}

// ── Action handlers ───────────────────────────────────────────────────────────

export function INIT_CNTL({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const controllerId = getMyControllerId()
  if (!controllerId) return err('NO POSITION')
  const { ownership, claimTrack } = getAtc()
  if (ownership[slewTarget.unitId] !== undefined) return err('ILL TRK')
  claimTrack(slewTarget.unitId, controllerId)
  sendWebrtcEvent('TRACK_CLAIMED', { unitId: slewTarget.unitId, controllerId })
  if (useSessionStore.getState().activeModule === 'ATC') {
    const aid = resolveCallsign(slewTarget.unit)
    useStripsStore.getState().addStrip(aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED, unitId: slewTarget.unitId })
  }
  ok()
}

export function OPEN_FPE({ captures, slewTarget }) {
  const aid = captures?.aid?.trim().toUpperCase() ?? null

  let unitId   = null
  let readOnly = false

  if (slewTarget) {
    unitId = slewTarget.unitId
  } else if (aid) {
    const plan = useFlightPlansStore.getState().plans[aid]
    if (plan?.unitId) unitId = String(plan.unitId)
  }

  if (unitId) {
    const owner = useAtcStore.getState().ownership[unitId]
    readOnly = !!(owner && owner !== getMyControllerId())
  }

  useFpeStore.getState().openFpe({ aid, unitId, readOnly })
  ok()
}

export function INIT_CNTL_BY_ID({ captures, positionName }) {
  // TODO: resolve unit by callsign/FLID when flight plan store exists
  err('NOT YET SUPPORTED')
}

export function TERM_CNTL({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { ownership, dropTrack, clearHandoff } = getAtc()
  if (ownership[slewTarget.unitId] !== getMyControllerId()) return err('ILL TRK')
  clearHandoff(slewTarget.unitId)
  dropTrack(slewTarget.unitId)
  sendWebrtcEvent('TRACK_DROPPED', { unitId: slewTarget.unitId })
  if (useSessionStore.getState().activeModule === 'ATC') {
    const { deleteOnDropTrack, deleteByAid } = useStripsStore.getState()
    if (deleteOnDropTrack) {
      const aid = resolveCallsign(slewTarget.unit)
      if (aid) deleteByAid(aid)
    }
  }
  ok()
}

export function TERM_CNTL_ALL() {
  const { ownership, dropTrack, clearHandoff } = getAtc()
  const controllerId = getMyControllerId()
  const { deleteOnDropTrack, deleteByAid } = useStripsStore.getState()
  const plans = useFlightPlansStore.getState().plans
  for (const [id, owner] of Object.entries(ownership)) {
    if (owner === controllerId) {
      clearHandoff(id)
      dropTrack(id)
      if (deleteOnDropTrack) {
        const plan = Object.values(plans).find((p) => p.unitId === Number(id))
        if (plan) deleteByAid(plan.aid)
      }
    }
  }
  ok()
}

export function HND_OFF({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { ownership, handoffs, setHandoff } = getAtc()
  const controllerId = getMyControllerId()

  // Bare HO + slew on a track with outgoing handoff = recall
  const existing = handoffs[slewTarget.unitId]
  if (existing?.state === HANDOFF_STATE.INITIATED && existing.from === controllerId) {
    getAtc().clearHandoff(slewTarget.unitId)
    return ok()
  }

  const tcp = captures?.tcp
  if (!tcp) return err('ILL POS')
  if (tcp === controllerId) return err('ILL POS')
  const knownIds = new Set(Object.values(useControllersStore.getState().registry).map((e) => e.controllerId).filter(Boolean))
  if (!knownIds.has(tcp)) return err('ILL POS')
  if (ownership[slewTarget.unitId] !== controllerId) return err('ILL TRK')
  setHandoff(slewTarget.unitId, { state: HANDOFF_STATE.INITIATED, from: controllerId, to: tcp })
  sendWebrtcEvent('HANDOFF_INITIATED', { unitId: slewTarget.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

export function HND_OFF_BARE({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { handoffs, clearHandoff, claimTrack } = getAtc()
  const controllerId = getMyControllerId()
  const ho = handoffs[slewTarget.unitId]

  if (!ho) return err('ILL POS')

  if (ho.state === HANDOFF_STATE.INITIATED && ho.from === controllerId) {
    clearHandoff(slewTarget.unitId)
    sendWebrtcEvent('HANDOFF_RECALLED', { unitId: slewTarget.unitId, fromControllerId: controllerId, toControllerId: ho.to })
    return ok()
  }

  if (ho.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
    getAtc().dropTrack(slewTarget.unitId)
    claimTrack(slewTarget.unitId, controllerId)
    clearHandoff(slewTarget.unitId)
    sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: slewTarget.unitId, fromControllerId: ho.from, toControllerId: controllerId })
    return ok()
  }

  err('INVALID HANDOFF STATE')
}

export function HND_OFF_ACCEPT_NEAR() {
  // Accept the handoff nearest range rings center (simplification: first incoming)
  const { handoffs, claimTrack, clearHandoff } = getAtc()
  const controllerId = getMyControllerId()
  for (const [id, ho] of Object.entries(handoffs)) {
    if (ho.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
      claimTrack(id, controllerId)
      clearHandoff(id)
      sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: id, fromControllerId: ho.from, toControllerId: controllerId })
      return ok()
    }
  }
  err('NO INCOMING HANDOFF')
}

export function POINT_OUT({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const tcp = captures?.tcp
  if (!tcp) return err('ILL POS')
  const controllerId = getMyControllerId()
  getAtc().setPointOut(slewTarget.unitId, { state: POINTOUT_STATE.SENT, from: controllerId, to: tcp })
  sendWebrtcEvent('POINT_OUT_SENT', { unitId: slewTarget.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

export function REJECT_POINT_OUT({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const controllerId = getMyControllerId()
  const po = getAtc().pointOuts[slewTarget.unitId]
  if (po?.state !== POINTOUT_STATE.RECEIVING || po.to !== controllerId) return err('ILL TRK')
  getAtc().clearPointOut(slewTarget.unitId)
  sendWebrtcEvent('POINT_OUT_REJECTED', { unitId: slewTarget.unitId, fromControllerId: po.from, toControllerId: controllerId })
  ok()
}

export function CONVERT_POINT_OUT({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { pointOuts, clearPointOut, claimTrack } = getAtc()
  const controllerId = getMyControllerId()
  const po = pointOuts[slewTarget.unitId]
  if (po?.state !== POINTOUT_STATE.RECEIVING || po.to !== controllerId) return err('ILL TRK')
  clearPointOut(slewTarget.unitId)
  claimTrack(slewTarget.unitId, controllerId)
  sendWebrtcEvent('POINT_OUT_CONVERTED', { unitId: slewTarget.unitId, fromControllerId: po.from, toControllerId: controllerId })
  ok()
}

export function SET_SP1({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const sp = captures?.sp ?? ''
  getAtc().setScratchpad(slewTarget.unitId, 'sp1', sp)
  ok()
}

export function CLEAR_SP1({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  getAtc().setScratchpad(slewTarget.unitId, 'sp1', '')
  ok()
}

export function SET_SP2({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const sp = captures?.sp ?? ''
  getAtc().setScratchpad(slewTarget.unitId, 'sp2', sp)
  ok()
}

export function CLEAR_SP2({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  getAtc().setScratchpad(slewTarget.unitId, 'sp2', '')
  ok()
}

export function SET_LEADER_SHORT({ captures, slewTarget, windowId }) {
  if (!slewTarget) return err('NO TARGET')
  const wid = windowId ?? WINDOW_ID
  const dir = captures.dir
  const current = getDisplay().windows[wid]?.leaderDirs ?? {}
  if (dir === '5') {
    const next = { ...current }
    delete next[slewTarget.unitId]
    getDisplay().updateWindow(wid, { leaderDirs: next })
  } else {
    getDisplay().updateWindow(wid, { leaderDirs: { ...current, [slewTarget.unitId]: dir } })
  }
  ok()
}

export function SET_LEADER_MF({ captures, slewTarget, windowId }) {
  return SET_LEADER_SHORT({ captures, slewTarget, windowId })
}

export function SET_LEADER_GLOBAL({ captures, windowId }) {
  const dir = captures.dir
  getDisplay().updateWindow(windowId ?? WINDOW_ID, { globalLeaderDir: dir === '5' ? null : dir })
  ok()
}

export function TOGGLE_PTL({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  getAtc().setScratchpad(slewTarget.unitId, '_ptl', 'toggle')
  ok()
}

// ── Minimum separation ────────────────────────────────────────────────────────

export function MIN_INIT({ slewTarget }) {
  if (!slewTarget) return err('NO TRACK')
  getDisplay().updateWindow(WINDOW_ID, {
    pendingAction: 'MIN_P2',
    minWip: { ac0: String(slewTarget.unitId) },
  })
  ok()
}

export function MIN_CLEAR() {
  getDisplay().updateWindow(WINDOW_ID, { minSep: null, minWip: null, pendingAction: null })
  ok()
}

// ── Range bearing line ────────────────────────────────────────────────────────

export function RBL_INIT({ slewTarget, canvasLatLng }) {
  const p0 = slewTarget
    ? { unitId: String(slewTarget.unitId) }
    : canvasLatLng
      ? { lat: canvasLatLng.lat, lng: canvasLatLng.lng }
      : null
  if (!p0) return err('NO POSITION')
  getDisplay().updateWindow(WINDOW_ID, { pendingAction: 'RBL_P2', rblWip: { p0 } })
  ok()
}

export function RBL_CLEAR_ALL() {
  getDisplay().updateWindow(WINDOW_ID, { rbls: [], rblWip: null, pendingAction: null })
  ok()
}

export function RBL_CLEAR_N({ captures }) {
  const n = parseInt(captures.n, 10)
  const win = getDisplay().windows[WINDOW_ID]
  const rbls = win?.rbls ?? []
  if (n < 1 || n > rbls.length) return err('INVALID')
  getDisplay().updateWindow(WINDOW_ID, { rbls: rbls.filter((_, i) => i !== n - 1) })
  ok()
}

export function SET_RANGE({ captures }) {
  const range = parseInt(captures.range, 10)
  if (range < 6 || range > 256) return err('INVALID RANGE')
  getDisplay().updateWindow(WINDOW_ID, { rangeNm: range })
  ok()
}

export function SET_RNG_RING({ captures }) {
  const spacing = parseInt(captures.spacing, 10)
  getDisplay().updateWindow(WINDOW_ID, { ringSpacingNm: spacing })
  ok()
}

export function RELOCATE_PREVIEW({ canvasPos }) {
  if (!canvasPos) return err('NO POSITION')
  usePreviewStore.getState().setPosition(canvasPos)
  ok()
}

export function QUICK_LOOK_TCP({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  // TODO: implement quicklook
  ok()
}

export function QUICK_LOOK_ALL() {
  // TODO
  ok()
}

export function BARE_SLEW({ slewTarget }) {
  if (!slewTarget) return clearBuffer()

  const { ownership, handoffs, pointOuts } = getAtc()
  const id = slewTarget.unitId
  const ho = handoffs[id]
  const po = pointOuts[id]
  const controllerId = getMyControllerId()

  // Incoming handoff to accept
  if (ho?.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
    getAtc().claimTrack(id, controllerId)
    getAtc().clearHandoff(id)
    sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: id, fromControllerId: ho.from, toControllerId: controllerId })
    return ok()
  }

  // Outgoing handoff to recall
  if (ho?.state === HANDOFF_STATE.INITIATED && ho.from === controllerId) {
    getAtc().clearHandoff(id)
    sendWebrtcEvent('HANDOFF_RECALLED', { unitId: id, fromControllerId: controllerId, toControllerId: ho.to })
    return ok()
  }

  // Incoming point out to acknowledge
  if (po?.state === POINTOUT_STATE.RECEIVING && po.to === controllerId) {
    getAtc().clearPointOut(id)
    sendWebrtcEvent('POINT_OUT_ACCEPTED', { unitId: id, fromControllerId: po.from, toControllerId: controllerId })
    return ok()
  }

  // Otherwise: clear buffer (more behaviors will be added — PTL toggle, FDB query, etc.)
  clearBuffer()
}

// ── Callsign rename ───────────────────────────────────────────────────────────

export function RENAME_CALLSIGN({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const newCallsign = captures?.newCallsign?.trim().toUpperCase()
  if (!newCallsign) return err('NO CALLSIGN')
  const { oldCallsign } = applyCallsignChange(slewTarget.unitId, slewTarget.unit, newCallsign)
  sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(slewTarget.unitId), oldCallsign, newCallsign })
  ok()
}

export function RESET_CALLSIGN({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { oldCallsign } = applyCallsignChange(slewTarget.unitId, slewTarget.unit, null)
  sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(slewTarget.unitId), oldCallsign, newCallsign: null })
  ok()
}

// ── List management helpers ───────────────────────────────────────────────────

function toggleList(listId) {
  const win = getDisplay().windows[WINDOW_ID]
  const current = win?.lists?.[listId]?.visible ?? true
  getDisplay().updateList(WINDOW_ID, listId, { visible: !current })
  ok()
}

function relocateList(listId, canvasPos, canvasSize) {
  if (!canvasPos || !canvasSize?.w) return err('NO POSITION')
  const xPct = (canvasPos.x / canvasSize.w) * 100
  const yPct = (canvasPos.y / canvasSize.h) * 100
  getDisplay().updateList(WINDOW_ID, listId, { xPct, yPct })
  ok()
}

function resizeList(listId, lines) {
  const n = parseInt(lines, 10)
  if (isNaN(n) || n < 1 || n > 100) return err('INVALID SIZE')
  getDisplay().updateList(WINDOW_ID, listId, { lines: n })
  ok()
}

// ── List actions ──────────────────────────────────────────────────────────────

export function RELOCATE_SSA({ canvasPos, canvasSize }) {
  relocateList('ssa', canvasPos, canvasSize)
}

export function TOGGLE_SIGNON()                        { toggleList('signOn') }
export function RELOCATE_SIGNON({ canvasPos, canvasSize }) {
  relocateList('signOn', canvasPos, canvasSize)
}

export function TOGGLE_TAB()                           { toggleList('tab') }
export function RELOCATE_TAB({ canvasPos, canvasSize })  { relocateList('tab', canvasPos, canvasSize) }
export function RESIZE_TAB({ captures })                 { resizeList('tab', captures.lines) }

export function TOGGLE_TOWER({ captures }) {
  const id = `tower${captures.idx}`
  toggleList(id)
}
export function RELOCATE_TOWER({ captures, canvasPos, canvasSize }) {
  relocateList(`tower${captures.idx}`, canvasPos, canvasSize)
}
export function RESIZE_TOWER({ captures }) {
  resizeList(`tower${captures.idx}`, captures.lines)
}

export function TOGGLE_COAST()                           { toggleList('coast') }
export function RELOCATE_COAST({ canvasPos, canvasSize }) { relocateList('coast', canvasPos, canvasSize) }
export function RESIZE_COAST({ captures })                { resizeList('coast', captures.lines) }

export function TOGGLE_ALERT()                           { toggleList('alert') }
export function RELOCATE_ALERT({ canvasPos, canvasSize }) { relocateList('alert', canvasPos, canvasSize) }

export function TOGGLE_VFR()                             { toggleList('vfr') }
export function RELOCATE_VFR({ canvasPos, canvasSize })  { relocateList('vfr', canvasPos, canvasSize) }
export function RESIZE_VFR({ captures })                 { resizeList('vfr', captures.lines) }

// ── Dispatch table ────────────────────────────────────────────────────────────

const ACTION_MAP = {
  OPEN_FPE,
  RENAME_CALLSIGN,
  RESET_CALLSIGN,
  INIT_CNTL,
  INIT_CNTL_BY_ID,
  TERM_CNTL,
  TERM_CNTL_ALL,
  HND_OFF,
  HND_OFF_SHORT: HND_OFF,
  HND_OFF_BARE,
  HND_OFF_ACCEPT_NEAR,
  POINT_OUT,
  REJECT_POINT_OUT,
  CONVERT_POINT_OUT,
  SET_SP1,       SET_SP1_MF: SET_SP1,
  CLEAR_SP1,     CLEAR_SP1_MF: CLEAR_SP1,
  SET_SP2,       SET_SP2_MF: SET_SP2,
  CLEAR_SP2,     CLEAR_SP2_MF: CLEAR_SP2,
  SET_LEADER_SHORT,
  SET_LEADER_MF,
  SET_LEADER_GLOBAL,
  TOGGLE_PTL,
  SET_RANGE,
  SET_RNG_RING,
  RELOCATE_PREVIEW,
  QUICK_LOOK_TCP,
  QUICK_LOOK_ALL,
  BARE_SLEW,
  MIN_INIT,
  MIN_CLEAR,
  RBL_INIT,
  RBL_CLEAR_ALL,
  RBL_CLEAR_N,
  // List management
  RELOCATE_SSA,
  TOGGLE_SIGNON, RELOCATE_SIGNON,
  TOGGLE_TAB,    RELOCATE_TAB,    RESIZE_TAB,
  TOGGLE_TOWER,  RELOCATE_TOWER,  RESIZE_TOWER,
  TOGGLE_COAST,  RELOCATE_COAST,  RESIZE_COAST,
  TOGGLE_ALERT,  RELOCATE_ALERT,
  TOGGLE_VFR,    RELOCATE_VFR,    RESIZE_VFR,
}

/**
 * Dispatch a parsed command to its action handler.
 *
 * @param {object} parsed      { command, captures }
 * @param {object} slewTarget  { unitId, unit } | null
 * @param {object} context     { positionName, canvasPos, canvasSize }
 */
export function dispatch(parsed, slewTarget, context) {
  const handler = ACTION_MAP[parsed.command.id]
  if (!handler) {
    usePreviewStore.getState().setResponse(`UNIMPLEMENTED: ${parsed.command.id}`)
    return
  }
  handler({ captures: parsed.captures, slewTarget, ...context })
}
