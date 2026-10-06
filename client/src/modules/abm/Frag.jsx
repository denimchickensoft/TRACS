import { useMemo, useState, useEffect, useRef } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign, matchLiveByPrefix, buildLiveUnitLookup, stripAcid } from '../../utils/callsign.js'
import { typeAbbrev } from './canvas/drawAbmContacts.js'
import { getOrdnanceName, preloadOrdnanceDb } from '../../utils/ordnance.js'
import { getAirdromeName, preloadAirdromes } from '../../utils/airdromes.js'
import { computeAirbaseLabels } from '../../store/runways.js'
import { groundState } from '../../utils/carriers.js'
import { ZERO_INDEXED_WAYPOINT_TYPES } from '../../utils/parseMission.js'
import './Frag.css'
import { altFromM, altUnit, speedFromMs, speedUnit } from '../../utils/units.js'
import { useUnitSystem } from '../../store/unitSystem.js'
import { getIcaoMapping } from '../../utils/icaoMapping.js'

const FRAG_SCALE_KEY = 'tracs.frag.scale'
const SCALE_MIN      = 0.5
const SCALE_MAX      = 2.0
const SCALE_STEP     = 0.05

// Flight-level rollup when 2+ units disagree (e.g. staggered catapult
// launches mid-flight) — the most-advanced state wins. Same as Ato.jsx.
const STATE_PRIORITY = { AIR: 3, TAXI: 2, GROUND: 1 }

// Non-airborne per-unit state — 'AIR' | 'TAXI' | 'GROUND'.
function unitState(liveUnit, isCarrierBase, carrierUnit) {
  return liveUnit.airborne ? 'AIR' : groundState(liveUnit, isCarrierBase, carrierUnit)
}

// Mode 1/2/3 IFF assignment fields — one per roster row (imported or
// manual). `onSetIff` commits directly to the store on each field's blur;
// for a manual flight it also has to ensure the roster row exists first
// (Ctrl+Shift+Click's ensureManualRosterEntry already does this for
// click-created rows, but a row typed straight into FRAG hasn't necessarily
// gone through that path yet).
function IffFields({ iff, onSetIff }) {
  const [draft, setDraft] = useState({
    mode1: iff?.mode1 ?? '', mode2: iff?.mode2 ?? '', mode3: iff?.mode3 ?? '',
  })
  useEffect(() => {
    setDraft({ mode1: iff?.mode1 ?? '', mode2: iff?.mode2 ?? '', mode3: iff?.mode3 ?? '' })
  }, [iff?.mode1, iff?.mode2, iff?.mode3])

  // Mode 1 is a real 2-digit octal code (00-73); Mode 2/3 are 4-digit — same
  // distinction drawAbmContacts.js's buildIffFrames() display already makes.
  function commit(field, value, maxLen) {
    const digits = value.replace(/\D/g, '').slice(0, maxLen)
    setDraft((d) => ({ ...d, [field]: digits }))
    onSetIff({ [field]: digits === '' ? null : digits })
  }

  return (
    <div className="frag-iff-row">
      <label className="frag-iff-field">
        <span>M1</span>
        <input value={draft.mode1} onChange={(e) => commit('mode1', e.target.value, 2)} maxLength={2} placeholder="--" />
      </label>
      <label className="frag-iff-field">
        <span>M2</span>
        <input value={draft.mode2} onChange={(e) => commit('mode2', e.target.value, 4)} maxLength={4} placeholder="----" />
      </label>
      <label className="frag-iff-field">
        <span>M3</span>
        <input value={draft.mode3} onChange={(e) => commit('mode3', e.target.value, 4)} maxLength={4} placeholder="----" />
      </label>
    </div>
  )
}

// Manual flights' "+ Add Aircraft" input — types a callsign straight into
// the flight's iffRoster (via ensureManualRosterEntry, same store path
// Ctrl+Shift+Click uses) without needing the aircraft to be live/visible
// yet. Lets a controller pre-assign an IFF code before a flight checks in.
function AddAircraftRow({ onAdd }) {
  const [value, setValue] = useState('')
  function submit() {
    const cs = stripAcid(value)
    if (!cs) return
    onAdd(cs)
    setValue('')
  }
  return (
    <div className="frag-add-aircraft">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
        placeholder="CALLSIGN"
        maxLength={16}
      />
      <button type="button" onClick={submit} disabled={!value.trim()}>+ ADD AIRCRAFT</button>
    </div>
  )
}

