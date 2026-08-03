import { useState, useRef, useCallback } from 'react'
import { unzipSync } from 'fflate'
import { parseLua, findAtoFlights } from '../../utils/parseMission.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { preloadOrdnanceDb } from '../../utils/ordnance.js'
import './AbmMissionImport.css'

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target.result)
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsText(file)
  })
}

async function loadMissionText(file) {
  if (file.name.toLowerCase().endsWith('.miz')) {
    const buf    = await file.arrayBuffer()
    const zipped = new Uint8Array(buf)
    const files  = unzipSync(zipped)
    if (!files['mission']) throw new Error('No "mission" file found inside .miz')
    return new TextDecoder().decode(files['mission'])
  }
  return readFileText(file)
}

function taskCounts(flights) {
  const counts = {}
  for (const f of flights) counts[f.task || '—'] = (counts[f.task || '—'] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

export function AbmMissionImport({ onClose }) {
  const setFlights = useAbmMissionStore(s => s.setFlights)
  const sessionCoalition = useSessionStore(s => s.coalition)

  const [phase,    setPhase]    = useState('idle')   // idle | loading | preview | error
  const [error,    setError]    = useState('')
  const [flights, setLocalFlights] = useState([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef()

  // Blue/red sessions must never even preview the other side's tasking —
  // that would spoil surprises the mission intended to keep hidden from
  // them. Filter right at import, before anything is shown. GM/admin
  // aren't aligned to a side, so they see everything (same rule as ATO/FRAG).
  const processFile = useCallback(async (file) => {
    setPhase('loading')
    try {
      const text    = await loadMissionText(file)
      const mission = parseLua(text)
      let found     = findAtoFlights(mission)

      if (sessionCoalition === 'blue' || sessionCoalition === 'red') {
        found = found.filter(f => f.coalition === sessionCoalition)
      }

      if (found.length === 0) throw new Error('No tasked flights found in this mission.')

      preloadOrdnanceDb()
      setLocalFlights(found)
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
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }
  const onFileChange = e => {
    const file = e.target.files[0]
    if (file) processFile(file)
  }

  const doImport = () => {
    setFlights(flights)
    onClose()
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
            <span className="mi-drop-label">Drop .miz or mission file</span>
            <span className="mi-drop-sub">or click to browse</span>
            <input
              ref={fileRef}
              type="file"
              accept=".miz,*"
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
        )}

        {phase === 'loading' && (
          <div className="mi-status">Parsing mission file…</div>
        )}

        {phase === 'error' && (
          <div className="mi-error">
            <span>{error}</span>
            <button className="mi-btn" onClick={() => setPhase('idle')}>Try Again</button>
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
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="mi-footer">
          <button className="mi-btn" onClick={onClose}>Cancel</button>
          {phase === 'preview' && (
            <button className="mi-btn mi-btn-primary" onClick={doImport}>
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
