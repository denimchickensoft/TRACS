import { useState, useRef, useCallback, useEffect } from 'react'
import { unzipSync } from 'fflate'
import { parseGeojson } from '../../utils/parseGeojson.js'
import { parseMiz } from '../../utils/parseMiz.js'
import { useAbmDrawingsStore } from '../../store/abmDrawings.js'
import './AbmMissionImport.css'

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target.result)
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsText(file)
  })
}

// A .zip (e.g. exportDrawings.js's bundle) expands into one entry per
// contained .geojson/.ndgeojson — each becomes its own pending row, same as
// if that many separate files had been dropped at once. Non-geometry
// entries inside the zip (stray files, folders) are silently skipped.
async function expandZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const entries = unzipSync(buf)
  const decoder = new TextDecoder()
  return Object.entries(entries)
    .filter(([entryName]) => /\.(nd)?(geo)?json$/i.test(entryName))
    .map(([entryName, data]) => ({ name: entryName, text: decoder.decode(data) }))
}

// A .miz is itself a zip whose "mission" entry is a Lua table, not GeoJSON
// — parseMiz.js reads its trigger-zone and native-Drawing geometry and
// returns one already-parsed {name, features} group per source (ZONES,
// plus one per ME Drawing layer that has content). Each group becomes its
// own pending row, same as a multi-entry .zip bundle.
async function expandMiz(file, theatre) {
  const buf = new Uint8Array(await file.arrayBuffer())
  const entries = unzipSync(buf)
  const missionEntry = entries['mission']
  if (!missionEntry) throw new Error('No "mission" file found inside .miz')
  const missionText = new TextDecoder().decode(missionEntry)
  const base = file.name.replace(/\.miz$/i, '')
  return parseMiz(missionText, theatre).map(g => ({ name: `${base} ${g.name}`, features: g.features }))
}

function geometrySummary(features) {
  const counts = {}
  for (const f of features) counts[f.geometry.type] = (counts[f.geometry.type] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([type, n]) => `${n} ${type}`).join(', ')
}