// Full name + "(ICAO/abbrev)" — unlike ATO's TASKUNIT column, which shows
// only the abbreviated form. Falls back to the same first-4-letters scheme
// store/runways.js uses for airports with no icaoMapping.json entry.
function airfieldLabel(ref, icaoMap) {
  if (!ref) return 'Unknown'
  if (ref.type === 'carrier') {
    return ref.carrierAbbrev ? `${ref.carrierName} (${ref.carrierAbbrev})` : ref.carrierName
  }
  if (ref.type === 'airbase') {
    const name = getAirdromeName(ref.theatre, ref.airdromeId)
    if (!name) return `Airdrome #${ref.airdromeId}`
    const icao   = icaoMap[ref.theatre?.toLowerCase()]?.[name]
    const abbrev = icao ?? computeAirbaseLabels([name])[name]
    return `${name} (${abbrev})`
  }
  if (ref.type === 'airstart') return 'Air Start'
  return 'Unknown'
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

function fmtAlt(m, sys) {
  if (m == null) return '—'
  return `${Math.round(altFromM(m, sys)).toLocaleString()} ${altUnit(sys)}`
}

function fmtSpeed(mps, sys) {
  if (mps == null) return '—'
  return `${Math.round(speedFromMs(mps, sys))} ${speedUnit(sys)}`
}

function radioPresets(radio) {
  return Object.entries(radio.channels ?? {})
    .filter(([, freq]) => freq != null && freq !== 0)
    .map(([preset, freq]) => ({
      preset,
      channel: Number(preset) + 1,
      freq: Number(freq),
      mod: radio.modulations?.[preset] === 1 ? 'FM' : 'AM',
    }))
    .sort((a, b) => Number(a.preset) - Number(b.preset))
}

// Group identical loadout items (e.g. 2x GBU-31, 2x AIM-9M) rather than
// listing each pylon separately.
function ordnanceSummary(unit) {
  const counts = new Map()
  for (const p of unit.payload.pylons) {
    if (!p.clsid) continue
    const name = getOrdnanceName(p.clsid)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
}

export function Frag({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir = useWheelDirection()
  const flights = useAbmMissionStore(s => s.flights)
  const unitSystem = useUnitSystem('abm')
  const selectedGroupId = useAbmMissionStore(s => s.selectedGroupId)
  const requestFind = useAbmMissionStore(s => s.requestFind)
  const findKey = useAbmMissionStore(s => s.findKey)
  const toggleBlink = useAbmMissionStore(s => s.toggleBlink)
  const routeVisible = useAbmMissionStore(s => s.routeVisible)
  const toggleRouteVisible = useAbmMissionStore(s => s.toggleRouteVisible)
  const blinkIds = useAbmMissionStore(s => s.blinkIds) ?? []
  const taskOverrides = useAbmMissionStore(s => s.taskOverrides) ?? {}
  const setTaskOverride = useAbmMissionStore(s => s.setTaskOverride)
  const liveUnits = useUnitsStore(s => s.units)

  // Mission-file unit -> live track. See utils/callsign.js's
  // buildLiveUnitLookup for the two-tier strategy (numeric unitId for
  // Olympus, normalized-callsign text for Tacview — Tacview's unitID has no
  // relationship to the mission file's unitId for AI-placed units, so a
  // numeric-only lookup silently fails for every Tacview session). Lets the roster
  // show how TRACS is actually resolving each aircraft's callsign right
  // next to what the mission designer named it.
  const findLiveUnit = useMemo(() => buildLiveUnitLookup(liveUnits), [liveUnits])

  // Raw numeric-only map, kept only for the carrier lookup below — a bare
  // carrierUnitId number has no callsign to fall back on, so that one case
  // still can't be fixed the same way (a separate, not-yet-solved problem
  // for Tacview-sourced carrier flights specifically).
  const liveByDcsId = useMemo(() => {
    const m = new Map()
    for (const u of Object.values(liveUnits)) {
      if (u.unitID != null) m.set(u.unitID, u)
    }
    return m
  }, [liveUnits])

  const [, setOrdnanceTick] = useState(0)
  useEffect(() => { preloadOrdnanceDb().then(() => setOrdnanceTick(t => t + 1)) }, [])

  // Real ICAO codes (client/public/icaoMapping.json), same fetch AbmScope.jsx
  // and Ato.jsx do — needed for the Base line's "(ICAO/abbrev)" suffix.
  const [icaoMap, setIcaoMap] = useState({})
  useEffect(() => {
    getIcaoMapping().then(setIcaoMap)
  }, [])

  const [expandedRadios, setExpandedRadios] = useState(new Set())
  const toggleRadio = (key) => setExpandedRadios(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const [scale, setScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem(FRAG_SCALE_KEY))
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
      localStorage.setItem(FRAG_SCALE_KEY, String(next))
      clearTimeout(scaleHintRef.current)
      setScaleHint(true)
      scaleHintRef.current = setTimeout(() => setScaleHint(false), 1200)
      return next
    })
  }

  const sessionCoalition = useSessionStore(s => s.coalition)

  // Same restriction as ATO — GM/admin sees any coalition, blue/red only
  // their own side. Defense-in-depth: AbmScope's click handler already
  // blocks selecting a foreign-coalition group, this just guarantees FRAG
  // itself never renders one regardless of how selectedGroupId got set.
  const flight = useMemo(() => {
    const found = flights.find(f => f.groupId === selectedGroupId) ?? null
    if (!found) return null
    if (sessionCoalition !== 'blue' && sessionCoalition !== 'red') return found
    return found.coalition === sessionCoalition ? found : null
  }, [flights, selectedGroupId, sessionCoalition])

  const [, setAirdromeTick] = useState(0)
  useEffect(() => {
    const theatre = flight?.launch?.theatre ?? flight?.recovery?.theatre
    if (theatre) preloadAirdromes(theatre).then(() => setAirdromeTick(t => t + 1))
  }, [flight])

  // Editable TASKING/Task field — a controller override of the mission's
  // own task string (store/abmMission.js taskOverrides, keyed by groupId),
  // which ATO's TASK column reads too. Local draft state resets only when
  // the selected flight changes (not on every taskOverrides update from
  // elsewhere), so an in-progress edit here never gets clobbered by e.g. a
  // cross-window sync echo of the same store.
  const [taskDraft, setTaskDraft] = useState('')
  useEffect(() => {
    setTaskDraft(flight ? (taskOverrides[flight.groupId] ?? (flight.task || flight.rawTask || '')) : '')
  }, [flight?.groupId]) // eslint-disable-line

  const commitTask = () => {
    if (!flight) return
    setTaskOverride(flight.groupId, taskDraft.trim() || null)
  }

  // Shared by the flight-level Status line and each roster row's granular
  // state below — carrierUnit is the live carrier Olympus unit a
  // carrier-based flight's TASKUNIT resolves to, used to compare a
  // non-airborne unit's velocity against the ship's own (see
  // utils/carriers.js groundState) rather than absolute ground speed.
  const flightBase          = flight ? resolveBase(flight) : null
  const flightIsCarrierBase = flightBase?.type === 'carrier'
  const flightCarrierUnit   = flightIsCarrierBase ? liveByDcsId.get(flightBase.carrierUnitId) : null

  // Manual flights (AddAtoFlight.jsx) have no DCS unitId — matched by
  // callsign *prefix* instead (Ato.jsx does the same), since there's no
  // reliable way to predict whether DCS resolves elements as "SHELL1"/
  // "SHELL2" or "SHELL31"/"SHELL32". Every live unit whose resolved
  // callsign starts with the entered prefix is a match.
  const flightLiveMatches = flight?.manual ? matchLiveByPrefix(flight.callsignPrefix, liveUnits) : []

  const style = { zoom: scale, ...(docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }) }

  return (
    <div className="frag" style={style}>
      {docked && <div className="frag-resize" onMouseDown={onResize} />}

      <div className="frag-title" onWheel={handleTitleWheel}>
        <span className="frag-title-text">{flight ? flight.name : 'FRAG'}</span>
        {scaleHint && <span className="frag-title-scale-hint">{Math.round(scale * 100)}%</span>}
        <span className="frag-title-right">
          {docked  && onUndock && <button className="frag-btn" onClick={onUndock} title="Undock">⬡</button>}
          {!docked && onDock   && <button className="frag-btn" onClick={onDock}   title="Dock">⬡</button>}
          {docked  && onHide   && <button className="frag-btn" onClick={onHide}   title="Hide">›</button>}
        </span>
      </div>

      <div className="frag-body">
        {!flight && (
          <div className="frag-empty">
            Ctrl+Shift+Click a contact on the scope,<br />or select a flight from ATO.
          </div>
        )}

        {flight && (
          <>
            <div className="frag-section">
              <div className="frag-section-label">TASKING</div>
              <div className="frag-kv">
                <span>Task</span>
                <input
                  className="frag-task-input"
                  value={taskDraft}
                  onChange={(e) => setTaskDraft(e.target.value)}
                  onBlur={commitTask}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                  spellCheck={false}
                />
              </div>
              <div className="frag-kv">
                <span>Base</span>
                {(() => {
                  const base = resolveBase(flight)
                  const findable = base?.type === 'airbase' || base?.type === 'carrier'
                  const baseKey = `base-${flight.groupId}`
                  const isActive = findable && findKey === baseKey
                  return (
                    <span
                      className={[findable ? 'frag-base-findable' : '', isActive ? 'frag-find-active' : ''].join(' ').trim()}
                      onClick={findable ? () => requestFind(isActive ? null : base, isActive ? null : baseKey) : undefined}
                      title={findable ? 'Highlight on scope' : undefined}
                    >
                      {airfieldLabel(base, icaoMap)}
                    </span>
                  )
                })()}
              </div>
              {(() => {
                // RESERVE only means "not spawned yet" — same live check as
                // ATO's STATUS column (Ato.jsx): a late-activation group
                // that's since been triggered in-game is ACTIVE regardless
                // of the mission file's static flag. Once the lead is live
                // (CALLSIGN populated — same gate the roster's TCS column
                // uses), ACTIVE is replaced by the flight's actual
                // air/ground picture — AIR beats TAXI beats GROUND across
                // every live unit in the flight.
                const liveLead  = flight.manual
                  ? (flightLiveMatches[0]?.unit ?? null)
                  : (flight.units[0] ? findLiveUnit(flight.units[0])?.unit ?? null : null)
                const isReserve = flight.lateActivation && !(flight.manual
                  ? flightLiveMatches.length > 0
                  : flight.units.some(u => findLiveUnit(u)))
                let statusLabel = 'ACTIVE'
                if (isReserve) {
                  statusLabel = 'RESERVE'
                } else if (liveLead) {
                  const liveUnitsForRollup = flight.manual
                    ? flightLiveMatches.map(m => m.unit)
                    : flight.units.map(u => findLiveUnit(u)?.unit).filter(Boolean)
                  let rollup = null
                  for (const lu of liveUnitsForRollup) {
                    const state = unitState(lu, flightIsCarrierBase, flightCarrierUnit)
                    if (!rollup || STATE_PRIORITY[state] > STATE_PRIORITY[rollup]) rollup = state
                  }
                  if (rollup) statusLabel = rollup
                }
                return (
                  <div className="frag-kv">
                    <span>Status</span>
                    <span className={isReserve ? 'frag-reserve' : 'frag-active'}>{statusLabel}</span>
                  </div>
                )
              })()}
            </div>

            <div className="frag-section">
              {flight.manual ? (
                // Manual flights have no mission-file roster. Two sources
                // merged into one list: live callsign-prefix matches
                // (Ato.jsx's same matchLiveByPrefix — any live aircraft
                // whose callsign starts with this flight's prefix shows up
                // automatically, no explicit add needed) and iffRoster rows
                // with no current live match — a callsign added via "+ Add
                // Aircraft" (or a prior click) before that aircraft is
                // actually live/visible, shown as PENDING so an assigned
                // code can be set ahead of check-in. No mission data exists
                // for ordnance/radios/link16/modex/skill on either kind, so
                // those simply aren't shown.
                (() => {
                  const liveCallsigns = new Set(flightLiveMatches.map(m => m.callsign))
                  const pendingRows = (flight.iffRoster ?? []).filter(u => !liveCallsigns.has(u.callsign))
                  return (
                    <>
                      <div className="frag-section-label">ROSTER ({flightLiveMatches.length + pendingRows.length})</div>
                      {flightLiveMatches.map(m => {
                        const isBlinking = blinkIds.includes(m.key)
                        const state = unitState(m.unit, flightIsCarrierBase, flightCarrierUnit)
                        const rosterRow = flight.iffRoster?.find(u => u.callsign === m.callsign)
                        return (
                          <div key={m.key} className="frag-unit">
                            <div
                              className={['frag-unit-header', 'frag-unit-findable', isBlinking ? 'frag-unit-blinking' : ''].join(' ').trim()}
                              onClick={() => toggleBlink(m.key)}
                              title="Blink datablock on scope"
                            >
                              <span className="frag-unit-cs">{m.callsign}</span>
                              <span className="frag-unit-type">{typeAbbrev(m.unit)}</span>
                              <span className={['frag-unit-state', `frag-unit-state-${state.toLowerCase()}`].join(' ')}>{state}</span>
                              {rosterRow && (
                                <button
                                  type="button"
                                  className="frag-unit-remove"
                                  title="Remove from roster"
                                  onClick={(e) => { e.stopPropagation(); useAbmMissionStore.getState().removeManualRosterEntry(flight.groupId, m.callsign) }}
                                >×</button>
                              )}
                            </div>
                            <IffFields
                              iff={rosterRow?.iff}
                              onSetIff={(patch) => {
                                const mission = useAbmMissionStore.getState()
                                mission.ensureManualRosterEntry(flight.callsignPrefix, m.callsign, flight.coalition ?? sessionCoalition)
                                mission.setUnitIff(flight.groupId, m.callsign, patch)
                              }}
                            />
                          </div>
                        )
                      })}
                      {pendingRows.map(r => (
                        <div key={r.callsign} className="frag-unit">
                          <div className="frag-unit-header">
                            <span className="frag-unit-cs">{r.callsign}</span>
                            <span className="frag-unit-state frag-unit-state-pending">PENDING</span>
                            <button
                              type="button"
                              className="frag-unit-remove"
                              title="Remove from roster"
                              onClick={() => useAbmMissionStore.getState().removeManualRosterEntry(flight.groupId, r.callsign)}
                            >×</button>
                          </div>
                          <IffFields
                            iff={r.iff}
                            onSetIff={(patch) => useAbmMissionStore.getState().setUnitIff(flight.groupId, r.callsign, patch)}
                          />
                        </div>
                      ))}
                      <AddAircraftRow
                        onAdd={(callsign) => useAbmMissionStore.getState().ensureManualRosterEntry(flight.callsignPrefix, callsign, flight.coalition ?? sessionCoalition)}
                      />
                    </>
                  )
                })()
              ) : (
                <>
                  <div className="frag-section-label">ROSTER ({flight.units.length})</div>
                  {flight.units.map(u => {
                    const found = findLiveUnit(u)
                    const liveUnit = found?.unit ?? null
                    const liveKey = found?.key ?? null
                    const tracsCallsign = liveUnit ? resolveCallsign(liveUnit) : null
                    const findable = liveKey != null
                    const isBlinking = findable && blinkIds.includes(liveKey)
                    // Granular per-unit air/ground state — the flight-level
                    // Status line above only shows the rolled-up worst/best case.
                    const state = liveUnit ? unitState(liveUnit, flightIsCarrierBase, flightCarrierUnit) : null
                    return (
                    <div key={u.unitId} className="frag-unit">
                      <div
                        className={['frag-unit-header', findable ? 'frag-unit-findable' : '', isBlinking ? 'frag-unit-blinking' : ''].join(' ').trim()}
                        onClick={findable ? () => toggleBlink(liveKey) : undefined}
                        title={findable ? 'Blink datablock on scope' : undefined}
                      >
                        <span className="frag-unit-cs">{u.callsign.toUpperCase()}</span>
                        <span className="frag-unit-type">{typeAbbrev({ name: u.rawType })}</span>
                        <span className="frag-unit-tcs">{tracsCallsign ? tracsCallsign.toUpperCase() : '—'}</span>
                        <span className="frag-unit-mdx">#{u.modex}</span>
                        <span className={['frag-unit-skl', u.skill === 'Client' ? 'client' : ''].join(' ')}>{u.skill}</span>
                        <span className={['frag-unit-state', state ? `frag-unit-state-${state.toLowerCase()}` : ''].join(' ').trim()}>{state ?? '—'}</span>
                      </div>
                      <IffFields
                        iff={u.iff}
                        onSetIff={(patch) => useAbmMissionStore.getState().setUnitIff(flight.groupId, u.callsign, patch)}
                      />
                      {(() => { const ord = ordnanceSummary(u); return ord.length > 0 && (
                        <div className="frag-ordnance">
                          {ord.map(([name, qty], i) => (
                            <div key={i} className="frag-ord-row">
                              <span className="frag-ord-name">{name}</span>
                              <span className="frag-ord-qty">x{qty}</span>
                            </div>
                          ))}
                        </div>
                      ) })()}
                      {u.radios.some(r => radioPresets(r).length > 0) && (() => {
                        const expanded = expandedRadios.has(u.unitId)
                        return (
                          <div className="frag-radio-block">
                            <div className="frag-radio-toggle" onClick={() => toggleRadio(u.unitId)}>
                              <span className="frag-radio-caret">{expanded ? '▾' : '▸'}</span>COMM
                            </div>
                            {expanded && (
                              <div className="frag-radios">
                                {u.radios.map((r, ri) => {
                                  const presets = radioPresets(r)
                                  if (presets.length === 0) return null
                                  return (
                                    <div key={ri} className="frag-radio">
                                      <div className="frag-radio-label">COMM{ri + 1}</div>
                                      {presets.map(p => (
                                        <div key={p.preset} className="frag-radio-row">
                                          <span className="frag-radio-ch">CH {p.channel}</span>
                                          <span className="frag-radio-fm">
                                            <span className="frag-radio-freq">{p.freq.toFixed(3)}</span>{' '}
                                            <span className="frag-radio-mod">{p.mod}</span>
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                      {u.link16.stn && (
                        <div className="frag-link16">L16 STN {u.link16.stn}</div>
                      )}
                    </div>
                    )
                  })}
                </>
              )}
            </div>

            {flight.route?.length > 0 && (
            <div className="frag-section frag-section-grow">
              <div
                className={['frag-section-label', 'frag-route-toggle', routeVisible ? 'frag-find-active' : ''].join(' ').trim()}
                onClick={toggleRouteVisible}
                title={routeVisible ? 'Hide route on scope' : 'Show route on scope'}
              >ROUTE</div>
              <div className="frag-route">
                {(() => {
                  // Hornet's own cockpit numbers waypoints one behind the
                  // mission editor's route order (confirmed in-sim) — see
                  // ZERO_INDEXED_WAYPOINT_TYPES for the aircraft this is
                  // verified for; everyone else keeps the natural 1-based
                  // ME numbering until similarly confirmed.
                  const wpLabelOffset = ZERO_INDEXED_WAYPOINT_TYPES.has(flight.units?.[0]?.rawType) ? 0 : 1
                  return (flight.route ?? []).map((wp, i) => {
                    const wpName = wp.name ?? `WP${i + wpLabelOffset}`
                    const findable = wp.lat != null && wp.lng != null
                    const wpKey = `wp-${flight.groupId}-${i}`
                    const isActive = findable && findKey === wpKey
                    return (
                      <div
                        key={i}
                        className={['frag-wp', findable ? 'frag-wp-findable' : '', isActive ? 'frag-find-active' : ''].join(' ').trim()}
                        onClick={findable ? () => requestFind(isActive ? null : { type: 'point', lat: wp.lat, lng: wp.lng, id: wpName }, isActive ? null : wpKey) : undefined}
                        title={findable ? 'Highlight on scope' : undefined}
                      >
                        <span className="frag-wp-idx">{i + wpLabelOffset}</span>
                        <span className="frag-wp-name">{wpName}</span>
                        <span className="frag-wp-alt">{fmtAlt(wp.alt, unitSystem)}</span>
                        <span className="frag-wp-speed">{fmtSpeed(wp.speed, unitSystem)}</span>
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
