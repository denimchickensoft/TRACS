// User-imported GeoJSON drawings for the ABM scope. Persisted to
// localStorage per-theatre (loading a different theatre shows a different
// stack of drawings, same split as store/abmAirspace.js's per-theatre
// fetch) and synced live across same-machine windows (main window + a
// future undocked Drawings popup) via BroadcastChannel — same local-only
// pattern as store/abmMission.js: these are this controller's own reference
// overlays, never broadcast to other room peers over WebRTC.

import { create } from 'zustand'
import {
  buildLineFeature, buildRectFeature, buildCircFeature,
  buildPolyFeature, buildSectFeature, buildRaceFeature, buildTextFeature,
} from '../utils/drawShapes.js'

const SB_KEY = 'tracs.abm.drawings'

// Command-drawn layers (as opposed to imported GeoJSON files) carry a
// shapeType + the generative params needed to rebuild their single feature
// — see AbmScope.jsx's .line/.rect/.circ/.poly/.sect/.race/.text commands.
const BUILDERS = {
  line: buildLineFeature,
  rect: buildRectFeature,
  circ: buildCircFeature,
  poly: buildPolyFeature,
  sect: buildSectFeature,
  race: buildRaceFeature,
  text: buildTextFeature,
}

// Auto-names new drawn shapes TYPE1, TYPE2, ... scanning existing layer
// names in this theatre for the highest existing suffix rather than
// tracking a separate counter (so deleting/renaming entries never causes
// collisions or gaps that matter).
function nextAutoName(layers, shapeType) {
  const prefix = shapeType.toUpperCase()
  const re = new RegExp(`^${prefix}(\\d+)$`)
  let max = 0
  for (const l of layers) {
    const m = re.exec(l.name)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `${prefix}${max + 1}`
}

// A .text shape's on-map label is its typed content, not the drawer row's
// name — only other shape types show their (renamable) row name on the map.
function labeledFeature(shapeType, built, name) {
  if (shapeType === 'text') return built
  return { ...built, label: [name] }
}

function serialize(s) {
  return { byTheatre: s.byTheatre }
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SB_KEY) ?? 'null') } catch { return null }
}

const saved = loadSaved() ?? {}

