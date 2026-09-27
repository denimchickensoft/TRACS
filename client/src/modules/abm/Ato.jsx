import { useState, useMemo, useEffect, useRef } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign, matchLiveByPrefix, buildLiveUnitLookup } from '../../utils/callsign.js'
import { parseFlightElement } from './canvas/drawAbmContacts.js'
import { getAirdromeName, preloadAirdromes } from '../../utils/airdromes.js'
import { computeAirbaseLabels } from '../../store/runways.js'
import { groundState } from '../../utils/carriers.js'
import { AbmMissionImport } from './AbmMissionImport.jsx'
import { AddAtoFlight } from './AddAtoFlight.jsx'
import './Ato.css'

export const ATO_NATURAL_WIDTH = 460

const ATO_SCALE_KEY    = 'tracs.ato.scale'
const ATO_SORT_KEY_KEY = 'tracs.ato.sortKey'
const ATO_SORT_DIR_KEY = 'tracs.ato.sortDir'
const SCALE_MIN     = 0.5
const SCALE_MAX     = 2.0
const SCALE_STEP    = 0.05

const COLUMNS = [
  { key: 'flight',   label: 'FLIGHT',    width: 90  },
  { key: 'task',     label: 'TASK',      width: 50  },
  { key: 'num',      label: 'TYPE/NUM',  width: 70  },
  { key: 'callsign', label: 'CALLSIGN',  width: 70  },
  { key: 'taskunit', label: 'TASKUNIT',  width: 50  },
  { key: 'freq',     label: 'FREQ',      width: 58  },
  { key: 'status',   label: 'STATUS',    width: 1   },   // flex remainder
]

// Trailing 16px column outside the sortable COLUMNS set — holds the
// per-row delete control, shown only for manually-added flights.
const gridTemplateColumns = COLUMNS.map(c => c.width === 1 ? '1fr' : `${c.width}px`).join(' ') + ' 16px'

// TASKUNIT column — abbreviated form only (real ICAO for airfields, hull
// abbreviation for carriers, e.g. "CV74"), unlike FRAG's expanded Base line
// which shows the full name too. Falls back to the same first-4-letters
// scheme store/runways.js uses for airports with no icaoMapping.json entry.
function airfieldAbbrev(ref, icaoMap) {
  if (!ref) return '—'
  if (ref.type === 'carrier')  return ref.carrierAbbrev ?? ref.carrierName
  if (ref.type === 'airbase') {
    const name = getAirdromeName(ref.theatre, ref.airdromeId)
    if (!name) return `Airdrome #${ref.airdromeId}`
    const icao = icaoMap[ref.theatre?.toLowerCase()]?.[name]
    return icao ?? computeAirbaseLabels([name])[name]
  }
  if (ref.type === 'airstart') return 'Air Start'
  return '—'
}

// "Base" — a flight's operating airfield, defined by whichever of departure
// (launch) or arrival (recovery) the mission actually captured. Departure
// wins when both are known; air-start flights fall back to recovery, since
// the mission never recorded a takeoff point for them.
function resolveBase(flight) {
  if (flight.launch?.type && flight.launch.type !== 'airstart') return flight.launch
  if (flight.recovery?.type && flight.recovery.type !== 'unknown') return flight.recovery
  return flight.launch
}

// Flight-level rollup when 2+ units disagree (e.g. staggered catapult
// launches mid-flight) — the most-advanced state wins.
const STATE_PRIORITY = { AIR: 3, TAXI: 2, GROUND: 1 }

const SORT_ACCESSORS = {
  flight:   r => r.name ?? '',
  task:     r => r.taskLabel ?? '',
  num:      r => r.units[0]?.type ?? '',
  callsign: r => r.callsignLabel ?? '',
  taskunit: r => r.taskunitLabel ?? '',
  freq:     r => r.frequency ?? -1,
  // RESERVE is its own group, separate from the "active" states (ACTIVE/
  // AIR/GROUND/TAXI) — plain alphabetical would interleave RESERVE between
  // GROUND and TAXI, splitting the reserve flights across the sorted list.
  status:   r => `${r.isReserve ? 1 : 0}_${r.statusLabel ?? ''}`,
}

