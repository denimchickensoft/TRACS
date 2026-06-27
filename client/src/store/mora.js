import { create } from 'zustand'

export const useMoraStore = create((set, get) => ({
  mora:    [],
  visible: false,
  theatre: null,
  loading: false,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/mora?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ mora: Array.isArray(data) ? data : [], theatre, loading: false })
    } catch (err) {
      console.error('[mora] load error:', err.message)
      set({ loading: false })
    }
  },

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setVisible:    (v) => set({ visible: v }),
  reset: () => set({ mora: [], visible: false, theatre: null, loading: false }),
}))
