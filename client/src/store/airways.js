import { create } from 'zustand'

export const AIRWAY_TYPES = ['V', 'J', 'B']

// Every airway name in the loaded theatre (upper-case), across V/J/B — what
// .airway <name> validates against.
export function airwayNameSet(airways) {
  const names = new Set()
  for (const type of AIRWAY_TYPES) {
    for (const seg of (airways?.[type] ?? [])) names.add(seg.name.toUpperCase())
  }
  return names
}

// Splits .airway args into class tokens (V/J/B, toggle a whole class) and
// airway-name tokens (pin one airway). No real airway is named a bare V/J/B.
export function splitAirwayArgs(raw) {
  const tokens = (raw ?? '').trim().split(/\s+/).map(t => t.toUpperCase()).filter(Boolean)
  return {
    types: tokens.filter(t => AIRWAY_TYPES.includes(t)),
    names: tokens.filter(t => !AIRWAY_TYPES.includes(t)),
  }
}

export const useAirwaysStore = create((set, get) => ({
  airways:  { V: [], J: [], B: [] },
  visible:  { V: false, J: false, B: false },
  theatre:  null,
  loading:  false,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/airways?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({
        airways: { V: data.V ?? [], J: data.J ?? [], B: data.B ?? [] },
        theatre,
        loading: false,
      })
    } catch (err) {
      console.error('[airways] load error:', err.message)
      set({ loading: false })
    }
  },

  toggleVisible: (type) => set((s) => ({ visible: { ...s.visible, [type]: !s.visible[type] } })),
  setVisible:    (v)    => set({ visible: v }),
  reset: () => set({ airways: { V: [], J: [], B: [] }, visible: { V: false, J: false, B: false }, theatre: null, loading: false }),
}))
