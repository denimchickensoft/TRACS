import { useState, useMemo, useEffect, useRef } from 'react'
import { usePopupFill } from '../../utils/usePopupFill.js'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign, matchLiveByPrefix } from '../../utils/callsign.js'
import { getFlightLinks, isPlayerLink } from '../../utils/flightLinks.js'
import { flightRows } from './atoRows.js'
import { parseFlightElement } from './canvas/drawAbmContacts.js'
import { getAirdromeName, preloadAirdromes } from '../../utils/airdromes.js'
import { computeAirbaseLabels } from '../../store/runways.js'
import { groundState } from '../../utils/carriers.js'
import { AbmMissionImport } from './AbmMissionImport.jsx'
import { AddAtoFlight } from './AddAtoFlight.jsx'
import './Ato.css'
import { getIcaoMapping } from '../../utils/icaoMapping.js'
import { useUnitSystem } from '../../store/unitSystem.js'
import { formatAltRange } from './flightAlt.js'
import { formatTacan } from '../../utils/parseMission.js'

export const ATO_NATURAL_WIDTH = 508

const ATO_SCALE_KEY    = 'tracs.ato.scale'
const ATO_SORT_KEY_KEY = 'tracs.ato.sortKey'
const ATO_SORT_DIR_KEY = 'tracs.ato.sortDir'
const SCALE_MIN     = 0.5
const SCALE_MAX     = 2.0
const SCALE_STEP    = 0.05

const ATO_COLLAPSED_KEY = 'tracs.ato.collapsed'

const COLUMNS = [
  { key: 'flight',   label: 'FLIGHT',    width: 90  },
  { key: 'callsign', label: 'CALLSIGN',  width: 70  },
  { key: 'task',     label: 'TASK',      width: 50  },
  { key: 'num',      label: 'TYPE/NUM',  width: 70  },
  { key: 'taskunit', label: 'TASKUNIT',  width: 50  },
  { key: 'alt',      label: 'ALT',       width: 48  },
  { key: 'freq',     label: 'FREQ',      width: 58  },
  { key: 'tacan',    label: 'TACAN',     width: 40  },
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
  alt:      r => (r.alt?.lo ? Number(r.alt.lo) : -1),
  freq:     r => r.frequency ?? -1,
  tacan:    r => r.tacan?.channel ?? -1,
  status:   r => r.statusLabel ?? '',
}

// The text each column shows, which the search matches against.
const CELL_TEXT = {
  flight:   r => r.name,
  callsign: r => r.callsignLabel,
  task:     r => r.taskLabel,
  num:      r => r.numType,
  taskunit: r => r.taskunitLabel,
  alt:      r => r.altLabel,
  freq:     r => r.freqLabel,
  tacan:    r => r.tacanLabel,
  status:   r => r.statusLabel,
}

// Status sections, top to bottom. PLANNED: in the mission from the start
// but not seen live (not spawned yet, slots empty, or out of the source's
// view). RESERVE: late activation, not spawned yet.
const SECTIONS = ['AIR', 'TAXI', 'GROUND', 'PLANNED', 'RESERVE']
const NOT_LIVE = new Set(['PLANNED', 'RESERVE'])

function loadCollapsed() {
  try {
    const saved = JSON.parse(localStorage.getItem(ATO_COLLAPSED_KEY) ?? 'null')
    if (Array.isArray(saved)) return new Set(saved)
  } catch { /* fall through to the default */ }
  return new Set(['RESERVE'])
}

const searchNorm = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()

