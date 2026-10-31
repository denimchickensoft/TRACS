import { useState, useRef, useCallback } from 'react'
import { findAtoFlights } from '../../utils/parseMission.js'
import { readMissionFile } from '../../utils/missionFile.js'
import { mapMizFlightPlans } from '../../utils/mizFlightPlans.js'
import { parseCsvFlightPlans } from '../../utils/csvFlightPlans.js'
import { dtcRouteSlots, buildDtcFlightPlan } from '../../utils/dtcFlightPlans.js'
import { useFlightPlansStore } from '../../store/flightPlans.js'
import { useSessionStore } from '../../store/session.js'
import { sendWebrtcEvent } from '../../webrtc/client.js'
import { AID_MAX_LEN } from '../../utils/callsign.js'
import './FlightPlanImport.css'

// Shared bulk import for the flight-plan ingestion paths --
// .miz / .stm static template / CSV / DTC.
// Controller-side, ATC/STARS only. Same drag-drop pattern as
// modules/abm/AbmMissionImport.jsx, adapted for a unified review list across
// all source formats plus DTC's extra route-slot/callsign step. Several
// .miz/.stm/.csv files can be dropped at once into one review list; a .dtc
// goes on its own because of that extra step.

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = e => resolve(e.target.result)
    reader.onerror = () => reject(new Error('File read failed'))
    reader.readAsText(file)
  })
}

// _collision: the AID is already filed, or an earlier row in this same
// batch claims it (two templates using the same callsign).
function withRowStates(plans) {
  const { plans: filed } = useFlightPlansStore.getState()
  const seen = new Set()
  return plans.map((plan) => {
    const row = { ...plan, _include: true, _collision: !!filed[plan.aid] || seen.has(plan.aid), _overwrite: false }
    seen.add(plan.aid)
    return row
  })
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

  // Plans from one .miz or .stm, each file mapped with its own theatre.
  const planMissionFile = useCallback(async (file) => {
    const { kind, mission } = await readMissionFile(file)
    let found = findAtoFlights(mission, { template: kind === 'stm' })
    if (sessionCoalition === 'blue' || sessionCoalition === 'red') {
      found = found.filter(f => f.coalition === sessionCoalition)
    }
    // A file with no flights for this side (another squadron's template, in
    // a batch) is skipped, not an error; processBatch only fails on none at all.
    if (found.length === 0) return []
    return mapMizFlightPlans(found, mission?.theatre ?? null)
  }, [sessionCoalition])

  const processBatch = useCallback(async (files) => {
    const built = []
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.csv')) built.push(...parseCsvFlightPlans(await readFileText(file)))
      else built.push(...await planMissionFile(file))
    }
    if (built.length === 0) throw new Error('No tasked flights found.')
    setRows(withRowStates(built))
    setPhase('review')
  }, [planMissionFile])

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

  const processFiles = useCallback(async (fileList) => {
    const files = [...fileList]
    if (!files.length) return
    setPhase('loading')
    try {
      const names = files.map(f => f.name.toLowerCase())
      const bad = files.filter((f, i) => !/\.(miz|stm|csv|dtc)$/.test(names[i]))
      if (bad.length) throw new Error(`Unrecognized file type (${bad.map(f => f.name).join(', ')}) — expected .miz, .stm, .csv, or .dtc.`)
      if (names.some(n => n.endsWith('.dtc'))) {
        if (files.length > 1) throw new Error('Load a .dtc file on its own, not together with other files.')
        await processDtc(files[0])
      } else {
        await processBatch(files)
      }
    } catch (e) {
      setError(e.message ?? 'Unknown error')
      setPhase('error')
    }
  }, [processBatch, processDtc])

  const confirmDtcSlot = (slot) => { setDtcSlot(slot); setPhase('dtc-aid') }

  const confirmDtcAid = () => {
    const aid = dtcAid.trim().toUpperCase()
    if (!aid) return
    const slotEntry = dtcPending.slots.find(s => s.slot === dtcSlot)
    const plan = buildDtcFlightPlan(dtcPending.family, dtcPending.theatre, slotEntry.points, aid)
    setRows(withRowStates([plan]))
    setPhase('review')
  }

  const onDragOver  = e => { e.preventDefault(); setDragging(true)  }
  const onDragLeave = e => { e.preventDefault(); setDragging(false) }
  const onDrop = e => {
    e.preventDefault(); setDragging(false)
    processFiles(e.dataTransfer.files)
  }
  const onFileChange = e => {
    processFiles(e.target.files)
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
            <span className="fpi-drop-label">Drop .miz, .stm, .csv, or .dtc files</span>
            <span className="fpi-drop-sub">or click to browse</span>
            <input
              ref={fileRef}
              type="file"
              accept=".miz,.stm,.csv,.dtc"
              multiple
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
