import { create } from 'zustand'

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
