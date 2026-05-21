import { useState, useRef, useCallback } from 'react'
import { unzipSync } from 'fflate'
import { parseLua, extractWeather, findCarriersAndAircraft } from '../../utils/parseMission.js'
import { useStatusBoardStore } from '../../store/statusBoard.js'
import './MissionImport.css'

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
    const buf  = await file.arrayBuffer()
    const zipped = new Uint8Array(buf)
    const files  = unzipSync(zipped)
    if (!files['mission']) throw new Error('No "mission" file found inside .miz')
    return new TextDecoder().decode(files['mission'])
  }
  return readFileText(file)
}

export function MissionImport({ activeCarrierType, onClose }) {
  const { setHeader, addMissionEntries } = useStatusBoardStore()

  const [phase,    setPhase]    = useState('idle')   // idle | loading | preview | error
  const [error,    setError]    = useState('')
  const [preview,  setPreview]  = useState(null)     // { weather, carriers, aircraft }
  const [carrierId,   setCarrierId]   = useState(null)
  const [selection,   setSelection]   = useState(new Set())
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef()

  // ── Parse a dropped/selected file ───────────────────────────────────────────
  const processFile = useCallback(async (file) => {
    setPhase('loading')
    try {
      const text    = await loadMissionText(file)
      const mission = parseLua(text)
      const weather = extractWeather(mission)
      const { carriers, aircraft } = findCarriersAndAircraft(mission)

      if (carriers.length === 0) throw new Error('No carrier ships found in this mission.')

      // Auto-select carrier matching the active TRACS carrier type
      const autoCarrier = carriers.find(c => c.type === activeCarrierType) ?? carriers[0]
      const selected = new Set(
        aircraft.filter(a => a.carrierUnitId === autoCarrier.unitId).map(a => a.callsign)
      )

      setPreview({ weather, carriers, aircraft })
      setCarrierId(autoCarrier.unitId)
      setSelection(selected)
      setPhase('preview')
    } catch (e) {
      setError(e.message ?? 'Unknown error')
      setPhase('error')
    }
  }, [activeCarrierType])

  // ── Drag and drop ────────────────────────────────────────────────────────────
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

  // ── Carrier change ────────────────────────────────────────────────────────────
  const onCarrierChange = (id) => {
    setCarrierId(id)
    const sel = new Set(
      (preview?.aircraft ?? []).filter(a => a.carrierUnitId === id).map(a => a.callsign)
    )
    setSelection(sel)
  }

  // ── Aircraft selection ────────────────────────────────────────────────────────
  const toggleAircraft = (cs) => {
    setSelection(prev => {
      const next = new Set(prev)
      next.has(cs) ? next.delete(cs) : next.add(cs)
      return next
    })
  }

  const toggleAll = () => {
    const visible = visibleAircraft()
    const allSelected = visible.every(a => selection.has(a.callsign))
    setSelection(allSelected
      ? new Set()
      : new Set(visible.map(a => a.callsign))
    )
  }

  const visibleAircraft = () =>
    (preview?.aircraft ?? []).filter(a => a.carrierUnitId === carrierId)

  // ── Import ────────────────────────────────────────────────────────────────────
  const doImport = () => {
    const { weather } = preview
    if (weather) {
      if (weather.qnh) setHeader('qnh', weather.qnh)
      if (weather.vis) setHeader('vis', weather.vis)
      if (weather.clg) setHeader('clg', weather.clg)
    }
    const toImport = visibleAircraft().filter(a => selection.has(a.callsign))
    if (toImport.length > 0) addMissionEntries(toImport)
    onClose()
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  const aircraft = visibleAircraft()
  const allChecked = aircraft.length > 0 && aircraft.every(a => selection.has(a.callsign))

  return (
    <div className="mi-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="mi-modal">
        <div className="mi-header">
          <span className="mi-title">LOAD MISSION</span>
          <button className="mi-close" onClick={onClose}>×</button>
        </div>

        {/* ── Idle: file drop zone ── */}
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

        {/* ── Loading ── */}
        {phase === 'loading' && (
          <div className="mi-status">Parsing mission file…</div>
        )}

        {/* ── Error ── */}
        {phase === 'error' && (
          <div className="mi-error">
            <span>{error}</span>
            <button className="mi-btn" onClick={() => setPhase('idle')}>Try Again</button>
          </div>
        )}

        {/* ── Preview ── */}
        {phase === 'preview' && preview && (
          <div className="mi-preview">

            {/* Weather */}
            <div className="mi-section">
              <div className="mi-section-label">WEATHER</div>
              <div className="mi-weather-row">
                {preview.weather?.clg
                  ? <span className="mi-wx-field"><span className="mi-wx-lbl">CLG</span>{preview.weather.clg}</span>
                  : <span className="mi-wx-field empty"><span className="mi-wx-lbl">CLG</span>——</span>
                }
                {preview.weather?.vis
                  ? <span className="mi-wx-field"><span className="mi-wx-lbl">VIS</span>{preview.weather.vis}</span>
                  : <span className="mi-wx-field empty"><span className="mi-wx-lbl">VIS</span>——</span>
                }
                {preview.weather?.qnh
                  ? <span className="mi-wx-field"><span className="mi-wx-lbl">QNH</span>{preview.weather.qnh}</span>
                  : <span className="mi-wx-field empty"><span className="mi-wx-lbl">QNH</span>——</span>
                }
              </div>
              {preview.weather?.ceilingNote && (
                <div className="mi-ceiling-note">{preview.weather.ceilingNote}</div>
              )}
            </div>

            {/* Carrier selector */}
            {preview.carriers.length > 1 && (
              <div className="mi-section">
                <div className="mi-section-label">CARRIER</div>
                <div className="mi-carrier-list">
                  {preview.carriers.map(c => (
                    <button
                      key={c.unitId}
                      className={['mi-carrier-btn', carrierId === c.unitId ? 'active' : ''].join(' ')}
                      onClick={() => onCarrierChange(c.unitId)}
                    >
                      {c.display}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Aircraft list */}
            <div className="mi-section mi-section-grow">
              <div className="mi-section-label">
                AIRCRAFT
                <span className="mi-ac-count">
                  {selection.size}/{aircraft.length} selected
                </span>
              </div>
              <div className="mi-ac-header">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                <span className="mi-ac-cs">CALLSIGN</span>
                <span className="mi-ac-type">TYPE</span>
                <span className="mi-ac-mdx">MODEX</span>
                <span className="mi-ac-msn">MISSION</span>
                <span className="mi-ac-skl">SKILL</span>
              </div>
              <div className="mi-ac-list">
                {aircraft.map(a => (
                  <label key={a.callsign} className="mi-ac-row">
                    <input
                      type="checkbox"
                      checked={selection.has(a.callsign)}
                      onChange={() => toggleAircraft(a.callsign)}
                    />
                    <span className="mi-ac-cs">{a.callsign}</span>
                    <span className="mi-ac-type">{a.type}</span>
                    <span className="mi-ac-mdx">{a.modex}</span>
                    <span className="mi-ac-msn">{a.task}</span>
                    <span className={['mi-ac-skl', a.skill === 'Client' ? 'client' : ''].join(' ')}>
                      {a.skill}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mi-footer">
          <button className="mi-btn" onClick={onClose}>Cancel</button>
          {phase === 'preview' && (
            <button
              className="mi-btn mi-btn-primary"
              onClick={doImport}
              disabled={selection.size === 0 && !preview.weather?.qnh && !preview.weather?.vis && !preview.weather?.clg}
            >
              Import
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
