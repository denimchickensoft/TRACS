import { useState, useRef, useCallback } from 'react'
import { unzipSync } from 'fflate'
import { parseLua, findAtoFlights } from '../../utils/parseMission.js'
import { mapMizFlightPlans } from '../../utils/mizFlightPlans.js'
import { parseCsvFlightPlans } from '../../utils/csvFlightPlans.js'
import { dtcRouteSlots, buildDtcFlightPlan } from '../../utils/dtcFlightPlans.js'
import { useFlightPlansStore } from '../../store/flightPlans.js'
import { useSessionStore } from '../../store/session.js'
import { sendWebrtcEvent } from '../../webrtc/client.js'
import { AID_MAX_LEN } from '../../utils/callsign.js'
import './FlightPlanImport.css'

// Shared bulk import for the three flight-plan ingestion paths --
// .miz / CSV / DTC -- see resources/specs/pilot-flightplan-ingestion-spec.md.
// Controller-side, ATC/STARS only. Same drag-drop pattern as
// modules/abm/AbmMissionImport.jsx, adapted for a unified review list across
// all three source formats plus DTC's extra route-slot/callsign step.

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target.result)
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsText(file)
  })
}

async function loadMizText(file) {
  const buf    = await file.arrayBuffer()
  const zipped = new Uint8Array(buf)
  const files  = unzipSync(zipped)
  if (!files['mission']) throw new Error('No "mission" file found inside .miz')
  return new TextDecoder().decode(files['mission'])
}

function withRowState(plan) {
  const existing = useFlightPlansStore.getState().plans[plan.aid]
  return {
    ...plan,
    _include: true,
    _collision: !!existing,
    _overwrite: false,
  }
}

