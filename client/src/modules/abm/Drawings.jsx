import { useState, useRef, useEffect, useMemo } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useSessionStore } from '../../store/session.js'
import { useAbmDrawingsStore } from '../../store/abmDrawings.js'
import { useAbmAirspaceStore } from '../../store/abmAirspace.js'
import { loadAbmPrefs } from '../../store/abmPrefs.js'
import { useAbmDeclination } from './useAbmDeclination.js'
import { toMagneticFromTrue, toTrueFromMagnetic } from '../../utils/bearing.js'
import { AbmDrawingImport } from './AbmDrawingImport.jsx'
import { exportDrawingsZip } from './exportDrawings.js'
import './Drawings.css'

// Editable numeric/select knobs per command-drawn shapeType (store/
// abmDrawings.js's `params`) — see modules/abm/draw/drawCommands.js for
// what each field means. Absent from this table (e.g. 'line', and now
// 'poly' too — a freeform vertex list has no scalar knob left to edit here)
// means no expand/edit panel is offered; imported layers (no shapeType at
// all) never get one either. `type: 'deg'` fields (headings) wrap into
// [0,359] on commit (360 → 0) instead of a plain float parse — see
// NumberField.
const SHAPE_FIELDS = {
  rect: [{ key: 'rotationDeg', label: 'Rotation°', type: 'deg' }],
  circ: [{ key: 'radiusNm', label: 'Radius NM' }],
  sect: [
    { key: 'startBrg', label: 'Start°', type: 'deg' },
    { key: 'endBrg',   label: 'End°', type: 'deg' },
    { key: 'radiusNm', label: 'Radius NM' },
  ],
  race: [
    { key: 'radialDeg',     label: 'Radial°', type: 'deg' },
    { key: 'turnDir',       label: 'Turns', type: 'select', options: ['L', 'R'] },
    { key: 'legNm',         label: 'Leg NM' },
    { key: 'turnRadiusNm',  label: 'Turn radius NM' },
  ],
  text: [
    { key: 'text',        label: 'Label', type: 'text' },
    { key: 'rotationDeg', label: 'Rotation°', type: 'deg' },
  ],
}

// Free-entry numeric field: typing is entirely decoupled from the stored
// value (a plain local draft string) so clearing/retyping the leading digit
// never gets fought by a controlled value snapping back mid-edit — the
// previous <input type="number" value={param}> bound the DOM value directly
// to the store, so an intermediate empty/partial string (which parses to
// NaN) was rejected and the input visibly reverted. Only commits (parses,
// clamps) on blur/Enter; resyncs from the store value otherwise, e.g. if
// the shape changes from a map edit while the panel is open.
function NumberField({ value, deg = false, onCommit }) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])

  const commit = () => {
    focused.current = false
    const parsed = parseFloat(draft)
    if (Number.isNaN(parsed)) { setDraft(String(value)); return }
    const next = deg ? ((Math.round(parsed) % 360) + 360) % 360 : parsed
    onCommit(next)
    setDraft(String(next))
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onFocus={() => { focused.current = true }}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
    />
  )
}

const DR_SORT_KEY_KEY = 'tracs.abm.drawings.sortKey'
const DR_SORT_DIR_KEY = 'tracs.abm.drawings.sortDir'
const DR_SCALE_KEY    = 'tracs.abm.drawings.scale'
const SCALE_MIN       = 0.5
const SCALE_MAX       = 2.0
const SCALE_STEP      = 0.05

// The trailing INFO column is left out of this table — it's a disclosure
// arrow for command-drawn shapes with editable params and a feature count
// for everything else (see the dr-count/dr-disclosure branch below), not
// one consistent value, so it isn't offered as a sort key.
const SORT_COLUMNS = [
  { key: 'visible', label: 'VIS'  },
  { key: 'color',   label: '●'   },
  { key: 'name',    label: 'NAME' },
  { key: 'label',   label: 'LBL'  },
]

