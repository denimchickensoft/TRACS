import { create } from 'zustand'

export const useMsaStore = create((set, get) => ({
  msa:     [],
  visible: false,
  theatre: null,
  loading: false,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/msa?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ msa: Array.isArray(data) ? data : [], theatre, loading: false })
    } catch (err) {
      console.error('[msa] load error:', err.message)
      set({ loading: false })
    }
  },

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  reset: () => set({ msa: [], visible: false, theatre: null, loading: false }),
}))
