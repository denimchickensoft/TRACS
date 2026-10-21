/**
 * CATCC slew commands — local reimplementation of the subset of STARS'
 * shared action library (modules/atc/actions/index.js) that docs/catcc.md
 * documents as CATCC's own ("shared with the ATC/STARS scope" was the old
 * framing; these are now independent copies). CATCC no longer touches
 * commandParser.js/actions/index.js at all — those hardcode/default to
 * STARS' own 'atc-main' window and useMapsStore, so reusing them makes
 * .aspcolors/.refresh/.dbca silently hit STARS' state instead of CATCC's.
 * Everything here targets CATCC's own
 * 'catcc-main' window and the genuinely-shared useAtcStore/useControllersStore
 * directly, with no windowId ambiguity possible.
 *
 * Deliberately NOT ported (not documented for CATCC, no CATCC UI renders
 * them): point-outs, scratchpads, RBL, procedures, flight-plan editor, TAB/tower/coast/alert/VFR
 * lists, min-sep, quicklook, .coords, .find, reported/assigned altitude
 * scratchpad (STARS never actually implemented these two either — they're
 * absent from actions/index.js's ACTION_MAP, so porting them would invent
 * new behavior, not preserve existing behavior).
 *
 * Only ENTER-triggered commands live in odsCommands.js; this file is SLEW
 * (type command, then click a target) plus the two modifier-click shortcuts
 * that were previously dispatched inline via actions/index.js.
 */

import { useAtcStore, HANDOFF_STATE } from '../../store/atc.js'
import { useDisplayStore }     from '../../store/display.js'
import { usePreviewStore }     from '../../store/preview.js'
import { sendWebrtcEvent }     from '../../webrtc/client.js'
import { getMyControllerId, getKnownControllerIds } from '../../utils/myControllerId.js'
import { boardLineByTarget }   from './boardLine.js'
import { patternKeyVerb }      from '../../utils/starsKeys.js'

const WINDOW_ID = 'catcc-main'

function ok()     { usePreviewStore.getState().clearAfterCommand() }
function err(msg) { usePreviewStore.getState().setResponse(msg) }

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

// ── HO <tcp> / <tcp> + slew — initiate handoff; recalls own outgoing handoff
// on the clicked target instead if one is already pending (same nuance as
// STARS' HND_OFF).
function handOff(tcp, target) {
  if (!target) return err('NO TARGET')
  const { ownership, handoffs, setHandoff, clearHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()

  const existing = handoffs[target.unitId]
  if (existing?.state === HANDOFF_STATE.INITIATED && existing.from === controllerId) {
    clearHandoff(target.unitId)
    sendWebrtcEvent('HANDOFF_RECALLED', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: existing.to })
    return ok()
  }

  if (!tcp || tcp === controllerId) return err('ILL POS')
  if (!getKnownControllerIds().has(tcp)) return err('ILL POS')
  if (ownership[target.unitId] !== controllerId) return err('ILL TRK')
  setHandoff(target.unitId, { state: HANDOFF_STATE.INITIATED, from: controllerId, to: tcp })
  sendWebrtcEvent('HANDOFF_INITIATED', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

// ── Plain click (empty buffer) — accept an incoming handoff, recall your own
// outgoing one, or stop the flash on a track you just handed off. Returns true if the click was consumed, so the caller can
// leave everything else (ODS lines, double-click focus) alone otherwise.
export function bareSlew(target) {
  if (!target) return false
  const { handoffs, blinkTracks, claimTrack, clearHandoff, clearBlinkTrack } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  const ho = handoffs[target.unitId]

  if (ho?.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
    claimTrack(target.unitId, controllerId)
    clearHandoff(target.unitId)
    sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: target.unitId, fromControllerId: ho.from, toControllerId: controllerId })
    return true
  }

  if (ho?.state === HANDOFF_STATE.INITIATED && ho.from === controllerId) {
    clearHandoff(target.unitId)
    sendWebrtcEvent('HANDOFF_RECALLED', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: ho.to })
    return true
  }

  // Sender side of an accepted handoff — local only, nothing to broadcast
  if (blinkTracks[target.unitId] > Date.now()) {
    clearBlinkTrack(target.unitId)
    return true
  }

  return false
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

// ── MF S + click — relocate the status-text overlay to a canvas position ────
// Unlike every other SLEW_COMMANDS entry, this one's "target" is a raw
// canvas position, not a unit — dispatchCatccSlew's optional `extra` param
// carries { canvasPos, view } for this one case.
function relocateStatusText(canvasPos, view) {
  if (!canvasPos || !view) return err('NO TARGET')
  useDisplayStore.getState().updateWindow(WINDOW_ID, {
    statusTextXPct: (canvasPos.x / view.width)  * 100,
    statusTextYPct: (canvasPos.y / view.height) * 100,
  })
  ok()
}

// ── Pattern table — SLEW-triggered only. Order matters: longer/more specific
// patterns before shorter ones that could otherwise shadow them (mirrors
// commandParser.js's own ordering convention). ─────────────────────────────
const SLEW_COMMANDS = [
  { id: 'IC',                pattern: /^IC$/ },
  { id: 'TC',                pattern: /^TC$/ },
  { id: 'HND_OFF',           pattern: /^HO ([^ ]+)$/,          captures: ['tcp'] },
  { id: 'HND_OFF_SHORT',     pattern: /^([1-9][A-Z0-9])$/,     captures: ['tcp'] },
  { id: 'SET_LEADER_GLOBAL', pattern: /^MF L([1-9])\1$/,       captures: ['dir'] },
  { id: 'SET_LEADER',        pattern: /^MF L([1-9])$/,         captures: ['dir'] },
  { id: 'MF_S',              pattern: /^MF S$/ },
]

// The key verb each command starts with: it only matches when that key
// entered it (leadToken), never when the letters are typed.
const KEY_VERB_OF = new Map(SLEW_COMMANDS.map((cmd) => [cmd, patternKeyVerb(cmd.pattern)]))

export function parseCatccSlew(buffer, leadToken = '') {
  const trimmed = buffer.trim().toUpperCase()
  for (const cmd of SLEW_COMMANDS) {
    const verb = KEY_VERB_OF.get(cmd)
    if (verb && verb !== leadToken) continue
    const match = trimmed.match(cmd.pattern)
    if (!match) continue
    const captures = {}
    cmd.captures?.forEach((name, i) => { captures[name] = match[i + 1] })
    return { id: cmd.id, captures }
  }
  // Anything else typed is status board fields for the clicked aircraft
  // (boardLine.js); an entry started by a key that matched nothing isn't.
  return trimmed && !leadToken ? { id: 'BOARD_LINE', captures: { rest: trimmed } } : null
}

export function dispatchCatccSlew(parsed, target, correlations, extra) {
  const { id, captures } = parsed
  switch (id) {
    case 'IC':                return initCntl(target, correlations)
    case 'TC':                return termCntl(target)
    case 'HND_OFF':           return handOff(captures.tcp, target)
    case 'HND_OFF_SHORT':     return handOff(captures.tcp, target)
    case 'SET_LEADER_GLOBAL': return setLeaderGlobal(captures.dir)
    case 'SET_LEADER':        return setLeader(captures.dir, target)
    case 'MF_S':              return relocateStatusText(extra?.canvasPos, extra?.view)
    case 'BOARD_LINE': {
      const msg = boardLineByTarget(captures.rest, target, correlations)
      return msg ? err(msg) : ok()
    }
  }
}
