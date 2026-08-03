import { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../../store/session.js'
import { useAbmDrawingsStore } from '../../store/abmDrawings.js'
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

export function Drawings({ docked = true, width, onResize, onUndock, onDock, onHide }) {
  const mission = useSessionStore(s => s.mission)
  const theatre = mission?.mission?.theatre ?? null
  const declinationDeg = useAbmDeclination()

  const layers              = useAbmDrawingsStore(s => (theatre ? s.byTheatre[theatre] ?? [] : []))
  const toggleVisible       = useAbmDrawingsStore(s => s.toggleVisible)
  const toggleLabelOverride = useAbmDrawingsStore(s => s.toggleLabelOverride)
  const setLayerColor       = useAbmDrawingsStore(s => s.setLayerColor)
  const removeLayer       = useAbmDrawingsStore(s => s.removeLayer)
  const renameLayer       = useAbmDrawingsStore(s => s.renameLayer)
  const updateShapeParams = useAbmDrawingsStore(s => s.updateShapeParams)
  const clearTheatre      = useAbmDrawingsStore(s => s.clearTheatre)

  const [importOpen, setImportOpen] = useState(false)
  const [initialFiles, setInitialFiles] = useState(null)
  const [dragging, setDragging] = useState(false)

  const [editingId, setEditingId] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const startRename = (layer) => { setEditingId(layer.id); setEditValue(layer.name) }
  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed) renameLayer(theatre, editingId, trimmed)
    setEditingId(null)
  }

  const setParam = (layer, key, value) => updateShapeParams(theatre, layer.id, { [key]: value })

  // params.*Brg/rotationDeg/radialDeg are stored as TRUE (drawShapes.js's
  // builders work entirely in true bearings, same as everywhere else in the
  // app) — but a controller reading/typing a heading here means MAGNETIC,
  // same convention as the typed .sect/.race commands and the on-map
  // dimension readouts. Convert at this boundary only; the store never
  // holds a magnetic value.
  const magOf  = (trueDeg) => Math.round(((toMagneticFromTrue(trueDeg, declinationDeg) % 360) + 360) % 360)
  const trueOf = (magDeg)  => toTrueFromMagnetic(magDeg, declinationDeg)

  const style = docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }

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

      <div className="dr-title">
        <span className="dr-title-text">Custom Drawings</span>
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
        {layers.map(layer => {
          const fields = SHAPE_FIELDS[layer.shapeType]
          const expanded = expandedId === layer.id
          return (
            <div key={layer.id} className="dr-row-group">
              <div className="dr-row">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={() => toggleVisible(theatre, layer.id)}
                />
                <input
                  type="color"
                  className="dr-swatch"
                  // null (the default until the user actually picks one, see
                  // store/abmDrawings.js) needs a placeholder here — a
                  // controlled color input can't take null — but the layer
                  // itself still renders from the airspace CUSTOM palette
                  // until this control is touched.
                  value={layer.color ?? '#dddddd'}
                  onChange={e => setLayerColor(theatre, layer.id, e.target.value)}
                  title="Drawing color (overrides the airspace CUSTOM default)"
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
