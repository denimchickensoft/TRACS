import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAicStore, getAicEffectiveDeclaration } from '../../store/aic.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { useSessionStore } from '../../store/session.js'
import { computeMagvar } from '../../utils/magvar.js'
import { gridBearingRangeNm, trueBearingRangeNm, toMagneticFromTrue } from '../../utils/bearing.js'
import { DECL_COLOR } from '../../utils/declarationSymbols.js'
import { computeAicIntercept } from './aicGeometry.js'
import { BRAA_SORT_KEYS, DEFAULT_BRAA_SORT, sortBraaRows } from './braaSort.js'
import './BraaList.css'
import { speedFlags, findCoalitionBullseye, isOwnSide } from '../../utils/tacticalHelpers.js'
import { altFromM, altUnit, formatDistance, METRIC } from '../../utils/units.js'
import { useUnitSystem } from '../../store/unitSystem.js'

const safeNum = (v, d = 0) => (typeof v === 'number' && isFinite(v)) ? v : d

// ── Geometry ─────────────────────────────────────────────────────────────────

function computeBraa(fighter, bogey, declinationDeg, theatre) {
  const fp = fighter.position, bp = bogey.position
  if (!fp || !bp) return null

  // Displayed BRAA bearing needs the grid-frame bearing (matches the canvas/
  // DCS convention — see utils/bearing.js). The aspect angle below needs the
  // separate real-true bearing instead, to stay in the same frame as
  // bogey.track (which is genuinely real-true, derived by Olympus from
  // lat/lng samples) — grid-converting one side of that comparison and not
  // the other would introduce the exact mismatch this whole fix is about.
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(fp.lat, fp.lng, bp.lat, bp.lng, theatre)
  const magBrgDeg = toMagneticFromTrue(gridBearingDeg, declinationDeg)

  // Aspect: angle between bogey track and bearing back to fighter
  const { trueBearingDeg: trueBrgDeg } = trueBearingRangeNm(fp.lat, fp.lng, bp.lat, bp.lng)
  const bogeyTrackDeg     = ((safeNum(bogey.track) * 180 / Math.PI) + 360) % 360
  const brgToFighterDeg   = (trueBrgDeg + 180) % 360
  let   aspectAngle = ((bogeyTrackDeg - brgToFighterDeg) + 360) % 360
  if (aspectAngle > 180) aspectAngle = 360 - aspectAngle

  const aspect = aspectAngle <= 30  ? 'HOT'
               : aspectAngle <= 60  ? 'FLANK'
               : aspectAngle <= 120 ? 'BEAM'
               : 'COLD'

  return {
    bearing: Math.round(magBrgDeg) || 360,
    range:   Math.round(rangeNm), // sort key
    rangeNm,
    altM:    bp.alt ?? 0,
    aspect,
  }
}

// declinationDeg must be IGRF declination ONLY — computeAicIntercept's
// interceptRad is derived from lat/lng + unit.track, both true-referenced.
function computeIntercept(fighter, bogey, declinationDeg) {
  const result = computeAicIntercept(fighter, bogey)
  if (!result) return null
  const interceptTrueDeg = (result.interceptRad * 180 / Math.PI + 360) % 360
  const interceptMagDeg  = toMagneticFromTrue(interceptTrueDeg, declinationDeg)
  return {
    heading:    Math.round(interceptMagDeg) || 360,
    ttiSeconds: Math.round(result.ttiHours * 3600),
  }
}

// Nearest 100 ft, or nearest 10 m in metric.
function fmtAlt(m, sys) {
  const step = sys === METRIC ? 10 : 100
  return `${Math.round(altFromM(m, sys) / step) * step} ${altUnit(sys)}`
}

