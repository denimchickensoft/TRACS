import { useState, useRef, useCallback } from 'react'
import { unzipSync } from 'fflate'
import { parseLua, findAtoPackages } from '../../utils/parseMission.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
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

function taskCounts(packages) {
  const counts = {}
  for (const p of packages) counts[p.task || '—'] = (counts[p.task || '—'] ?? 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

export function AbmMissionImport({ onClose }) {
  const setPackages = useAbmMissionStore(s => s.setPackages)

  const [phase,    setPhase]    = useState('idle')   // idle | loading | preview | error
  const [error,    setError]    = useState('')
  const [packages, setLocalPackages] = useState([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef()

  const processFile = useCallback(async (file) => {
    setPhase('loading')
    try {
      const text    = await loadMissionText(file)
      const mission = parseLua(text)
      const pkgs    = findAtoPackages(mission)

      if (pkgs.length === 0) throw new Error('No tasked flights found in this mission.')

      preloadOrdnanceDb()
      setLocalPackages(pkgs)
      setPhase('preview')
    } catch (e) {
      setError(e.message ?? 'Unknown error')
      setPhase('error')
    }
  }, [])

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
    setPackages(packages)
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
              <div className="mi-section-label">PACKAGES FOUND</div>
              <div className="mi-task-counts">
                {taskCounts(packages).map(([task, n]) => (
                  <span key={task} className="mi-task-count">
                    <span className="mi-task-count-n">{n}</span>{task}
                  </span>
                ))}
              </div>
            </div>
            <div className="mi-section mi-section-grow">
              <div className="mi-section-label">FLIGHTS ({packages.length})</div>
              <div className="mi-ac-list">
                {packages.map(p => (
                  <div key={p.groupId} className="mi-pkg-row">
                    <span className="mi-pkg-name">{p.name}</span>
                    <span className="mi-pkg-task">{p.task || p.rawTask}</span>
                    <span className="mi-pkg-units">{p.units.length}x</span>
                    {p.lateActivation && <span className="mi-pkg-reserve">RESERVE</span>}
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
