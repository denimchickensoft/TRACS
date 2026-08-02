import { create } from 'zustand'

const SB_KEY = 'tracs.catcc.sb'

function serialize(s) {
  return {
    event: s.event, launch: s.launch, recovery: s.recovery,
    sunrise: s.sunrise, sunset: s.sunset,
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

export const useStatusBoardStore = create((set) => ({
  event:        saved.event        ?? '',
  launch:       saved.launch       ?? '',
  recovery:     saved.recovery     ?? '',
  sunrise:      saved.sunrise      ?? '',  // TODO: auto-calculate from carrier position + date
  sunset:       saved.sunset       ?? '',  // TODO: auto-calculate from carrier position + date
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
          sideNumber: '', pilot: '', type: '', msn: '', atd: '', radial: '', bingo: '', eat: '', angels: '', state: '', ata: '',
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
          sideNumber: e.modex, pilot: '', type: e.type, msn: e.task,
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

  insertEntryAfter: (afterId) =>
    set((s) => {
      const newEntry = { id: s.nextId, fromMission: false, evt: '', callsign: '', unitId: null, sideNumber: '', pilot: '', type: '', msn: '', atd: '', radial: '', bingo: '', eat: '', angels: '', state: '', ata: '' }
      const idx = s.entries.findIndex((e) => e.id === afterId)
      const entries = idx === -1
        ? [...s.entries, newEntry]
        : [...s.entries.slice(0, idx + 1), newEntry, ...s.entries.slice(idx + 1)]
      return { entries, nextId: s.nextId + 1 }
    }),

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
    event: '', launch: '', recovery: '', sunrise: '', sunset: '',
    clg: '', vis: '', qnh: '',
    caseLaunch: '', caseRecovery: '', marBtn: '', app: '', twrBtn: '', depBtn: '',
    rad: '',
    entries: [], nextId: 1,
  }),

  clearAll: (rad = '') => set({
    event: '', launch: '', recovery: '', sunrise: '', sunset: '',
    clg: '', vis: '', qnh: '',
    caseLaunch: '', caseRecovery: '', marBtn: '', app: '', twrBtn: '', depBtn: '',
    rad,
    entries: [], nextId: 1,
  }),
}))

// ── Persistence + cross-window sync ──────────────────────────────────────────
// _syncing suppresses re-broadcast in all three cases: BroadcastChannel apply,
// WebRTC apply (applyStatusBoardUpdate), and callsign rename (renameStatusBoardEntry).
let _syncing = false

// WebRTC broadcast hook — registered by the WebRTC client after sign-in.
let _webrtcBroadcast = null
export function registerStatusBoardBroadcast(fn) { _webrtcBroadcast = fn }

function buildPayload(s) {
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

const _sbCh = new BroadcastChannel('tracs-statusboard')

useStatusBoardStore.subscribe((state) => {
  if (_syncing) return
  try { localStorage.setItem(SB_KEY, JSON.stringify(serialize(state))) } catch {}
  _webrtcBroadcast?.(buildPayload(state))
  _sbCh.postMessage({ type: 'STATE_UPDATE', state: serialize(state) })
})

_sbCh.onmessage = (e) => {
  if (e.data?.type === 'STATE_UPDATE') {
    _syncing = true
    useStatusBoardStore.setState(e.data.state)
    _syncing = false
  } else if (e.data?.type === 'REQUEST_STATE') {
    _sbCh.postMessage({ type: 'STATE_UPDATE', state: serialize(useStatusBoardStore.getState()) })
  }
}
_sbCh.postMessage({ type: 'REQUEST_STATE' })

// Update a status board entry's callsign by unitId without triggering re-broadcast.
export function renameStatusBoardEntry(unitId, newCallsign) {
  _syncing = true
  try {
    useStatusBoardStore.getState().renameEntry(unitId, newCallsign)
  } finally {
    _syncing = false
  }
}

// Apply an incoming STATUS_BOARD_UPDATE payload without triggering re-broadcast.
export function applyStatusBoardUpdate(payload) {
  _syncing = true
  try {
    const flat = { ...(payload.eventHeader ?? {}), ...(payload.recoveryStatus ?? {}) }
    if (Object.keys(flat).length > 0)  useStatusBoardStore.setState(flat)
    if (payload.entries != null)        useStatusBoardStore.setState({ entries: payload.entries })
  } finally {
    _syncing = false
  }
}
