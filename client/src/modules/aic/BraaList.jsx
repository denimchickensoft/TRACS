import { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useAicStore }  from '../../store/aic.js'
import { useUnitsStore } from '../../store/units.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { useSessionStore } from '../../store/session.js'
import { computeMagvar } from '../../utils/magvar.js'
import { gridBearingRangeNm, trueBearingRangeNm, toMagneticFromTrue } from '../../utils/bearing.js'
import { DECLARATION } from '../../store/aic.js'
import { computeAicIntercept } from './aicGeometry.js'
import './BraaList.css'

function speedFlags(unit) {
  if (!unit) return ''
  const kts  = (unit.speed ?? 0) * 1.94384
  const altFt = (unit.position?.alt ?? 0) * 3.28084
  const parts = []
  if (altFt >= 40000) parts.push('HIGH')
  if (kts >= 900) parts.push('VERY FAST')
  else if (kts >= 600) parts.push('FAST')
  return parts.join('  ')
}

const DECL_COLOR = {
  [DECLARATION.HOSTILE]:  '#FF4444',
  [DECLARATION.BOGEY]:    '#FFCC00',
  [DECLARATION.NEUTRAL]:  '#44CC44',
  [DECLARATION.FRIENDLY]: '#4488FF',
}

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

  const altFt      = Math.round((bp.alt ?? 0) * 3.28084)
  const altRounded = Math.round(altFt / 100) * 100

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
    range:   Math.round(rangeNm),
    altFt,
    altRounded,
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
const BRAA_SCALE_MIN = 0.7
const BRAA_SCALE_MAX = 1.4
const BRAA_SCALE_STEP = 0.05

export const BRAA_NATURAL_WIDTH = 280

export function BraaList({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir     = useWheelDirection()
  const units        = useUnitsStore(s => s.units)
  const coalition    = useSessionStore(s => s.coalition)
  const mission      = useSessionStore(s => s.mission)
  const braaList          = useAicStore(s => s.braaList)
  const removeBraaPair    = useAicStore(s => s.removeBraaPair)
  const getEffectiveDecl  = useAicStore(s => s.getEffectiveDeclaration)
  const declarations      = useAicStore(s => s.declarations)
  const myCoalitionNum    = { blue: 2, red: 1, gm: 2, admin: 2 }[coalition] ?? 2

  const missionDate = mission?.mission?.dateAndTime?.date ?? null
  const bullseyes   = useSessionStore(s => s.bullseyes)

  const bullseyeEntry = useMemo(() => {
    if (!bullseyes?.bullseyes) return null
    const coalStr = coalition === 'red' ? 'red' : 'blue'
    return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
        ?? Object.values(bullseyes.bullseyes)[0]
        ?? null
  }, [bullseyes, coalition])

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
    e.preventDefault()
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
    const fighterLabel = resolveDisplay(fighter, fighterDecl === 'FRIENDLY')
    const bogeyLabel   = resolveDisplay(bogey,   bogeyDecl   === 'FRIENDLY')
    const bogeyFlags = speedFlags(bogey)
    return { ...pair, fighter, bogey, braa, intercept, fighterLabel, bogeyLabel, fighterDecl, bogeyDecl, bogeyFlags }
  }), [braaList, units, declinationDeg, declarations, myCoalitionNum]) // eslint-disable-line

  return (
    <div className="braa" style={style}>
      {docked && <div className="braa-resize" onMouseDown={onResize} />}

      {/* Title bar */}
      <div className="braa-title" onWheel={handleTitleWheel}>
        <span className="braa-title-text">BRAA LIST</span>
        {scaleHint && <span className="braa-scale-hint">{Math.round(scale * 100)}%</span>}
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

        {rows.map(row => (
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
                <span>{String(row.braa.bearing).padStart(3,'0')}°M / {row.braa.range}NM</span>
                <span>{row.braa.altRounded} FT</span>
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
