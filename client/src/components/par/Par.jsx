import { useEffect, useState, useMemo, useRef } from 'react'
import { useUnitsStore }        from '../../store/units.js'
import { useRunwaysStore }      from '../../store/runways.js'
import { useCorrelationStore }  from '../../store/correlation.js'
import { useSessionStore, MODULE } from '../../store/session.js'
import { CARRIER_TYPES }        from '../../utils/carriers.js'
import { computeMagvar, theatreConvergence } from '../../utils/magvar.js'
import { resolveCallsign }      from '../../utils/callsign.js'
import './Par.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const D2R            = Math.PI / 180
const METERS_TO_FEET = 3.28084
const NM_TO_FEET     = 6076.115
const AIRBORNE       = new Set(['Aircraft', 'Helicopter'])
const PAR_MAX_ELEV   = 8   // degrees — PAR elevation service volume upper limit
const PAR_AZ_HALF    = 10  // degrees — PAR azimuth service volume half-angle (each side)
const GS_TOL_DEG     = 0.7  // glideslope full-scale deflection (ILS/PAR standard)
const AZ_TOL_DEG     = 2.5  // azimuth full-scale deflection
const TCH_FT         = 50   // standard threshold crossing height (airfield)

// ── Geometry helpers ──────────────────────────────────────────────────────────

function distNm(lat1, lng1, lat2, lng2) {
  const R  = 3440.065
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R
  const Δφ = (lat2 - lat1) * D2R, Δλ = (lng2 - lng1) * D2R
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const φ1 = lat1 * D2R, φ2 = lat2 * D2R, Δλ = (lng2 - lng1) * D2R
  const y  = Math.sin(Δλ) * Math.cos(φ2)
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) / D2R) + 360) % 360
}

// Projects a unit position onto the approach geometry.
// Returns rangeFinal (NM outbound from threshold), lateralDev (NM, +right),
// altAgl (ft above threshold elevation), and vertDev (ft above glidepath).
function projectOnApproach(pos, cfg) {
  const outbound   = (cfg.trueHdg + 180) % 360
  const dist       = distNm(cfg.threshLat, cfg.threshLng, pos.lat, pos.lng)
  if (dist < 0.001) return { rangeFinal: 0, lateralDev: 0, vertDev: 0, altAgl: 0 }
  const brg        = bearingDeg(cfg.threshLat, cfg.threshLng, pos.lat, pos.lng)
  const off        = ((outbound - brg) + 540) % 360 - 180
  const offRad     = off * D2R
  const rangeFinal = dist * Math.cos(offRad)
  const lateralDev = dist * Math.sin(offRad)
  const altFt      = (pos.alt ?? 0) * METERS_TO_FEET
  const altAgl     = altFt - (cfg.threshElev ?? 0)
  const gpAlt      = rangeFinal * NM_TO_FEET * Math.tan(cfg.gsAngle * D2R) + (cfg.tch ?? 0)
  const vertDev    = altAgl - gpAlt
  return { rangeFinal, lateralDev, vertDev, altAgl }
}

// ── Panel resize hook ─────────────────────────────────────────────────────────

function useSize(ref) {
  const [size, setSize] = useState({ width: 320, height: 160 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ width: Math.floor(width), height: Math.floor(height) })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [ref]) // eslint-disable-line
  return size
}

// ── ElevationPanel ────────────────────────────────────────────────────────────
// Side view of the approach. X-axis = range (far out = left, threshold = right).
// Y-axis = altitude AGL from threshold in feet (0 at bottom, increasing upward).
// The glideslope is a DIAGONAL line rising from lower-right (threshold, 0 ft)
// to upper-left (far range, gsEndAlt ft). The service volume upper limit (8°)
// is a steeper dashed diagonal forming the ceiling of what the PAR can detect.

