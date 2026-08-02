import { useState, useMemo, useEffect, useRef } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useSessionStore } from '../../store/session.js'
import { getAirdromeName, preloadAirdromes } from '../../utils/airdromes.js'
import { AbmMissionImport } from './AbmMissionImport.jsx'
import './Ato.css'

export const ATO_NATURAL_WIDTH = 460

const ATO_SCALE_KEY = 'tracs.ato.scale'
const SCALE_MIN     = 0.5
const SCALE_MAX     = 2.0
const SCALE_STEP    = 0.05

const COLUMNS = [
  { key: 'pkg',      label: 'PKG',       width: 90  },
  { key: 'task',     label: 'TASK',      width: 50  },
  { key: 'num',      label: 'NUM/TYPE',  width: 70  },
  { key: 'callsign', label: 'CALLSIGN',  width: 70  },
  { key: 'taskunit', label: 'TASKUNIT',  width: 90  },
  { key: 'freq',     label: 'FREQ',      width: 58  },
  { key: 'status',   label: 'STATUS',    width: 60  },
  { key: 'scl',      label: 'SCL',       width: 1   },   // flex remainder
]

const gridTemplateColumns = COLUMNS.map(c => c.width === 1 ? '1fr' : `${c.width}px`).join(' ')

function airfieldLabel(ref) {
  if (!ref) return '—'
  if (ref.type === 'carrier')  return ref.carrierName
  if (ref.type === 'airbase')  return getAirdromeName(ref.theatre, ref.airdromeId) ?? `Airdrome #${ref.airdromeId}`
  if (ref.type === 'airstart') return 'Air Start'
  return '—'
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

function baseCallsign(name) {
  return ((name ?? '').replace(/\s*\d*$/, '') || name).toUpperCase()
}

function sclCount(pkg) {
  const names = new Set()
  for (const unit of pkg.units) {
    for (const pylon of unit.payload.pylons) {
      if (pylon.clsid) names.add(pylon.clsid)
    }
  }
  return names.size
}

const SORT_ACCESSORS = {
  pkg:      r => r.name ?? '',
  task:     r => r.task || r.rawTask || '',
  num:      r => r.units[0]?.type ?? '',
  callsign: r => baseCallsign(r.units[0]?.callsign) ?? '',
  taskunit: r => r.taskunitLabel ?? '',
  freq:     r => r.frequency ?? -1,
  status:   r => r.statusLabel ?? '',
  scl:      r => r.sclCount ?? 0,
}

export function Ato({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir = useWheelDirection()
  const allPackages = useAbmMissionStore(s => s.packages)
  const selectGroup = useAbmMissionStore(s => s.selectGroup)
  const sessionCoalition = useSessionStore(s => s.coalition)

  // An ATO tasks one side's own assets — show only the controller's
  // coalition. GM/admin aren't aligned to a side, so they see everything.
  const packages = useMemo(() => {
    if (sessionCoalition !== 'blue' && sessionCoalition !== 'red') return allPackages
    return allPackages.filter(p => p.coalition === sessionCoalition)
  }, [allPackages, sessionCoalition])

  const [importOpen, setImportOpen] = useState(false)
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState(1)   // 1 = asc, -1 = desc

  const [, setAirdromeTick] = useState(0)
  useEffect(() => {
    const theatres = new Set(packages.flatMap(p => [p.launch?.theatre, p.recovery?.theatre]).filter(Boolean))
    Promise.all([...theatres].map(preloadAirdromes)).then(() => setAirdromeTick(t => t + 1))
  }, [packages])

  const [scale, setScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem(ATO_SCALE_KEY))
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
      localStorage.setItem(ATO_SCALE_KEY, String(next))
      clearTimeout(scaleHintRef.current)
      setScaleHint(true)
      scaleHintRef.current = setTimeout(() => setScaleHint(false), 1200)
      return next
    })
  }

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => -d)
    else { setSortKey(key); setSortDir(1) }
  }

  const rows = useMemo(() => packages.map(p => ({
    ...p,
    numType: p.units.length > 0 ? `${p.units.length}x ${p.units[0].type}` : '—',
    taskunitLabel: airfieldLabel(resolveBase(p)),
    freqLabel: p.frequency != null ? p.frequency.toFixed(3) : '—',
    statusLabel: p.lateActivation ? 'RESERVE' : 'ACTIVE',
    sclCount: sclCount(p),
    sclLabel: sclCount(p) > 0 ? `${sclCount(p)} type${sclCount(p) > 1 ? 's' : ''}` : '—',
  })), [packages])

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
          <div className="ato-empty">No mission loaded.<br />Load a .miz or mission file below.</div>
        )}

        {rows.length > 0 && (
          <>
            <div className="ato-row ato-row-header" style={{ gridTemplateColumns }}>
              {COLUMNS.map(c => (
                <span key={c.key} className="ato-col-sort" onClick={() => handleSort(c.key)} title={`Sort by ${c.label}`}>
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}
                </span>
              ))}
            </div>
            {sortedRows.map(row => (
              <div
                key={row.groupId}
                className="ato-row"
                style={{ gridTemplateColumns }}
                onClick={() => selectGroup(row.groupId)}
                title="Click for FRAG detail"
              >
                <span className="ato-pkg">{row.name}</span>
                <span>{row.task || row.rawTask}</span>
                <span>{row.numType}</span>
                <span>{baseCallsign(row.units[0]?.callsign)}</span>
                <span className="ato-taskunit">{row.taskunitLabel}</span>
                <span>{row.freqLabel}</span>
                <span className={row.lateActivation ? 'ato-reserve' : 'ato-active'}>{row.statusLabel}</span>
                <span>{row.sclLabel}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="ato-footer">
        <button className="ato-add-btn" onClick={() => setImportOpen(true)}>⬆ Load Mission</button>
      </div>

      {importOpen && <AbmMissionImport onClose={() => setImportOpen(false)} />}
    </div>
  )
}