const SORT_ACCESSORS = {
  visible: l => l.visible ? 1 : 0,
  color:   l => l.color ?? '',
  name:    l => l.name ?? '',
  label:   l => (l.shapeType === 'text' || l.labelOverride) ? 1 : 0,
}

// Swatch + popover — the swatch itself always shows the actually-rendered
// color (drawAbmCustomDrawings.js's resolved stroke: layer.color when
// colorOverride is on, otherwise the airspace palette's CUSTOM stroke), with
// a border style distinguishing the two so an override is visible at a
// glance instead of looking like any other picked color. The popover holds
// the native color picker plus the Override checkbox — picking a color
// always turns override on (store/abmDrawings.js's setLayerColor), the
// checkbox alone flips override without discarding the stored color pick.
function ColorSwatch({ layer, paletteStroke, onPick, onToggleOverride }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const fallback = '#dddddd'
  const resolved = layer.colorOverride ? (layer.color ?? fallback) : (paletteStroke ?? fallback)

  return (
    <span className="dr-swatch-wrap" ref={wrapRef}>
      <button
        type="button"
        className={['dr-swatch', layer.colorOverride ? 'dr-swatch-override' : 'dr-swatch-palette'].join(' ')}
        style={{ background: resolved }}
        onClick={() => setOpen(o => !o)}
        title={layer.colorOverride
          ? `Override color: ${resolved} (overrides the airspace palette)`
          : `Using airspace palette CUSTOM color: ${resolved}`}
      />
      {open && (
        <div className="dr-swatch-popover">
          <input
            type="color"
            className="dr-swatch-input"
            value={layer.color ?? resolved}
            onChange={e => onPick(e.target.value)}
          />
          <label className="dr-swatch-override-row">
            <input
              type="checkbox"
              checked={layer.colorOverride}
              onChange={e => onToggleOverride(e.target.checked)}
            />
            Override
          </label>
        </div>
      )}
    </span>
  )
}

