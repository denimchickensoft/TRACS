/**
 * CATCC slew commands — local reimplementation of the subset of STARS'
 * shared action library (modules/atc/actions/index.js) that docs/catcc.md
 * documents as CATCC's own ("shared with the ATC/STARS scope" was the old
 * framing; these are now independent copies). CATCC no longer touches
 * commandParser.js/actions/index.js at all — those hardcode/default to
 * STARS' own 'atc-main' window and useMapsStore, which caused two real bugs
 * (.aspcolors/.refresh/.dbca silently hitting STARS' state instead of
 * CATCC's — see conversation history). Everything here targets CATCC's own
 * 'catcc-main' window and the genuinely-shared useAtcStore/useControllersStore
 * directly, with no windowId ambiguity possible.
 *
 * Deliberately NOT ported (not documented for CATCC, no CATCC UI renders
 * them): RBL, procedures, flight-plan editor, TAB/tower/coast/alert/VFR
 * lists, min-sep, quicklook, .coords, .find, reported/assigned altitude
 * scratchpad (STARS never actually implemented these two either — they're
 * absent from actions/index.js's ACTION_MAP, so porting them would invent
 * new behavior, not preserve existing behavior).
 *
 * Only ENTER-triggered commands live in odsCommands.js; this file is SLEW
 * (type command, then click a target) plus the two modifier-click shortcuts
 * that were previously dispatched inline via actions/index.js.
 */

import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../../store/atc.js'
import { useDisplayStore }     from '../../store/display.js'
import { useSessionStore }     from '../../store/session.js'
import { useControllersStore } from '../../store/controllers.js'
import { usePreviewStore }     from '../../store/preview.js'
import { sendWebrtcEvent }     from '../../webrtc/client.js'

const WINDOW_ID = 'catcc-main'

function ok()     { usePreviewStore.getState().clearAfterCommand() }
function err(msg) { usePreviewStore.getState().setResponse(msg) }

function getMyControllerId() {
  const pos = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[pos]?.controllerId ?? null
}

function knownControllerIds() {
  return new Set(
    Object.values(useControllersStore.getState().registry)
      .map((e) => e.controllerId)
      .filter(Boolean)
  )
}

// ── Modifier-click shortcuts (Ctrl+Shift+Click / Shift+Click) + "IC"/"TC" + slew ──

export function initCntl(target, correlations) {
  if (!target) return err('NO TARGET')
  const controllerId = getMyControllerId()
  if (!controllerId) return err('NO POSITION')
  const { ownership, claimTrack } = useAtcStore.getState()
  if (ownership[target.unitId] !== undefined) return err('ILL TRK')
  if (!correlations?.[String(target.unitId)]) return err('ILL TRK')
  claimTrack(target.unitId, controllerId)
  sendWebrtcEvent('TRACK_CLAIMED', { unitId: target.unitId, controllerId })
  ok()
}

