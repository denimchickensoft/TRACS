import { create } from 'zustand'
import { THEATRE_MAGVAR } from '../utils/magvar.js'

const FT_PER_NM = 6076.115

function nmBetween(lat1, lng1, lat2, lng2) {
  const R  = 3440.065
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function filterThresholdNm(suffix) {
  const s = (suffix ?? '').toUpperCase()
  if (s === 'CTR') return 250
  if (s === 'TWR') return 30
  return 60
}

// Flat-earth approximation — accurate to centimetres for runway lengths.
function computeEndpoints(centerLat, centerLng, headingDeg, lengthFt) {
  const halfNm  = (lengthFt / FT_PER_NM) / 2
  const headRad = headingDeg * Math.PI / 180
  const cosLat  = Math.cos(centerLat * Math.PI / 180)
  const dLat    = (halfNm / 60) * Math.cos(headRad)
  const dLng    = (halfNm / 60) * Math.sin(headRad) / cosLat
  return {
    end1: { lat: centerLat + dLat, lng: centerLng + dLng },
    end2: { lat: centerLat - dLat, lng: centerLng - dLng },
  }
}

const theatreCache = {}

export const useRunwaysStore = create((set) => ({
  runways: [],
  theatre: null,

  loadForTheatre: async (theatre, suffix = '', facilityLat = null, facilityLng = null) => {
    if (!theatre) return
    try {
      if (!theatreCache[theatre]) {
        const res = await fetch(`/runways/${encodeURIComponent(theatre)}.json`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        theatreCache[theatre] = await res.json()
      }

      const { airbases } = theatreCache[theatre]
      const threshold    = filterThresholdNm(suffix)
      const hasPos       = facilityLat != null && facilityLng != null
      const magvar       = THEATRE_MAGVAR[theatre] ?? 0

      const runways = []
      for (const ab of airbases ?? []) {
        for (const rwy of ab.runways ?? []) {
          if (hasPos && nmBetween(facilityLat, facilityLng, rwy.lat, rwy.lon) > threshold) continue
          // Runway name is a magnetic heading; add magvar to get true heading for WGS84 endpoint calc.
          const { end1, end2 } = computeEndpoints(rwy.lat, rwy.lon, rwy.name * 10 + magvar, rwy.length_ft)
          runways.push({ airbase: ab.airbase, end1, end2 })
        }
      }

      set({ runways, theatre })
      console.log(`[runways] ${theatre}: suffix=${suffix || 'none'}, ${runways.length} runways within ${threshold} nm`)
    } catch (err) {
      console.error('[runways] load error:', err.message)
    }
  },

  reset: () => set({ runways: [], theatre: null }),
}))
