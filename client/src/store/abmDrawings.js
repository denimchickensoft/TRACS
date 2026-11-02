// User-imported GeoJSON drawings for the ABM scope, per theatre (loading a
// different theatre shows a different stack of drawings, same split as
// store/abmAirspace.js's per-theatre fetch). Persisted to IndexedDB through
// utils/localDb.js, one `<theatre>|drawing|<id>` record per layer, so an
// edit rewrites only the layers it touched; other same-machine windows
// (main window + an undocked Drawings popup) re-read just those records.
// Same local-only pattern as store/abmMission.js: these are this
// controller's own reference overlays, never broadcast to other room peers
// over WebRTC.

import { create } from 'zustand'
import {
  buildLineFeature, buildRectFeature, buildCircFeature,
  buildPolyFeature, buildSectFeature, buildRaceFeature, buildTextFeature,
} from '../utils/drawShapes.js'
import {
  loadWhere, loadPrefix, getRecords, putRecords, deleteRecords, onRemoteChange, describeDbError,
} from '../utils/localDb.js'

// Where drawings lived before IndexedDB - migrated once, then removed.
const LEGACY_KEY = 'tracs.abm.drawings'

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

export const useAbmDrawingsStore = create((set) => ({
  byTheatre:    {},     // { [theatre]: [{id, name, color, visible, addedAt, features}] } - filled by hydrate()
  persistError: null,   // last failed save, shown in the Drawings panel

  // features: normalized array from utils/parseGeojson.js. If any feature
  // carries its own simplestyle `stroke` (the file's own authored color),
  // that seeds `color` and `colorOverride` starts true — an imported file's
  // color is authoritative over the airspace palette by default, matching
  // what the file actually specifies. Otherwise color starts null/override
  // false, same as a fresh command-drawn shape: drawAbmCustomDrawings.js
  // falls back to the current airspace palette's CUSTOM stroke (server/
  // navdata/config/airspace_colors.json) until the user explicitly picks a
  // color via the Drawings panel swatch. Only the first stroke found is
  // used as the seed — a file whose features carry several different
  // stroke colors collapses to one uniform layer color, same as any other
  // manual pick; per-feature color is no longer read at render time (see
  // drawAbmCustomDrawings.js).
  // `source` tags a layer added from the running mission
  // (missionData/areas.js), so the same mission isn't added twice.
  addLayer: (theatre, name, features, source = null) => set((s) => {
    const existing = s.byTheatre[theatre] ?? []
    const seedColor = features.find(f => f.properties?.stroke)?.properties?.stroke ?? null
    const layer = {
      id:      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      color:   seedColor,
      colorOverride: seedColor !== null,
      visible: true,
      labelOverride: false,
      addedAt: Date.now(),
      features,
      ...(source ? { source } : {}),
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
      colorOverride: false,
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

  // Drag-and-drop reorder (Drawings panel) — array order here IS draw
  // order (drawAbmCustomDrawings.js iterates byTheatre[theatre] as-is, back
  // to front), so this is the one action that changes on-scope z-order
  // rather than just display order. Moves fromId to sit immediately before
  // toId's current position. Only meaningful against the raw (unsorted)
  // list — Drawings.jsx gates dragging on that.
  reorderLayer: (theatre, fromId, toId) => set((s) => {
    const layers = s.byTheatre[theatre] ?? []
    const fromIdx = layers.findIndex(l => l.id === fromId)
    const toIdx   = layers.findIndex(l => l.id === toId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return {}
    const next = [...layers]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(next.findIndex(l => l.id === toId), 0, moved)
    return { byTheatre: { ...s.byTheatre, [theatre]: next } }
  }),

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

  // Drawer's swatch/color-picker — picking a color always turns override on
  // (matches drawAbmCustomDrawings.js's colorOverride-gated priority: an
  // unpicked/overridden-off layer falls back to the airspace_colors.json
  // CUSTOM stroke instead).
  setLayerColor: (theatre, id, color) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => l.id === id ? { ...l, color, colorOverride: true } : l),
    },
  })),

  // Swatch popup's Override checkbox — toggled independently of the color
  // picker so a controller can flip back to the palette default and back to
  // their (or the file's) picked color without losing that stored value.
  setLayerColorOverride: (theatre, id, colorOverride) => set((s) => ({
    byTheatre: {
      ...s.byTheatre,
      [theatre]: (s.byTheatre[theatre] ?? []).map(l => l.id === id ? { ...l, colorOverride } : l),
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

// ── Persistence (IndexedDB) + cross-window sync ───────────────────────────

const drawingKey   = (theatre, id) => `${theatre}|drawing|${id}`
const isDrawingKey = (key) => key.split('|')[1] === 'drawing'

// Records → { [theatre]: layers[] }, in stored draw order. `order` only
// exists in the stored record; in memory, array position is the order.
function groupRecords(rows) {
  const byTheatre = {}
  for (const [key, rec] of rows) {
    if (!rec?.id) continue
    const theatre = key.split('|')[0]
    if (!byTheatre[theatre]) byTheatre[theatre] = []
    byTheatre[theatre].push(rec)
  }
  for (const theatre of Object.keys(byTheatre)) {
    byTheatre[theatre] = byTheatre[theatre]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((rec) => {
        const layer = { ...rec }
        delete layer.order
        return layer
      })
  }
  return byTheatre
}

// The record writes that turn `prev` into `next`: a layer is (re)written
// when it's new, changed (immutable updates give it a new reference) or
// moved to a different position; layers that disappeared are deleted.
export function diffDrawingWrites(prev, next) {
  const puts = []
  const dels = []
  for (const theatre of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const before = prev[theatre] ?? []
    const after  = next[theatre] ?? []
    if (before === after) continue
    const prevById = new Map(before.map((layer, i) => [layer.id, { layer, i }]))
    after.forEach((layer, i) => {
      const was = prevById.get(layer.id)
      if (!was || was.layer !== layer || was.i !== i) puts.push([drawingKey(theatre, layer.id), { ...layer, order: i }])
    })
    const keep = new Set(after.map((layer) => layer.id))
    for (const layer of before) if (!keep.has(layer.id)) dels.push(drawingKey(theatre, layer.id))
  }
  return { puts, dels }
}

function readLegacy() {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(LEGACY_KEY) } catch { return null }
}

// Moves the old single localStorage blob into per-layer records. Only
// layers IndexedDB doesn't already hold are written (a record already there
// is the newer copy), and the blob is removed only after every one of them
// reads back - a failed write leaves it in place to retry next launch.
// Safe to repeat, so a second window starting at the same moment, or the
// blob coming back after a downgrade, can't lose or duplicate a drawing (at
// worst, one deleted in that same instant comes back).
export async function migrateLegacyDrawings() {
  const raw = readLegacy()
  if (raw == null) return
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { /* unreadable blob - leave it alone */ }
  if (!parsed || typeof parsed !== 'object') return

  const entries = []
  for (const [theatre, layers] of Object.entries(parsed.byTheatre ?? {})) {
    (layers ?? []).forEach((layer, i) => {
      if (layer?.id) entries.push([drawingKey(theatre, layer.id), { ...layer, order: i }])
    })
  }
  const existing = await getRecords(entries.map(([key]) => key))
  const missing  = entries.filter((_, i) => existing[i] === undefined)
  await putRecords(missing)
  const check = await getRecords(missing.map(([key]) => key))
  if (check.some((v) => v === undefined)) throw new Error('ABM drawings migration could not be verified')
  try { localStorage.removeItem(LEGACY_KEY) } catch { /* nothing more to do */ }
}

let _hydrated       = false
let _applyingStored = false
let _writes         = Promise.resolve()

function applyStored(byTheatre) {
  _applyingStored = true
  try { useAbmDrawingsStore.setState({ byTheatre }) } finally { _applyingStored = false }
}

function reportError(err) {
  const msg = describeDbError(err)
  console.error('[abmDrawings] storage error:', msg)
  useAbmDrawingsStore.setState({ persistError: msg })
}

useAbmDrawingsStore.subscribe((state, prev) => {
  if (!_hydrated || _applyingStored || state.byTheatre === prev.byTheatre) return
  const { puts, dels } = diffDrawingWrites(prev.byTheatre, state.byTheatre)
  if (!puts.length && !dels.length) return
  _writes = _writes
    .then(async () => {
      await putRecords(puts)
      await deleteRecords(dels)
      if (useAbmDrawingsStore.getState().persistError) useAbmDrawingsStore.setState({ persistError: null })
    })
    .catch(reportError)
})

// Another window changed drawing records: once our own pending writes have
// landed, reload each affected theatre's layers.
onRemoteChange((changedKeys) => {
  if (!_hydrated) return
  const theatres = new Set(changedKeys.filter(isDrawingKey).map((key) => key.split('|')[0]))
  if (!theatres.size) return
  _writes = _writes
    .then(async () => {
      for (const theatre of theatres) {
        const layers = groupRecords(await loadPrefix(`${theatre}|drawing|`))[theatre] ?? []
        applyStored({ ...useAbmDrawingsStore.getState().byTheatre, [theatre]: layers })
      }
    })
    .catch(reportError)
})

async function hydrate() {
  try {
    await migrateLegacyDrawings()
  } catch (err) {
    reportError(err)   // the localStorage copy stays put; load what IndexedDB has
  }
  try {
    const stored  = groupRecords(await loadWhere(isDrawingKey))
    const pending = useAbmDrawingsStore.getState().byTheatre
    applyStored(stored)
    _hydrated = true
    // Anything drawn in the moment before loading finished is added on top
    // (and so persisted by the subscriber).
    if (Object.values(pending).some((layers) => layers.length)) {
      const merged = { ...stored }
      for (const [theatre, layers] of Object.entries(pending)) {
        const have = new Set((merged[theatre] ?? []).map((l) => l.id))
        merged[theatre] = [...(merged[theatre] ?? []), ...layers.filter((l) => !have.has(l.id))]
      }
      useAbmDrawingsStore.setState({ byTheatre: merged })
    }
  } catch (err) {
    reportError(err)
  }
}

// Resolves once stored drawings are loaded (or loading failed and was reported).
export const drawingsReady = hydrate()
