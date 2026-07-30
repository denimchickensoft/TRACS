import { create } from 'zustand'

// Flat, unbucketed airspace features for ABM — deliberately bypasses
// useMapsStore's assignButtons/bucketByEnvelope pipeline (store/maps.js),
// which exists only for STARS' 5-slot DCB + facility-envelope naming logic.
// ABM has no facility and no DCB, so it just wants every feature in the
// theatre tagged with its own displayCategory, filtered at draw time.
export const useAbmAirspaceStore = create((set, get) => ({
  features: [],
  palettes: [],  // [{ name, colors: { [displayCategory]: { stroke, fill, dash, label } } }]
  theatre:  null,
  loading:  false,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/airspace?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ features: data.features ?? [], palettes: data.palettes ?? get().palettes, theatre, loading: false })
    } catch (err) {
      console.error('[abmAirspace] load error:', err.message)
      set({ loading: false })
    }
  },

  // Theatre-independent — airspace_colors.json isn't per-theatre, so this
  // hits the dedicated /api/navdata/palettes endpoint (same file STARS'
  // useMapsStore.refreshPalettes re-fetches via the airspace endpoint).
  refreshPalettes: async () => {
    try {
      const res = await fetch('/api/navdata/palettes')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const palettes = await res.json()
      set({ palettes: palettes ?? [] })
      return true
    } catch (err) {
      console.error('[abmAirspace] palette refresh error:', err.message)
      return false
    }
  },

  reset: () => set({ features: [], palettes: [], theatre: null, loading: false }),
}))
