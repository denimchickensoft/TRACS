import { create } from 'zustand'
import { computeMagvar, missionDecimalYear } from '../utils/magvar.js'
import { EARTH_RADIUS_NM } from '../utils/units.js'
import { getIcaoMapping } from '../utils/icaoMapping.js'
import { log } from '../utils/log.js'

const FT_PER_NM = 6076.115

function nmBetween(lat1, lng1, lat2, lng2) {
  const R  = EARTH_RADIUS_NM
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

function headingToCompass(deg) {
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][idx]
}

function angDist(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360)
  return Math.min(d, 360 - d)
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
let icaoMapping = null

export const useRunwaysStore = create((set, get) => ({
  // centerlines: one entry per runway direction
  // { id, label, thresholdLat, thresholdLng, headingRad, rwyEnd1, rwyEnd2 }
  centerlines:      [],
  cltrVisible:      {},
  satBuckets:       [],   // [{ label: 'NW', ids: [...] }, { label: 'SE', ids: [...] }]
  airportPositions: {},   // ICAO → {lat, lon} — all theatre airports, no distance filter

  theatre:         null,
  facilityAirbase: null,
  _lastLoadKey:    null,

  loadForTheatre: async (theatre, suffix = '', facilityLat = null, facilityLng = null, facilityAirbase = null, missionDate = null) => {
    if (!theatre) return
    const yearKey     = missionDate ? missionDecimalYear(missionDate).toFixed(2) : 'now'
    const loadKey = `${theatre}|${suffix}|${facilityLat}|${facilityLng}|${facilityAirbase}|${yearKey}`
    if (get()._lastLoadKey === loadKey) return
    try {
      if (!theatreCache[theatre]) {
        const rwyRes = await fetch(`/runways/${encodeURIComponent(theatre)}.json`)
        if (!rwyRes.ok) throw new Error(`HTTP ${rwyRes.status}`)
        const rwyData = await rwyRes.json()

        // Pre-pass: group runway entries by lower designator to find parallels.
        // suffixMap: rwy object → { lowerSuffix: 'L'|'C'|'R'|'' }
        // lowerSuffix is the suffix in the lower-numbered heading direction.
        const suffixMap = new Map()
        for (const ab of rwyData.airbases ?? []) {
          if (!Array.isArray(ab.runways) || ab.runways.length === 0) continue
          const groups = {}
          for (const rwy of ab.runways) {
            const recip    = ((rwy.name + 18) % 36) || 36
            const lowerNum = Math.min(rwy.name, recip)
            if (!groups[lowerNum]) groups[lowerNum] = []
            groups[lowerNum].push(rwy)
          }
          for (const [lowerNumStr, rwys] of Object.entries(groups)) {
            if (rwys.length === 1) {
              suffixMap.set(rwys[0], '')
              continue
            }
            const lowerNum = parseInt(lowerNumStr, 10)
            const headRad  = (lowerNum * 10) * Math.PI / 180
            const perpE    = Math.cos(headRad)
            const perpN    = -Math.sin(headRad)
            const cosLat   = Math.cos(rwys[0].lat * Math.PI / 180)
            const sorted   = [...rwys].sort((a, b) =>
              (a.lon * cosLat * perpE + a.lat * perpN) -
              (b.lon * cosLat * perpE + b.lat * perpN)
            )
            const SUFFIXES = rwys.length === 2 ? ['L', 'R'] : ['L', 'C', 'R']
            for (let i = 0; i < sorted.length; i++) {
              suffixMap.set(sorted[i], SUFFIXES[i] ?? 'R')
            }
          }
        }

        theatreCache[theatre] = { ...rwyData, suffixMap }
      }

      const { airbases, suffixMap } = theatreCache[theatre]
      const threshold    = filterThresholdNm(suffix)
      const hasPos       = facilityLat != null && facilityLng != null
      const isNewTheatre = get().theatre !== theatre

      const rawCenterlines = []
      const seenCtr        = new Set()

      let facilityFlowMagHead = null
      let facilityLongestLen  = 0

      for (const ab of airbases ?? []) {
        if (!Array.isArray(ab.runways) || ab.runways.length === 0) continue
        for (const rwy of ab.runways) {
          if (rwy.course_true_deg == null) continue
          if (hasPos && nmBetween(facilityLat, facilityLng, rwy.lat, rwy.lon) > threshold) continue

          const reciprocal  = ((rwy.name + 18) % 36) || 36
          const lowerNum    = Math.min(rwy.name, reciprocal)
          const lowerSuffix = suffixMap.get(rwy) ?? ''
          const recipSuffix = lowerSuffix === 'L' ? 'R' : lowerSuffix === 'R' ? 'L' : lowerSuffix
          const primaryIsLower = rwy.name === lowerNum
          const name1 = String(rwy.name)    + (primaryIsLower ? lowerSuffix : recipSuffix)
          const name2 = String(reciprocal)  + (primaryIsLower ? recipSuffix : lowerSuffix)

          // Compute magnetic headings from DCS's raw heading via WMM declination.
          // course_true_deg matches what DCS itself calls "true" (its own raw
          // heading, uncorrected for grid convergence — see utils/magvar.js);
          // negating gives the approach direction.
          const rwyDeclination = computeMagvar(rwy.lat, rwy.lon, missionDate)
          const rawMagHead     = ((-rwy.course_true_deg) - rwyDeclination + 360) % 360
          // Orient toward rwy.name * 10 (the primary designator direction).
          const expected     = rwy.name * 10
          const magHead      = angDist(rawMagHead, expected) <= 90 ? rawMagHead : (rawMagHead + 180) % 360
          const magHead2     = (magHead + 180) % 360

          // Track facility's longest runway for satellite flow bucket computation
          if (facilityAirbase && ab.airbase === facilityAirbase && rwy.length_ft > facilityLongestLen) {
            facilityLongestLen  = rwy.length_ft
            facilityFlowMagHead = magHead
          }

          const headingDeg = -rwy.course_true_deg
          let end1, end2
          if (rwy.end1?.lat != null) {
            end1 = { lat: rwy.end1.lat, lng: rwy.end1.lon }
            end2 = { lat: rwy.end2.lat, lng: rwy.end2.lon }
          } else {
            ;({ end1, end2 } = computeEndpoints(rwy.lat, rwy.lon, headingDeg, rwy.length_ft))
          }
          // When geographic endpoints are available derive heading from them so the
          // approach extension matches the tile (avoids meridian-convergence offset).
          const headingRad = (rwy.end1?.lat != null)
            ? Math.atan2(
                (end1.lng - end2.lng) * Math.cos(end2.lat * Math.PI / 180),
                end1.lat - end2.lat
              )
            : headingDeg * Math.PI / 180
          // ── Centerlines (one per direction), carrying pavement endpoints ──
          // headingRad = bearing from end2 → end1. The primary runway (rwy.name)
          // lands in the magHead direction. If magHead aligns with headingRad the
          // threshold is at end2; if it aligns with the opposite end (end1) we swap.
          const headRad_deg   = ((headingRad * 180 / Math.PI) % 360 + 360) % 360
          const swap          = angDist(magHead, headRad_deg) > 90
          const primThresh    = swap ? end1 : end2
          const otherThresh   = swap ? end2 : end1
          const primHeadRad   = swap ? headingRad         : headingRad + Math.PI
          const otherHeadRad  = swap ? headingRad + Math.PI : headingRad

          const id1 = `${ab.airbase}__${name1}`
          if (!seenCtr.has(id1)) {
            seenCtr.add(id1)
            rawCenterlines.push({
              airbase:      ab.airbase,
              rwyName:      name1,
              thresholdLat: primThresh.lat,
              thresholdLng: primThresh.lng,
              headingRad:   primHeadRad,
              magHead:      magHead,
              elevFt:       rwy.elevation_ft ?? 0,
              declinationDeg: rwyDeclination,
              rwyEnd1:      end1,
              rwyEnd2:      end2,
            })
          }
          const id2 = `${ab.airbase}__${name2}`
          if (!seenCtr.has(id2)) {
            seenCtr.add(id2)
            rawCenterlines.push({
              airbase:      ab.airbase,
              rwyName:      name2,
              thresholdLat: otherThresh.lat,
              thresholdLng: otherThresh.lng,
              headingRad:   otherHeadRad,
              magHead:      magHead2,
              elevFt:       rwy.elevation_ft ?? 0,
              declinationDeg: rwyDeclination,
              rwyEnd1:      end1,
              rwyEnd2:      end2,
            })
          }
        }
      }

      // Load ICAO mapping once
      if (!icaoMapping) {
        icaoMapping = await getIcaoMapping()
      }

      // Resolve labels: ICAO code if available, abbreviated name as fallback
      const abNames     = [...new Set(rawCenterlines.map((c) => c.airbase))]
      const fallbackMap = computeAirbaseLabels(abNames)
      const theatreIcao = icaoMapping[theatre.toLowerCase()] ?? {}
      const labelMap    = {}
      for (const name of abNames) {
        labelMap[name] = theatreIcao[name] ?? fallbackMap[name]
      }

      // Build airport positions for ALL ICAO-mapped airports in the theatre,
      // independent of the distance filter.  Used by lookupFix so that route
      // drawing can connect to distant DEP/DEST airports (e.g. OMAA from OMDB).
      const airportPositions = {}
      for (const ab of airbases ?? []) {
        const icaoCode = theatreIcao[ab.airbase]
        if (!icaoCode) continue
        let latSum = 0, lonSum = 0, count = 0
        for (const rwy of (ab.runways ?? [])) {
          if (rwy.lat != null && rwy.lon != null) {
            latSum += rwy.lat; lonSum += rwy.lon; count++
          }
        }
        if (count > 0) airportPositions[icaoCode] = { lat: latSum / count, lon: lonSum / count }
      }

      const centerlines = rawCenterlines.map((c) => ({
        id:           `${c.airbase}__${c.rwyName}`,
        label:        `${labelMap[c.airbase]} ${c.rwyName}`,
        airbase:      c.airbase,
        icao:         theatreIcao[c.airbase] ?? null,
        thresholdLat: c.thresholdLat,
        thresholdLng: c.thresholdLng,
        headingRad:   c.headingRad,
        magHead:      c.magHead,
        elevFt:       c.elevFt,
        declinationDeg: c.declinationDeg,
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


      // ── Satellite flow buckets ───────────────────────────────────────────────
      // Group non-facility centerlines into two directional buckets derived from
      // the facility's longest runway heading.  Each centerline goes into the
      // bucket whose flow heading it is closest to (angular distance ≤ 90°).
      const satBuckets = []
      if (facilityFlowMagHead != null) {
        const headA  = ((facilityFlowMagHead % 360) + 360) % 360
        const headB  = (headA + 180) % 360
        const labelA = headingToCompass(headA)
        const labelB = headingToCompass(headB)
        const bucketA = { label: labelA, ids: [] }
        const bucketB = { label: labelB, ids: [] }

        for (const cl of centerlines) {
          if (cl.airbase === facilityAirbase) continue
          const clMagHead = cl.magHead ?? ((cl.headingRad * 180 / Math.PI) - cl.declinationDeg + 180 + 360) % 360
          if (angDist(clMagHead, headA) <= angDist(clMagHead, headB)) bucketA.ids.push(cl.id)
          else bucketB.ids.push(cl.id)
        }

        if (bucketA.ids.length > 0) satBuckets.push(bucketA)
        if (bucketB.ids.length > 0) satBuckets.push(bucketB)
      }

      set({ centerlines, cltrVisible, satBuckets, theatre, facilityAirbase: facilityAirbase || null, airportPositions, _lastLoadKey: loadKey })
      log.info(`[runways] ${theatre}: ${centerlines.length} centerlines, ${satBuckets.map(b => `${b.label}:${b.ids.length}`).join(' ')} sat`)
    } catch (err) {
      console.error('[runways] load error:', err.message)
    }
  },

  toggleCenterline: (id) => set((s) => ({ cltrVisible: { ...s.cltrVisible, [id]: !s.cltrVisible[id] } })),

  toggleSatBucket: (label) => set((s) => {
    const bucket = s.satBuckets.find((b) => b.label === label)
    if (!bucket) return {}
    const allOn  = bucket.ids.every((id) => s.cltrVisible[id])
    const updates = {}
    for (const id of bucket.ids) updates[id] = !allOn
    return { cltrVisible: { ...s.cltrVisible, ...updates } }
  }),

  reset: () => set({ centerlines: [], cltrVisible: {}, satBuckets: [], theatre: null, facilityAirbase: null, airportPositions: {} }),
}))