export function AbmDrawingImport({ theatre, onClose, initialFiles = null }) {
  const addLayer = useAbmDrawingsStore(s => s.addLayer)

  const [phase,   setPhase]   = useState('idle')   // idle | loading | preview
  const [pending, setPending] = useState([])        // [{id, name, features, error}]
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef()

  // Each file (or zip entry) is parsed independently so one bad one in a
  // multi-drop doesn't block the rest — failures show inline in their own
  // row instead of a single all-or-nothing error screen. A .zip expands
  // into one {name, text} per contained drawing before this same per-item
  // parse step runs, so a bundle and an equivalent multi-file drop end up
  // identical from here on.
  const processFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList ?? [])
    if (!files.length) return
    setPhase('loading')

    const items = []
    for (const file of files) {
      if (/\.miz$/i.test(file.name)) {
        try {
          items.push(...await expandMiz(file, theatre))
        } catch (e) {
          items.push({ name: file.name, error: e.message ?? 'Bad .miz file' })
        }
      } else if (/\.zip$/i.test(file.name)) {
        try {
          items.push(...await expandZip(file))
        } catch (e) {
          items.push({ name: file.name, text: null, error: e.message ?? 'Bad zip file' })
        }
      } else {
        items.push({ name: file.name, file })
      }
    }

    const results = await Promise.all(items.map(async (item) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const name = item.name.replace(/\.(nd)?(geo)?json$/i, '')
      if (item.error) return { id, name, features: null, error: item.error }
      if (item.features) return { id, name, features: item.features, error: null }
      try {
        const text = item.text ?? await readFileText(item.file)
        return { id, name, features: parseGeojson(text), error: null }
      } catch (e) {
        return { id, name, features: null, error: e.message ?? 'Unknown error' }
      }
    }))
    setPending(results)
    setPhase('preview')
  }, [theatre])

  // Dropped directly on the Drawings panel (Drawings.jsx) rather than
  // inside this modal's own dropzone — skip straight to parsing instead of
  // making the user drop a second time. Runs once; initialFiles is only
  // ever set at mount (Drawings.jsx opens a fresh modal per drop).
  useEffect(() => {
    if (initialFiles?.length) processFiles(initialFiles)
  }, []) // eslint-disable-line

  const onDragOver  = e => { e.preventDefault(); setDragging(true)  }
  const onDragLeave = e => { e.preventDefault(); setDragging(false) }
  const onDrop = e => {
    e.preventDefault(); setDragging(false)
    processFiles(e.dataTransfer.files)
  }
  const onFileChange = e => processFiles(e.target.files)

  const updateName = (id, name) => {
    setPending(rows => rows.map(r => r.id === id ? { ...r, name } : r))
  }
  const removeRow = (id) => {
    setPending(rows => rows.filter(r => r.id !== id))
  }

  // Explodes one multi-shape row (e.g. a .miz's "ZONES" or "COMMON" group)
  // into one row per feature, each keeping only its own geometry. Each
  // resulting row imports as its own single-feature layer, so
  // store/abmDrawings.js's addLayer seeds that layer's color from that one
  // shape's own `properties.stroke` — the only way to retain each shape's
  // individual DCS-authored color through a layer model whose colorOverride
  // is otherwise all-or-nothing per layer (see addLayer's own comment).
  // Opt-in and per-row rather than automatic, since a mission's zone table
  // can run into the hundreds (Foothold: 828) — splitting only blows up
  // the preview list for groups the controller actually wants split.
  const splitRow = (id) => {
    setPending(rows => {
      const idx = rows.findIndex(r => r.id === id)
      if (idx < 0) return rows
      const row = rows[idx]
      const split = row.features.map((f, i) => ({
        id:       `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`,
        name:     (f.label?.[0] ?? `${row.name} ${i + 1}`).slice(0, 40),
        features: [f],
        error:    null,
      }))
      return [...rows.slice(0, idx), ...split, ...rows.slice(idx + 1)]
    })
  }

  const importable = pending.filter(r => !r.error)

  const doImport = () => {
    for (const row of importable) {
      addLayer(theatre, row.name.trim() || 'Untitled', row.features)
    }
    onClose()
  }

  return (
    <div className="mi-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mi-modal">
        <div className="mi-header">
          <span className="mi-title">LOAD DRAWING</span>
          <button className="mi-close" onClick={onClose}>×</button>
        </div>

        {phase === 'idle' && (
          <div
            className={['mi-dropzone', dragging ? 'dragging' : ''].join(' ')}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <span className="mi-drop-icon">⬆</span>
            <span className="mi-drop-label">Drop .geojson/.json/.ndgeojson, a .zip bundle, or a .miz mission</span>
            <span className="mi-drop-sub">or click to browse — multiple files supported</span>
            <input
              ref={fileRef}
              type="file"
              accept=".geojson,.json,.ndgeojson,.ndjson,.zip,.miz,*"
              multiple
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
        )}

        {phase === 'loading' && (
          <div className="mi-status">Parsing…</div>
        )}

        {phase === 'preview' && (
          <div className="mi-preview">
            <div className="mi-section-label" style={{ padding: '6px 8px 0' }}>
              {pending.length} file{pending.length === 1 ? '' : 's'} — {importable.length} ready
            </div>
            <div className="mi-drawing-list">
              {pending.map(row => (
                <div key={row.id} className="mi-drawing-row">
                  <input
                    className="mi-drawing-name"
                    value={row.name}
                    onChange={e => updateName(row.id, e.target.value)}
                    disabled={!!row.error}
                    maxLength={40}
                  />
                  <span className={['mi-drawing-summary', row.error ? 'error' : ''].join(' ')}>
                    {row.error ?? geometrySummary(row.features)}
                  </span>
                  {!row.error && row.features.length > 1 && (
                    <button
                      className="mi-drawing-split"
                      onClick={() => splitRow(row.id)}
                      title="Split into one layer per shape, keeping each shape's own DCS color"
                    >
                      Split ({row.features.length})
                    </button>
                  )}
                  {(row.error || row.features.length <= 1) && <span />}
                  <button className="mi-drawing-remove" onClick={() => removeRow(row.id)} title="Remove">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mi-footer">
          <button className="mi-btn" onClick={onClose}>Cancel</button>
          {phase === 'preview' && (
            <button className="mi-btn mi-btn-primary" disabled={importable.length === 0} onClick={doImport}>
              Import{importable.length > 0 ? ` (${importable.length})` : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
