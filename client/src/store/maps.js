import { create } from 'zustand'
import { EARTH_RADIUS_NM } from '../utils/units.js'
import { log } from '../utils/log.js'

// ── Position preset order ─────────────────────────────────────────────────────
// Each entry is exactly 5 slots. 'MVA' is a sentinel — not a displayCategory —
// that pins the MVA terrain overlay to that slot on the main bar.
// Note: position key 'CTR' = Center, distinct from the 'CTR' control-zone displayCategory.
const ICAO_PRESETS = {
  TWR:     ['CTR', 'TMA', 'CTA', 'CLASS D', 'MVA'],
  APP:     ['TMA', 'CTR', 'CTA', 'CLASS C', 'MVA'],
  DEP:     ['TMA', 'CTR', 'CTA', 'CLASS C', 'MVA'],
  RDR:     ['TMA', 'CTR', 'CTA', 'CLASS C', 'MVA'],
  CTR:     ['CTA', 'TMA', 'CTR', 'CLASS A', 'CLASS B'],
  CONTROL: ['CTA', 'TMA', 'CTR', 'CLASS A', 'CLASS B'],
  default: ['CTR', 'TMA', 'CTA', 'CLASS D', 'MVA'],
}

// ── Distance filtering ────────────────────────────────────────────────────────

function nmBetween(lat1, lng1, lat2, lng2) {
  const R  = EARTH_RADIUS_NM
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function minNmToBbox(lat, lng, bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  const nearLat = Math.max(minLat, Math.min(maxLat, lat))
  const nearLng = Math.max(minLng, Math.min(maxLng, lng))
  return nmBetween(lat, lng, nearLat, nearLng)
}

function filterThresholdNm(suffix) {
  const s = (suffix ?? '').toUpperCase()
  if (s === 'CTR') return 250
  if (s === 'TWR') return 30
  return 60
}

function filterGroupsByDistance(features, suffix, facilityLat, facilityLng) {
  if (facilityLat == null || facilityLng == null) return features
  const threshold = filterThresholdNm(suffix)
  return features.filter((f) => minNmToBbox(facilityLat, facilityLng, f.bbox) <= threshold)
}

// ── Facility envelope + naming-convention bucketing ───────────────────────────
// SUA/MIL never participate — they always bucket straight to their own category,
// same as before this step existed.
const ENVELOPE_EXCLUDED = new Set(['SUA', 'MIL'])

const ROMAN_SUFFIX   = /^(I{1,3}|IV|VI{0,3}|IX|XI{0,2})$/
const COMPASS_SUFFIX = /^(NORTH|SOUTH|EAST|WEST|CENTRAL|CENTER|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST|NE|NW|SE|SW)$/

// Strips a trailing differentiator (Roman numeral / compass word / "SECTOR x" /
// "SEC x" / "<compass> SECTION") so e.g. "DUBAI CTA VIII" and "DUBAI CTA VI"
// both reduce to "DUBAI CTA" — but "SANTA BARBARA" and "SANTA MONICA MUN" stay
// distinct since neither has a strippable trailing token.
function baseName(name) {
  let words = name.trim().split(/\s+/)
  let changed = true
  while (changed && words.length > 1) {
    changed = false
    const last       = words[words.length - 1].toUpperCase()
    const secondLast = words[words.length - 2]?.toUpperCase() ?? ''
    if (secondLast === 'SECTOR' || secondLast === 'SEC') { words = words.slice(0, -2); changed = true; continue }
    if (last === 'SECTION' && COMPASS_SUFFIX.test(secondLast)) { words = words.slice(0, -2); changed = true; continue }
    if (ROMAN_SUFFIX.test(last))   { words = words.slice(0, -1); changed = true; continue }
    if (COMPASS_SUFFIX.test(last)) { words = words.slice(0, -1); changed = true; continue }
  }
  return words.join(' ')
}

function bboxContainsPoint(bbox, lng, lat) {
  const [minLng, minLat, maxLng, maxLat] = bbox
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat
}

function pointInRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}

function pointInPolygon(lng, lat, coords) {
  if (!pointInRing(lng, lat, coords[0])) return false
  for (let k = 1; k < coords.length; k++) {
    if (pointInRing(lng, lat, coords[k])) return false // inside a hole
  }
  return true
}

