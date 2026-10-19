import { create } from 'zustand'
import { createBroadcastHook } from '../utils/broadcastRegistry.js'
import { generateBcn } from '../utils/bcn.js'
import { shallowEqual } from '../utils/storeSync.js'
import { isValidTime } from '../modules/catcc/statusBoardColumns.js'
import { useSessionStore } from './session.js'

const SB_KEY = 'tracs.catcc.sb'

function serialize(s) {
  return {
    event: s.event, launch: s.launch, recovery: s.recovery,
    clg: s.clg, vis: s.vis, qnh: s.qnh,
    caseLaunch: s.caseLaunch, caseRecovery: s.caseRecovery,
    marBtn: s.marBtn, app: s.app, twrBtn: s.twrBtn, depBtn: s.depBtn,
    rad: s.rad,
    entries: s.entries, nextId: s.nextId,
  }
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SB_KEY) ?? 'null') } catch { return null }
}

const saved = loadSaved() ?? {}

// Marshal slots step EAT by 1 minute and ANGELS by 1 from the lowest-ANGELS
// filled row; the first slot whose EAT and ANGELS are both unused wins, so a
// gap left by a removed row is reused. Anchored on ANGELS rather than EAT
// because ANGELS never wraps, where EAT can roll past 2359. Null when no row
// has both values yet, or the next slot would pass ANGELS 99.
function nextMarshalSlot(entries) {
  const filled = entries.filter((e) => isValidTime(e.eat) && /^\d{4}$/.test(e.eat) && /^\d+$/.test(e.angels))
  if (!filled.length) return null
  const toMin = (hhmm) => (parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10)) % 1440
  const usedEat    = new Set(filled.map((e) => toMin(e.eat)))
  const usedAngels = new Set(filled.map((e) => parseInt(e.angels, 10)))
  const anchor = filled.reduce((a, b) => parseInt(b.angels, 10) < parseInt(a.angels, 10) ? b : a)
  const baseMin    = toMin(anchor.eat)
  const baseAngels = parseInt(anchor.angels, 10)
  for (let k = 1; baseAngels + k <= 99; k++) {
    const min = (baseMin + k) % 1440
    const angels = baseAngels + k
    if (usedEat.has(min) || usedAngels.has(angels)) continue
    const eat = `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`
    return { eat, angels: String(angels) }
  }
  return null
}

