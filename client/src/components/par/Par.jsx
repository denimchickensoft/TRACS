import { useEffect, useState, useMemo, useRef } from 'react'
import { useUnitsStore }        from '../../store/units.js'
import { useRunwaysStore }      from '../../store/runways.js'
import { useCorrelationStore }  from '../../store/correlation.js'
import { useSessionStore, MODULE } from '../../store/session.js'
import { CARRIER_TYPES, computeCarrierBrcFb, carrierDeckAltFt, deckPosition } from '../../utils/carriers.js'
import { computeMagvar, theatreConvergence } from '../../utils/magvar.js'
import { resolveCallsign }      from '../../utils/callsign.js'
import { ElevationPanel, AzimuthPanel } from './ParPanels.jsx'
import { D2R, NM_TO_FEET, PAR_MAX_ELEV, PAR_AZ_HALF, GS_TOL_DEG, AZ_TOL_DEG } from './parConstants.js'
import './Par.css'

// ── Constants ─────────────────────────────────────────────────────────────────

const METERS_TO_FEET = 3.28084
const AIRBORNE       = new Set(['Aircraft', 'Helicopter'])
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
  }, [ref])
  return size
}

// ── ElevationPanel ────────────────────────────────────────────────────────────
// Side view of the approach. X-axis = range (far out = left, threshold = right).
// Y-axis = altitude AGL from threshold in feet (0 at bottom, increasing upward).
// The glideslope is a DIAGONAL line rising from lower-right (threshold, 0 ft)
// to upper-left (far range, gsEndAlt ft). The service volume upper limit (8°)
// is a steeper dashed diagonal forming the ceiling of what the PAR can detect.

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
  const sessionFacilityDcsName = useSessionStore((s) => s.facilityDcsName)

  const params = useMemo(() => new URLSearchParams(window.location.search), [])

  const initTheatre = docked
    ? (sessionMission?.mission?.theatre ?? null)
    : (params.get('theatre') ?? null)

  const missionDate = sessionMission?.mission?.dateAndTime?.date ?? null

  const initCarrierId = docked
    ? (sessionModule === MODULE.CATCC ? sessionCarrierId : null)
    : (params.get('carrierUnitId') != null ? Number(params.get('carrierUnitId')) : null)

  const facilityDcsName = docked
    ? sessionFacilityDcsName
    : (params.get('facilityDcsName') ?? null)

  // ── WebSocket connection (standalone popup only) ───────────────────
  useEffect(() => {
    if (docked) return
    document.title = 'PAR – TRACS'
  }, [docked])

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
  const carrierUnit  = initCarrierId != null ? (units[initCarrierId] ?? null) : null

  // ── Approach config state ──────────────────────────────────────────
  const [mode, setMode] = useState(() => {
    const saved = localStorage.getItem('tracs.par.mode')
    if (saved === 'carrier' && initCarrierId == null) return 'airfield'
    if (initCarrierId != null) return 'carrier'
    return saved ?? 'airfield'
  })
  const [runwayId,   setRunwayId]   = useState(() => localStorage.getItem('tracs.par.runwayId') ?? '')
  const [manualLat,  setManualLat]  = useState('')
  const [manualLng,  setManualLng]  = useState('')
  const [manualHdg,  setManualHdg]  = useState('')
  const [threshElev, setThreshElev] = useState(0)
  const [gsAngleRaw, setGsAngleRaw] = useState(() => {
    const saved = localStorage.getItem(`tracs.par.gsAngle.${mode}`)
    const v = parseFloat(saved)
    return isNaN(v) ? String(mode === 'carrier' ? 3.5 : 3.0) : saved
  })
  const [rangeNmRaw, setRangeNmRaw] = useState(() => {
    const saved = localStorage.getItem(`tracs.par.rangeNm.${mode}`)
    const v = parseFloat(saved)
    return isNaN(v) ? '10' : saved
  })
  const gsAngle = Math.min(7, Math.max(1, parseFloat(gsAngleRaw) || (mode === 'carrier' ? 3.5 : 3.0)))
  const rangeNm = parseFloat(rangeNmRaw) || 10

  // GS angle and range default/persistence are per-mode (carrier GS defaults to 3.5,
  // airfield to 3.0) — re-derive whenever mode changes instead of sharing one storage
  // key across both.
  useEffect(() => {
    const savedGs = localStorage.getItem(`tracs.par.gsAngle.${mode}`)
    const vGs = parseFloat(savedGs)
    setGsAngleRaw(isNaN(vGs) ? String(mode === 'carrier' ? 3.5 : 3.0) : savedGs)

    const savedRange = localStorage.getItem(`tracs.par.rangeNm.${mode}`)
    const vRange = parseFloat(savedRange)
    setRangeNmRaw(isNaN(vRange) ? '10' : savedRange)
  }, [mode])

  // Persist PAR config across remounts and popup windows
  useEffect(() => { localStorage.setItem('tracs.par.mode',     mode)      }, [mode])
  useEffect(() => { localStorage.setItem('tracs.par.runwayId', runwayId)  }, [runwayId])
  useEffect(() => { localStorage.setItem(`tracs.par.gsAngle.${mode}`,  gsAngleRaw)  }, [gsAngleRaw, mode])
  useEffect(() => { localStorage.setItem(`tracs.par.rangeNm.${mode}`,  rangeNmRaw)  }, [rangeNmRaw, mode])

  // Sync manual fields from selected runway (handles dropdown changes and on-mount restore)
  useEffect(() => {
    if (!runwayId || !centerlines.length) return
    const cl = centerlines.find((c) => c.id === runwayId)
    if (!cl) return
    setManualLat(cl.thresholdLat.toFixed(6))
    setManualLng(cl.thresholdLng.toFixed(6))
    const magHdg = cl.magHead ?? ((cl.headingRad / D2R + 180 - cl.declinationDeg) % 360 + 360) % 360
    setManualHdg(Math.round(magHdg).toString())
    setThreshElev(Math.round(cl.elevFt))
  }, [runwayId, centerlines])

  // Tolerances derived from standard angular FSD values — not user-configurable
  const vertTol = rangeNm * NM_TO_FEET * Math.tan(GS_TOL_DEG * D2R)
  const latTol  = rangeNm * Math.tan(AZ_TOL_DEG * D2R)

  // ── Computed approach configuration ───────────────────────────────
  const approachCfg = useMemo(() => {
    const base = { gsAngle, rangeNm, latTol, vertTol }

    if (mode === 'carrier' && carrierUnit?.position) {
      const ct         = CARRIER_TYPES[carrierUnit.name]
      const deckOff    = ct?.deckOffset    ?? 9
      // The carrier's own altitude plus its deck height, same reference the
      // DECK tab uses.
      const deckHt     = carrierDeckAltFt(carrierUnit, { deckHeightFt: ct?.deckHeightFt ?? 72 })
      const gridHdgDeg = (carrierUnit.heading ?? 0) / D2R  // DCS grid heading
      const magvar     = computeMagvar(carrierUnit.position.lat, carrierUnit.position.lng, missionDate)
      // Real geographic true (grid + convergence) for the approach-corridor
      // geometry below, which compares against bearingDeg()'s real-lat/lng
      // bearings — see utils/magvar.js's note on the one legitimate use of
      // theatreConvergence(). finalBearingMag is a displayed number instead
      // (matching DCS's own cockpit reading), so it uses declination only.
      const conv       = initTheatre ? theatreConvergence(initTheatre, carrierUnit.position.lat, carrierUnit.position.lng) : 0
      const trueHdgDeg = gridHdgDeg + conv
      const { fb: finalBearingMag } = computeCarrierBrcFb(gridHdgDeg, magvar, deckOff)
      const trueHdg    = ((trueHdgDeg - deckOff) % 360 + 360) % 360
      return {
        ...base,
        threshLat:  carrierUnit.position.lat,
        threshLng:  carrierUnit.position.lng,
        trueHdg,
        threshElev: deckHt,
        tch:        TCH_FT,
        finalBearingMag,
        valid: true,
      }
    }

    if (mode === 'airfield') {
      const lat = parseFloat(manualLat)
      const lng = parseFloat(manualLng)
      // The HDG box displays a whole-degree rounded value, but while it still
      // reflects an unedited runway selection, compute from that runway's
      // precise magHead instead — rounding for display shouldn't feed the
      // corridor geometry. Any manual edit clears runwayId (see input
      // onChange below), which falls this back to the typed value.
      const selectedCl = runwayId ? centerlines.find((c) => c.id === runwayId) : null
      const hdg = selectedCl ? selectedCl.magHead : parseFloat(manualHdg)
      if (!isNaN(lat) && !isNaN(lng) && !isNaN(hdg)) {
        const magvar = computeMagvar(lat, lng, missionDate)
        const conv   = initTheatre ? theatreConvergence(initTheatre, lat, lng) : 0
        return {
          ...base,
          threshLat:  lat,
          threshLng:  lng,
          trueHdg:    ((hdg + magvar + conv) % 360 + 360) % 360,
          threshElev: threshElev,
          tch:        TCH_FT,
          finalBearingMag: ((hdg % 360) + 360) % 360,
          valid: true,
        }
      }
    }

    return { ...base, valid: false }
  }, [mode, carrierUnit, manualLat, manualLng, manualHdg, runwayId, centerlines,
      gsAngle, rangeNm, latTol, vertTol, threshElev, missionDate, initTheatre]) // latTol/vertTol derived from rangeNm

  // ── Contacts in approach corridor ─────────────────────────────────
  const contacts = useMemo(() => {
    if (!approachCfg.valid) return []
    const results = []
    const azConeSlope = Math.tan(PAR_AZ_HALF * D2R)
    const svCeilSlope = Math.tan(PAR_MAX_ELEV * D2R) * NM_TO_FEET
    const carrierType = mode === 'carrier' ? CARRIER_TYPES[carrierUnit?.name] : null
    for (const [id, unit] of Object.entries(units)) {
      if (!AIRBORNE.has(unit.category) || !unit.position) continue
      // An aircraft parked or trapped on the deck reads a few feet above it,
      // so the altitude check below can't tell it from one on short final.
      // The DECK tab's own test decides: on deck there, never on PAR.
      if (carrierType && deckPosition(unit, carrierUnit, carrierType, initTheatre)) continue
      const proj = projectOnApproach(unit.position, approachCfg)
      // Reject if behind the threshold, beyond display range, or at/below deck/field height (landed)
      if (proj.rangeFinal < 0 || proj.rangeFinal > approachCfg.rangeNm) continue
      if (proj.altAgl <= 0) continue
      // Reject if outside the PAR azimuth service volume cone
      if (Math.abs(proj.lateralDev) > proj.rangeFinal * azConeSlope * 1.1) continue
      // Reject if above the PAR elevation service volume ceiling
      if (proj.altAgl > proj.rangeFinal * svCeilSlope * 1.1) continue
      // Carrier mode: show correlated side number or XXX. Airfield: resolve callsign per toggle.
      const label = mode === 'carrier'
        ? (correlations[String(id)] ?? 'XXX')
        : resolveCallsign(unit)
      results.push({ id, label, ...proj })
    }
    return results
  }, [units, approachCfg, mode, correlations, carrierUnit, initTheatre])

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
    const gridHdg = (carrierUnit.heading ?? 0) / D2R
    const { fb: fbRaw } = computeCarrierBrcFb(gridHdg, magvar, deckOff)
    const fb = Math.round(fbRaw)
    return fb === 0 ? 360 : fb
  }, [carrierUnit, missionDate])

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
            value={gsAngleRaw}
            onChange={(e) => setGsAngleRaw(e.target.value)}
            onBlur={() => setGsAngleRaw(String(gsAngle))}
          />
          <span className="par-label">°</span>
          <span className="par-label" style={{ marginLeft: 6 }}>RNG</span>
          <input
            className="par-input par-input--xs"
            value={rangeNmRaw}
            onChange={(e) => setRangeNmRaw(e.target.value)}
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