function pointInGeometry(lng, lat, geom) {
  if (!geom) return false
  if (geom.type === 'Polygon') return pointInPolygon(lng, lat, geom.coordinates)
  if (geom.type === 'MultiPolygon') return geom.coordinates.some((poly) => pointInPolygon(lng, lat, poly))
  return false
}

// Tags each feature with `bucketCategory`: its real displayCategory if it
// envelops the facility (or shares a base name + category with something that
// does), otherwise `ADJ <displayCategory>`. SUA/MIL pass through untouched.
// Operates only on what already survived the bbox filter (step 2's output).
function bucketByEnvelope(features, facilityLat, facilityLng) {
  if (facilityLat == null || facilityLng == null) {
    return features.map((f) => ({ ...f, bucketCategory: f.displayCategory }))
  }

  const eligible = features.filter((f) => !ENVELOPE_EXCLUDED.has(f.displayCategory))

  const claimed = new Set() // `${category}|${baseName}` that actually envelop the facility
  for (const f of eligible) {
    if (f.bbox && !bboxContainsPoint(f.bbox, facilityLng, facilityLat)) continue
    if (pointInGeometry(facilityLng, facilityLat, f.geometry)) {
      claimed.add(`${f.displayCategory}|${baseName(f.name)}`)
    }
  }

  return features.map((f) => {
    if (ENVELOPE_EXCLUDED.has(f.displayCategory)) return { ...f, bucketCategory: f.displayCategory }
    const key = `${f.displayCategory}|${baseName(f.name)}`
    return { ...f, bucketCategory: claimed.has(key) ? f.displayCategory : `ADJ ${f.displayCategory}` }
  })
}

// ── Button assignment ─────────────────────────────────────────────────────────

function assignButtons(features, categories, suffix) {
  const preset = ICAO_PRESETS[suffix?.toUpperCase()] ?? ICAO_PRESETS.default

  // Separate MVA sentinel from airspace categories
  const mvaIdx         = preset.indexOf('MVA')
  const mvaSlot        = mvaIdx >= 0 ? mvaIdx : null
  const airspacePreset = preset.filter(c => c !== 'MVA')
  const mainSlots      = mvaSlot != null ? 4 : 5

  // Group filtered features by bucketCategory (real category, or "ADJ <category>"
  // for envelope/naming-convention leftovers — see bucketByEnvelope). Rendering
  // still uses the feature's true displayCategory, so ADJ groups keep their
  // parent category's color/style; only the DCB grouping/toggle key differs.
  // Canonical order is looked up by the true displayCategory since "ADJ *" isn't
  // one of the server's known categories.
  const categoryRank = new Map(categories.map((c, i) => [c, i]))
  const groupMap = new Map()
  for (const f of features) {
    const key = f.bucketCategory ?? f.displayCategory
    if (!groupMap.has(key)) groupMap.set(key, [])
    groupMap.get(key).push(f)
  }
  const allGroups = [...groupMap.entries()]
    .sort(([, feats1], [, feats2]) =>
      (categoryRank.get(feats1[0]?.displayCategory) ?? 999) - (categoryRank.get(feats2[0]?.displayCategory) ?? 999))
    .map(([key, feats]) => ({ name: key, displayCategory: feats[0]?.displayCategory ?? key, features: feats }))

  const available = new Map(allGroups.map((g) => [g.name, g]))
  const assigned  = []
  const submenu   = []

  for (const cat of airspacePreset) {
    if (assigned.length >= mainSlots) break
    if (available.has(cat)) {
      assigned.push(available.get(cat))
      available.delete(cat)
    }
  }

  for (const group of available.values()) {
    // ADJ buckets never occupy a main slot, even if one's open — always submenu.
    if (assigned.length < mainSlots && !group.name.startsWith('ADJ ')) assigned.push(group)
    else submenu.push(group)
  }

  // Pad with null at mvaSlot so submenu items remain at indices 5+
  const maps = mvaSlot != null
    ? [...assigned.slice(0, mvaSlot), null, ...assigned.slice(mvaSlot), ...submenu]
    : [...assigned, ...submenu]

  return { maps, mvaSlot }
}

