import { create } from 'zustand'

// ── Position preset order ─────────────────────────────────────────────────────
// Names must match colors[acCode].label values from airspace_colors.json
const ICAO_PRESETS = {
  TWR:     ['CTR', 'TMA', 'R', 'P', 'Class D'],
  APP:     ['TMA', 'CTR', 'CTA', 'R', 'P'],
  DEP:     ['TMA', 'CTR', 'CTA', 'R', 'P'],
  RDR:     ['TMA', 'CTR', 'CTA', 'R', 'P'],
  CTR:     ['FIR', 'UIR', 'TMA', 'R', 'P'],
  default: ['TMA', 'CTR', 'CTA', 'R', 'P'],
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

function filterGroupsByDistance(groups, suffix, facilityLat, facilityLng) {
  if (facilityLat == null || facilityLng == null) return groups
  const threshold = filterThresholdNm(suffix)
  return groups
    .map((g) => ({
      ...g,
      features: g.features.filter((f) => minNmToBbox(facilityLat, facilityLng, f.bbox) <= threshold),
    }))
    .filter((g) => g.features.length > 0)
}

// ── Button assignment ─────────────────────────────────────────────────────────

function assignButtons(groups, suffix) {
  const presetOrder = ICAO_PRESETS[suffix?.toUpperCase()] ?? ICAO_PRESETS.default

  const available = new Map(groups.map((g) => [g.name, g]))
  const assigned  = []
  const submenu   = []

  for (const name of presetOrder) {
    if (assigned.length >= 5) break
    if (available.has(name)) {
      assigned.push(available.get(name))
      available.delete(name)
    }
  }

  for (const group of available.values()) {
    if (assigned.length < 5) assigned.push(group)
    else submenu.push(group)
  }

  return [...assigned, ...submenu]
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
  maps:        [],    // flat: [assigned(0-4), ...submenu(5+)]
  colors:      null,  // { [acCode]: { stroke, fill, label } } from navdata
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

      const { groups, colors } = serverCache[theatre]

      const filtered = filterGroupsByDistance(groups ?? [], suffix, facilityLat, facilityLng)
      const maps     = assignButtons(filtered, suffix)

      // Preserve visibility when re-filtering the same theatre (e.g. airbases update);
      // only reset when switching to a different theatre.
      const isNewTheatre = get().theatre !== theatre
      let visible
      if (isNewTheatre) {
        const v = { lbl: false }
        maps.forEach((_, i) => { v[i] = false })
        const saved = loadSaved(theatre, positionKey)
        if (saved) Object.assign(v, saved)
        visible = v
      } else {
        visible = get().visible
      }

      set({ maps, colors: colors ?? null, visible, theatre, loading: false, _lastLoadKey: loadKey })
      console.log(`[maps] ${theatre}: suffix=${suffix || 'none'}, ${maps.length} groups (${Math.min(maps.length, 5)} main, ${Math.max(0, maps.length - 5)} submenu)`)
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

  reset: () => set({ maps: [], colors: null, visible: {}, theatre: null, positionKey: null, loading: false }),
}))
