import { create } from 'zustand'

// Each sector: { alt, label, labelPt:[lon,lat], rings:[[ [lon,lat], … ], …] } —
// discrete (non-nested) MVA sectors for one facility. We precompute a lon/lat
// bbox over the outer ring so the canvas drawer can cull offscreen sectors.
function withBbox(sector) {
  const outer = sector.rings?.[0] ?? []
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const [lon, lat] of outer) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { ...sector, bbox: [minLon, minLat, maxLon, maxLat] }
}

export const useMvaStore = create((set, get) => ({
  mva:     [],
  visible: false,
  icao:    null,
  loading: false,

  // MVA is facility-scoped (served per ICAO, ~50 NM radius), unlike the
  // theatre-wide relief/MORA layers — load whenever the active facility changes.
  loadForFacility: async (icao) => {
    if (!icao || get().icao === icao) return
    set({ loading: true })
    try {
      const res = await fetch(`/api/navdata/mva?icao=${encodeURIComponent(icao)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ mva: Array.isArray(data) ? data.map(withBbox) : [], icao, loading: false })
    } catch (err) {
      console.error('[mva] load error:', err.message)
      set({ mva: [], icao, loading: false })
    }
  },

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  setVisible:    (v) => set({ visible: v }),
  reset: () => set({ mva: [], visible: false, icao: null, loading: false }),
}))