export function FlightPlanImport({ onClose }) {
  const add    = useFlightPlansStore(s => s.add)
  const remove = useFlightPlansStore(s => s.remove)
  const sessionCoalition = useSessionStore(s => s.coalition)

  // idle | loading | dtc-slot | dtc-aid | review | error
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [rows,  setRows]  = useState([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef()

  // DTC-only intermediate state: parsed file + chosen slot, pending an AID.
  const [dtcPending, setDtcPending] = useState(null) // { family, theatre, slots }
  const [dtcSlot,    setDtcSlot]    = useState(null)
  const [dtcAid,     setDtcAid]     = useState('')

  const processMiz = useCallback(async (file) => {
    const text    = await loadMizText(file)
    const mission = parseLua(text)
    let found     = findAtoFlights(mission)
    if (sessionCoalition === 'blue' || sessionCoalition === 'red') {
      found = found.filter(f => f.coalition === sessionCoalition)
    }
    if (found.length === 0) throw new Error('No tasked flights found in this mission.')
    const built = await mapMizFlightPlans(found, mission?.theatre ?? null)
    setRows(built.map(withRowState))
    setPhase('review')
  }, [sessionCoalition])

  const processCsv = useCallback(async (file) => {
    const text = await readFileText(file)
    const built = parseCsvFlightPlans(text)
    setRows(built.map(withRowState))
    setPhase('review')
  }, [])

  const processDtc = useCallback(async (file) => {
    const text = await readFileText(file)
    const json = JSON.parse(text)
    const parsed = dtcRouteSlots(json)
    if (parsed.slots.length === 0) throw new Error('No route waypoints found in this DTC file.')
    setDtcPending(parsed)
    if (parsed.slots.length === 1) {
      setDtcSlot(parsed.slots[0].slot)
      setPhase('dtc-aid')
    } else {
      setPhase('dtc-slot')
    }
  }, [])

  const processFile = useCallback(async (file) => {
    setPhase('loading')
    try {
      const name = file.name.toLowerCase()
      if (name.endsWith('.miz')) await processMiz(file)
      else if (name.endsWith('.csv')) await processCsv(file)
      else if (name.endsWith('.dtc')) await processDtc(file)
      else throw new Error('Unrecognized file type — expected .miz, .csv, or .dtc.')
    } catch (e) {
      setError(e.message ?? 'Unknown error')
      setPhase('error')
    }
  }, [processMiz, processCsv, processDtc])

  const confirmDtcSlot = (slot) => { setDtcSlot(slot); setPhase('dtc-aid') }

  const confirmDtcAid = () => {
    const aid = dtcAid.trim().toUpperCase()
    if (!aid) return
    const slotEntry = dtcPending.slots.find(s => s.slot === dtcSlot)
    const plan = buildDtcFlightPlan(dtcPending.family, dtcPending.theatre, slotEntry.points, aid)
    setRows([withRowState(plan)])
    setPhase('review')
  }

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

  const toggleInclude  = (i) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, _include: !r._include } : r))
  const toggleOverwrite = (i) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, _overwrite: !r._overwrite } : r))
  const discardRteWarning = (i) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, _include: false } : r))

  const reset = () => {
    setPhase('idle'); setError(''); setRows([])
    setDtcPending(null); setDtcSlot(null); setDtcAid('')
  }

  const doImport = () => {
    for (const row of rows) {
      if (!row._include) continue
      if (row._collision) {
        if (!row._overwrite) continue
        remove(row.aid)
      }
      const { _include, _collision, _overwrite, _rteWarnings, _groupId, ...plan } = row
      add(plan)
      // Broadcast to other ATC peers -- same pattern FPE.jsx uses for a
      // controller-authored create, fetching the store's record so cid/bcn
      // (host-minted by add()) go out with it.
      sendWebrtcEvent('FLIGHT_PLAN_CREATE', useFlightPlansStore.getState().plans[plan.aid])
    }
    onClose()
  }

  const importCount = rows.filter(r => r._include && (!r._collision || r._overwrite)).length

  return (
    <div className="fpi-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="fpi-modal">
        <div className="fpi-header">
          <span className="fpi-title">IMPORT FLIGHT PLANS</span>
          <button className="fpi-close" onClick={onClose}>×</button>
        </div>

        {phase === 'idle' && (
          <div
            className={['fpi-dropzone', dragging ? 'dragging' : ''].join(' ')}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <span className="fpi-drop-icon">⬆</span>
            <span className="fpi-drop-label">Drop .miz, .csv, or .dtc file</span>
            <span className="fpi-drop-sub">or click to browse</span>
            <input
              ref={fileRef}
              type="file"
              accept=".miz,.csv,.dtc"
              style={{ display: 'none' }}
              onChange={onFileChange}
            />
          </div>
        )}

        {phase === 'loading' && (
          <div className="fpi-status">Parsing file…</div>
        )}

        {phase === 'error' && (
          <div className="fpi-error">
            <span>{error}</span>
            <button className="fpi-btn" onClick={reset}>Try Again</button>
          </div>
        )}

        {phase === 'dtc-slot' && (
          <div className="fpi-preview">
            <div className="fpi-section">
              <div className="fpi-section-label">
                MULTIPLE STORED ROUTES FOUND — SELECT ONE
              </div>
              <div className="fpi-slot-list">
                {dtcPending.slots.map(s => (
                  <button
                    key={s.slot}
                    className="fpi-slot-btn"
                    onClick={() => confirmDtcSlot(s.slot)}
                  >
                    {s.slot} <span className="fpi-slot-count">({s.points.length} pts)</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {phase === 'dtc-aid' && (
          <div className="fpi-preview">
            <div className="fpi-section">
              <div className="fpi-section-label">
                DTC files carry no callsign — enter the flight's AID
              </div>
              <form
                className="fpi-aid-form"
                onSubmit={(e) => { e.preventDefault(); confirmDtcAid() }}
              >
                <input
                  className="fpi-aid-input"
                  autoFocus
                  value={dtcAid}
                  onChange={e => setDtcAid(e.target.value.toUpperCase())}
                  placeholder="Callsign"
                  maxLength={AID_MAX_LEN}
                />
                <button type="submit" className="fpi-btn fpi-btn-primary" disabled={!dtcAid.trim()}>
                  Continue
                </button>
              </form>
            </div>
          </div>
        )}

        {phase === 'review' && (
          <div className="fpi-preview">
            <div className="fpi-section fpi-section-grow">
              <div className="fpi-section-label">FLIGHT PLANS ({rows.length})</div>
              <div className="fpi-row-list">
                {rows.map((row, i) => (
                  <div key={`${row.aid}-${i}`} className={['fpi-row', !row._include ? 'excluded' : ''].join(' ')}>
                    <label className="fpi-row-check">
                      <input type="checkbox" checked={row._include} onChange={() => toggleInclude(i)} />
                    </label>
                    <span className="fpi-row-aid">{row.aid}</span>
                    <span className="fpi-row-typ">{row.typ}</span>
                    <span className="fpi-row-dep-dest">{row.dep || '—'} / {row.dest || '—'}</span>
                    <span className="fpi-row-rte" title={row.rte}>{row.rte}</span>
                    {row._collision && (
                      <span className="fpi-row-badge fpi-badge-collision">
                        EXISTS
                        <button
                          className={['fpi-mini-btn', row._overwrite ? 'active' : ''].join(' ')}
                          onClick={() => toggleOverwrite(i)}
                        >
                          {row._overwrite ? 'OVERWRITE' : 'SKIP'}
                        </button>
                      </span>
                    )}
                    {row._rteWarnings?.length > 0 && (
                      <span className="fpi-row-badge fpi-badge-warn" title={`Unmatched fixes: ${row._rteWarnings.join(', ')}`}>
                        {row._rteWarnings.length} UNMATCHED FIX{row._rteWarnings.length > 1 ? 'ES' : ''}
                        <button className="fpi-mini-btn" onClick={() => discardRteWarning(i)}>DISCARD</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="fpi-footer">
          <button className="fpi-btn" onClick={onClose}>Cancel</button>
          {phase === 'review' && (
            <button className="fpi-btn fpi-btn-primary" onClick={doImport} disabled={importCount === 0}>
              Import ({importCount})
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