export function Ato({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir = useWheelDirection()
  const allFlights = useAbmMissionStore(s => s.flights)
  const selectFlight = useAbmMissionStore(s => s.selectFlight)
  const clearFlights = useAbmMissionStore(s => s.clearFlights)
  const clearAllFlights = useAbmMissionStore(s => s.clearAllFlights)
  const removeFlight = useAbmMissionStore(s => s.removeFlight)
  const taskOverrides = useAbmMissionStore(s => s.taskOverrides)
  const unitSystem    = useUnitSystem('abm')
  const sessionCoalition = useSessionStore(s => s.coalition)
  const liveUnits = useUnitsStore(s => s.units)

  // Mission-file unit -> live track (utils/flightLinks.js, shared with the
  // FRAG roster), so CALLSIGN reflects TRACS's resolved callsign (rename
  // overrides, the MP-name convention), not the mission file's.
  const links = useMemo(() => getFlightLinks(allFlights, liveUnits), [allFlights, liveUnits])

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
    getIcaoMapping().then(setIcaoMap)
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

  // One row per MP flight callsign plus a base row (atoRows.js) for an
  // imported flight; one row for a manual flight.
  const rows = useMemo(() => flights.flatMap(f => {
    const base = resolveBase(f)
    const isCarrierBase = base?.type === 'carrier'
    const carrierUnit = isCarrierBase ? liveByDcsId.get(base.carrierUnitId) : null
    const shared = {
      // FRAG's editable Task field (store/abmMission.js taskOverrides) wins
      // over the mission's own task string when a controller has set one.
      taskLabel: (taskOverrides ?? {})[f.flightId] ?? (f.task || f.rawTask || '-'),
      taskunitLabel: airfieldAbbrev(base, icaoMap),
      altLabel: formatAltRange(f.alt, unitSystem) || '-',
      freqLabel: f.frequency != null ? f.frequency.toFixed(3) : '-',
      tacanLabel: formatTacan(f.tacan, false) || '-',
    }
    // AIR beats TAXI beats GROUND across a row's live units. A carrier base
    // makes the ground state relative to the carrier's own velocity (see
    // utils/carriers.js groundState), so a jet parked on a moving deck
    // doesn't read as taxiing.
    const status = (liveList) => {
      let rollup = null
      for (const lu of liveList) {
        const state = lu.airborne ? 'AIR' : groundState(lu, isCarrierBase, carrierUnit)
        if (!rollup || STATE_PRIORITY[state] > STATE_PRIORITY[rollup]) rollup = state
      }
      if (rollup) return rollup
      return f.lateActivation ? 'RESERVE' : 'PLANNED'
    }

    if (f.manual) {
      // Manual flights (AddAtoFlight.jsx) have no DCS unit to link: every
      // live unit whose resolved callsign starts with the entered prefix.
      const matches = matchLiveByPrefix(f.callsignPrefix, liveUnits)
      const lead = matches[0]?.unit ?? null
      return [{
        ...f, ...shared, key: `${f.flightId}`, row: null,
        numType: f.units.length > 0 ? `${f.units[0].type} x${f.units.length}` : '-',
        callsignLabel: lead ? (parseFlightElement(lead)?.flightKey ?? resolveCallsign(lead).toUpperCase()) : f.name,
        callsignLive: !!lead,
        hasHuman: matches.some(m => m.unit.human === true),
        statusLabel: status(matches.map(m => m.unit)),
      }]
    }

    return flightRows(f, links).map(({ row, callsign, unitIndices }) => {
      const units = unitIndices.map(i => f.units[i])
      const live = unitIndices.map(i => links.live(f, i)).filter(Boolean)
      return {
        ...f, ...shared, key: `${f.flightId}|${row ?? ''}`, row,
        numType: units.length > 0 ? `${units[0].type} x${units.length}` : '-',
        callsignLabel: callsign ?? f.name,
        callsignLive: callsign != null,
        hasHuman: live.some(isPlayerLink),
        statusLabel: status(live.map(l => l.unit)),
      }
    })
  }), [flights, icaoMap, liveByDcsId, links, liveUnits, taskOverrides, unitSystem])

  const [query, setQuery] = useState('')
  const [queryColumn, setQueryColumn] = useState('all')
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const toggleSection = (name) => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(name) ? next.delete(name) : next.add(name)
    try { localStorage.setItem(ATO_COLLAPSED_KEY, JSON.stringify([...next])) } catch { /* per-window convenience only */ }
    return next
  })

  // Search, then the column sort, then the status sections in SECTIONS order.
  const sections = useMemo(() => {
    const q = searchNorm(query)
    const keys = queryColumn === 'all' ? COLUMNS.map(c => c.key) : [queryColumn]
    let list = q ? rows.filter(r => keys.some(k => searchNorm(CELL_TEXT[k](r)).includes(q))) : rows
    if (sortKey) {
      const accessor = SORT_ACCESSORS[sortKey]
      list = [...list].sort((a, b) => {
        const av = accessor(a), bv = accessor(b)
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir
        return String(av).localeCompare(String(bv)) * sortDir
      })
    }
    return SECTIONS
      .map(name => ({ name, rows: list.filter(r => r.statusLabel === name) }))
      .filter(sec => sec.rows.length > 0)
  }, [rows, query, queryColumn, sortKey, sortDir])

  // Popped out: fill the window, with the rows scrolling under the header
  const fill  = usePopupFill(scale, !docked)
  const style = { zoom: scale, ...(fill ?? (width ? { width, minWidth: width } : { flex: 1, minWidth: 0 })) }

  return (
    <div className={`ato${fill ? ' popup-fill' : ''}`} style={style}>
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

      <div className="ato-search">
        <input
          className="ato-search-input"
          value={query}
          placeholder="Search"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }}
        />
        <select className="ato-search-column" value={queryColumn} onChange={(e) => setQueryColumn(e.target.value)}>
          <option value="all">ALL</option>
          {COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>

      <div className="ato-body">
        {rows.length === 0 && (
          <div className="ato-empty">No mission loaded.<br />Load a .miz/mission file, or add a flight manually, below.</div>
        )}
        {rows.length > 0 && sections.length === 0 && (
          <div className="ato-empty">No flights match.</div>
        )}

        {sections.length > 0 && (
          <>
            <div className="ato-row ato-row-header" style={{ gridTemplateColumns }}>
              {COLUMNS.map(c => (
                <span key={c.key} className="ato-col-sort" onClick={() => handleSort(c.key)} title={`Sort by ${c.label}`}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
                </span>
              ))}
              <span />
            </div>
            {sections.map(sec => {
              const isCollapsed = collapsed.has(sec.name)
              return (
                <div key={sec.name} className="ato-section">
                  <div className={`ato-section-header ato-st-${sec.name.toLowerCase()}`} onClick={() => toggleSection(sec.name)}>
                    <span className="ato-section-caret">{isCollapsed ? '▸' : '▾'}</span>
                    {sec.name}
                    <span className="ato-section-count">{sec.rows.length}</span>
                  </div>
                  {!isCollapsed && sec.rows.map((row, i) => (
                    <div
                      key={row.key}
                      className={['ato-row', i % 2 ? 'ato-row-alt' : '', NOT_LIVE.has(row.statusLabel) ? 'ato-row-dim' : ''].join(' ').trim()}
                      style={{ gridTemplateColumns }}
                      onClick={() => selectFlight(row.flightId, { row: row.row })}
                    >
                      <span className="ato-cell ato-flight-name" title={row.name}>{row.name}</span>
                      <span className={`ato-cell ${row.callsignLive ? 'ato-cs-live' : 'ato-cs-static'}`} title={row.callsignLabel}>{row.callsignLabel}</span>
                      <span className="ato-cell" title={row.taskLabel}>{row.taskLabel}</span>
                      <span className="ato-cell" title={row.numType}>{row.numType}</span>
                      <span className="ato-cell ato-taskunit" title={row.taskunitLabel}>{row.taskunitLabel}</span>
                      <span className="ato-cell" title={row.altLabel}>{row.altLabel}</span>
                      <span
                        className={`ato-cell ato-freq${row.hasHuman ? ' ato-freq-dim' : ''}`}
                        title={`${row.freqLabel} - click to open the lead's COMM`}
                        onClick={(e) => { e.stopPropagation(); selectFlight(row.flightId, { row: row.row, expandLeadComm: true }) }}
                      >{row.freqLabel}</span>
                      <span className="ato-cell" title={formatTacan(row.tacan) || row.tacanLabel}>{row.tacanLabel}</span>
                      <span className={`ato-cell ato-st-${row.statusLabel.toLowerCase()}`}>{row.statusLabel}</span>
                      <span className="ato-row-actions">
                        {row.manual && (
                          <button
                            className="ato-row-delete"
                            onClick={(e) => { e.stopPropagation(); removeFlight(row.flightId) }}
                            title="Remove flight"
                          >×</button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )
            })}
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
