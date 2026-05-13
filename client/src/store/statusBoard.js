import { create } from 'zustand'

const SB_KEY = 'tracs.catcc.sb'

function serialize(s) {
  return {
    event: s.event, launch: s.launch, recovery: s.recovery,
    sunrise: s.sunrise, sunset: s.sunset, tz: s.tz,
    caseLaunch: s.caseLaunch, caseRecovery: s.caseRecovery,
    marBtn: s.marBtn, app: s.app, twrBtn: s.twrBtn, depBtn: s.depBtn,
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
  tz:           saved.tz           ?? '',
  caseLaunch:   saved.caseLaunch   ?? '',
  caseRecovery: saved.caseRecovery ?? '',
  marBtn:       saved.marBtn       ?? '',
  app:          saved.app          ?? '',
  twrBtn:       saved.twrBtn       ?? '',
  depBtn:       saved.depBtn       ?? '',
  entries:      saved.entries      ?? [],
  nextId:       saved.nextId       ?? 1,

  setHeader: (field, value) => set({ [field]: value }),

  addEntry: (callsign = '', unitId = null) =>
    set((s) => {
      if (callsign && s.entries.some((e) => e.callsign === callsign)) return s
      return {
        entries: [...s.entries, {
          id: s.nextId, evt: '', callsign, unitId,
          sideNumber: '', msn: '', atd: '', bingo: '', angls: '', state: '', ata: '',
        }],
        nextId: s.nextId + 1,
      }
    }),

  updateEntry: (id, field, value) =>
    set((s) => {
      if (field === 'callsign' && value && s.entries.some((e) => e.id !== id && e.callsign === value)) return s
      return { entries: s.entries.map((e) => e.id === id ? { ...e, [field]: value } : e) }
    }),

  insertEntryAfter: (afterId) =>
    set((s) => {
      const newEntry = { id: s.nextId, evt: '', callsign: '', unitId: null, sideNumber: '', msn: '', atd: '', bingo: '', angls: '', state: '', ata: '' }
      const idx = s.entries.findIndex((e) => e.id === afterId)
      const entries = idx === -1
        ? [...s.entries, newEntry]
        : [...s.entries.slice(0, idx + 1), newEntry, ...s.entries.slice(idx + 1)]
      return { entries, nextId: s.nextId + 1 }
    }),

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
    event: '', launch: '', recovery: '', sunrise: '', sunset: '', tz: '',
    caseLaunch: '', caseRecovery: '', marBtn: '', app: '', twrBtn: '', depBtn: '',
    entries: [], nextId: 1,
  }),
}))

// ── Persistence + cross-window sync ──────────────────────────────────────────
let _externalUpdate = false

// WebRTC broadcast hook — registered by the WebRTC client after sign-in.
// Receives the full STATUS_BOARD_UPDATE payload to send.
let _webrtcBroadcast = null
export function registerStatusBoardBroadcast(fn) { _webrtcBroadcast = fn }

function buildPayload(s) {
  return {
    eventHeader: {
      event: s.event, launch: s.launch, recovery: s.recovery, tz: s.tz,
    },
    recoveryStatus: {
      caseLaunch: s.caseLaunch, caseRecovery: s.caseRecovery,
      app: s.app, marBtn: s.marBtn, twrBtn: s.twrBtn, depBtn: s.depBtn,
    },
    entries: s.entries,
  }
}

useStatusBoardStore.subscribe((state) => {
  if (_externalUpdate) return
  try { localStorage.setItem(SB_KEY, JSON.stringify(serialize(state))) } catch {}
  _webrtcBroadcast?.(buildPayload(state))
})

window.addEventListener('storage', (e) => {
  if (e.key !== SB_KEY || !e.newValue) return
  try {
    _externalUpdate = true
    useStatusBoardStore.setState(JSON.parse(e.newValue))
    _externalUpdate = false
  } catch {
    _externalUpdate = false
  }
})

// Apply an incoming STATUS_BOARD_UPDATE payload without triggering re-broadcast.
// Called by the WebRTC handler when a remote STATUS_BOARD_UPDATE arrives.
export function applyStatusBoardUpdate(payload) {
  _externalUpdate = true
  try {
    const flat = { ...(payload.eventHeader ?? {}), ...(payload.recoveryStatus ?? {}) }
    if (Object.keys(flat).length > 0)  useStatusBoardStore.setState(flat)
    if (payload.entries != null)        useStatusBoardStore.setState({ entries: payload.entries })
  } finally {
    _externalUpdate = false
  }
}
