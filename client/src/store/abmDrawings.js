// User-imported GeoJSON drawings for the ABM scope. Persisted to
// localStorage per-theatre (loading a different theatre shows a different
// stack of drawings, same split as store/abmAirspace.js's per-theatre
// fetch) and synced live across same-machine windows (main window + a
// future undocked Drawings popup) via BroadcastChannel — same local-only
// pattern as store/abmMission.js: these are this controller's own reference
// overlays, never broadcast to other room peers over WebRTC.

import { create } from 'zustand'

const SB_KEY = 'tracs.abm.drawings'

// Cycled by import order within a theatre so stacked files stay visually
// distinguishable without the user having to pick colors themselves.
const PALETTE = ['#FFD700', '#66CCFF', '#FF6666', '#66FF99', '#CC88FF', '#FFAA44', '#44DDDD', '#FF66AA']

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

  // features: normalized array from utils/parseGeojson.js.
  addLayer: (theatre, name, features) => set((s) => {
    const existing = s.byTheatre[theatre] ?? []
    const layer = {
      id:      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      color:   PALETTE[existing.length % PALETTE.length],
      visible: true,
      addedAt: Date.now(),
      features,
    }
    return { byTheatre: { ...s.byTheatre, [theatre]: [...existing, layer] } }
  }),

  removeLayer: (theatre, id) => set((s) => ({
    byTheatre: { ...s.byTheatre, [theatre]: (s.byTheatre[theatre] ?? []).filter(l => l.id !== id) },
  })),

  toggleVisible: (theatre, id) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => l.id === id ? { ...l, visible: !l.visible } : l),
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
