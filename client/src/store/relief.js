import { create } from 'zustand'

// Each region: { elev, rings: [[ [lon,lat], … ], …] } — nested elevation bands.
// We precompute a lon/lat bbox over the outer ring so the canvas drawer can
// cull offscreen regions cheaply (theatres hold hundreds of bands).
function withBbox(region) {
  const outer = region.rings?.[0] ?? []
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of outer) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { ...region, bbox: [minLon, minLat, maxLon, maxLat] }
}

export const useReliefStore = create((set, get) => ({
  relief:  [],
  visible: false,
  theatre: null,
  loading: false,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/relief?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ relief: Array.isArray(data) ? data.map(withBbox) : [], theatre, loading: false })
    } catch (err) {
      console.error('[relief] load error:', err.message)
      set({ loading: false })
    }
  },

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  reset: () => set({ relief: [], visible: false, theatre: null, loading: false }),
}))