export function Ato({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir = useWheelDirection()
  const allFlights = useAbmMissionStore(s => s.flights)
  const selectGroup = useAbmMissionStore(s => s.selectGroup)
  const clearFlights = useAbmMissionStore(s => s.clearFlights)
  const clearAllFlights = useAbmMissionStore(s => s.clearAllFlights)
  const removeFlight = useAbmMissionStore(s => s.removeFlight)
  const taskOverrides = useAbmMissionStore(s => s.taskOverrides)
  const sessionCoalition = useSessionStore(s => s.coalition)
  const liveUnits = useUnitsStore(s => s.units)

  // Mission-file unit -> live track — same two-tier lookup Frag.jsx's roster
  // uses (see utils/callsign.js's buildLiveUnitLookup) — so CALLSIGN
  // reflects TRACS's actual resolved callsign (rename overrides, useDcsNames
  // pilot-name convention, etc.), not just the mission file's.
  const findLiveUnit = useMemo(() => buildLiveUnitLookup(liveUnits), [liveUnits])

  // Raw numeric-only map, kept only for the carrier lookup below — see
  // Frag.jsx's identical comment for why that one case can't use the
  // callsign fallback.
  const liveByDcsId = useMemo(() => {
    const m = new Map()
    for (const u of Object.values(liveUnits)) {
      if (u.unitID != null) m.set(u.unitID, u)
    }
    return m
  }, [liveUnits])

  // An ATO tasks one side's own assets — show only the controller's
  // coalition. GM/admin aren't aligned to a side, so they see everything.
  const flights = useMemo(() => {
    if (sessionCoalition !== 'blue' && sessionCoalition !== 'red') return allFlights
    return allFlights.filter(f => f.coalition === sessionCoalition)
  }, [allFlights, sessionCoalition])

  const [importOpen, setImportOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  // Persisted like the scale below — last-used sort survives a reload/reopen
  // rather than resetting to import order every time.
  const [sortKey, setSortKey] = useState(() => localStorage.getItem(ATO_SORT_KEY_KEY) || null)
  const [sortDir, setSortDir] = useState(() => (localStorage.getItem(ATO_SORT_DIR_KEY) === '-1' ? -1 : 1))   // 1 = asc, -1 = desc

  const [, setAirdromeTick] = useState(0)
  useEffect(() => {
    const theatres = new Set(flights.flatMap(f => [f.launch?.theatre, f.recovery?.theatre]).filter(Boolean))
    Promise.all([...theatres].map(preloadAirdromes)).then(() => setAirdromeTick(t => t + 1))
  }, [flights])

  // Real ICAO codes (client/public/icaoMapping.json), same fetch AbmScope.jsx
  // does — needed to abbreviate TASKUNIT to an airfield's actual ICAO rather
  // than the generic first-4-letters fallback.
  const [icaoMap, setIcaoMap] = useState({})
  useEffect(() => {
    fetch('/icaoMapping.json').then(r => r.ok ? r.json() : {}).catch(() => ({})).then(setIcaoMap)
  }, [])

  const [scale, setScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem(ATO_SCALE_KEY))
    return isNaN(saved) ? 1.0 : Math.min(SCALE_MAX, Math.max(SCALE_MIN, saved))
  })
  const [scaleHint, setScaleHint] = useState(false)
  const scaleHintRef = useRef(null)

  useEffect(() => { onScaleChange?.(scale) }, [scale]) // eslint-disable-line

  const handleTitleWheel = (e) => {
    const dir = wheelDir(e)
    if (dir === null) return
    setScale((prev) => {
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, parseFloat((prev - dir * SCALE_STEP).toFixed(2))))
      localStorage.setItem(ATO_SCALE_KEY, String(next))
      clearTimeout(scaleHintRef.current)
      setScaleHint(true)
      scaleHintRef.current = setTimeout(() => setScaleHint(false), 1200)
      return next
    })
  }

  const handleSort = (key) => {
    const nextDir = sortKey === key ? -sortDir : 1
    setSortKey(key)
    setSortDir(nextDir)
    localStorage.setItem(ATO_SORT_KEY_KEY, key)
    localStorage.setItem(ATO_SORT_DIR_KEY, String(nextDir))
  }

  const rows = useMemo(() => flights.map(f => {
    // Manual flights (AddAtoFlight.jsx) have no DCS unitId — matched by
    // callsign *prefix* instead, since there's no reliable way to predict
    // whether DCS resolves elements as "SHELL1"/"SHELL2" or "SHELL31"/
    // "SHELL32". liveMatches is every live unit whose resolved callsign
    // starts with the entered prefix; its first entry stands in for "the
    // lead" imported flights get from units[0].
    const liveMatches = f.manual ? matchLiveByPrefix(f.callsignPrefix, liveUnits) : null
    const liveLead = f.manual
      ? (liveMatches[0]?.unit ?? null)
      : (f.units[0] ? findLiveUnit(f.units[0])?.unit ?? null : null)

    // CALLSIGN is the flight's, not the lead aircraft's — drop the element
    // digit ("SHELL11" -> "SHELL1") via the same flight/element split
    // formation-suppression uses. Callsigns that don't split (no 2+-digit
    // trailing run) show as resolved, unchanged.
    const fe = liveLead ? parseFlightElement(liveLead) : null
    const callsignLabel = fe ? fe.flightKey : (liveLead ? resolveCallsign(liveLead).toUpperCase() : '—')
    // RESERVE only means "not spawned yet" — a late-activation group that
    // has since been triggered in-game (any of its units now live in
    // Olympus) is ACTIVE regardless of the mission file's static flag.
    // Non-late-activation flights exist from mission start and are always
    // ACTIVE, live or not (matches DCS's own lateActivation semantics).
    // Manual flights are never late-activation, so this is always live once
    // a callsign match is found.
    const isLive = f.manual ? liveMatches.length > 0 : f.units.some(u => findLiveUnit(u))

    // Once the lead is live (CALLSIGN populated), ACTIVE is replaced by the
    // flight's actual air/ground picture — AIR beats TAXI beats GROUND
    // across every live unit in the flight. base.type === 'carrier' makes
    // the ground-state comparison relative to the carrier's own velocity
    // (see utils/carriers.js groundState) rather than absolute ground speed,
    // since a jet parked on a moving carrier otherwise reads as taxiing.
    let statusLabel = 'ACTIVE'
    if (f.lateActivation && !isLive) {
      statusLabel = 'RESERVE'
    } else if (liveLead) {
      const base = resolveBase(f)
      const isCarrierBase = base?.type === 'carrier'
      const carrierUnit = isCarrierBase ? liveByDcsId.get(base.carrierUnitId) : null
      const liveUnitsForRollup = f.manual
        ? liveMatches.map(m => m.unit)
        : f.units.map(u => findLiveUnit(u)?.unit).filter(Boolean)
      let rollup = null
      for (const lu of liveUnitsForRollup) {
        const state = lu.airborne ? 'AIR' : groundState(lu, isCarrierBase, carrierUnit)
        if (!rollup || STATE_PRIORITY[state] > STATE_PRIORITY[rollup]) rollup = state
      }
      if (rollup) statusLabel = rollup
    }

    return {
      ...f,
      numType: f.units.length > 0 ? `${f.units[0].type} x${f.units.length}` : '—',
      callsignLabel,
      // FRAG's editable Task field (store/abmMission.js taskOverrides) wins
      // over the mission's own task string when a controller has set one.
      taskLabel: (taskOverrides ?? {})[f.groupId] ?? (f.task || f.rawTask || '—'),
      taskunitLabel: airfieldAbbrev(resolveBase(f), icaoMap),
      freqLabel: f.frequency != null ? f.frequency.toFixed(3) : '—',
      isReserve: f.lateActivation && !isLive,
      statusLabel,
    }
  }), [flights, icaoMap, liveByDcsId, findLiveUnit, liveUnits, taskOverrides])

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows
    const accessor = SORT_ACCESSORS[sortKey]
    return [...rows].sort((a, b) => {
      const av = accessor(a), bv = accessor(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir
      return String(av).localeCompare(String(bv)) * sortDir
    })
  }, [rows, sortKey, sortDir])

  const style = { zoom: scale, ...(docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }) }

  return (
    <div className="ato" style={style}>
      {docked && <div className="ato-resize" onMouseDown={onResize} />}

      <div className="ato-title" onWheel={handleTitleWheel}>
        <span className="ato-title-text">Air Tasking Order</span>
        {scaleHint && <span className="ato-title-scale-hint">{Math.round(scale * 100)}%</span>}
        <span className="ato-title-right">
          {docked  && onUndock && <button className="ato-btn" onClick={onUndock} title="Undock">⬡</button>}
          {!docked && onDock   && <button className="ato-btn" onClick={onDock}   title="Dock">⬡</button>}
          {docked  && onHide   && <button className="ato-btn" onClick={onHide}   title="Hide">›</button>}
        </span>
      </div>

      <div className="ato-body">
        {rows.length === 0 && (
          <div className="ato-empty">No mission loaded.<br />Load a .miz/mission file, or add a flight manually, below.</div>
        )}

        {rows.length > 0 && (
          <>
            <div className="ato-row ato-row-header" style={{ gridTemplateColumns }}>
              {COLUMNS.map(c => (
                <span key={c.key} className="ato-col-sort" onClick={() => handleSort(c.key)} title={`Sort by ${c.label}`}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
                </span>
              ))}
              <span />
            </div>
            {sortedRows.map(row => (
              <div
                key={row.groupId}
                className="ato-row"
                style={{ gridTemplateColumns }}
                onClick={() => selectGroup(row.groupId)}
                title="Click for FRAG detail"
              >
                <span className="ato-flight-name">{row.name}</span>
                <span>{row.taskLabel}</span>
                <span>{row.numType}</span>
                <span>{row.callsignLabel}</span>
                <span className="ato-taskunit">{row.taskunitLabel}</span>
                <span>{row.freqLabel}</span>
                <span className={row.isReserve ? 'ato-reserve' : 'ato-active'}>{row.statusLabel}</span>
                <span className="ato-row-actions">
                  {row.manual && (
                    <button
                      className="ato-row-delete"
                      onClick={(e) => { e.stopPropagation(); removeFlight(row.groupId) }}
                      title="Remove flight"
                    >×</button>
                  )}
                </span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="ato-footer">
        {confirmingClear ? (
          <>
            <span className="ato-confirm-label">Clear ALL flights?</span>
            <button
              className="ato-add-btn ato-confirm-btn"
              onClick={() => { clearAllFlights(); setConfirmingClear(false) }}
            >Confirm</button>
            <button className="ato-add-btn" onClick={() => setConfirmingClear(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button className="ato-add-btn" onClick={() => setImportOpen(true)}>⬆ Load Mission</button>
            <button className="ato-add-btn" onClick={() => setAddOpen(true)}>+ Add Flight</button>
            {allFlights.some(f => !f.manual) && (
              <button className="ato-add-btn ato-clear-mission-btn" onClick={clearFlights}>✕ Clear Mission</button>
            )}
            <button className="ato-add-btn ato-clear-all-btn" onClick={() => setConfirmingClear(true)}>✕ Clear ALL</button>
          </>
        )}
      </div>

      {importOpen && <AbmMissionImport onClose={() => setImportOpen(false)} />}
      {addOpen && <AddAtoFlight onClose={() => setAddOpen(false)} />}
    </div>
  )
}
