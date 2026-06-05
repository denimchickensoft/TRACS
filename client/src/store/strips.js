import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { syncStore } from '../utils/storeSync.js'

// What caused the auto-add — drives the highlight color
export const STRIP_HIGHLIGHT = {
  AUTO_ADDED: 'auto-added',  // green — any auto-add trigger
  AMENDED:    'amended',     // yellow — flight plan was amended
  COASTING:   'coasting',    // red — contact is coasting
}

// How incoming annotations are merged when a strip already exists
export const CONFLICT_RESOLUTION = {
  OVERWRITE: 'overwrite',  // incoming replaces existing
  MERGE:     'merge',      // incoming fills blank cells only
  IGNORE:    'ignore',     // existing always kept
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveAnnotations(existing, incoming, mode) {
  if (mode === CONFLICT_RESOLUTION.OVERWRITE) return incoming.slice()
  if (mode === CONFLICT_RESOLUTION.IGNORE)    return existing.slice()
  // merge: incoming fills blank cells only
  return existing.map((cell, i) => cell || incoming[i] || '')
}

const DEFAULT_BAY = { id: 'default', name: 'Bay 1', sortBy: 'time', stripIds: [] }

const DEFAULT_SETTINGS = {
  conflictResolution:   CONFLICT_RESOLUTION.OVERWRITE,
  autoAddOnTrack:       true,
  autoAddOnHandoff:     true,
  autoAddOnStripPass:   true,
  ignoreStripPasses:    false,   // reject all incoming strip passes
  autoAddOnDepMatch:    false,
  depAirports:          [],
  autoAddOnDestMatch:   false,
  destAirports:         [],
  deleteOnDropTrack:    false,
}

export const useStripsStore = create(
  persist(
    (set, get) => ({
  // { [id]: Strip }
  // Strip: { id, aid, unitId, annotations[9], highlight, createdAt }
  strips: {},

  // Array of bay objects: [{ id, name, sortBy, stripIds[] }]
  bays: [{ ...DEFAULT_BAY }],

  ...DEFAULT_SETTINGS,

  // ── Add strip ─────────────────────────────────────────────────────
  // Returns strip ID if created, null if duplicate (no annotation update requested).
  addStrip: (aid, { annotations = null, bayId = null, highlight = null, unitId = null } = {}) => {
    const state = get()
    const normalizedAid = aid?.toUpperCase()
    if (!normalizedAid) return null

    // Find existing strip for this AID
    const existing = Object.values(state.strips).find((s) => s.aid === normalizedAid)

    if (existing) {
      // If incoming annotations provided, apply conflict resolution
      if (annotations) {
        const resolved = resolveAnnotations(existing.annotations, annotations, state.conflictResolution)
        set((s) => ({
          strips: { ...s.strips, [existing.id]: { ...existing, annotations: resolved } },
        }))
      }
      return null  // no new strip created
    }

    // New strip
    const id  = genId()
    const bay = state.bays.find((b) => b.id === (bayId ?? state.bays[0]?.id))
    if (!bay) return null

    set((s) => ({
      strips: {
        ...s.strips,
        [id]: {
          id,
          aid: normalizedAid,
          unitId: unitId != null ? unitId : null,
          annotations: annotations ? annotations.slice() : Array(9).fill(''),
          highlight,
          createdAt: Date.now(),
        },
      },
      bays: s.bays.map((b) =>
        b.id === bay.id ? { ...b, stripIds: [...b.stripIds, id] } : b
      ),
    }))

    return id
  },

  // ── Update a single annotation cell ───────────────────────────────
  setAnnotation: (stripId, cellIndex, value) =>
    set((state) => {
      const strip = state.strips[stripId]
      if (!strip) return {}
      const annotations = [...strip.annotations]
      annotations[cellIndex] = value.slice(0, 3)
      return { strips: { ...state.strips, [stripId]: { ...strip, annotations } } }
    }),

  // ── Acknowledge (clear) highlight ─────────────────────────────────
  acknowledgeStrip: (stripId) =>
    set((state) => {
      const strip = state.strips[stripId]
      if (!strip) return {}
      return { strips: { ...state.strips, [stripId]: { ...strip, highlight: null } } }
    }),

  // ── Set highlight (e.g. when plan amended) ────────────────────────
  setHighlight: (aid, highlight) =>
    set((state) => {
      const strip = Object.values(state.strips).find((s) => s.aid === aid?.toUpperCase())
      if (!strip) return {}
      return { strips: { ...state.strips, [strip.id]: { ...strip, highlight } } }
    }),

  // ── Delete strip ──────────────────────────────────────────────────
  deleteStrip: (stripId) =>
    set((state) => {
      const next = { ...state.strips }
      delete next[stripId]
      return {
        strips: next,
        bays: state.bays.map((b) => ({
          ...b,
          stripIds: b.stripIds.filter((id) => id !== stripId),
        })),
      }
    }),

  // ── Delete all strips for an AID (e.g. flight plan deleted) ──────
  deleteByAid: (aid) =>
    set((state) => {
      const normalized = aid?.toUpperCase()
      const toRemove = new Set(
        Object.values(state.strips).filter((s) => s.aid === normalized).map((s) => s.id)
      )
      const next = { ...state.strips }
      toRemove.forEach((id) => delete next[id])
      return {
        strips: next,
        bays: state.bays.map((b) => ({
          ...b,
          stripIds: b.stripIds.filter((id) => !toRemove.has(id)),
        })),
      }
    }),

  // ── Rename AID for all strips correlated to a unit ───────────────
  renameAid: (unitId, newAid) =>
    set((state) => {
      const normalized = newAid?.toUpperCase()
      if (!normalized) return {}
      const updated = {}
      for (const [id, strip] of Object.entries(state.strips)) {
        updated[id] = String(strip.unitId) === String(unitId)
          ? { ...strip, aid: normalized }
          : strip
      }
      return { strips: updated }
    }),

  // ── Bay management ─────────────────────────────────────────────────
  addBay: (name) =>
    set((state) => ({
      bays: [...state.bays, { id: genId(), name, sortBy: 'time', stripIds: [] }],
    })),

  removeBay: (bayId) =>
    set((state) => {
      if (bayId === 'default' || state.bays.length <= 1) return {}
      const removed = state.bays.find((b) => b.id === bayId)
      const defaultBay = state.bays.find((b) => b.id === 'default') ?? state.bays[0]
      return {
        bays: state.bays
          .filter((b) => b.id !== bayId)
          .map((b) =>
            b.id === defaultBay.id
              ? { ...b, stripIds: [...b.stripIds, ...(removed?.stripIds ?? [])] }
              : b
          ),
      }
    }),

  setSortBy: (bayId, sortBy) =>
    set((state) => ({
      bays: state.bays.map((b) => (b.id === bayId ? { ...b, sortBy } : b)),
    })),

  moveStripToBay: (stripId, targetBayId) =>
    set((state) => ({
      bays: state.bays.map((b) => {
        if (b.stripIds.includes(stripId) && b.id !== targetBayId)
          return { ...b, stripIds: b.stripIds.filter((id) => id !== stripId) }
        if (b.id === targetBayId && !b.stripIds.includes(stripId))
          return { ...b, stripIds: [...b.stripIds, stripId] }
        return b
      }),
    })),

  reorderBay: (bayId, newOrder) =>
    set((state) => ({
      bays: state.bays.map((b) => (b.id === bayId ? { ...b, stripIds: newOrder } : b)),
    })),

  setConflictResolution:  (mode) => set({ conflictResolution: mode }),
  setSetting:             (key, value) => set({ [key]: value }),
  addDepAirport:          (icao) => set((s) => ({ depAirports:  [...new Set([...s.depAirports,  icao.toUpperCase()])] })),
  removeDepAirport:       (icao) => set((s) => ({ depAirports:  s.depAirports.filter((a) => a !== icao) })),
  addDestAirport:         (icao) => set((s) => ({ destAirports: [...new Set([...s.destAirports, icao.toUpperCase()])] })),
  removeDestAirport:      (icao) => set((s) => ({ destAirports: s.destAirports.filter((a) => a !== icao) })),

  reset: () => set({ strips: {}, bays: [{ ...DEFAULT_BAY }] }),
    }),
    {
      name: 'tracs.strips',
      partialize: (state) => ({ strips: state.strips, bays: state.bays }),
    }
  )
)

if (typeof window !== 'undefined') {
  const _isPopup  = !!new URLSearchParams(window.location.search).get('window')
  const _stripsCh = new BroadcastChannel('tracs-strips')
  const _pick     = (s) => ({ strips: s.strips, bays: s.bays })

  if (!_isPopup) {
    // Main window: broadcast changes and respond to requests, but never apply
    // incoming state — each main window owns its own strip bays independently.
    useStripsStore.subscribe((state) => _stripsCh.postMessage({ type: 'STATE_UPDATE', state: _pick(state) }))
    _stripsCh.onmessage = (e) => {
      if (e.data?.type === 'REQUEST_STATE') _stripsCh.postMessage({ type: 'STATE_UPDATE', state: _pick(useStripsStore.getState()) })
    }
  } else {
    // Popup window: receive strips from the main window, never broadcast.
    _stripsCh.onmessage = (e) => {
      if (e.data?.type === 'STATE_UPDATE') useStripsStore.setState(e.data.state)
    }
    _stripsCh.postMessage({ type: 'REQUEST_STATE' })
  }
}