function ElevationPanel({ contacts, config, width, height, mode, mirrored }) {
  const { rangeNm, gsAngle, vertTol, tch = 0 } = config
  const M = { t: 14, b: 22, l: 42, r: 10 }
  const W = width  - M.l - M.r
  const H = height - M.t - M.b

  // Altitude at far range for glideslope (includes TCH offset) and service volume ceiling
  const gsEndAlt  = rangeNm * NM_TO_FEET * Math.tan(gsAngle * D2R) + tch
  const svCeilAlt = rangeNm * NM_TO_FEET * Math.tan(PAR_MAX_ELEV * D2R) + tch

  // Round display max up to a clean tick boundary
  const altStep = svCeilAlt <= 2000 ? 250 : svCeilAlt <= 6000 ? 500 : 1000
  const maxAlt  = Math.ceil(svCeilAlt / altStep) * altStep

  // x: threshold at right (standard) or left (mirrored); far range is the opposite end
  const xr = mirrored
    ? (r) => M.l + (r / rangeNm) * W
    : (r) => M.l + (1 - r / rangeNm) * W
  // y: altitude 0 = bottom of plot; maxAlt = top (y decreases as altitude increases)
  const ya = (alt) => M.t + H * (1 - alt / maxAlt)

  // Label anchors that follow the threshold end vs the far end
  const thrX      = mirrored ? M.l + 4   : M.l + W - 2
  const thrAnchor = mirrored ? 'start'   : 'end'
  const farX      = mirrored ? M.l + W - 2 : M.l + 4
  const farAnchor = mirrored ? 'end'     : 'start'
  const tolOffset = mirrored ? 2         : -2
  const tolAnchor = mirrored ? 'start'   : 'end'

  const rTickStep = rangeNm <= 5 ? 1 : rangeNm <= 12 ? 2 : 5
  const rTicks    = []
  const aTicks    = []
  for (let r = 0; r <= rangeNm; r += rTickStep) rTicks.push(r)
  for (let a = 0; a <= maxAlt; a += altStep) aTicks.push(a)

  // Tolerance corridor: triangle that tapers to TCH point at the threshold.
  const tolPoly = [
    `${xr(0)},${ya(tch)}`,
    `${xr(rangeNm)},${ya(gsEndAlt + vertTol)}`,
    `${xr(rangeNm)},${ya(gsEndAlt - vertTol)}`,
  ].join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block' }}
      fontFamily="Roboto Mono, monospace">
      <defs>
        <clipPath id="par-el-clip">
          <rect x={M.l} y={M.t} width={W} height={H} />
        </clipPath>
      </defs>

      {/* Background */}
      <rect width={width} height={height} fill="#060606" />
      <rect x={M.l} y={M.t} width={W} height={H} fill="#0d0d0d" />

      <g clipPath="url(#par-el-clip)">
        {/* Altitude grid lines (horizontal) */}
        {aTicks.map((a) => (
          <line key={a}
            x1={M.l} y1={ya(a)} x2={M.l + W} y2={ya(a)}
            stroke={a === 0 ? '#1c1c1c' : '#161616'} strokeWidth={1}
          />
        ))}

        {/* Range grid lines (vertical) */}
        {rTicks.map((r) => (
          <line key={r}
            x1={xr(r)} y1={M.t} x2={xr(r)} y2={M.t + H}
            stroke="#161616" strokeWidth={1}
          />
        ))}

        {/* Service volume upper bound — 8° diagonal from threshold */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(svCeilAlt)}
          stroke="#1a3a1a" strokeWidth={1} strokeDasharray="9 5"
        />

        {/* Tolerance corridor — parallelogram around glideslope */}
        <polygon points={tolPoly} fill="rgba(0,75,0,0.22)" stroke="none" />

        {/* Tolerance upper edge — converges to TCH at threshold */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(gsEndAlt + vertTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3"
        />
        {/* Tolerance lower edge — converges to TCH at threshold */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(gsEndAlt - vertTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3"
        />

        {/* CASE III — 1200 ft minimum descent altitude (carrier only) */}
        {mode === 'carrier' && (() => {
          const interceptRange = 1200 / (NM_TO_FEET * Math.tan(gsAngle * D2R))
          return (
            <line
              x1={xr(rangeNm)}      y1={ya(1200)}
              x2={xr(interceptRange)} y2={ya(1200)}
              stroke="#5a4a10" strokeWidth={1} strokeDasharray="8 4"
            />
          )
        })()}

        {/* Ideal glideslope — crosses threshold at TCH */}
        <line
          x1={xr(0)}       y1={ya(tch)}
          x2={xr(rangeNm)} y2={ya(gsEndAlt)}
          stroke="#2a7a2a" strokeWidth={2}
        />

        {/* Tolerance band label at the far-range edge */}
        <text x={xr(rangeNm) + tolOffset} y={ya(gsEndAlt + vertTol) - 2}
          textAnchor={tolAnchor} fontSize={9} fill="#235a23">
          +{GS_TOL_DEG}°
        </text>
        <text x={xr(rangeNm) + tolOffset} y={ya(gsEndAlt - vertTol) + 9}
          textAnchor={tolAnchor} fontSize={9} fill="#235a23">
          -{GS_TOL_DEG}°
        </text>

        {/* Contacts — shown at actual (range, altitude AGL) */}
        {contacts.map((c) => {
          const x        = xr(c.rangeFinal)
          const y        = ya(c.altAgl)
          const tolAtRng = vertTol * (c.rangeFinal / rangeNm)
          const inTol    = Math.abs(c.vertDev) <= tolAtRng
          const color    = inTol ? (mode === 'carrier' ? '#FFD700' : '#4db8ff') : '#ffaa22'
          return (
            <g key={c.id}>
              <circle cx={x} cy={y} r={4} fill={color} />
              <text x={x} y={y - 7} fontSize={9} fill={color} textAnchor="middle">{c.label}</text>
            </g>
          )
        })}
      </g>

      {/* Plot border */}
      <rect x={M.l} y={M.t} width={W} height={H}
        fill="none" stroke="#1e1e1e" strokeWidth={1} />

      {/* Altitude axis labels (left of plot) */}
      {aTicks.map((a) => (
        <text key={a} x={M.l - 4} y={ya(a) + 3}
          textAnchor="end" fontSize={9}
          fill={a === 0 ? '#2a2a2a' : '#383838'}>
          {a === 0 ? '0' : a >= 1000 ? `${a / 1000}k` : a}
        </text>
      ))}

      {/* Glideslope angle label — left Y-axis at the far-range GS altitude */}
      <text x={M.l - 4} y={ya(gsEndAlt) + 3}
        textAnchor="end" fontSize={9} fill="#2a6a2a">
        {gsAngle.toFixed(1)}°
      </text>


      {/* Range tick labels (bottom) */}
      {rTicks.map((r) => (
        <text key={r} x={xr(r)} y={height - 5}
          textAnchor="middle" fontSize={9} fill="#343434">{r}</text>
      ))}

      {/* Panel identifier (far end) and threshold marker */}
      <text x={farX} y={M.t + 11} textAnchor={farAnchor} fontSize={9} fill="#2c2c2c" letterSpacing={1}>EL</text>
      <text x={thrX} y={M.t + 11} textAnchor={thrAnchor} fontSize={9} fill="#2c2c2c">THR</text>
    </svg>
  )
}

// ── AzimuthPanel ──────────────────────────────────────────────────────────────
// Top-down view of the approach. X-axis = range (far out = left, threshold = right).
// Y-axis = lateral deviation from centerline. lateralDev is always +right from the pilot's
// perspective, which is geographically +south for eastern approaches and +north for western.
// yl() flips sign when mirrored so that right-of-CL always appears below center on screen
// (i.e., the display is consistent regardless of approach direction).
// The PAR's ±10° azimuth coverage forms a V-cone from the threshold point outward.

function AzimuthPanel({ contacts, config, width, height, mode, mirrored }) {
  const { rangeNm, latTol } = config
  const M  = { t: 14, b: 22, l: 42, r: 10 }
  const W  = width  - M.l - M.r
  const H  = height - M.t - M.b
  const cy = M.t + H / 2

  // Service volume half-width at the far range (NM)
  const coneHalfNm = rangeNm * Math.tan(PAR_AZ_HALF * D2R)
  // Display range is slightly wider than the cone so the boundaries are visible
  const displayLat = Math.max(latTol * 2.5, coneHalfNm * 1.15)

  const xr = mirrored
    ? (r) => M.l + (r / rangeNm) * W
    : (r) => M.l + (1 - r / rangeNm) * W
  const yl = mirrored
    ? (lat) => cy - (lat / displayLat) * (H / 2)
    : (lat) => cy + (lat / displayLat) * (H / 2)

  const thrX      = mirrored ? M.l + 4   : M.l + W - 2
  const thrAnchor = mirrored ? 'start'   : 'end'
  const farX      = mirrored ? M.l + W - 2 : M.l + 4
  const farAnchor = mirrored ? 'end'     : 'start'

  const rTickStep = rangeNm <= 5 ? 1 : rangeNm <= 12 ? 2 : 5
  const rTicks    = []
  for (let r = 0; r <= rangeNm; r += rTickStep) rTicks.push(r)

  // Cone origin: threshold = right-center of the plot area
  const coneOX = xr(0)
  const coneOY = yl(0)

  return (
    <svg width={width} height={height} style={{ display: 'block' }}
      fontFamily="Roboto Mono, monospace">
      <defs>
        <clipPath id="par-az-clip">
          <rect x={M.l} y={M.t} width={W} height={H} />
        </clipPath>
      </defs>

      {/* Background */}
      <rect width={width} height={height} fill="#060606" />
      <rect x={M.l} y={M.t} width={W} height={H} fill="#0d0d0d" />

      <g clipPath="url(#par-az-clip)">
        {/* Range grid lines */}
        {rTicks.map((r) => (
          <line key={r}
            x1={xr(r)} y1={M.t} x2={xr(r)} y2={M.t + H}
            stroke="#161616" strokeWidth={1}
          />
        ))}

        {/* Service volume cone — V opening from threshold outward */}
        <line
          x1={coneOX} y1={coneOY}
          x2={xr(rangeNm)} y2={yl(-coneHalfNm)}
          stroke="#1a3a1a" strokeWidth={1} strokeDasharray="9 5"
        />
        <line
          x1={coneOX} y1={coneOY}
          x2={xr(rangeNm)} y2={yl(coneHalfNm)}
          stroke="#1a3a1a" strokeWidth={1} strokeDasharray="9 5"
        />

        {/* Tolerance corridor — triangle tapering to threshold (angular tolerance) */}
        <polygon
          points={[
            `${coneOX},${coneOY}`,
            `${xr(rangeNm)},${yl(-latTol)}`,
            `${xr(rangeNm)},${yl( latTol)}`,
          ].join(' ')}
          fill="rgba(0,75,0,0.22)"
        />

        {/* Centerline */}
        <line x1={coneOX} y1={coneOY} x2={xr(rangeNm)} y2={yl(0)}
          stroke="#2a7a2a" strokeWidth={1} />

        {/* Tolerance edges — converge to threshold point */}
        <line x1={coneOX} y1={coneOY} x2={xr(rangeNm)} y2={yl(-latTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3" />
        <line x1={coneOX} y1={coneOY} x2={xr(rangeNm)} y2={yl( latTol)}
          stroke="#235a23" strokeWidth={1} strokeDasharray="5 3" />

        {/* Contacts — shown at actual (range, lateral deviation) */}
        {contacts.map((c) => {
          const x        = xr(c.rangeFinal)
          const y        = yl(c.lateralDev)
          const tolAtRng = latTol * (c.rangeFinal / rangeNm)
          const inTol    = Math.abs(c.lateralDev) <= tolAtRng
          const color    = inTol ? (mode === 'carrier' ? '#FFD700' : '#4db8ff') : '#ffaa22'
          return (
            <g key={c.id}>
              <circle cx={x} cy={y} r={4} fill={color} />
              <text x={x} y={y - 7} fontSize={9} fill={color} textAnchor="middle">{c.label}</text>
            </g>
          )
        })}
      </g>

      {/* Plot border */}
      <rect x={M.l} y={M.t} width={W} height={H}
        fill="none" stroke="#1e1e1e" strokeWidth={1} />

      {/* Lateral deviation axis labels (left of plot) */}
      <text x={M.l - 4} y={yl(-latTol) + 3} textAnchor="end" fontSize={9} fill="#383838">
        -{AZ_TOL_DEG}°
      </text>
      <text x={M.l - 4} y={cy + 3} textAnchor="end" fontSize={9} fill="#2a5a2a">CL</text>
      <text x={M.l - 4} y={yl( latTol) + 3} textAnchor="end" fontSize={9} fill="#383838">
        +{AZ_TOL_DEG}°
      </text>

      {/* Range tick labels (bottom) */}
      {rTicks.map((r) => (
        <text key={r} x={xr(r)} y={height - 5}
          textAnchor="middle" fontSize={9} fill="#343434">{r}</text>
      ))}

      {/* Panel identifier (far end) and threshold marker */}
      <text x={farX} y={M.t + 11} textAnchor={farAnchor} fontSize={9} fill="#2c2c2c" letterSpacing={1}>AZ</text>
      <text x={thrX} y={M.t + 11} textAnchor={thrAnchor} fontSize={9} fill="#2c2c2c">THR</text>
    </svg>
  )
}

// ── Par ───────────────────────────────────────────────────────────────────────

export function Par({
  docked   = false,
  width    = null,
  onResize = null,
  onUndock = null,
  onHide   = null,
}) {
  // ── Session (docked reads store; standalone reads URL params) ─────
  const sessionMission    = useSessionStore((s) => s.mission)
  const sessionCarrierId  = useSessionStore((s) => s.carrierUnitId)
  const sessionModule     = useSessionStore((s) => s.activeModule)
  const sessionAirbases   = useSessionStore((s) => s.airbases)
  const facilityDcsName   = useSessionStore((s) => s.facilityDcsName)

  const params = useMemo(() => new URLSearchParams(window.location.search), [])

  const initTheatre = docked
    ? (sessionMission?.mission?.theatre ?? null)
    : (params.get('theatre') ?? null)

  const missionDate = sessionMission?.mission?.dateAndTime?.date ?? null

  const initCarrierId = docked
    ? (sessionModule === MODULE.CATCC ? sessionCarrierId : null)
    : (params.get('carrierUnitId') != null ? Number(params.get('carrierUnitId')) : null)

  // ── WebSocket connection (standalone popup only) ───────────────────
  useEffect(() => {
    if (docked) return
    document.title = 'PAR – TRACS'
  }, [docked]) // eslint-disable-line

  // ── Runway data (for airfield runway selector) ─────────────────────
  // When docked, AtcScope owns loadForTheatre — don't conflict with it.
  const { centerlines, loadForTheatre } = useRunwaysStore()
  useEffect(() => {
    if (docked || !initTheatre) return
    loadForTheatre(initTheatre, '', null, null, null, missionDate)
  }, [docked, initTheatre, missionDate]) // eslint-disable-line

  // ── Units + correlation ────────────────────────────────────────────
  const units        = useUnitsStore((s) => s.units)
  const correlations = useCorrelationStore((s) => s.correlations)
  const useDcsNames  = useSessionStore((s) => s.useDcsNames)
  const carrierUnit  = initCarrierId != null ? (units[initCarrierId] ?? null) : null

  // ── Approach config state ──────────────────────────────────────────
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('tracs.par.mode')
    if (saved === 'carrier' && initCarrierId == null) return 'airfield'
    return saved ?? (initCarrierId != null ? 'carrier' : 'airfield')
  })
  const [runwayId,   setRunwayId]   = useState(() => localStorage.getItem('tracs.par.runwayId') ?? '')
  const [manualLat,  setManualLat]  = useState('')
  const [manualLng,  setManualLng]  = useState('')
  const [manualHdg,  setManualHdg]  = useState('')
  const [threshElev, setThreshElev] = useState(0)
  const [gsAngle,    setGsAngle]    = useState(() => {
    const saved = parseFloat(localStorage.getItem('tracs.par.gsAngle'))
    return isNaN(saved) ? (initCarrierId != null ? 3.5 : 3.0) : saved
  })
  const [rangeNm,    setRangeNm]    = useState(() => {
    const saved = parseFloat(localStorage.getItem('tracs.par.rangeNm'))
    return isNaN(saved) ? 10 : saved
  })

  // Persist PAR config across remounts and popup windows
  useEffect(() => { localStorage.setItem('tracs.par.mode',     mode)           }, [mode])
  useEffect(() => { localStorage.setItem('tracs.par.runwayId', runwayId)       }, [runwayId])
  useEffect(() => { localStorage.setItem('tracs.par.gsAngle',  String(gsAngle)) }, [gsAngle])
  useEffect(() => { localStorage.setItem('tracs.par.rangeNm',  String(rangeNm)) }, [rangeNm])

  // Sync manual fields from selected runway (handles dropdown changes and on-mount restore)
  useEffect(() => {
    if (!runwayId || !centerlines.length) return
    const cl = centerlines.find((c) => c.id === runwayId)
    if (!cl) return
    setManualLat(cl.thresholdLat.toFixed(6))
    setManualLng(cl.thresholdLng.toFixed(6))
    const magHdg = cl.magHead ?? ((cl.headingRad / D2R + 180 - cl.magvar) % 360 + 360) % 360
    setManualHdg(Math.round(magHdg).toString())
    setThreshElev(Math.round(cl.elevFt))
  }, [runwayId, centerlines]) // eslint-disable-line

  // Tolerances derived from standard angular FSD values — not user-configurable
  const vertTol = rangeNm * NM_TO_FEET * Math.tan(GS_TOL_DEG * D2R)
  const latTol  = rangeNm * Math.tan(AZ_TOL_DEG * D2R)

  // ── Computed approach configuration ───────────────────────────────
  const approachCfg = useMemo(() => {
    const base = { gsAngle, rangeNm, latTol, vertTol }

    if (mode === 'carrier' && carrierUnit?.position) {
      const ct         = CARRIER_TYPES[carrierUnit.name]
      const deckOff    = ct?.deckOffset    ?? 9
      const deckHt     = ct?.deckHeightFt  ?? 72
      const gridHdgDeg = (carrierUnit.heading ?? 0) / D2R  // DCS grid heading
      const magvar     = computeMagvar(carrierUnit.position.lat, carrierUnit.position.lng, missionDate)
      const conv       = initTheatre ? theatreConvergence(initTheatre, carrierUnit.position.lat, carrierUnit.position.lng) : 0
      const trueHdgDeg = gridHdgDeg - conv  // geographic true heading
      // finalBearingMag: geographic true − IGRF (= DCS_grid − DCS_magvar, same result)
      const finalBearingMag = ((trueHdgDeg - deckOff - magvar) % 360 + 360) % 360
      return {
        ...base,
        threshLat:  carrierUnit.position.lat,
        threshLng:  carrierUnit.position.lng,
        trueHdg:    ((trueHdgDeg - deckOff) % 360 + 360) % 360,
        threshElev: deckHt,
        tch:        TCH_FT,
        finalBearingMag,
        valid: true,
      }
    }

    if (mode === 'airfield') {
      const lat = parseFloat(manualLat)
      const lng = parseFloat(manualLng)
      const hdg = parseFloat(manualHdg)
      if (!isNaN(lat) && !isNaN(lng) && !isNaN(hdg)) {
        const magvar = computeMagvar(lat, lng, missionDate)
        return {
          ...base,
          threshLat:  lat,
          threshLng:  lng,
          trueHdg:    ((hdg + magvar) % 360 + 360) % 360,
          threshElev: threshElev,
          tch:        TCH_FT,
          finalBearingMag: ((hdg % 360) + 360) % 360,
          valid: true,
        }
      }
    }

    return { ...base, valid: false }
  }, [mode, carrierUnit, manualLat, manualLng, manualHdg,
      gsAngle, rangeNm, latTol, vertTol, threshElev, missionDate, initTheatre]) // latTol/vertTol derived from rangeNm

  // ── Contacts in approach corridor ─────────────────────────────────
  const contacts = useMemo(() => {
    if (!approachCfg.valid) return []
    const results = []
    const azConeSlope = Math.tan(PAR_AZ_HALF * D2R)
    const svCeilSlope = Math.tan(PAR_MAX_ELEV * D2R) * NM_TO_FEET
    for (const [id, unit] of Object.entries(units)) {
      if (!AIRBORNE.has(unit.category) || !unit.position) continue
      const proj = projectOnApproach(unit.position, approachCfg)
      // Reject if behind the threshold, beyond display range, or below TCH (landed)
      if (proj.rangeFinal < 0 || proj.rangeFinal > approachCfg.rangeNm) continue
      if (proj.altAgl <= (approachCfg.tch ?? 0)) continue
      // Reject if outside the PAR azimuth service volume cone
      if (Math.abs(proj.lateralDev) > proj.rangeFinal * azConeSlope * 1.1) continue
      // Reject if above the PAR elevation service volume ceiling
      if (proj.altAgl > proj.rangeFinal * svCeilSlope * 1.1) continue
      // Carrier mode: show correlated side number or XXX. Airfield: resolve callsign per toggle.
      const label = mode === 'carrier'
        ? (correlations[String(id)] ?? 'XXX')
        : resolveCallsign(unit).slice(0, 8)
      results.push({ id, label, ...proj })
    }
    return results
  }, [units, approachCfg, mode, correlations, useDcsNames])

  // ── Centerlines sorted by distance to facility ────────────────────
  const sortedCenterlines = useMemo(() => {
    if (!facilityDcsName) return centerlines
    const raw = sessionAirbases?.airbases ?? sessionAirbases ?? {}
    const fac = Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName)
    if (!fac?.latitude) return centerlines
    return [...centerlines].sort((a, b) =>
      distNm(fac.latitude, fac.longitude, a.thresholdLat, a.thresholdLng) -
      distNm(fac.latitude, fac.longitude, b.thresholdLat, b.thresholdLng)
    )
  }, [centerlines, facilityDcsName, sessionAirbases])

  // ── Panel size tracking ────────────────────────────────────────────
  const elRef  = useRef(null)
  const azRef  = useRef(null)
  const elSize = useSize(elRef)
  const azSize = useSize(azRef)

  // ── Carrier approach info for display ─────────────────────────────
  const carrierFbDisplay = useMemo(() => {
    if (!carrierUnit?.position) return null
    const deckOff = CARRIER_TYPES[carrierUnit.name]?.deckOffset ?? 9
    const magvar  = computeMagvar(carrierUnit.position.lat, carrierUnit.position.lng, missionDate)
    const conv    = initTheatre ? theatreConvergence(initTheatre, carrierUnit.position.lat, carrierUnit.position.lng) : 0
    const gridHdg = (carrierUnit.heading ?? 0) / D2R
    const brc     = ((gridHdg - conv - magvar + 720) % 360)
    const fb      = Math.round(((brc - deckOff + 360) % 360))
    return fb === 0 ? 360 : fb
  }, [carrierUnit, missionDate, initTheatre])

  const hasCarrierData = mode === 'carrier' && carrierUnit?.position != null
  const mirrored = approachCfg.valid && (approachCfg.finalBearingMag % 360) >= 180

  const windowStyle = docked && width ? { width, minWidth: width } : {}

  return (
    <div className={`par-window${docked ? ' par-window--docked' : ''}`} style={windowStyle}>
      {docked && <div className="par-resize-handle" onMouseDown={onResize} />}

      {/* ── Drawer header (docked only) ──────────────────────────────── */}
      {docked && (
        <div className="par-drawer-header">
          <span className="par-drawer-title">PAR</span>
          <div className="par-drawer-btns">
            {onUndock && <button className="par-drawer-btn" onClick={onUndock} title="Undock">⬡</button>}
            {onHide   && <button className="par-drawer-btn" onClick={onHide}   title="Hide">›</button>}
          </div>
        </div>
      )}

      {/* ── Config panel ────────────────────────────────────────────── */}
      <div className="par-config">

        {/* Row 1: mode selector + runway or carrier info */}
        <div className="par-config-row">
          <span className="par-label">MODE</span>
          <button
            className={`par-mode-btn${mode === 'airfield' ? ' par-mode-btn--active' : ''}`}
            onClick={() => setMode('airfield')}
          >AIRFIELD</button>
          <button
            className={`par-mode-btn${mode === 'carrier' ? ' par-mode-btn--active' : ''}`}
            onClick={() => setMode('carrier')}
            disabled={initCarrierId == null}
          >CARRIER</button>

          {mode === 'airfield' && centerlines.length > 0 && (
            <>
              <span className="par-label">RWY</span>
              <select
                className="par-select"
                value={runwayId}
                onChange={(e) => {
                  const id = e.target.value
                  setRunwayId(id)
                  if (!id) {
                    setManualLat(''); setManualLng(''); setManualHdg('')
                    setThreshElev(0)
                  }
                }}
              >
                <option value="">— select —</option>
                {sortedCenterlines.map((cl) => (
                  <option key={cl.id} value={cl.id}>{cl.label}</option>
                ))}
              </select>
            </>
          )}

          {mode === 'carrier' && (
            <span className="par-info">
              {hasCarrierData
                ? `FB ${String(carrierFbDisplay ?? '---').padStart(3, '0')}`
                : 'NO CARRIER DATA'}
            </span>
          )}
        </div>

        {/* Row 2 (airfield): manual threshold coords + heading + elevation */}
        {mode === 'airfield' && (
          <div className="par-config-row">
            <span className="par-label">LAT</span>
            <input
              className="par-input par-input--sm"
              value={manualLat}
              onChange={(e) => { setManualLat(e.target.value); setRunwayId('') }}
              placeholder="0.0000"
            />
            <span className="par-label">LNG</span>
            <input
              className="par-input par-input--sm"
              value={manualLng}
              onChange={(e) => { setManualLng(e.target.value); setRunwayId('') }}
              placeholder="0.0000"
            />
            <span className="par-label">HDG</span>
            <input
              className="par-input par-input--xs"
              value={manualHdg}
              onChange={(e) => { setManualHdg(e.target.value); setRunwayId('') }}
              placeholder="000"
            />
            <span className="par-label">°M</span>
            <span className="par-label" style={{ marginLeft: 8 }}>ELEV</span>
            <input
              className="par-input par-input--xs"
              value={threshElev}
              onChange={(e) => setThreshElev(Number(e.target.value) || 0)}
            />
            <span className="par-label">ft</span>
          </div>
        )}

        {/* Row 3: approach parameters */}
        <div className="par-config-row">
          <span className="par-label">GS</span>
          <input
            className="par-input par-input--xs"
            value={gsAngle}
            onChange={(e) => setGsAngle(parseFloat(e.target.value) || 3.0)}
          />
          <span className="par-label">°</span>
          <span className="par-label" style={{ marginLeft: 6 }}>RNG</span>
          <input
            className="par-input par-input--xs"
            value={rangeNm}
            onChange={(e) => setRangeNm(parseFloat(e.target.value) || 10)}
          />
          <span className="par-label">NM</span>
          <span className="par-info" style={{ marginLeft: 10 }}>
            GS ±{GS_TOL_DEG}°  AZ ±{AZ_TOL_DEG}°
          </span>
        </div>
      </div>

      {/* ── Elevation display (top) ──────────────────────────────────── */}
      <div ref={elRef} className="par-panel">
        {approachCfg.valid
          ? <ElevationPanel
              contacts={contacts}
              config={approachCfg}
              width={elSize.width}
              height={elSize.height}
              mode={mode}
              mirrored={mirrored}
            />
          : <div className="par-panel-msg">CONFIGURE APPROACH</div>
        }
      </div>

      {/* ── Azimuth display (bottom) ─────────────────────────────────── */}
      <div ref={azRef} className="par-panel">
        {approachCfg.valid
          ? <AzimuthPanel
              contacts={contacts}
              config={approachCfg}
              width={azSize.width}
              height={azSize.height}
              mode={mode}
              mirrored={mirrored}
            />
          : <div className="par-panel-msg">CONFIGURE APPROACH</div>
        }
      </div>
    </div>
  )
}
