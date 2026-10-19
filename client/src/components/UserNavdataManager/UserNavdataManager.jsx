import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useUserNavdataStore } from '../../store/userNavdata.js'
import { readImportFiles, finalizeRow, outsideShare } from '../../utils/userNavdataImport.js'
import { normalizeFixId } from '../../utils/userFixes.js'
import { rowsFromCandidates, makeFixLookup, makeNearestFix } from '../../utils/userProcedures.js'
import { getTheatreAirports } from '../../utils/theatreAirports.js'
import { ProceduresTab } from './UserNavdataProcedures.jsx'
import './UserNavdataManager.css'

// Fixes table rows rendered at once; the filter narrows anything beyond it.
const FIX_ROW_LIMIT = 500

const EMPTY = { fixes: [], maps: [], procs: [] }

function geometrySummary(features) {
  const counts = {}
  for (const f of features) counts[f.geometry.type] = (counts[f.geometry.type] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(', ')
}

function rowSummary(row) {
  const { fixes, features } = finalizeRow(row)
  const parts = []
  if (fixes.length) parts.push(`${fixes.length} fix${fixes.length === 1 ? '' : 'es'}`)
  if (features.length) parts.push(geometrySummary(features))
  return parts.join(' · ') || 'nothing to import'
}

const fmtCoord = (v) => Number(v).toFixed(5)

// ── Import tab ──────────────────────────────────────────────────────────────

function ImportTab({ theatre, bbox, maps, onDone, onProcRows }) {
  const upsertFixes = useUserNavdataStore((s) => s.upsertFixes)
  const addMap      = useUserNavdataStore((s) => s.addMap)
  const updateMap   = useUserNavdataStore((s) => s.updateMap)

  const [phase, setPhase]       = useState('idle')   // idle | loading | preview
  const [rows, setRows]         = useState([])
  const [skipped, setSkipped]   = useState([])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy]         = useState(false)
  const fileRef = useRef()

  const mapByName = useMemo(() => new Map(maps.map((m) => [m.name.toUpperCase(), m])), [maps])

  const processFiles = useCallback(async (fileList) => {
    if (!fileList?.length) return
    setPhase('loading')
    const result = await readImportFiles(fileList, theatre)
    // Procedure files go to the PROCEDURES tab's import list.
    const procFiles = result.rows.filter((r) => r.procs)
    const rest = result.rows.filter((r) => !r.procs)
    if (procFiles.length) onProcRows(procFiles.flatMap((r) => rowsFromCandidates(r.fileName, r.procs)))
    if (procFiles.length && !rest.length && !result.skipped.length) { setPhase('idle'); return }
    setRows(rest.map((r) => ({ ...r, importFixes: true, importMap: true, replace: true })))
    setSkipped(result.skipped)
    setPhase('preview')
  }, [theatre, onProcRows])

  const patchRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const removeRow = (key) => setRows((rs) => rs.filter((r) => r.key !== key))

  const plan = rows.filter((r) => !r.error).map((r) => {
    const { fixes, features } = finalizeRow(r)
    return {
      row: r,
      fixes:    r.importFixes ? fixes : [],
      features: r.importMap ? features : [],
    }
  }).filter((p) => p.fixes.length || p.features.length)

  // Select all / Deselect all over the fixes + video map boxes each
  // non-error row actually shows.
  const tickable = rows.filter((r) => !r.error).map((r) => {
    const { fixes, features } = finalizeRow(r)
    return { row: r, hasFixes: fixes.length > 0, hasMap: features.length > 0 }
  }).filter((t) => t.hasFixes || t.hasMap)
  const allSelected = tickable.length > 0 &&
    tickable.every((t) => (!t.hasFixes || t.row.importFixes) && (!t.hasMap || t.row.importMap))
  const setAll = (on) => setRows((rs) => rs.map((r) => (r.error ? r : { ...r, importFixes: on, importMap: on })))

  const doImport = async () => {
    setBusy(true)
    const errors = []
    const allFixes = plan.flatMap((p) => p.fixes.map((f) => ({ ...f, source: p.row.name })))
    let fixCount = 0
    let mapCount = 0
    if (allFixes.length) {
      const err = await upsertFixes(theatre, allFixes)
      if (err) errors.push(err)
      else fixCount = allFixes.length
    }
    for (const p of plan) {
      if (!p.features.length) continue
      const name     = p.row.name.trim() || 'Untitled'
      const existing = mapByName.get(name.toUpperCase())
      const err = existing && p.row.replace
        ? await updateMap(theatre, existing.id, { features: p.features, source: p.row.fileName })
        : await addMap(theatre, { name, features: p.features, source: p.row.fileName })
      if (err) errors.push(err)
      else mapCount++
    }
    setBusy(false)
    onDone(errors.length
      ? { error: errors[0] }
      : { message: `Imported ${fixCount} fix${fixCount === 1 ? '' : 'es'} and ${mapCount} map${mapCount === 1 ? '' : 's'} into ${theatre}`, mapCount })
    setRows([])
    setSkipped([])
    setPhase('idle')
  }

  if (phase === 'idle') {
    return (
      <div
        className={`unm-dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false) }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files) }}
        onClick={() => fileRef.current?.click()}
      >
        <span className="unm-drop-icon">⬆</span>
        <span className="unm-drop-label">Drop LotATC .json, GeoJSON, KML/KMZ, .csv fixes, a .miz, procedure .json, or a .zip of any of these</span>
        <span className="unm-drop-sub">or click to browse - imports into {theatre || '(no theatre selected)'}</span>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.geojson,.ndgeojson,.kml,.kmz,.csv,.miz,.zip,*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { processFiles(e.target.files); e.target.value = '' }}
        />
      </div>
    )
  }

  if (phase === 'loading') return <div className="unm-status">Parsing…</div>

  return (
    <div className="unm-body">
      <div className="unm-toolbar">
        <span className="unm-muted">{rows.length} item{rows.length === 1 ? '' : 's'} - {plan.length} to import</span>
        <span className="unm-spacer" />
        <button className="unm-btn" disabled={!tickable.length} onClick={() => setAll(!allSelected)}>
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <button className="unm-btn" onClick={() => { setRows([]); setSkipped([]); setPhase('idle') }}>Start over</button>
      </div>
      <div className="unm-list">
        {rows.map((row) => {
          const share = row.error ? null : outsideShare(finalizeRow(row), bbox)
          const sameName = !row.error && mapByName.get(row.name.trim().toUpperCase())
          return (
            <div key={row.key} className="unm-import-row">
              <div className="unm-import-main">
                <input
                  className="unm-input unm-grow"
                  value={row.name}
                  onChange={(e) => patchRow(row.key, { name: e.target.value })}
                  disabled={!!row.error}
                  maxLength={60}
                  title={row.fileName}
                />
                <button className="unm-x" onClick={() => removeRow(row.key)} title="Remove">×</button>
              </div>
              <div className={`unm-import-sub${row.error ? ' error' : ''}`}>
                {row.error ? `${row.fileName}: ${row.error}` : rowSummary(row)}
              </div>
              {!row.error && (
                <div className="unm-import-opts">
                  {finalizeRow(row).fixes.length > 0 && (
                    <label><input type="checkbox" checked={row.importFixes} onChange={(e) => patchRow(row.key, { importFixes: e.target.checked })} /> fixes</label>
                  )}
                  {finalizeRow(row).features.length > 0 && (
                    <label><input type="checkbox" checked={row.importMap} onChange={(e) => patchRow(row.key, { importMap: e.target.checked })} /> video map</label>
                  )}
                  {row.pointCandidates > 0 && (
                    <label title="Named points become fixes instead of map labels">
                      <input type="checkbox" checked={row.pointsAsFixes} onChange={(e) => patchRow(row.key, { pointsAsFixes: e.target.checked })} /> points as fixes ({row.pointCandidates})
                    </label>
                  )}
                  {row.closedLineCandidates > 0 && row.importMap && (
                    <label title="Lines that end where they start become polygons, so they can be filled">
                      <input type="checkbox" checked={row.closedLinesAsPolygons} onChange={(e) => patchRow(row.key, { closedLinesAsPolygons: e.target.checked })} /> closed lines as polygons ({row.closedLineCandidates})
                    </label>
                  )}
                  {sameName && row.importMap && finalizeRow(row).features.length > 0 && (
                    <select className="unm-select" value={row.replace ? 'replace' : 'new'} onChange={(e) => patchRow(row.key, { replace: e.target.value === 'replace' })}>
                      <option value="replace">replace existing map</option>
                      <option value="new">add as new map</option>
                    </select>
                  )}
                  {share != null && share > 0.5 && (
                    <span className="unm-warn">mostly outside {theatre}</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {skipped.length > 0 && (
          <div className="unm-skipped" title={skipped.join('\n')}>
            Skipped {skipped.length} unsupported file{skipped.length === 1 ? '' : 's'}: {skipped.map((n) => n.split('/').pop()).join(', ')}
          </div>
        )}
      </div>
      <div className="unm-footer">
        <button className="unm-btn unm-btn-primary" disabled={!plan.length || busy || !theatre} onClick={doImport}>
          {busy ? 'Importing…' : `Import${plan.length ? ` (${plan.length})` : ''}`}
        </button>
      </div>
    </div>
  )
}

// ── Fixes tab ───────────────────────────────────────────────────────────────

function FixRow({ fix, selected, onSelect, overrides, onSave, onDelete }) {
  const [editing, setEditing] = useState(null)   // { id, lat, lon } while editing

  if (editing) {
    const save = async () => {
      const err = await onSave(fix.id, { id: editing.id, lat: Number(editing.lat), lon: Number(editing.lon) })
      if (!err) setEditing(null)
    }
    return (
      <div className="unm-fix-row editing">
        <span />
        <input className="unm-input" value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
        <input className="unm-input" value={editing.lat} onChange={(e) => setEditing({ ...editing, lat: e.target.value })} />
        <input className="unm-input" value={editing.lon} onChange={(e) => setEditing({ ...editing, lon: e.target.value })} />
        <span className="unm-row-actions">
          <button className="unm-link" onClick={save}>save</button>
          <button className="unm-link" onClick={() => setEditing(null)}>cancel</button>
        </span>
      </div>
    )
  }

  return (
    <div className="unm-fix-row">
      <input type="checkbox" checked={selected} onChange={(e) => onSelect(fix.id, e.target.checked)} />
      <span className="unm-fix-id" title={overrides ? 'Overrides a navdata fix with the same ID' : undefined}>
        {fix.id}{overrides && <span className="unm-override"> *</span>}
      </span>
      <span>{fmtCoord(fix.lat)}</span>
      <span>{fmtCoord(fix.lon)}</span>
      <span className="unm-row-actions">
        <span className="unm-muted unm-source" title={fix.source ?? ''}>{fix.source ?? ''}</span>
        <button className="unm-link" onClick={() => setEditing({ id: fix.id, lat: String(fix.lat), lon: String(fix.lon) })}>edit</button>
        <button className="unm-x" onClick={() => onDelete([fix.id])} title="Delete">×</button>
      </span>
    </div>
  )
}

function FixesTab({ theatre, fixes, baseFixIds, onStatus }) {
  const upsertFixes = useUserNavdataStore((s) => s.upsertFixes)
  const updateFix   = useUserNavdataStore((s) => s.updateFix)
  const removeFixes = useUserNavdataStore((s) => s.removeFixes)

  const [filter, setFilter]     = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [draft, setDraft]       = useState({ id: '', lat: '', lon: '' })
  const [confirm, setConfirm]   = useState(null)   // { label, ids }

  useEffect(() => { setSelected(new Set()); setConfirm(null) }, [theatre])

  const q = filter.trim().toUpperCase()
  const shown = q ? fixes.filter((f) => f.id.includes(q) || (f.source ?? '').toUpperCase().includes(q)) : fixes
  const sources = useMemo(() => [...new Set(fixes.map((f) => f.source).filter(Boolean))].sort(), [fixes])

  const report = (err, ok) => onStatus(err ? { error: err } : { message: ok })

  // Enter in any add field submits, once all three are filled in.
  const onAddKey = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (draft.id.trim() && draft.lat.trim() && draft.lon.trim()) add()
  }

  const add = async () => {
    const id = normalizeFixId(draft.id)
    if (!id || draft.lat === '' || draft.lon === '') return onStatus({ error: 'ID, latitude and longitude are required' })
    const lat = Number(draft.lat)
    const lon = Number(draft.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return onStatus({ error: 'Latitude/longitude must be decimal degrees' })
    }
    const err = await upsertFixes(theatre, [{ id, lat, lon, source: 'manual' }])
    report(err, `Saved fix ${id}`)
    if (!err) setDraft({ id: '', lat: '', lon: '' })
  }

  const save = async (oldId, patch) => {
    const err = await updateFix(theatre, oldId, patch)
    report(err, `Saved fix ${normalizeFixId(patch.id)}`)
    return err
  }

  const del = async (ids) => {
    const err = await removeFixes(theatre, ids)
    report(err, `Deleted ${ids.length} fix${ids.length === 1 ? '' : 'es'}`)
    if (!err) setSelected((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n })
    setConfirm(null)
  }

  const toggle = (id, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const allShownSelected = shown.length > 0 && shown.every((f) => selected.has(f.id))

  return (
    <div className="unm-body">
      <div className="unm-toolbar">
        <input className="unm-input" placeholder="filter ID or source" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="unm-spacer" />
        <select
          className="unm-select"
          value=""
          disabled={!sources.length}
          onChange={(e) => {
            const src = e.target.value
            if (src) setConfirm({ label: `Delete all fixes from ${src}?`, ids: fixes.filter((f) => f.source === src).map((f) => f.id) })
          }}
        >
          <option value="">delete by source…</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="unm-btn" disabled={!selected.size} onClick={() => setConfirm({ label: `Delete ${selected.size} selected fix${selected.size === 1 ? '' : 'es'}?`, ids: [...selected] })}>
          Delete selected
        </button>
        <button className="unm-btn unm-btn-danger" disabled={!fixes.length} onClick={() => setConfirm({ label: `Delete ALL ${fixes.length} fixes in ${theatre}?`, ids: fixes.map((f) => f.id) })}>
          Delete all
        </button>
      </div>

      {confirm && (
        <div className="unm-confirm">
          <span>{confirm.label}</span>
          <button className="unm-btn unm-btn-danger" onClick={() => del(confirm.ids)}>Confirm</button>
          <button className="unm-btn" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}

      <div className="unm-fix-row unm-fix-head">
        <input type="checkbox" checked={allShownSelected} onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((f) => f.id)) : new Set())} title="Select all shown" />
        <span>ID</span><span>LAT</span><span>LON</span><span>SOURCE</span>
      </div>
      <div className="unm-fix-row unm-fix-add">
        <span />
        <input className="unm-input" placeholder="ID" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} onKeyDown={onAddKey} />
        <input className="unm-input" placeholder="lat (36.7123)" value={draft.lat} onChange={(e) => setDraft({ ...draft, lat: e.target.value })} onKeyDown={onAddKey} />
        <input className="unm-input" placeholder="lon (-115.1048)" value={draft.lon} onChange={(e) => setDraft({ ...draft, lon: e.target.value })} onKeyDown={onAddKey} />
        <span className="unm-row-actions"><button className="unm-btn" onClick={add}>Add</button></span>
      </div>
      <div className="unm-list">
        {shown.slice(0, FIX_ROW_LIMIT).map((fix) => (
          <FixRow
            key={fix.id}
            fix={fix}
            selected={selected.has(fix.id)}
            onSelect={toggle}
            overrides={baseFixIds.has(fix.id)}
            onSave={save}
            onDelete={(ids) => setConfirm({ label: `Delete fix ${ids[0]}?`, ids })}
          />
        ))}
        {!fixes.length && <div className="unm-empty">No user fixes in {theatre}</div>}
        {shown.length > FIX_ROW_LIMIT && (
          <div className="unm-empty">Showing {FIX_ROW_LIMIT} of {shown.length} - use the filter to narrow</div>
        )}
      </div>
      <div className="unm-footnote">* overrides a navdata fix with the same ID</div>
    </div>
  )
}

// ── Video maps tab ──────────────────────────────────────────────────────────

function MapRow({ map, selected, onSelect, onPatch, onReplace, onDelete }) {
  const [name, setName]   = useState(map.name)
  const [label, setLabel] = useState(map.label ?? '')
  const fileRef = useRef()

  useEffect(() => { setName(map.name) }, [map.name])
  useEffect(() => { setLabel(map.label ?? '') }, [map.label])

  return (
    <div className="unm-map-row">
      <input type="checkbox" checked={selected} onChange={(e) => onSelect(map.id, e.target.checked)} />
      <input
        className="unm-input"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { const v = name.trim(); if (v && v !== map.name) onPatch(map.id, { name: v }); else setName(map.name) }}
        title={map.source ?? ''}
      />
      <input
        className="unm-input"
        value={label}
        maxLength={16}
        onChange={(e) => setLabel(e.target.value.toUpperCase())}
        onBlur={() => { const v = label.trim(); if (v && v !== map.label) onPatch(map.id, { label: v }); else setLabel(map.label ?? '') }}
        title="DCB button text"
      />
      <select className="unm-select" value={map.group ?? 'A'} onChange={(e) => onPatch(map.id, { group: e.target.value })} title="Brightness: MAP A or MAP B">
        <option value="A">A</option>
        <option value="B">B</option>
      </select>
      <span className="unm-muted">{map.features.length}</span>
      <span className="unm-row-actions">
        <button className="unm-link" onClick={() => fileRef.current?.click()} title="Re-import this map's geometry from a file">replace</button>
        <button className="unm-x" onClick={() => onDelete([map.id])} title="Delete">×</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.geojson,.ndgeojson,.kml,.kmz,.miz,.zip,*"
          style={{ display: 'none' }}
          onChange={(e) => { onReplace(map, e.target.files); e.target.value = '' }}
        />
      </span>
    </div>
  )
}

function MapsTab({ theatre, maps, onStatus }) {
  const updateMap  = useUserNavdataStore((s) => s.updateMap)
  const removeMaps = useUserNavdataStore((s) => s.removeMaps)

  const [selected, setSelected] = useState(() => new Set())
  const [confirm, setConfirm]   = useState(null)   // { label, ids }

  useEffect(() => { setSelected(new Set()); setConfirm(null) }, [theatre])

  const patch = async (id, p) => {
    const err = await updateMap(theatre, id, p)
    onStatus(err ? { error: err } : { message: 'Saved' })
  }

  // Takes every map feature from the chosen file(s) — fixes in it are ignored.
  const replace = async (map, fileList) => {
    if (!fileList?.length) return
    const { rows } = await readImportFiles(fileList, theatre)
    const features = rows.filter((r) => !r.error).flatMap((r) => finalizeRow({ ...r, pointsAsFixes: false }).features)
    if (!features.length) return onStatus({ error: rows.find((r) => r.error)?.error ?? 'No map geometry in that file' })
    const err = await updateMap(theatre, map.id, { features, source: fileList[0].name })
    onStatus(err ? { error: err } : { message: `Replaced ${map.name} (${features.length} features)` })
  }

  const del = async (ids) => {
    const err = await removeMaps(theatre, ids)
    onStatus(err ? { error: err } : { message: `Deleted ${ids.length} map${ids.length === 1 ? '' : 's'}` })
    if (!err) setSelected((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n })
    setConfirm(null)
  }

  const toggle = (id, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })

  return (
    <div className="unm-body">
      <div className="unm-toolbar">
        <span className="unm-muted">Maps appear as buttons in the STARS DCB MAPS menu</span>
        <span className="unm-spacer" />
        <button className="unm-btn" disabled={!selected.size} onClick={() => setConfirm({ label: `Delete ${selected.size} selected map${selected.size === 1 ? '' : 's'}?`, ids: [...selected] })}>
          Delete selected
        </button>
      </div>

      {confirm && (
        <div className="unm-confirm">
          <span>{confirm.label}</span>
          <button className="unm-btn unm-btn-danger" onClick={() => del(confirm.ids)}>Confirm</button>
          <button className="unm-btn" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      )}

      <div className="unm-map-row unm-fix-head">
        <input
          type="checkbox"
          checked={maps.length > 0 && maps.every((m) => selected.has(m.id))}
          onChange={(e) => setSelected(e.target.checked ? new Set(maps.map((m) => m.id)) : new Set())}
          title="Select all"
        />
        <span>NAME</span><span>DCB LABEL</span><span>BRT</span><span>SHAPES</span><span />
      </div>
      <div className="unm-list">
        {maps.map((m) => (
          <MapRow
            key={m.id}
            map={m}
            selected={selected.has(m.id)}
            onSelect={toggle}
            onPatch={patch}
            onReplace={replace}
            onDelete={(ids) => setConfirm({ label: `Delete map ${m.name}?`, ids })}
          />
        ))}
        {!maps.length && <div className="unm-empty">No user video maps in {theatre}</div>}
      </div>
    </div>
  )
}

// ── Dialog ──────────────────────────────────────────────────────────────────

export function UserNavdataManager({ theatre: activeTheatre, onClose }) {
  const ensureTheatre = useUserNavdataStore((s) => s.ensureTheatre)

  const [theatres, setTheatres] = useState(activeTheatre ? [activeTheatre] : [])
  const [bboxes, setBboxes]     = useState({})
  const [theatre, setTheatre]   = useState(activeTheatre ?? null)
  const [tab, setTab]           = useState('import')
  const [status, setStatus]     = useState(null)   // { message } | { error }
  const [baseFixes, setBaseFixes] = useState([])
  const [navaids, setNavaids]   = useState([])
  const [airports, setAirports] = useState([])
  const [pendingProcRows, setPendingProcRows] = useState(null)

  const data = useUserNavdataStore((s) => (theatre ? s.byTheatre[theatre] : null)) ?? EMPTY
  const procs = data.procs ?? EMPTY.procs

  const baseFixIds = useMemo(() => new Set(baseFixes.map((f) => normalizeFixId(f.id))), [baseFixes])
  // User fixes first, so they win over navdata as they do on the scope.
  const lookupFix  = useMemo(() => makeFixLookup([data.fixes, baseFixes, navaids]), [data.fixes, baseFixes, navaids])
  const nearestFix = useMemo(() => makeNearestFix([data.fixes, baseFixes, navaids]), [data.fixes, baseFixes, navaids])

  useEffect(() => {
    const ac = new AbortController()
    fetch('/api/navdata/theatres', { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        const list = d.theatres ?? []
        setTheatres(activeTheatre && !list.includes(activeTheatre) ? [activeTheatre, ...list] : list)
        setBboxes(d.bboxes ?? {})
        setTheatre((t) => t ?? list[0] ?? null)
      })
      .catch(() => {})
    return () => ac.abort()
  }, [activeTheatre])

  useEffect(() => {
    if (!theatre) return
    ensureTheatre(theatre).catch((err) => setStatus({ error: err?.message ?? String(err) }))
    const ac = new AbortController()
    const q = `theatre=${encodeURIComponent(theatre)}`
    setBaseFixes([])
    setNavaids([])
    setAirports([])
    fetch(`/api/navdata/fixes?${q}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setBaseFixes)
      .catch(() => {})
    fetch(`/api/navdata/navaids?${q}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setNavaids)
      .catch(() => {})
    getTheatreAirports(theatre).then((list) => { if (!ac.signal.aborted) setAirports(list) })
    return () => ac.abort()
  }, [theatre, ensureTheatre])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onImported = (result) => {
    setStatus(result)
    if (!result.error) setTab(result.mapCount ? 'maps' : 'fixes')
  }

  const onProcRows = useCallback((rows) => {
    setPendingProcRows(rows)
    setTab('procs')
  }, [])
  const onPendingTaken = useCallback(() => setPendingProcRows(null), [])

  return (
    <div className="unm-overlay">
      <div className="unm-modal" role="dialog" aria-modal="true">
        <div className="unm-header">
          <span className="unm-title">USER NAVDATA</span>
          <select className="unm-select" value={theatre ?? ''} onChange={(e) => { setTheatre(e.target.value); setStatus(null) }}>
            {theatres.map((t) => <option key={t} value={t}>{t}{t === activeTheatre ? ' (current)' : ''}</option>)}
          </select>
          <span className="unm-spacer" />
          <button className="unm-close" onClick={onClose}>×</button>
        </div>

        <div className="unm-tabs">
          {[
            ['import', 'IMPORT'],
            ['fixes', `FIXES (${data.fixes.length})`],
            ['maps', `VIDEO MAPS (${data.maps.length})`],
            ['procs', `PROCEDURES (${procs.length})`],
          ].map(([key, label]) => (
            <button key={key} className={`unm-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</button>
          ))}
        </div>

        {!theatre && <div className="unm-status">No theatre available</div>}
        {theatre && tab === 'import' && (
          <ImportTab theatre={theatre} bbox={bboxes[theatre] ?? null} maps={data.maps} onDone={onImported} onProcRows={onProcRows} />
        )}
        {theatre && tab === 'fixes' && (
          <FixesTab theatre={theatre} fixes={data.fixes} baseFixIds={baseFixIds} onStatus={setStatus} />
        )}
        {theatre && tab === 'maps' && (
          <MapsTab theatre={theatre} maps={data.maps} onStatus={setStatus} />
        )}
        {theatre && tab === 'procs' && (
          <ProceduresTab
            theatre={theatre}
            procs={procs}
            airports={airports}
            lookupFix={lookupFix}
            nearestFix={nearestFix}
            pendingRows={pendingProcRows}
            onPendingTaken={onPendingTaken}
            onStatus={setStatus}
          />
        )}

        {status && (
          <div className={`unm-statusline${status.error ? ' error' : ''}`}>{status.error ?? status.message}</div>
        )}
      </div>
    </div>
  )
}
