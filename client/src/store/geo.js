import { create } from 'zustand'

export const useGeoStore = create((set, get) => ({
  boundaries: [],
  coastlines: [],
  visible:    false,
  theatre:    null,
  loading:    false,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/geo?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { boundaries, coastlines } = await res.json()
      set({ boundaries: boundaries ?? [], coastlines: coastlines ?? [], theatre, loading: false })
    } catch (err) {
      console.error('[geo] load error:', err.message)
      set({ loading: false })
    }
  },

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setVisible:    (v) => set({ visible: v }),
  reset: () => set({ boundaries: [], coastlines: [], visible: false, theatre: null, loading: false }),
}))
