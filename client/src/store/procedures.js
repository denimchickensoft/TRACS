import { create } from 'zustand'

const TYPE_LABELS = {
  ILS:    'ILS',     RNAV:   'RNAV',    VORDME: 'VOR/DME',
  NDB:    'NDB',     TCN:    'TACAN',   LOC:    'LOC',
  NDBDME: 'NDB/DME', VOR:   'VOR',     GNSS:   'GNSS',
  LDA:    'LDA',     LOCB:  'LOC BC',  GPS:    'GPS',
  IGS:    'IGS',
}

function rwyNumber(runway) {
  if (!runway) return 'CIRC'
  const m = runway.match(/\d+/)
  return m ? m[0] : 'CIRC'
}

function buildGroups(raw) {
  const sidGroups  = {}
  const starGroups = {}
  const appchGroups = {}

  for (const key of Object.keys(raw.SID ?? {})) {
    const base = key.slice(0, -1)
    if (!sidGroups[base]) sidGroups[base] = []
    sidGroups[base].push(key)
  }

  for (const key of Object.keys(raw.STAR ?? {})) {
    const base = key.slice(0, -1)
    if (!starGroups[base]) starGroups[base] = []
    starGroups[base].push(key)
  }

  for (const [key, proc] of Object.entries(raw.APPCH ?? {})) {
    const typeLabel = TYPE_LABELS[proc.type] ?? proc.type ?? '?'
    const groupKey  = `${typeLabel} ${rwyNumber(proc.runway)}`
    if (!appchGroups[groupKey]) appchGroups[groupKey] = []
    appchGroups[groupKey].push(key)
  }

  return { sidGroups, starGroups, appchGroups }
}

export const useProceduresStore = create((set, get) => ({
  icao:        null,
  raw:         null,
  sidGroups:   {},
  starGroups:  {},
  appchGroups: {},
  visible:     new Set(),
  loading:     false,

  loadForIcao: async (icao) => {
    if (!icao || get().icao === icao) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/procedures?icao=${encodeURIComponent(icao)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const raw = await res.json()
      set({ icao, raw, ...buildGroups(raw), visible: new Set(), loading: false })
    } catch (err) {
      console.error('[procedures] load error:', err.message)
      set({ icao, raw: null, sidGroups: {}, starGroups: {}, appchGroups: {}, visible: new Set(), loading: false })
    }
  },

  toggleVisible: (key) => set((s) => {
    const next = new Set(s.visible)
    next.has(key) ? next.delete(key) : next.add(key)
    return { visible: next }
  }),

  // Individual procedures shown via .proc command (keyed by raw proc name, e.g. "ATUD3F")
  commandVisible: new Set(),

  toggleProc: (key) => set((s) => {
    const next = new Set(s.commandVisible)
    next.has(key) ? next.delete(key) : next.add(key)
    return { commandVisible: next }
  }),

  clearCommandProcs: () => set({ commandVisible: new Set() }),

  reset: () => set({
    icao: null, raw: null,
    sidGroups: {}, starGroups: {}, appchGroups: {},
    visible: new Set(), commandVisible: new Set(), loading: false,
  }),
}))
