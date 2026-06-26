import { create } from 'zustand'

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
  const R  = 3440.065
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

// ── Button assignment ─────────────────────────────────────────────────────────

function assignButtons(features, categories, suffix) {
  const preset = ICAO_PRESETS[suffix?.toUpperCase()] ?? ICAO_PRESETS.default

  // Separate MVA sentinel from airspace categories
  const mvaIdx         = preset.indexOf('MVA')
  const mvaSlot        = mvaIdx >= 0 ? mvaIdx : null
  const airspacePreset = preset.filter(c => c !== 'MVA')
  const mainSlots      = mvaSlot != null ? 4 : 5

  // Group filtered features by displayCategory, preserving server's canonical order
  const categoryRank = new Map(categories.map((c, i) => [c, i]))
  const groupMap = new Map()
  for (const f of features) {
    const cat = f.displayCategory
    if (!groupMap.has(cat)) groupMap.set(cat, [])
    groupMap.get(cat).push(f)
  }
  const allGroups = [...groupMap.entries()]
    .sort(([a], [b]) => (categoryRank.get(a) ?? 999) - (categoryRank.get(b) ?? 999))
    .map(([cat, feats]) => ({ name: cat, displayCategory: cat, features: feats }))

  const available = new Map(allGroups.map((g) => [g.displayCategory, g]))
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
    if (assigned.length < mainSlots) assigned.push(group)
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
  return `tracs-maps-${theatre}:${positionKey}`
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
      const { maps, mvaSlot } = assignButtons(filtered, categories ?? [], suffix)

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
      console.log(`[maps] ${theatre}: suffix=${suffix || 'none'}, ${mainCount} main airspace (+${mvaSlot != null ? 'MVA' : 'none'}), ${Math.max(0, maps.length - 5)} submenu, ${(palettes ?? []).length} palettes`)
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

  reset: () => set({ maps: [], mvaSlot: null, palettes: [], visible: {}, theatre: null, positionKey: null, loading: false }),
}))
