import { useState, useEffect, useMemo } from 'react'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { useUnitsStore } from '../../store/units.js'
import { isCarrierUnit, CARRIER_TYPES } from '../../utils/carriers.js'
import { stripAcid } from '../../utils/callsign.js'
import './AddAtoFlight.css'

// Manually-added flights have no DCS unitId to match a live Olympus unit
// against — the entered callsign is stored as a *prefix* (Ato.jsx/Frag.jsx
// matchLiveByPrefix), matched against every live unit whose resolved
// callsign starts with it. DCS concatenates flight number + element digit
// with no separator (flight 1's elements are "SHELL11"/"SHELL12", flight 3's
// are "SHELL31"/"SHELL32") — include the flight number in the prefix
// ("SHELL1") so a same-named-but-different-numbered flight elsewhere in the
// mission doesn't also get swept in; the trailing element digit is the only
// part that should be left off. It's the one required field besides a name.
export function AddAtoFlight({ onClose }) {
  const addFlight = useAbmMissionStore(s => s.addFlight)
  const sessionCoalition = useSessionStore(s => s.coalition)
  const mission = useSessionStore(s => s.mission)
  const theatre = mission?.mission?.theatre
  const liveUnits = useUnitsStore(s => s.units)

  const isGmAdmin = sessionCoalition !== 'blue' && sessionCoalition !== 'red'

  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [type, setType] = useState('')
  const [num, setNum] = useState('1')
  const [callsign, setCallsign] = useState('')
  const [freq, setFreq] = useState('')
  const [baseKey, setBaseKey] = useState('')
  const [coalition, setCoalition] = useState(isGmAdmin ? 'blue' : sessionCoalition)
  const [error, setError] = useState('')

  // Known airbases for the loaded theatre (client/public/airdromes/<theatre>.json,
  // same table getAirdromeName reads) — enumerated fresh here since that
  // module only exposes single-id lookups, not the full list.
  const [airbases, setAirbases] = useState([])
  useEffect(() => {
    if (!theatre) { setAirbases([]); return }
    fetch(`/airdromes/${encodeURIComponent(theatre)}.json`)
      .then(r => r.ok ? r.json() : {})
      .then(data => setAirbases(
        Object.entries(data)
          .map(([id, name]) => ({ airdromeId: Number(id), name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      ))
      .catch(() => setAirbases([]))
  }, [theatre])

  const carriers = useMemo(() => {
    const out = []
    for (const unit of Object.values(liveUnits)) {
      if (!isCarrierUnit(unit)) continue
      const info = CARRIER_TYPES[unit.name]
      out.push({ carrierUnitId: unit.unitID, carrierName: info.displayName, carrierAbbrev: info.facilityId })
    }
    return out
  }, [liveUnits])

  const baseOptions = useMemo(() => [
    ...airbases.map(ab => ({ key: `airbase-${ab.airdromeId}`, label: ab.name, ref: { type: 'airbase', airdromeId: ab.airdromeId, theatre } })),
    ...carriers.map(cv => ({ key: `carrier-${cv.carrierUnitId}`, label: `${cv.carrierName} (${cv.carrierAbbrev})`, ref: { type: 'carrier', ...cv } })),
  ], [airbases, carriers, theatre])

  const submit = () => {
    if (!name.trim())     { setError('Flight name required'); return }
    if (!callsign.trim()) { setError('Callsign prefix required — used to match this flight to live aircraft'); return }

    const base = baseOptions.find(o => o.key === baseKey)?.ref ?? null
    const count = Math.max(1, parseInt(num, 10) || 1)

    addFlight({
      coalition,
      name: name.trim(),
      task: task.trim(),
      rawTask: task.trim(),
      frequency: freq.trim() ? parseFloat(freq.trim()) : null,
      lateActivation: false,
      uncontrolled: false,
      launch: base ?? { type: 'airstart' },
      recovery: { type: 'unknown' },
      route: [],
      // The match key (Ato.jsx/Frag.jsx matchLiveByPrefix) — not a per-unit
      // callsign, since we can't predict DCS's exact element-numbering
      // scheme for this flight ahead of time.
      callsignPrefix: stripAcid(callsign.trim()),
      // Placeholder roster, purely for the TYPE/NUM display (Ato.jsx
      // numType) — the *actual* roster FRAG shows for a manual flight is
      // built live from matchLiveByPrefix, not from this array.
      units: Array.from({ length: count }, (_, i) => ({
        unitId: -(i + 1),
        type: type.trim() || '—',
        rawType: type.trim(),
      })),
    })
    onClose()
  }

  return (
    <div className="af-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="af-modal">
        <div className="af-header">
          <span className="af-title">ADD FLIGHT</span>
          <button className="af-close" onClick={onClose}>×</button>
        </div>

        <div className="af-body">
          <label className="af-field">
            <span>Flight Name</span>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Shell 3" spellCheck={false} />
          </label>

          <label className="af-field">
            <span>Task</span>
            <input value={task} onChange={e => setTask(e.target.value)} placeholder="e.g. AR" spellCheck={false} />
          </label>

          <div className="af-row">
            <label className="af-field">
              <span>Type</span>
              <input value={type} onChange={e => setType(e.target.value)} placeholder="e.g. KC135" spellCheck={false} />
            </label>
            <label className="af-field af-field-num">
              <span>Num</span>
              <input type="number" min="1" value={num} onChange={e => setNum(e.target.value)} />
            </label>
          </div>

          <label className="af-field">
            <span>Callsign Prefix (name + flight #, no element #)</span>
            <input value={callsign} onChange={e => setCallsign(e.target.value)} placeholder="e.g. SHELL1" spellCheck={false} />
          </label>

          <label className="af-field">
            <span>Base / Taskunit</span>
            <select value={baseKey} onChange={e => setBaseKey(e.target.value)}>
              <option value="">— none —</option>
              {baseOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>

          <label className="af-field">
            <span>Freq (MHz)</span>
            <input value={freq} onChange={e => setFreq(e.target.value)} placeholder="e.g. 257" inputMode="decimal" />
          </label>

          {isGmAdmin && (
            <label className="af-field">
              <span>Coalition</span>
              <select value={coalition} onChange={e => setCoalition(e.target.value)}>
                <option value="blue">Blue</option>
                <option value="red">Red</option>
              </select>
            </label>
          )}

          {error && <div className="af-error">{error}</div>}
        </div>

        <div className="af-footer">
          <button className="af-btn" onClick={onClose}>Cancel</button>
          <button className="af-btn af-btn-primary" onClick={submit}>Add</button>
        </div>
      </div>
    </div>
  )
}
