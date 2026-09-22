import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useSessionStore } from './session.js'

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

  // ── Clear every strip from one bay only (local, personal -- no WebRTC
  // broadcast, unlike a flight-plan delete) ────────────────────────────
  clearBay: (bayId) =>
    set((state) => {
      const bay = state.bays.find((b) => b.id === bayId)
      if (!bay) return {}
      const removed = new Set(bay.stripIds)
      const strips = { ...state.strips }
      for (const id of removed) delete strips[id]
      return {
        strips,
        bays: state.bays.map((b) => (b.id === bayId ? { ...b, stripIds: [] } : b)),
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

// Bidirectional, but scoped to "this position's main window + its own
// popup" — NOT a global broadcast like the symmetric syncStore() helper
// (utils/storeSync.js) other stores use. Strip bays are personal/per-
// position (a controller's own strip bay is theirs alone — they hand a
// strip to another controller explicitly via STRIP_PASSED, never via this
// channel), so two independent positions open at once (routine now that
// Electron's "New Window" can sign into multiple positions from one running
// instance) must never see each other's strips. The channel name is keyed
// by facilityId+positionName so a popup only ever syncs with its own owning
// position, never an unrelated one that happens to share the browser/app
// origin.
if (typeof window !== 'undefined') {
  const _params  = new URLSearchParams(window.location.search)
  const _isPopup = !!_params.get('window')
  const _pick    = (s) => ({ strips: s.strips, bays: s.bays })

  let _ch        = null
  let _isSyncing = false

  const _channelName = (facilityId, positionName) => `tracs-strips-${facilityId}-${positionName}`

  function _setupChannel(facilityId, positionName) {
    _ch?.close()
    _ch = new BroadcastChannel(_channelName(facilityId, positionName))
    _ch.onmessage = (e) => {
      if (e.data?.type === 'STATE_UPDATE') {
        _isSyncing = true
        useStripsStore.setState(e.data.state)
        _isSyncing = false
      } else if (e.data?.type === 'REQUEST_STATE') {
        _ch.postMessage({ type: 'STATE_UPDATE', state: _pick(useStripsStore.getState()) })
      }
    }
    _ch.postMessage({ type: 'REQUEST_STATE' })
  }

  // Broadcast every local change (from either a main window or its popup),
  // guarded so applying an incoming update doesn't immediately re-broadcast
  // an echo of itself.
  useStripsStore.subscribe((state) => {
    if (!_isSyncing && _ch) _ch.postMessage({ type: 'STATE_UPDATE', state: _pick(state) })
  })

  if (_isPopup) {
    // A popup already knows its owning position from the URL the moment it
    // opens (see App.jsx's handleStripsUndock) — no need to wait for anything.
    _setupChannel(_params.get('facilityId') ?? '', _params.get('positionName') ?? '')
  } else {
    // Main window: facilityId/positionName are blank until login completes
    // (session.js's setFacility(), which runs well after this module's
    // top-level code does) — defer channel setup until they're actually
    // known, and re-key it if they ever change (e.g. signing into a
    // different position later without restarting the window).
    let _lastKey = null
    const _trySetup = () => {
      const { facilityId, positionName } = useSessionStore.getState()
      if (!facilityId || !positionName) return
      const key = _channelName(facilityId, positionName)
      if (key === _lastKey) return
      _lastKey = key
      _setupChannel(facilityId, positionName)
    }
    useSessionStore.subscribe(_trySetup)
    _trySetup()
  }
}