export function Drawings({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir = useWheelDirection()
  const mission = useSessionStore(s => s.mission)
  const theatre = mission?.mission?.theatre ?? null
  const declinationDeg = useAbmDeclination()

  const layers              = useAbmDrawingsStore(s => (theatre ? s.byTheatre[theatre] ?? [] : []))
  const toggleVisible       = useAbmDrawingsStore(s => s.toggleVisible)
  const toggleLabelOverride = useAbmDrawingsStore(s => s.toggleLabelOverride)
  const setLayerColor       = useAbmDrawingsStore(s => s.setLayerColor)
  const setLayerColorOverride = useAbmDrawingsStore(s => s.setLayerColorOverride)
  const removeLayer       = useAbmDrawingsStore(s => s.removeLayer)
  const renameLayer       = useAbmDrawingsStore(s => s.renameLayer)
  const updateShapeParams = useAbmDrawingsStore(s => s.updateShapeParams)
  const clearTheatre      = useAbmDrawingsStore(s => s.clearTheatre)
  const toggleAll         = useAbmDrawingsStore(s => s.toggleAll)

  // Same palette AbmScope's drawAbmCustomDrawings call resolves against
  // (useAbmAirspaceStore's paletteIdx, hydrated from abmPrefs there) — kept
  // reactive here so an unpicked/override-off drawing's swatch tracks a
  // live `.aspcolors` change instead of going stale.
  const airspacePalettes = useAbmAirspaceStore(s => s.palettes)
  const paletteIdx       = useAbmAirspaceStore(s => s.paletteIdx)
  const paletteStroke    = airspacePalettes[paletteIdx]?.colors?.CUSTOM?.stroke ?? null

  // When docked, AbmScope owns loading palettes + hydrating paletteIdx from
  // abmPrefs (see its own comment: paletteIdx is a single global value, not
  // per-window, so this panel just reads it reactively) — don't conflict
  // with that. Standalone, there's no AbmScope instance in this document to
  // do either, so this popup would otherwise always see an empty palette
  // list and the default paletteIdx (0), rendering every un-overridden
  // drawing's swatch as a hardcoded gray instead of the real palette color.
  useEffect(() => {
    if (docked) return
    useAbmAirspaceStore.setState({ paletteIdx: loadAbmPrefs().aspColorIdx })
  }, [docked])
  useEffect(() => {
    if (docked || !theatre) return
    useAbmAirspaceStore.getState().loadForTheatre(theatre)
  }, [docked, theatre])

  const [importOpen, setImportOpen] = useState(false)
  const [initialFiles, setInitialFiles] = useState(null)
  const [dragging, setDragging] = useState(false)

  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const [sortKey, setSortKey] = useState(() => localStorage.getItem(DR_SORT_KEY_KEY) || null)
  const [sortDir, setSortDir] = useState(() => (localStorage.getItem(DR_SORT_DIR_KEY) === '-1' ? -1 : 1))   // 1 = asc, -1 = desc

  // ASC -> DESC -> OFF (unlike Ato's ASC/DESC-only toggle) — a third "off"
  // state is needed here because sorting and the drag-reorder below are
  // mutually exclusive: dragging only makes sense when the panel is showing
  // the underlying array order (reorderLayer's actual draw z-order), so
  // there has to be a way back to that from any sorted state.
  const handleSort = (key) => {
    let nextKey = key, nextDir = 1
    if (sortKey === key) {
      if (sortDir === 1) nextDir = -1
      else nextKey = null
    }
    setSortKey(nextKey)
    setSortDir(nextDir)
    localStorage.setItem(DR_SORT_KEY_KEY, nextKey ?? '')
    localStorage.setItem(DR_SORT_DIR_KEY, String(nextDir))
  }

  const sortedLayers = useMemo(() => {
    if (!sortKey) return layers
    const accessor = SORT_ACCESSORS[sortKey]
    return [...layers].sort((a, b) => {
      const av = accessor(a), bv = accessor(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir
      return String(av).localeCompare(String(bv)) * sortDir
    })
  }, [layers, sortKey, sortDir])

  // Manual drag-and-drop reorder — only enabled in unsorted (manual-order)
  // view; see handleSort's comment for why.
  const manualOrder = sortKey === null
  const reorderLayer = useAbmDrawingsStore(s => s.reorderLayer)
  const [dragLayerId, setDragLayerId]       = useState(null)
  const [dragOverLayerId, setDragOverLayerId] = useState(null)

  const onGripDragStart = (e, id) => {
    setDragLayerId(id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onRowDragOver = (e, id) => {
    if (!dragLayerId || dragLayerId === id) return
    e.preventDefault()
    if (dragOverLayerId !== id) setDragOverLayerId(id)
  }
  const onRowDrop = (e, id) => {
    if (!dragLayerId || dragLayerId === id) return
    e.preventDefault()
    reorderLayer(theatre, dragLayerId, id)
    setDragLayerId(null)
    setDragOverLayerId(null)
  }
  const onGripDragEnd = () => { setDragLayerId(null); setDragOverLayerId(null) }

  const startRename = (layer) => { setEditingId(layer.id); setEditValue(layer.name) }
  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed) renameLayer(theatre, editingId, trimmed)
    setEditingId(null)
  }

  const setParam = (layer, key, value) => updateShapeParams(theatre, layer.id, { [key]: value })

  // params.startBrg/endBrg (.sect) are stored grid-frame (buildSectFeature
  // uses gridDestinationPoint — see utils/bearing.js); rotationDeg/radialDeg
  // (.rect/.race/.text) are stored real-true (their builders still use plain
  // destinationPoint — deliberately unconverted, see drawCommands.js). Either
  // way toMagneticFromTrue/toTrueFromMagnetic is the same declination-only
  // operation, since a controller reading/typing a heading here always means
  // MAGNETIC — same convention as the typed .sect/.race commands and the
  // on-map dimension readouts. Convert at this boundary only; the store
  // never holds a magnetic value.
  const magOf  = (trueDeg) => Math.round(((toMagneticFromTrue(trueDeg, declinationDeg) % 360) + 360) % 360)
  const trueOf = (magDeg)  => toTrueFromMagnetic(magDeg, declinationDeg)

  const [scale, setScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem(DR_SCALE_KEY))
    return isNaN(saved) ? 1.0 : Math.min(SCALE_MAX, Math.max(SCALE_MIN, saved))
  })
  const [scaleHint, setScaleHint] = useState(false)
  const scaleHintRef = useRef(null)

  useEffect(() => { onScaleChange?.(scale) }, [scale]) // eslint-disable-line

  const handleTitleWheel = (e) => {
    const dir = wheelDir(e)
    if (dir === null) return
    setScale((prev) => {
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, parseFloat((prev - dir * SCALE_STEP).toFixed(2))))
      localStorage.setItem(DR_SCALE_KEY, String(next))
      clearTimeout(scaleHintRef.current)
      setScaleHint(true)
      scaleHintRef.current = setTimeout(() => setScaleHint(false), 1200)
      return next
    })
  }

  const style = { zoom: scale, ...(docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }) }

  // Dropping a file anywhere on the panel skips straight to the import
  // modal's parse/preview step — same AbmDrawingImport flow the "Load
  // Drawing" button opens, just pre-fed with the dropped files instead of
  // making the user drop a second time inside the modal's own dropzone.
  const onDragOver  = e => { e.preventDefault(); if (theatre) setDragging(true) }
  const onDragLeave = e => { e.preventDefault(); setDragging(false) }
  const onDrop = e => {
    e.preventDefault(); setDragging(false)
    if (!theatre || !e.dataTransfer.files?.length) return
    setInitialFiles(e.dataTransfer.files)
    setImportOpen(true)
  }

  return (
    <div
      className={['dr', dragging ? 'dr-dragging' : ''].join(' ')}
      style={style}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {docked && <div className="dr-resize" onMouseDown={onResize} />}

      <div className="dr-title" onWheel={handleTitleWheel}>
        <span className="dr-title-text">Custom Drawings</span>
        {scaleHint && <span className="dr-title-scale-hint">{Math.round(scale * 100)}%</span>}
        <span className="dr-title-right">
          {docked  && onUndock && <button className="dr-btn" onClick={onUndock} title="Undock">⬡</button>}
          {!docked && onDock   && <button className="dr-btn" onClick={onDock}   title="Dock">⬡</button>}
          {docked  && onHide   && <button className="dr-btn" onClick={onHide}   title="Hide">›</button>}
        </span>
      </div>

      <div className="dr-body">
        {!theatre && (
          <div className="dr-empty">No theatre loaded.</div>
        )}
        {theatre && layers.length === 0 && (
          <div className="dr-empty">No drawings loaded for this theatre.<br />Load a .geojson file below.</div>
        )}
        {layers.length > 0 && (
          <div className="dr-row dr-row-header">
            <span className="dr-col-label" title={manualOrder ? 'Drag to reorder (draw order, back to front)' : 'Clear sort to drag-reorder'} />
            {SORT_COLUMNS.map(c => (
              c.key === 'visible' ? (
                <input
                  key={c.key}
                  type="checkbox"
                  checked={layers.some(l => l.visible)}
                  ref={el => { if (el) el.indeterminate = layers.some(l => l.visible) && layers.some(l => !l.visible) }}
                  onChange={() => toggleAll(theatre)}
                  title="Toggle all drawings visible/hidden (.custom)"
                />
              ) : (
                <span
                  key={c.key}
                  className="dr-col-label dr-col-sort"
                  onClick={() => handleSort(c.key)}
                  title={`Sort by ${c.key === 'label' ? 'always-show-label' : c.label}`}
                >
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
                </span>
              )
            ))}
            <span className="dr-col-label" title="Parameters / feature count">INFO</span>
          </div>
        )}
        {sortedLayers.map(layer => {
          const fields = SHAPE_FIELDS[layer.shapeType]
          const expanded = expandedId === layer.id
          return (
            <div key={layer.id} className="dr-row-group">
              <div
                className={['dr-row', dragOverLayerId === layer.id ? 'dr-row-dragover' : ''].join(' ')}
                onDragOver={e => onRowDragOver(e, layer.id)}
                onDrop={e => onRowDrop(e, layer.id)}
              >
                <span
                  className={['dr-grip', manualOrder ? '' : 'dr-grip-disabled'].join(' ')}
                  draggable={manualOrder}
                  onDragStart={e => onGripDragStart(e, layer.id)}
                  onDragEnd={onGripDragEnd}
                  title={manualOrder ? 'Drag to reorder (draw order, back to front)' : 'Clear sort to drag-reorder'}
                >⠿</span>
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={() => toggleVisible(theatre, layer.id)}
                />
                <ColorSwatch
                  layer={layer}
                  paletteStroke={paletteStroke}
                  onPick={color => setLayerColor(theatre, layer.id, color)}
                  onToggleOverride={enabled => setLayerColorOverride(theatre, layer.id, enabled)}
                />
                {editingId === layer.id ? (
                  <input
                    className="dr-name-input"
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <span className="dr-name" title={layer.name} onClick={() => startRename(layer)}>
                    {layer.name}
                  </span>
                )}
                <input
                  type="checkbox"
                  className="dr-label-override"
                  checked={layer.shapeType === 'text' ? true : !!layer.labelOverride}
                  onChange={() => toggleLabelOverride(theatre, layer.id)}
                  title={layer.shapeType === 'text'
                    ? 'Text labels always show, regardless of .labels'
                    : "Always show this drawing's label, regardless of .labels"}
                  disabled={layer.shapeType === 'text'}
                />
                {fields ? (
                  <button
                    className="dr-disclosure"
                    onClick={() => setExpandedId(id => id === layer.id ? null : layer.id)}
                    title="Edit parameters"
                  >{expanded ? '▾' : '▸'}</button>
                ) : (
                  <span className="dr-count">{layer.features.length}</span>
                )}
                <button
                  className="dr-row-delete"
                  onClick={() => removeLayer(theatre, layer.id)}
                  title="Remove drawing"
                >×</button>
              </div>
              {expanded && fields && (
                <div className="dr-params">
                  {fields.map(f => (
                    <label key={f.key} className="dr-param-row">
                      <span className="dr-param-label">{f.label}</span>
                      {f.type === 'select' ? (
                        <select
                          value={layer.params[f.key]}
                          onChange={e => setParam(layer, f.key, e.target.value)}
                        >
                          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : f.type === 'text' ? (
                        <input
                          type="text"
                          value={layer.params[f.key]}
                          onChange={e => setParam(layer, f.key, e.target.value)}
                        />
                      ) : f.type === 'deg' ? (
                        <NumberField
                          value={magOf(layer.params[f.key])}
                          deg
                          onCommit={v => setParam(layer, f.key, trueOf(v))}
                        />
                      ) : (
                        <NumberField
                          value={layer.params[f.key]}
                          onCommit={v => setParam(layer, f.key, v)}
                        />
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="dr-footer">
        {confirmingClear ? (
          <>
            <span className="dr-confirm-label">Clear ALL drawings?</span>
            <button
              className="dr-add-btn dr-confirm-btn"
              onClick={() => { clearTheatre(theatre); setConfirmingClear(false) }}
            >Confirm</button>
            <button className="dr-add-btn" onClick={() => setConfirmingClear(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="dr-add-btn" disabled={!theatre} onClick={() => setImportOpen(true)}>⬆ Load Drawing</button>
            {layers.length > 0 && (
              <button className="dr-add-btn" onClick={() => exportDrawingsZip(layers, theatre)}>⬇ Export</button>
            )}
            {layers.length > 0 && (
              <button className="dr-add-btn dr-clear-all-btn" onClick={() => setConfirmingClear(true)}>✕ Clear ALL</button>
            )}
          </>
        )}
      </div>

      {importOpen && (
        <AbmDrawingImport
          theatre={theatre}
          initialFiles={initialFiles}
          onClose={() => { setImportOpen(false); setInitialFiles(null) }}
        />
      )}
    </div>
  )
}
