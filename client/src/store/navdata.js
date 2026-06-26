import { create }          from 'zustand'
import { useRunwaysStore }  from './runways.js'

export const useNavdataStore = create((set, get) => ({
  fixes:   [],
  navaids: [],
  theatre: null,

  loadForTheatre: async (theatre) => {
    if (!theatre || get().theatre === theatre) return
    try {
      const [fixRes, navRes] = await Promise.all([
        fetch(`/api/navdata/fixes?theatre=${encodeURIComponent(theatre)}`),
        fetch(`/api/navdata/navaids?theatre=${encodeURIComponent(theatre)}`),
      ])
      const fixes   = fixRes.ok ? await fixRes.json()  : []
      const navaids = navRes.ok ? await navRes.json()  : []
      set({ fixes, navaids, theatre })
    } catch {
      // navdata may not be ready (503) — silently skip
    }
  },

  // Returns { lat, lon, id } for the first match in fixes → navaids → runway centerlines, or null.
  lookupFix: (query) => {
    const q = (query ?? '').trim().toUpperCase()
    if (!q) return null

    const { fixes, navaids } = get()

    const fix = fixes.find((f) => f.id.toUpperCase() === q)
    if (fix) return { lat: fix.lat, lon: fix.lon, id: q }

    const navaid = navaids.find((n) => n.id.toUpperCase() === q)
    if (navaid) return { lat: navaid.lat, lon: navaid.lon, id: q }

    const centerlines = useRunwaysStore.getState().centerlines
    const rwy = centerlines.find((c) => (c.label ?? '').split(' ')[0].toUpperCase() === q)
    if (rwy) {
      return {
        lat: (rwy.rwyEnd1.lat + rwy.rwyEnd2.lat) / 2,
        lon: (rwy.rwyEnd1.lng + rwy.rwyEnd2.lng) / 2,
        id:  q,
      }
    }

    // Last resort: airport positions built from the full theatre roster,
    // not distance-filtered.  Resolves ICAO codes for distant DEP/DEST airports.
    const apPos = useRunwaysStore.getState().airportPositions[q]
    if (apPos) return { lat: apPos.lat, lon: apPos.lon, id: q }

    return null
  },
}))
