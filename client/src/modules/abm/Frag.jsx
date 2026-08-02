import { useMemo, useState, useEffect, useRef } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { typeAbbrev } from './canvas/drawAbmContacts.js'
import { getOrdnanceName, preloadOrdnanceDb } from '../../utils/ordnance.js'
import { getAirdromeName, preloadAirdromes } from '../../utils/airdromes.js'
import './Frag.css'

const FRAG_SCALE_KEY = 'tracs.frag.scale'
const SCALE_MIN      = 0.5
const SCALE_MAX      = 2.0
const SCALE_STEP     = 0.05

function airfieldLabel(ref) {
  if (!ref) return 'Unknown'
  if (ref.type === 'carrier')  return ref.carrierName
  if (ref.type === 'airbase')  return getAirdromeName(ref.theatre, ref.airdromeId) ?? `Airdrome #${ref.airdromeId}`
  if (ref.type === 'airstart') return 'Air Start'
  return 'Unknown'
}

// "Base" — a package's operating airfield, defined by whichever of
// departure (launch) or arrival (recovery) the mission actually captured.
// Departure wins when both are known; air-start flights fall back to
// recovery, since the mission never recorded a takeoff point for them.
function resolveBase(pkg) {
  if (pkg.launch?.type && pkg.launch.type !== 'airstart') return pkg.launch
  if (pkg.recovery?.type && pkg.recovery.type !== 'unknown') return pkg.recovery
  return pkg.launch
}

function fmtAlt(m) {
  if (m == null) return '—'
  return `${Math.round(m * 3.28084).toLocaleString()} FT`
}

function fmtSpeed(mps) {
  if (mps == null) return '—'
  return `${Math.round(mps * 1.94384)} KT`
}

function radioPresets(radio) {
  return Object.entries(radio.channels ?? {})
    .filter(([, freq]) => freq != null && freq !== 0)
    .map(([preset, freq]) => ({
      preset,
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
  const packages = useAbmMissionStore(s => s.packages)
  const selectedGroupId = useAbmMissionStore(s => s.selectedGroupId)
  const liveUnits = useUnitsStore(s => s.units)

  // Mission-file unit -> live Olympus unit, matched on DCS's own numeric
  // unit ID (mission file's unitId === live unit's unitID). Lets the roster
  // show how TRACS is actually resolving each aircraft's callsign right
  // next to what the mission designer named it.
  const liveByDcsId = useMemo(() => {
    const m = new Map()
    for (const u of Object.values(liveUnits)) {
      if (u.unitID != null) m.set(u.unitID, u)
    }
    return m
  }, [liveUnits])

  const [, setOrdnanceTick] = useState(0)
  useEffect(() => { preloadOrdnanceDb().then(() => setOrdnanceTick(t => t + 1)) }, [])

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
    e.preventDefault()
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
  const pkg = useMemo(() => {
    const found = packages.find(p => p.groupId === selectedGroupId) ?? null
    if (!found) return null
    if (sessionCoalition !== 'blue' && sessionCoalition !== 'red') return found
    return found.coalition === sessionCoalition ? found : null
  }, [packages, selectedGroupId, sessionCoalition])

  const [, setAirdromeTick] = useState(0)
  useEffect(() => {
    const theatre = pkg?.launch?.theatre ?? pkg?.recovery?.theatre
    if (theatre) preloadAirdromes(theatre).then(() => setAirdromeTick(t => t + 1))
  }, [pkg])

  const style = { zoom: scale, ...(docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }) }

  return (
    <div className="frag" style={style}>
      {docked && <div className="frag-resize" onMouseDown={onResize} />}

      <div className="frag-title" onWheel={handleTitleWheel}>
        <span className="frag-title-text">{pkg ? pkg.name : 'FRAG'}</span>
        {scaleHint && <span className="frag-title-scale-hint">{Math.round(scale * 100)}%</span>}
        <span className="frag-title-right">
          {docked  && onUndock && <button className="frag-btn" onClick={onUndock} title="Undock">⬡</button>}
          {!docked && onDock   && <button className="frag-btn" onClick={onDock}   title="Dock">⬡</button>}
          {docked  && onHide   && <button className="frag-btn" onClick={onHide}   title="Hide">›</button>}
        </span>
      </div>

      <div className="frag-body">
        {!pkg && (
          <div className="frag-empty">
            Ctrl+Shift+Click a contact on the scope,<br />or select a package from ATO.
          </div>
        )}

        {pkg && (
          <>
            <div className="frag-section">
              <div className="frag-section-label">TASKING</div>
              <div className="frag-kv"><span>Task</span><span>{pkg.task || pkg.rawTask}</span></div>
              <div className="frag-kv"><span>Base</span><span>{airfieldLabel(resolveBase(pkg))}</span></div>
              <div className="frag-kv"><span>Status</span><span className={pkg.lateActivation ? 'frag-reserve' : 'frag-active'}>{pkg.lateActivation ? 'RESERVE' : 'ACTIVE'}</span></div>
            </div>

            <div className="frag-section">
              <div className="frag-section-label">ROSTER ({pkg.units.length})</div>
              {pkg.units.map(u => {
                const liveUnit = liveByDcsId.get(u.unitId)
                const tracsCallsign = liveUnit ? resolveCallsign(liveUnit) : null
                return (
                <div key={u.unitId} className="frag-unit">
                  <div className="frag-unit-header">
                    <span className="frag-unit-cs">{u.callsign.toUpperCase()}</span>
                    <span className="frag-unit-type">{typeAbbrev({ name: u.rawType })}</span>
                    <span className="frag-unit-tcs">{tracsCallsign ? tracsCallsign.toUpperCase() : '—'}</span>
                    <span className="frag-unit-mdx">#{u.modex}</span>
                    <span className={['frag-unit-skl', u.skill === 'Client' ? 'client' : ''].join(' ')}>{u.skill}</span>
                  </div>
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
                                      <span className="frag-radio-ch">CH {p.preset}</span>
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
            </div>

            <div className="frag-section frag-section-grow">
              <div className="frag-section-label">ROUTE</div>
              <div className="frag-route">
                {pkg.route.map((wp, i) => (
                  <div key={i} className="frag-wp">
                    <span className="frag-wp-name">{wp.name ?? `WP${i + 1}`}</span>
                    <span className="frag-wp-alt">{fmtAlt(wp.alt)}</span>
                    <span className="frag-wp-speed">{fmtSpeed(wp.speed)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