// ── Server response cache (per theatre, keyed by name) ───────────────────────
const serverCache = {}

function lsKey(theatre, positionKey) {
  return `tracs.maps.${theatre}.${positionKey}`
}

function saveVisible(theatre, positionKey, visible) {
  if (!theatre || !positionKey) return
  try { localStorage.setItem(lsKey(theatre, positionKey), JSON.stringify(visible)) } catch {}
}

function loadSaved(theatre, positionKey) {
  if (!theatre || !positionKey) return null
  try { return JSON.parse(localStorage.getItem(lsKey(theatre, positionKey))) } catch { return null }
}

export const useMapsStore = create((set, get) => ({
  maps:        [],    // flat: [assigned(0-4), ...submenu(5+)]; index 4 is null when MVA occupies that slot
  mvaSlot:     null, // index 0-4 where MVA button appears on main bar, or null (CTR positions)
  palettes:    [],    // [{ name, colors: { [displayCategory]: { stroke, fill, label } } }]
  visible:     {},    // { [index]: bool, lbl: bool }
  theatre:     null,
  positionKey: null,
  loading:     false,
  _lastLoadKey: null,

  loadForTheatre: async (theatre, suffix = '', facilityLat = null, facilityLng = null, positionKey = null) => {
    if (!theatre) return
    const loadKey = `${theatre}|${suffix}|${facilityLat}|${facilityLng}`
    if (get()._lastLoadKey === loadKey) return
    set({ loading: true, positionKey })
    try {
      if (!serverCache[theatre]) {
        const res = await fetch(`/api/navdata/airspace?theatre=${encodeURIComponent(theatre)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        serverCache[theatre] = await res.json()
      }

      const { features, categories, palettes } = serverCache[theatre]

      const filtered           = filterGroupsByDistance(features ?? [], suffix, facilityLat, facilityLng)
      const bucketed           = bucketByEnvelope(filtered, facilityLat, facilityLng)
      const { maps, mvaSlot } = assignButtons(bucketed, categories ?? [], suffix)

      // Preserve visibility when re-filtering the same theatre (e.g. airbases update);
      // only reset when switching to a different theatre.
      const isNewTheatre = get().theatre !== theatre
      let visible
      if (isNewTheatre) {
        const v = { lbl: false }
        maps.forEach((entry, i) => { if (entry != null) v[i] = false })
        const saved = loadSaved(theatre, positionKey)
        if (saved) Object.assign(v, saved)
        visible = v
      } else {
        visible = get().visible
      }

      set({ maps, mvaSlot, palettes: palettes ?? [], visible, theatre, loading: false, _lastLoadKey: loadKey })
      const mainCount = maps.slice(0, 5).filter(Boolean).length
      log.info(`[maps] ${theatre}: suffix=${suffix || 'none'}, ${mainCount} main airspace (+${mvaSlot != null ? 'MVA' : 'none'}), ${Math.max(0, maps.length - 5)} submenu, ${(palettes ?? []).length} palettes`)
    } catch (err) {
      console.error('[maps] load error:', err.message)
      set({ loading: false })
    }
  },

  toggleMap: (key) =>
    set((s) => {
      const visible = { ...s.visible, [key]: !s.visible[key] }
      saveVisible(s.theatre, s.positionKey, visible)
      return { visible }
    }),

  setVisible: (visible) => {
    const { theatre, positionKey } = get()
    saveVisible(theatre, positionKey, visible)
    set({ visible })
  },

  refreshPalettes: async () => {
    const { theatre } = get()
    if (!theatre) return false
    try {
      const res = await fetch(`/api/navdata/airspace?theatre=${encodeURIComponent(theatre)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const palettes = data.palettes ?? []
      if (serverCache[theatre]) serverCache[theatre].palettes = palettes
      set({ palettes })
      return true
    } catch (e) {
      console.error('[maps] palette refresh error:', e.message)
      return false
    }
  },

  setPalettes: (palettes) => set({ palettes }),

  reset: () => set({ maps: [], mvaSlot: null, palettes: [], visible: {}, theatre: null, positionKey: null, loading: false }),
}))
