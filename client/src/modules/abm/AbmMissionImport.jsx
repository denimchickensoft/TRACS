import { useState, useRef, useCallback } from 'react'
import { findAtoFlights } from '../../utils/parseMission.js'
import { readMissionFile } from '../../utils/missionFile.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { preloadOrdnanceDb } from '../../utils/ordnance.js'
import { parseIffCsv } from '../../utils/csvIffAssignments.js'
import './AbmMissionImport.css'

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target.result)
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsText(file)
  })
}

function taskCounts(flights) {
  const counts = {}
  for (const f of flights) counts[f.task || '—'] = (counts[f.task || '—'] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

export function AbmMissionImport({ onClose }) {
  const setFlights = useAbmMissionStore(s => s.setFlights)
  const sessionCoalition = useSessionStore(s => s.coalition)

  const [phase,    setPhase]    = useState('idle')   // idle | loading | preview | csv-preview | csv-done | error
  const [error,    setError]    = useState('')
  const [flights, setLocalFlights] = useState([])
  const [csvRows,  setCsvRows]  = useState([])
  const [csvResult, setCsvResult] = useState(null)
  const [notes,    setNotes]    = useState([])       // per-file errors/warnings shown in the preview
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef()

  // Blue/red sessions must never even preview the other side's tasking —
  // that would spoil surprises the mission intended to keep hidden from
  // them. Filter right at import, before anything is shown. GM/admin
  // aren't aligned to a side, so they see everything (same rule as ATO/FRAG).
  //
  // A .csv here is a bulk IFF-code assignment sheet, not a mission file — it goes through
  // this same Load Mission modal rather than a separate FRAG-panel importer
  // because ATO/FRAG already share one dataset (useAbmMissionStore().flights);
  // there's no second place for a CSV import to "trickle down" into.
  //
  // Several files can be dropped at once: at most one .miz (or bare mission
  // file), which replaces the previously loaded mission's flights, plus any
  // number of static templates (.stm), which stack on top -- see the store's
  // mergeTemplateFlights.
  const processFiles = useCallback(async (fileList) => {
    const files = [...fileList]
    if (!files.length) return
    setPhase('loading')
    try {
      const csv = files.filter(f => f.name.toLowerCase().endsWith('.csv'))
      if (csv.length) {
        if (files.length > 1) throw new Error('Load an IFF .csv on its own, not together with other files.')
        const text = await readFileText(csv[0])
        const rows = parseIffCsv(text)
        setCsvRows(rows)
        setPhase('csv-preview')
        return
      }

      const found = []
      const fileNotes = []
      let missionFile = null
      for (const file of files) {
        try {
          const { kind, mission } = await readMissionFile(file)
          const template = kind === 'stm'
          if (!template) {
            if (missionFile) throw new Error(`only one mission per load (already loading ${missionFile})`)
            missionFile = file.name
          }
          let fileFlights = findAtoFlights(mission, { template })
          if (sessionCoalition === 'blue' || sessionCoalition === 'red') {
            fileFlights = fileFlights.filter(f => f.coalition === sessionCoalition)
          }
          if (fileFlights.length === 0) fileNotes.push(`${file.name}: no flights`)
          for (const f of fileFlights) {
            const dupe = found.findIndex(g => g.groupId === f.groupId)
            if (dupe !== -1) {
              fileNotes.push(`${f.name}: in more than one file, using ${file.name}`)
              found.splice(dupe, 1)
            }
            found.push(f)
          }
        } catch (e) {
          fileNotes.push(`${file.name}: ${e.message ?? 'could not be read'}`)
        }
      }

      if (found.length === 0) throw new Error(fileNotes.join('\n') || 'No tasked flights found in this mission.')

      preloadOrdnanceDb()
      setLocalFlights(found)
      setNotes(fileNotes)
      setPhase('preview')
    } catch (e) {
      setError(e.message ?? 'Unknown error')
      setPhase('error')
    }
  }, [sessionCoalition])

  const onDragOver  = e => { e.preventDefault(); setDragging(true)  }
  const onDragLeave = e => { e.preventDefault(); setDragging(false) }
  const onDrop = e => {
    e.preventDefault(); setDragging(false)
    processFiles(e.dataTransfer.files)
  }
  const onFileChange = e => {
    processFiles(e.target.files)
  }

  // Template flights already loaded under the same coalition + group name,
  // which this import will replace.
  const loadedTemplateIds = new Set(
    useAbmMissionStore.getState().flights.filter(f => f.source === 'stm').map(f => f.groupId)
  )

  const doImport = () => {
    const templates = flights.filter(f => f.source === 'stm')
    const missionFlights = flights.filter(f => f.source !== 'stm')
    // A batch of templates alone leaves the loaded mission's flights alone.
    if (missionFlights.length) setFlights(missionFlights)
    if (templates.length) useAbmMissionStore.getState().mergeTemplateFlights(templates)
    onClose()
  }

  const doApplyCsv = () => {
    const result = useAbmMissionStore.getState().applyIffCsv(csvRows)
    setCsvResult(result)
    setPhase('csv-done')
  }

  return (
    <div className="mi-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mi-modal">
        <div className="mi-header">
          <span className="mi-title">LOAD MISSION</span>
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
            <span className="mi-drop-label">Drop .miz, mission, .stm templates, or IFF .csv file</span>
            <span className="mi-drop-sub">or click to browse</span>
            <input
              ref={fileRef}
              type="file"
              accept=".miz,.stm,.csv,*"
              multiple
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
        )}

        {phase === 'loading' && (
          <div className="mi-status">Parsing file…</div>
        )}

        {phase === 'error' && (
          <div className="mi-error">
            <span>{error}</span>
            <button className="mi-btn" onClick={() => setPhase('idle')}>Try Again</button>
          </div>
        )}

        {phase === 'csv-preview' && (
          <div className="mi-preview">
            <div className="mi-section mi-section-grow">
              <div className="mi-section-label">IFF ASSIGNMENTS ({csvRows.length})</div>
              <div className="mi-ac-list">
                {csvRows.map((r, i) => (
                  <div key={i} className="mi-flight-row">
                    <span className="mi-flight-name">{r.callsign}</span>
                    <span className="mi-flight-task">
                      {[r.mode1 && `M1 ${r.mode1}`, r.mode2 && `M2 ${r.mode2}`, r.mode3 && `M3 ${r.mode3}`].filter(Boolean).join(' · ') || '—'}
                      {r.dropped?.length > 0 && ` (dropped: ${r.dropped.join(', ')})`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mi-status">
              Assign-only — matched against callsigns already on a FRAG roster (imported or manual). Unmatched rows are skipped, not created as new flights.
            </div>
          </div>
        )}

        {phase === 'csv-done' && (
          <div className="mi-preview">
            <div className="mi-status">
              Assigned {csvResult.matched.length} of {csvRows.length}.
              {csvResult.skipped.length > 0 && (
                <> Skipped (no matching roster row): {csvResult.skipped.join(', ')}</>
              )}
            </div>
          </div>
        )}

        {phase === 'preview' && (
          <div className="mi-preview">
            <div className="mi-section">
              <div className="mi-section-label">FLIGHTS FOUND</div>
              <div className="mi-task-counts">
                {taskCounts(flights).map(([task, n]) => (
                  <span key={task} className="mi-task-count">
                    <span className="mi-task-count-n">{n}</span>{task}
                  </span>
                ))}
              </div>
            </div>
            <div className="mi-section mi-section-grow">
              <div className="mi-section-label">FLIGHTS ({flights.length})</div>
              <div className="mi-ac-list">
                {flights.map(f => (
                  <div key={f.groupId} className="mi-flight-row">
                    <span className="mi-flight-name">{f.name}</span>
                    <span className="mi-flight-task">{f.task || f.rawTask}</span>
                    <span className="mi-flight-units">{f.units.length}x</span>
                    {f.lateActivation && <span className="mi-flight-reserve">RESERVE</span>}
                    {loadedTemplateIds.has(f.groupId) && <span className="mi-flight-reserve">REPLACES</span>}
                  </div>
                ))}
              </div>
            </div>
            {notes.length > 0 && (
              <div className="mi-section mi-notes">
                {notes.map((n, i) => <div key={i}>{n}</div>)}
              </div>
            )}
          </div>
        )}

        <div className="mi-footer">
          <button className="mi-btn" onClick={onClose}>{phase === 'csv-done' ? 'Close' : 'Cancel'}</button>
          {phase === 'preview' && (
            <button className="mi-btn mi-btn-primary" onClick={doImport}>
              Import
            </button>
          )}
          {phase === 'csv-preview' && (
            <button className="mi-btn mi-btn-primary" onClick={doApplyCsv}>
              Apply
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
