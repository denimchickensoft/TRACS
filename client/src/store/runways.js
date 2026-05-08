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

// ── Airbase label generation ──────────────────────────────────────────────────
//
// Default: first segment (split at [\s-]), uppercase, max 4 chars.
// Collision resolution: first 3 chars + first alpha char where stripped
// full names diverge.

export function computeAirbaseLabels(names) {
  function baseLabel(name) {
    return name.split(/[\s-]/)[0].slice(0, 4).toUpperCase()
  }

  const unique = [...new Set(names)]
  const byBase = {}
  for (const name of unique) {
    const b = baseLabel(name)
    if (!byBase[b]) byBase[b] = []
    byBase[b].push(name)
  }

  const result = {}
  for (const [base, group] of Object.entries(byBase)) {
    if (group.length === 1) {
      result[group[0]] = base
      continue
    }
    const stripped = group.map((n) => n.replace(/[\s-]/g, '').toUpperCase())
    const maxLen   = Math.max(...stripped.map((s) => s.length))
    let divergeIdx = maxLen - 1
    for (let i = 0; i < maxLen; i++) {
      const chars = new Set(stripped.map((s) => s[i] ?? ''))
      if (chars.size > 1) { divergeIdx = i; break }
    }
    const prefix = base.slice(0, 3)
    for (let i = 0; i < group.length; i++) {
      result[group[i]] = prefix + (stripped[i][divergeIdx] ?? '_')
    }
  }
  return result
}

const theatreCache = {}

export const useRunwaysStore = create((set, get) => ({
  // centerlines: one entry per runway direction
  // { id, label, thresholdLat, thresholdLng, headingRad, rwyEnd1, rwyEnd2 }
  centerlines:  [],
  cltrVisible:  {},
  obstructions: [],
  obstVisible:  false,

  theatre:         null,
  facilityAirbase: null,
  _lastLoadKey:    null,

  loadForTheatre: async (theatre, suffix = '', facilityLat = null, facilityLng = null, facilityAirbase = null) => {
    if (!theatre) return
    const loadKey = `${theatre}|${suffix}|${facilityLat}|${facilityLng}|${facilityAirbase}`
    if (get()._lastLoadKey === loadKey) return
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
      const isNewTheatre = get().theatre !== theatre

      const rawCenterlines = []
      const seenRwy        = new Set()
      const seenCtr        = new Set()

      for (const ab of airbases ?? []) {
        for (const rwy of ab.runways ?? []) {
          if (hasPos && nmBetween(facilityLat, facilityLng, rwy.lat, rwy.lon) > threshold) continue

          const headingDeg = rwy.name * 10 + magvar
          const headingRad = headingDeg * Math.PI / 180
          const { end1, end2 } = computeEndpoints(rwy.lat, rwy.lon, headingDeg, rwy.length_ft)

          const rwyNum1 = rwy.name
          const rwyNum2 = ((rwy.name + 18) % 36) || 36

          // ── Centerlines (one per direction), carrying pavement endpoints ──
          const id1 = `${ab.airbase}__${rwyNum1}`
          if (!seenCtr.has(id1)) {
            seenCtr.add(id1)
            rawCenterlines.push({
              airbase:      ab.airbase,
              rwyNum:       rwyNum1,
              thresholdLat: end2.lat,
              thresholdLng: end2.lng,
              headingRad:   headingRad + Math.PI,
              rwyEnd1:      end1,
              rwyEnd2:      end2,
            })
          }
          const id2 = `${ab.airbase}__${rwyNum2}`
          if (!seenCtr.has(id2)) {
            seenCtr.add(id2)
            rawCenterlines.push({
              airbase:      ab.airbase,
              rwyNum:       rwyNum2,
              thresholdLat: end1.lat,
              thresholdLng: end1.lng,
              headingRad:   headingRad,
              rwyEnd1:      end1,
              rwyEnd2:      end2,
            })
          }

          // track seen pavements for deduplication (not needed for output, kept for seenRwy logic)
          const lo  = Math.min(rwyNum1, rwyNum2)
          const hi  = Math.max(rwyNum1, rwyNum2)
          seenRwy.add(`${ab.airbase}__rwy__${lo}_${hi}`)
        }
      }

      // Resolve abbreviated airbase labels (collision-aware)
      const abNames  = [...new Set(rawCenterlines.map((c) => c.airbase))]
      const labelMap = computeAirbaseLabels(abNames)

      const centerlines = rawCenterlines.map((c) => ({
        id:           `${c.airbase}__${c.rwyNum}`,
        label:        `${labelMap[c.airbase]} ${String(c.rwyNum).padStart(2, '0')}`,
        airbase:      c.airbase,
        thresholdLat: c.thresholdLat,
        thresholdLng: c.thresholdLng,
        headingRad:   c.headingRad,
        rwyEnd1:      c.rwyEnd1,
        rwyEnd2:      c.rwyEnd2,
      }))

      // On new theatre reset all visibility; otherwise preserve user state.
      // Always auto-select the facility's centerlines when facilityAirbase is known.
      const prevCltr  = isNewTheatre ? {} : { ...get().cltrVisible }
      const cltrVisible = {}
      for (const c of centerlines) {
        if (facilityAirbase && c.airbase === facilityAirbase) {
          cltrVisible[c.id] = true
        } else {
          cltrVisible[c.id] = prevCltr[c.id] ?? false
        }
      }

      // Load obstruction points (per-theatre, silently skip if unavailable)
      let obstructions = get().obstructions
      if (isNewTheatre) {
        try {
          const obsRes = await fetch(`/obstructions/${encodeURIComponent(theatre)}.json`)
          obstructions = obsRes.ok ? await obsRes.json() : []
        } catch {
          obstructions = []
        }
      }

      set({ centerlines, cltrVisible, obstructions, obstVisible: isNewTheatre ? false : get().obstVisible, theatre, facilityAirbase: facilityAirbase || null, _lastLoadKey: loadKey })
      console.log(`[runways] ${theatre}: ${centerlines.length} centerline maps, ${obstructions.length} obstructions`)
    } catch (err) {
      console.error('[runways] load error:', err.message)
    }
  },

  toggleCenterline: (id) => set((s) => ({ cltrVisible: { ...s.cltrVisible, [id]: !s.cltrVisible[id] } })),
  toggleObst:       ()   => set((s) => ({ obstVisible: !s.obstVisible })),

  reset: () => set({ centerlines: [], cltrVisible: {}, obstructions: [], obstVisible: false, theatre: null, facilityAirbase: null }),
}))