export function termCntl(target) {
  if (!target) return err('NO TARGET')
  const { ownership, dropTrack, clearHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  if (ownership[target.unitId] !== controllerId) return err('ILL TRK')
  clearHandoff(target.unitId)
  dropTrack(target.unitId)
  sendWebrtcEvent('TRACK_DROPPED', { unitId: target.unitId })
  ok()
}

// ── HO <tcp> + slew — initiate handoff; recalls own outgoing handoff on the
// clicked target instead if one is already pending (same nuance as STARS' HND_OFF).
function handOff(tcp, target) {
  if (!target) return err('NO TARGET')
  const { ownership, handoffs, setHandoff, clearHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()

  const existing = handoffs[target.unitId]
  if (existing?.state === HANDOFF_STATE.INITIATED && existing.from === controllerId) {
    clearHandoff(target.unitId)
    return ok()
  }

  if (!tcp || tcp === controllerId) return err('ILL POS')
  if (!knownControllerIds().has(tcp)) return err('ILL POS')
  if (ownership[target.unitId] !== controllerId) return err('ILL TRK')
  setHandoff(target.unitId, { state: HANDOFF_STATE.INITIATED, from: controllerId, to: tcp })
  sendWebrtcEvent('HANDOFF_INITIATED', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

// ── <tcp>* + slew — point out ────────────────────────────────────────────────
function pointOut(tcp, target) {
  if (!target) return err('NO TARGET')
  if (!tcp) return err('ILL POS')
  const controllerId = getMyControllerId()
  if (tcp === controllerId) return err('ILL POS')
  if (!knownControllerIds().has(tcp)) return err('ILL POS')
  useAtcStore.getState().setPointOut(target.unitId, { state: POINTOUT_STATE.SENT, from: controllerId, to: tcp })
  sendWebrtcEvent('POINT_OUT_SENT', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

// ── ** + slew — accept incoming point-out as a handoff ───────────────────────
function convertPointOut(target) {
  if (!target) return err('NO TARGET')
  const { pointOuts, clearPointOut, claimTrack } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  const po = pointOuts[target.unitId]
  if (po?.state !== POINTOUT_STATE.RECEIVING || po.to !== controllerId) return err('ILL TRK')
  clearPointOut(target.unitId)
  claimTrack(target.unitId, controllerId)
  sendWebrtcEvent('POINT_OUT_CONVERTED', { unitId: target.unitId, fromControllerId: po.from, toControllerId: controllerId })
  ok()
}

// ── UN + slew — reject an incoming point-out ──────────────────────────────────
function rejectPointOut(target) {
  if (!target) return err('NO TARGET')
  const controllerId = getMyControllerId()
  const po = useAtcStore.getState().pointOuts[target.unitId]
  if (po?.state !== POINTOUT_STATE.RECEIVING || po.to !== controllerId) return err('ILL TRK')
  useAtcStore.getState().clearPointOut(target.unitId)
  sendWebrtcEvent('POINT_OUT_REJECTED', { unitId: target.unitId, fromControllerId: po.from, toControllerId: controllerId })
  ok()
}

// ── MF L<n><n> + slew — global leader direction; MF L<n> + slew — per-track ──
// dir '5' = center/no offset, matching the numpad-direction convention
// elsewhere (DIR_TO_ANGLE, utils/carriers.js, drawCatccDatablocks.js).
function setLeaderGlobal(dir) {
  useDisplayStore.getState().updateWindow(WINDOW_ID, { globalLeaderDir: dir === '5' ? null : dir })
  ok()
}

function setLeader(dir, target) {
  if (!target) return err('NO TARGET')
  const current = useDisplayStore.getState().windows[WINDOW_ID]?.leaderDirs ?? {}
  if (dir === '5') {
    const next = { ...current }
    delete next[target.unitId]
    useDisplayStore.getState().updateWindow(WINDOW_ID, { leaderDirs: next })
  } else {
    useDisplayStore.getState().updateWindow(WINDOW_ID, { leaderDirs: { ...current, [target.unitId]: dir } })
  }
  ok()
}

// ── 3-4 char alphanumeric + slew — scratchpad 1; +prefixed — scratchpad 2 ────
// Bare "." / "+" + slew clears the respective field.
function setScratchpad(field, value, target) {
  if (!target) return err('NO TARGET')
  if (useAtcStore.getState().ownership[target.unitId] !== getMyControllerId()) return err('ILL TRK')
  useAtcStore.getState().setScratchpad(target.unitId, field, value)
  ok()
}

// ── Pattern table — SLEW-triggered only. Order matters: longer/more specific
// patterns before shorter ones that could otherwise shadow them (mirrors
// commandParser.js's own ordering convention). ─────────────────────────────
const SLEW_COMMANDS = [
  { id: 'IC',                pattern: /^IC$/ },
  { id: 'TC',                pattern: /^TC$/ },
  { id: 'HND_OFF',           pattern: /^HO ([^ ]+)$/,          captures: ['tcp'] },
  { id: 'POINT_OUT',         pattern: /^([^ *]+)\*$/,          captures: ['tcp'] },
  { id: 'CONVERT_PO',        pattern: /^\*\*$/ },
  { id: 'REJECT_PO',         pattern: /^UN$/ },
  { id: 'SET_LEADER_GLOBAL', pattern: /^MF L([1-9])\1$/,       captures: ['dir'] },
  { id: 'SET_LEADER',        pattern: /^MF L([1-9])$/,         captures: ['dir'] },
  { id: 'SET_SP1',           pattern: /^([A-Z0-9/]{3,4})$/,    captures: ['sp'] },
  { id: 'SET_SP2',           pattern: /^\+([A-Z0-9/]{1,4})$/,  captures: ['sp'] },
  { id: 'CLEAR_SP1',         pattern: /^\.$/ },
  { id: 'CLEAR_SP2',         pattern: /^\+$/ },
]

export function parseCatccSlew(buffer) {
  const trimmed = buffer.trim().toUpperCase()
  for (const cmd of SLEW_COMMANDS) {
    const match = trimmed.match(cmd.pattern)
    if (!match) continue
    const captures = {}
    cmd.captures?.forEach((name, i) => { captures[name] = match[i + 1] })
    return { id: cmd.id, captures }
  }
  return null
}

export function dispatchCatccSlew(parsed, target, correlations) {
  const { id, captures } = parsed
  switch (id) {
    case 'IC':                return initCntl(target, correlations)
    case 'TC':                return termCntl(target)
    case 'HND_OFF':           return handOff(captures.tcp, target)
    case 'POINT_OUT':         return pointOut(captures.tcp, target)
    case 'CONVERT_PO':        return convertPointOut(target)
    case 'REJECT_PO':         return rejectPointOut(target)
    case 'SET_LEADER_GLOBAL': return setLeaderGlobal(captures.dir)
    case 'SET_LEADER':        return setLeader(captures.dir, target)
    case 'SET_SP1':           return setScratchpad('sp1', captures.sp, target)
    case 'SET_SP2':           return setScratchpad('sp2', captures.sp, target)
    case 'CLEAR_SP1':         return setScratchpad('sp1', '', target)
    case 'CLEAR_SP2':         return setScratchpad('sp2', '', target)
  }
}