export const useAbmDrawingsStore = create((set, get) => ({
  byTheatre: saved.byTheatre ?? {},   // { [theatre]: [{id, name, color, visible, addedAt, features}] }

  layersFor: (theatre) => get().byTheatre[theatre] ?? [],

  // features: normalized array from utils/parseGeojson.js. color starts
  // null — drawAbmCustomDrawings.js falls back to the current airspace
  // palette's CUSTOM stroke (server/navdata/config/airspace_colors.json)
  // until the user explicitly picks one via the Drawings panel swatch, so a
  // freshly imported/drawn layer never silently overrides the theatre's
  // color scheme.
  addLayer: (theatre, name, features) => set((s) => {
    const existing = s.byTheatre[theatre] ?? []
    const layer = {
      id:      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      color:   null,
      visible: true,
      labelOverride: false,
      addedAt: Date.now(),
      features,
    }
    return { byTheatre: { ...s.byTheatre, [theatre]: [...existing, layer] } }
  }),

  // shapeType/params drive the .line/.rect/.circ/.poly/.sect/.race/.text
  // draw commands (AbmScope.jsx) — regenerated via updateShapeParams
  // whenever the drawer edits a parameter, so the baked `features` never
  // drifts from `params`.
  addDrawnShape: (theatre, shapeType, params, name = null) => set((s) => {
    const existing = s.byTheatre[theatre] ?? []
    const finalName = name ?? nextAutoName(existing, shapeType)
    const built = labeledFeature(shapeType, BUILDERS[shapeType](params), finalName)
    const layer = {
      id:       `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name:     finalName,
      color:    null,
      visible:  true,
      labelOverride: false,
      addedAt:  Date.now(),
      features: [built],
      shapeType,
      params,
    }
    return { byTheatre: { ...s.byTheatre, [theatre]: [...existing, layer] } }
  }),

  removeLayer: (theatre, id) => set((s) => ({
    byTheatre: { ...s.byTheatre, [theatre]: (s.byTheatre[theatre] ?? []).filter(l => l.id !== id) },
  })),

  // Drawings panel's "Clear ALL" footer button (confirm-gated, same pattern
  // as Ato.jsx's clearAllFlights) — drops every layer (imported and
  // command-drawn alike) for this theatre only.
  clearTheatre: (theatre) => set((s) => ({
    byTheatre: { ...s.byTheatre, [theatre]: [] },
  })),

  // .clear <name> — case-insensitive; removes every layer with that name
  // (renames aren't required to be unique, so more than one can match).
  removeLayersByName: (theatre, name) => set((s) => {
    const target = name.toUpperCase()
    return {
      byTheatre: {
        ...s.byTheatre,
        [theatre]: (s.byTheatre[theatre] ?? []).filter(l => l.name.toUpperCase() !== target),
      },
    }
  }),

  renameLayer: (theatre, id, name) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => {
        if (l.id !== id) return l
        if (l.shapeType && l.features?.length) {
          return { ...l, name, features: [labeledFeature(l.shapeType, l.features[0], name)] }
        }
        return { ...l, name }
      }),
    },
  })),

  // Recomputes a command-drawn layer's feature from a patched params object
  // — a no-op (returns the layer unchanged) for imported layers, which have
  // no shapeType/params to rebuild from.
  updateShapeParams: (theatre, id, patch) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => {
        if (l.id !== id || !l.shapeType) return l
        const params = { ...l.params, ...patch }
        const built  = labeledFeature(l.shapeType, BUILDERS[l.shapeType](params), l.name)
        return { ...l, params, features: [built] }
      }),
    },
  })),

  // Drawer's swatch/color-picker — the layer's own color already outranks
  // the airspace_colors.json CUSTOM stroke in drawAbmCustomDrawings.js, so
  // picking one here always overrides that palette default per-drawing.
  setLayerColor: (theatre, id, color) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => l.id === id ? { ...l, color } : l),
    },
  })),

  toggleVisible: (theatre, id) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => l.id === id ? { ...l, visible: !l.visible } : l),
    },
  })),

  // Drawer's per-row "Label" checkbox — when on, this layer's label always
  // shows regardless of the global .labels toggle (same as .text shapes
  // already do unconditionally; this just makes that override opt-in and
  // available to every shape/imported layer, not hardcoded to one type).
  toggleLabelOverride: (theatre, id) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => l.id === id ? { ...l, labelOverride: !l.labelOverride } : l),
    },
  })),

  // .custom bulk toggle — same any-on pattern as AbmScope's .asp: on if any
  // layer in this theatre is currently visible, off (all) otherwise.
  toggleAll: (theatre) => set((s) => {
    const layers = s.byTheatre[theatre] ?? []
    const anyOn  = layers.some(l => l.visible)
    return {
      byTheatre: { ...s.byTheatre, [theatre]: layers.map(l => ({ ...l, visible: !anyOn })) },
    }
  }),

  // .cust <name> — case-insensitive; toggles visibility of every layer with
  // that name (renames aren't required to be unique, so more than one can
  // match) — same any-on pattern as toggleAll, but scoped to the matched
  // subset: if any matched layer is currently visible, all matched layers
  // turn off, otherwise all matched layers turn on.
  toggleLayersByName: (theatre, name) => set((s) => {
    const target = name.toUpperCase()
    const layers = s.byTheatre[theatre] ?? []
    const anyOn = layers.some(l => l.name.toUpperCase() === target && l.visible)
    return {
      byTheatre: {
        ...s.byTheatre,
        [theatre]: layers.map(l => l.name.toUpperCase() === target ? { ...l, visible: !anyOn } : l),
      },
    }
  }),
}))

// ── Cross-window sync (main window + any future undocked Drawings popup) ───
let _syncing = false

const _ch = new BroadcastChannel('tracs-abm-drawings')

useAbmDrawingsStore.subscribe((state) => {
  if (_syncing) return
  try { localStorage.setItem(SB_KEY, JSON.stringify(serialize(state))) } catch {}
  _ch.postMessage({ type: 'STATE_UPDATE', state: serialize(state) })
})

_ch.onmessage = (e) => {
  if (e.data?.type === 'STATE_UPDATE') {
    _syncing = true
    useAbmDrawingsStore.setState(e.data.state)
    _syncing = false
  } else if (e.data?.type === 'REQUEST_STATE') {
    _ch.postMessage({ type: 'STATE_UPDATE', state: serialize(useAbmDrawingsStore.getState()) })
  }
}
_ch.postMessage({ type: 'REQUEST_STATE' })