export const useStatusBoardStore = create((set) => ({
  event:        saved.event        ?? '',
  launch:       saved.launch       ?? '',
  recovery:     saved.recovery     ?? '',
  clg:          saved.clg          ?? '',
  vis:          saved.vis          ?? '',
  qnh:          saved.qnh          ?? '',
  caseLaunch:   saved.caseLaunch   ?? '',
  caseRecovery: saved.caseRecovery ?? '',
  marBtn:       saved.marBtn       ?? '',
  app:          saved.app          ?? '',
  twrBtn:       saved.twrBtn       ?? '',
  depBtn:       saved.depBtn       ?? '',
  rad:          saved.rad          ?? '',
  entries:      saved.entries      ?? [],
  nextId:       saved.nextId       ?? 1,

  setHeader: (field, value) => set({ [field]: value }),

  addEntry: (callsign = '', unitId = null) =>
    set((s) => {
      if (callsign && s.entries.some((e) => e.callsign === callsign)) return s
      return {
        entries: [...s.entries, {
          id: s.nextId, evt: '', callsign, unitId,
          sideNumber: '', bcn: '', pilot: '', type: '', msn: '', atd: '', radial: '', bingo: '', eat: '', angels: '', state: '', ata: '',
        }],
        nextId: s.nextId + 1,
      }
    }),

  addMissionEntries: (incoming) =>
    set((s) => {
      const existing = new Set(s.entries.map(e => e.callsign).filter(Boolean))
      const toAdd = []
      let id = s.nextId
      for (const e of incoming) {
        if (e.callsign && existing.has(e.callsign)) continue
        toAdd.push({
          id, fromMission: true,
          evt: '', callsign: e.callsign, unitId: null,
          sideNumber: e.modex, bcn: '', pilot: '', type: e.type, msn: e.task,
          atd: '', radial: '', bingo: '', eat: '', angels: '', state: '', ata: '',
        })
        id++
      }
      return { entries: [...s.entries, ...toAdd], nextId: id }
    }),

  clearMissionData: () =>
    set((s) => ({
      clg: '', vis: '', qnh: '',
      entries: s.entries.filter(e => !e.fromMission),
    })),

  updateEntry: (id, field, value) =>
    set((s) => {
      if (field === 'callsign' && value && s.entries.some((e) => e.id !== id && e.callsign === value)) return s
      return { entries: s.entries.map((e) => e.id === id ? { ...e, [field]: value } : e) }
    }),

  // Autofill stamps (see modules/catcc/StatusBoardAutofill.jsx). A new
  // launch starts a new cycle, so it blanks the previous ATA in the same set.
  stampDeparture: (id, hhmm) =>
    set((s) => ({ entries: s.entries.map((e) => e.id === id ? { ...e, atd: hhmm, ata: '' } : e) })),

  stampArrival: (id, hhmm) =>
    set((s) => ({ entries: s.entries.map((e) => e.id === id ? { ...e, ata: hhmm } : e) })),

  // CASE 2/3 marshal: give the row the first free EAT/ANGELS slot (see nextMarshalSlot).
  assignNextMarshal: (id) =>
    set((s) => {
      if (s.caseRecovery !== '2' && s.caseRecovery !== '3') return s
      const entry = s.entries.find((e) => e.id === id)
      if (!entry || entry.eat || entry.angels) return s
      const slot = nextMarshalSlot(s.entries)
      if (!slot) return s
      return { entries: s.entries.map((e) => e.id === id ? { ...e, ...slot } : e) }
    }),

  insertEntryAfter: (afterId) =>
    set((s) => {
      const newEntry = { id: s.nextId, fromMission: false, evt: '', callsign: '', unitId: null, sideNumber: '', bcn: '', pilot: '', type: '', msn: '', atd: '', radial: '', bingo: '', eat: '', angels: '', state: '', ata: '' }
      const idx = s.entries.findIndex((e) => e.id === afterId)
      const entries = idx === -1
        ? [...s.entries, newEntry]
        : [...s.entries.slice(0, idx + 1), newEntry, ...s.entries.slice(idx + 1)]
      return { entries, nextId: s.nextId + 1 }
    }),

  recycleBcn: (id) =>
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, bcn: generateBcn(s.entries.map((e2) => e2.bcn)) } : e
      ),
    })),

  renameEntry: (unitId, newCallsign) =>
    set((s) => ({
      entries: s.entries.map((e) =>
        String(e.unitId) === String(unitId) ? { ...e, callsign: newCallsign } : e
      ),
    })),

  removeEntry: (id) =>
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),

  moveEntry: (id, dir) =>
    set((s) => {
      const idx = s.entries.findIndex((e) => e.id === id)
      const next = idx + dir
      if (next < 0 || next >= s.entries.length) return s
      const entries = [...s.entries]
      ;[entries[idx], entries[next]] = [entries[next], entries[idx]]
      return { entries }
    }),

  reset: () => set({
    event: '', launch: '', recovery: '',
    clg: '', vis: '', qnh: '',
    caseLaunch: '', caseRecovery: '', marBtn: '', app: '', twrBtn: '', depBtn: '',
    rad: '',
    entries: [], nextId: 1,
  }),

  clearAll: (rad = '') => set({
    event: '', launch: '', recovery: '',
    clg: '', vis: '', qnh: '',
    caseLaunch: '', caseRecovery: '', marBtn: '', app: '', twrBtn: '', depBtn: '',
    rad,
    entries: [], nextId: 1,
  }),
}))

// ── Persistence + cross-window sync ──────────────────────────────────────────
// A popped-out board has no WebRTC client: its main window carries its edits
// to the network and carries remote edits back to it. _applying records where
// the change being applied came from, so the subscriber forwards it everywhere
// except back to its source:
//   null      a local edit: localStorage, WebRTC and the channel
//   'remote'  another controller (WebRTC apply or callsign rename): localStorage + channel
//   'popup'   this position's pop-out: localStorage + WebRTC
//   'window'  another main window of this position: localStorage only (it sent it itself)
// Deliberately NOT utils/storeSync.js's syncStore — that helper's isSyncing flag
// is private to its own subscribe/onmessage closure, with no way for external
// callers to mark an apply's source.
let _applying = null

const _params  = new URLSearchParams(window.location.search)
const _isPopup = !!_params.get('window')

// WebRTC broadcast hook — registered by the WebRTC client after sign-in.
const { register: registerStatusBoardBroadcast, broadcast: _webrtcBroadcast } = createBroadcastHook()
export { registerStatusBoardBroadcast }

