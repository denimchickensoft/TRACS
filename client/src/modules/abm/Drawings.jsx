import { useState } from 'react'
import { useSessionStore } from '../../store/session.js'
import { useAbmDrawingsStore } from '../../store/abmDrawings.js'
import { AbmDrawingImport } from './AbmDrawingImport.jsx'
import './Drawings.css'

export function Drawings({ docked = true, width, onResize, onUndock, onDock, onHide }) {
  const mission = useSessionStore(s => s.mission)
  const theatre = mission?.mission?.theatre ?? null

  const layers        = useAbmDrawingsStore(s => (theatre ? s.byTheatre[theatre] ?? [] : []))
  const toggleVisible = useAbmDrawingsStore(s => s.toggleVisible)
  const removeLayer   = useAbmDrawingsStore(s => s.removeLayer)

  const [importOpen, setImportOpen] = useState(false)
  const [initialFiles, setInitialFiles] = useState(null)
  const [dragging, setDragging] = useState(false)

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
        {layers.map(layer => (
          <div key={layer.id} className="dr-row">
            <input
              type="checkbox"
              checked={layer.visible}
              onChange={() => toggleVisible(theatre, layer.id)}
            />
            <span className="dr-swatch" style={{ background: layer.color }} />
            <span className="dr-name" title={layer.name}>{layer.name}</span>
            <span className="dr-count">{layer.features.length}</span>
            <button
              className="dr-row-delete"
              onClick={() => removeLayer(theatre, layer.id)}
              title="Remove drawing"
            >×</button>
          </div>
        ))}
      </div>

      <div className="dr-footer">
        <button className="dr-add-btn" disabled={!theatre} onClick={() => setImportOpen(true)}>⬆ Load Drawing</button>
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