function fmtTti(s) {
  if (s == null || !isFinite(s)) return '--:--'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

function shortType(unit) {
  return (unit?.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1') || '?'
}

function resolveDisplay(unit, isFriendly) {
  if (!unit) return '?'
  return isFriendly ? resolveCallsign(unit) : shortType(unit)
}

// ── BraaList component ────────────────────────────────────────────────────────

const BRAA_SCALE_KEY = 'tracs.braa.scale'
const BRAA_SORT_KEY  = 'tracs.braa.sort'

function loadSort() {
  try {
    const saved = JSON.parse(localStorage.getItem(BRAA_SORT_KEY) ?? 'null')
    if (BRAA_SORT_KEYS.some((k) => k.value === saved?.key) && (saved.dir === 'asc' || saved.dir === 'desc')) return saved
  } catch { /* fall through to the default */ }
  return DEFAULT_BRAA_SORT
}
const BRAA_SCALE_MIN = 0.7
const BRAA_SCALE_MAX = 1.4
const BRAA_SCALE_STEP = 0.05

export const BRAA_NATURAL_WIDTH = 280

export function BraaList({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir     = useWheelDirection()
  const units        = useUnitsStore(s => s.units)
  const unitSystem   = useUnitSystem('aic')
  const coalition    = useSessionStore(s => s.coalition)
  const mission      = useSessionStore(s => s.mission)
  const braaList          = useAicStore(s => s.braaList)
  const removeBraaPair    = useAicStore(s => s.removeBraaPair)
  const getEffectiveDecl  = getAicEffectiveDeclaration
  const declarations      = useAicStore(s => s.declarations)
  const myCoalitionNum    = { blue: 2, red: 1, gm: 2, admin: 2 }[coalition] ?? 2

  const missionDate = mission?.mission?.dateAndTime?.date ?? null
  const bullseyes   = useSessionStore(s => s.bullseyes)

  const bullseyeEntry = useMemo(() => findCoalitionBullseye(bullseyes, coalition), [bullseyes, coalition])

  const bsLat = bullseyeEntry?.latitude  ?? 0
  const bsLng = bullseyeEntry?.longitude ?? 0

  const declinationDeg = useMemo(
    () => computeMagvar(bsLat, bsLng, missionDate),
    [bsLat, bsLng, missionDate]
  )

  // Title bar: scroll wheel changes zoom scale
  const [scale,     setScale]     = useState(() => {
    const saved = parseFloat(localStorage.getItem(BRAA_SCALE_KEY))
    return isNaN(saved) ? 1.0 : Math.min(BRAA_SCALE_MAX, Math.max(BRAA_SCALE_MIN, saved))
  })
  const [scaleHint, setScaleHint] = useState(false)
  const scaleHintRef = useRef(null)

  useEffect(() => { onScaleChange?.(scale) }, [scale]) // eslint-disable-line

  const handleTitleWheel = useCallback((e) => {
    const dir = wheelDir(e)
    if (dir === null) return
    setScale(s => {
      const next = Math.min(BRAA_SCALE_MAX, Math.max(BRAA_SCALE_MIN, parseFloat((s - dir * BRAA_SCALE_STEP).toFixed(2))))
      localStorage.setItem(BRAA_SCALE_KEY, String(next))
      clearTimeout(scaleHintRef.current)
      setScaleHint(true)
      scaleHintRef.current = setTimeout(() => setScaleHint(false), 1200)
      return next
    })
  }, [wheelDir])

  const style = docked ? { zoom: scale, width, minWidth: width } : { zoom: scale }

  const rows = useMemo(() => braaList.map(pair => {
    const fighter = units[pair.fighterId]
    const bogey   = units[pair.bogeyId]
    const braa      = (fighter && bogey) ? computeBraa(fighter, bogey, declinationDeg) : null
    const intercept = (fighter && bogey) ? computeIntercept(fighter, bogey, declinationDeg) : null
    const fighterDecl = fighter ? getEffectiveDecl(pair.fighterId, fighter, myCoalitionNum) : null
    const bogeyDecl   = bogey   ? getEffectiveDecl(pair.bogeyId,   bogey,   myCoalitionNum) : null
    const fighterRevealed = fighterDecl === 'FRIENDLY' && isOwnSide(fighter, coalition)
    const fighterLabel = resolveDisplay(fighter, fighterRevealed)
    const bogeyLabel   = resolveDisplay(bogey,   bogeyDecl   === 'FRIENDLY' && isOwnSide(bogey, coalition))
    const fighterCallsign = fighterRevealed ? fighterLabel : null
    const bogeyFlags = speedFlags(bogey)
    return { ...pair, fighter, bogey, braa, intercept, fighterLabel, fighterCallsign, bogeyLabel, fighterDecl, bogeyDecl, bogeyFlags }
  }), [braaList, units, declinationDeg, declarations, myCoalitionNum, coalition]) // eslint-disable-line

  const [sort, setSort] = useState(loadSort)
  const changeSort = (next) => {
    setSort(next)
    try { localStorage.setItem(BRAA_SORT_KEY, JSON.stringify(next)) } catch { /* not saved */ }
  }
  const sortedRows = useMemo(() => sortBraaRows(rows, sort), [rows, sort])

  return (
    <div className="braa" style={style}>
      {docked && <div className="braa-resize" onMouseDown={onResize} />}

      {/* Title bar */}
      <div className="braa-title" onWheel={handleTitleWheel}>
        <span className="braa-title-text">BRAA LIST</span>
        {scaleHint && <span className="braa-scale-hint">{Math.round(scale * 100)}%</span>}
        <select
          className="braa-sort-select"
          value={sort.key}
          onChange={(e) => changeSort({ ...sort, key: e.target.value })}
          title="Sort by"
        >
          {BRAA_SORT_KEYS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          className="braa-btn braa-sort-dir"
          onClick={() => changeSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          title={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
        >{sort.dir === 'asc' ? '▲' : '▼'}</button>
        <span className="braa-title-right">
          {docked  && onUndock && <button className="braa-btn" onClick={onUndock} title="Undock">⬡</button>}
          {!docked && onDock   && <button className="braa-btn" onClick={onDock}   title="Dock">⬡</button>}
          {docked  && onHide   && <button className="braa-btn" onClick={onHide}   title="Hide">›</button>}
        </span>
      </div>

      {/* Body */}
      <div className="braa-body">
        {rows.length === 0 && (
          <div className="braa-empty">No BRAA pairs.<br />Ctrl+click two contacts to add.</div>
        )}

        {sortedRows.map(row => (
          <div
            key={row.id}
            className="braa-row"
            onClick={(e) => { if (e.shiftKey) removeBraaPair(row.id) }}
          >
            <div className="braa-row-header">
              <span className="braa-callsign" style={{ color: DECL_COLOR[row.fighterDecl] ?? '#aaa' }}>{row.fighterLabel}</span>
              <span className="braa-arrow">→</span>
              <span className="braa-callsign" style={{ color: DECL_COLOR[row.bogeyDecl] ?? '#aaa', flex: 1 }}>{row.bogeyLabel}</span>
              <button className="braa-remove" onClick={() => removeBraaPair(row.id)} title="Remove">×</button>
            </div>
            {row.braa ? (
              <div className="braa-data">
                <span>{String(row.braa.bearing).padStart(3,'0')}°M / {formatDistance(row.braa.rangeNm, unitSystem)}</span>
                <span>{fmtAlt(row.braa.altM, unitSystem)}</span>
                <span className={`braa-aspect braa-aspect--${row.braa.aspect.toLowerCase()}`}>{row.braa.aspect}</span>
                {row.bogeyFlags && <span className="braa-flags">{row.bogeyFlags}</span>}
              </div>
            ) : (
              <div className="braa-data braa-data--na">NO DATA</div>
            )}
            {row.intercept ? (
              <div className="braa-intercept">
                <span>HDG {String(row.intercept.heading).padStart(3,'0')}°</span>
                <span>TTI {fmtTti(row.intercept.ttiSeconds)}</span>
              </div>
            ) : (
              <div className="braa-intercept braa-intercept--na">NO INTERCEPT</div>
            )}
          </div>
        ))}
      </div>

      {braaList.length > 0 && (
        <div className="braa-footer">
          <button
            className="braa-clear-btn"
            onClick={() => { if (window.confirm('Clear all BRAA pairs?')) braaList.forEach(p => removeBraaPair(p.id)) }}
          >
            Clear All
          </button>
        </div>
      )}
    </div>
  )
}