// The wire shape for STATUS_BOARD_UPDATE, also used for the status board part
// of a CATCC state dump, so live updates and late-join dumps carry the same fields.
export function buildStatusBoardPayload(s) {
  return {
    eventHeader: {
      event: s.event, launch: s.launch, recovery: s.recovery,
      clg: s.clg, vis: s.vis, qnh: s.qnh,
    },
    recoveryStatus: {
      caseLaunch: s.caseLaunch, caseRecovery: s.caseRecovery,
      app: s.app, marBtn: s.marBtn, twrBtn: s.twrBtn, depBtn: s.depBtn,
      rad: s.rad,
    },
    entries: s.entries,
  }
}

// Rows from other controllers come from their own counters, and the wire
// payload carries no nextId, so a new local row must start past every id
// already on the board. Never moves backwards.
function nextFreeId(entries, nextId) {
  return entries.reduce((n, e) => (Number.isFinite(e.id) && e.id >= n ? e.id + 1 : n), nextId)
}

function applyFrom(source, patch) {
  _applying = source
  try {
    useStatusBoardStore.setState(patch)
  } finally {
    _applying = null
  }
}

// Scoped to this position's own windows, like store/strips.js: two positions
// signed in from one app instance (Electron's New Window) each keep their own board.
let _sbCh = null
const _channelName = (facilityId, positionName) => `tracs-statusboard-${facilityId}-${positionName}`

function _setupChannel(facilityId, positionName) {
  _sbCh?.close()
  _sbCh = new BroadcastChannel(_channelName(facilityId, positionName))
  _sbCh.onmessage = (e) => {
    if (e.data?.type === 'STATE_UPDATE') {
      const { state } = e.data
      const entries = state.entries ?? useStatusBoardStore.getState().entries
      applyFrom(e.data.relay ? 'popup' : 'window', {
        ...state,
        nextId: nextFreeId(entries, Math.max(state.nextId ?? 1, useStatusBoardStore.getState().nextId)),
      })
    } else if (e.data?.type === 'REQUEST_STATE') {
      // A reply is never a relay request: opening a second pop-out mustn't
      // make the main window resend the board to everyone.
      _sbCh.postMessage({ type: 'STATE_UPDATE', state: serialize(useStatusBoardStore.getState()) })
    }
  }
  _sbCh.postMessage({ type: 'REQUEST_STATE' })
}

useStatusBoardStore.subscribe((state, prev) => {
  if (shallowEqual(serialize(state), serialize(prev))) return
  try { localStorage.setItem(SB_KEY, JSON.stringify(serialize(state))) } catch {}
  if (_applying === 'window') return
  if (_applying !== 'remote') _webrtcBroadcast?.(buildStatusBoardPayload(state))
  if (_applying === 'popup') return
  _sbCh?.postMessage({ type: 'STATE_UPDATE', state: serialize(state), relay: _isPopup })
})

if (_isPopup) {
  // A pop-out knows its owning position from the URL it was opened with
  // (App.jsx's undock handlers).
  _setupChannel(_params.get('facilityId') ?? '', _params.get('positionName') ?? '')
} else {
  // A main window only knows its position after login, and may sign into a
  // different one later without restarting.
  let _lastKey = null
  const _trySetup = () => {
    const { facilityId, positionName } = useSessionStore.getState()
    if (!facilityId || !positionName) return
    const key = _channelName(facilityId, positionName)
    if (key === _lastKey) return
    _lastKey = key
    _setupChannel(facilityId, positionName)
  }
  useSessionStore.subscribe(_trySetup)
  _trySetup()
}

// Update a status board entry's callsign by unitId without sending it over
// WebRTC: every peer applies the same CALLSIGN_RENAME itself.
export function renameStatusBoardEntry(unitId, newCallsign) {
  _applying = 'remote'
  try {
    useStatusBoardStore.getState().renameEntry(unitId, newCallsign)
  } finally {
    _applying = null
  }
}

// Apply an incoming STATUS_BOARD_UPDATE payload without sending it back out
// over WebRTC. One setState, so a pop-out never sees a new header with old rows.
export function applyStatusBoardUpdate(payload) {
  const patch = { ...(payload.eventHeader ?? {}), ...(payload.recoveryStatus ?? {}) }
  if (payload.entries != null) {
    patch.entries = payload.entries
    patch.nextId  = nextFreeId(payload.entries, useStatusBoardStore.getState().nextId)
  }
  if (Object.keys(patch).length > 0) applyFrom('remote', patch)
}
