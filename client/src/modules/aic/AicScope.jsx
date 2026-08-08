import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection }   from '../../utils/wheel.js'
import { useUnitsStore }       from '../../store/units.js'
import { useSessionStore }     from '../../store/session.js'
import { useDisplayStore }     from '../../store/display.js'
import { useAicStore, DECLARATION, ROE_STATE } from '../../store/aic.js'
import { applyCallsignChange }  from '../../utils/callsignRename.js'
import { resolveCallsign }      from '../../utils/callsign.js'
import { sendWebrtcSessionEvent } from '../../webrtc/client.js'
import { useNavdataStore }       from '../../store/navdata.js'
import { useRunwaysStore }       from '../../store/runways.js'
import { latLngToCanvas, rangeToPixelsPerNm, canvasToLatLng } from '../atc/stars/canvas/projection.js'
import { resolveSlew }         from '../atc/stars/input/slewResolver.js'
import { computeMagvar } from '../../utils/magvar.js'
import { gridBearingRangeNm, toMagneticFromTrue, toTrueFromMagnetic } from '../../utils/bearing.js'
import { drawAicLayers, drawSector } from './canvas/drawAicLayers.js'
import { drawAicContacts }     from './canvas/drawAicContacts.js'
import { drawGeo }             from '../atc/stars/canvas/drawGeo.js'
import { drawRelief }          from '../atc/stars/canvas/drawRelief.js'
import { computePicture, sectorAxisBearing } from './canvas/computePicture.js'
import { useGeoStore }         from '../../store/geo.js'
import { useReliefStore }      from '../../store/relief.js'
import { useMapsStore }        from '../../store/maps.js'
import { useBrevityStore }     from '../../store/brevity.js'
import { useMissionClock }     from '../../utils/useMissionClock.js'
import { BraaList }            from './BraaList.jsx'
import './AicScope.css'

const WINDOW_ID = 'aic-main'
const AIC_SETTINGS_KEY = 'aic-settings'
const AIC_AUTOTHREAT_KEY = 'tracs-aic-autothreat'
const AIC_PICTURE_KEY = 'tracs-aic-showpicture'
const AIC_BEC_KEY = 'tracs-aic-bec'
const AIC_WIN_FIELDS = [
  'rangeNm', 'ringSpacingNm', 'ptlSeconds', 'symSize',
  'fadedSeconds', 'threatRadius', 'centerLat', 'centerLng',
  'centerOverridden', 'aspColorIdx',
]

const COALITION_NUM = { blue: 2, red: 1, gm: 2, admin: 2 }

const F_KEY_DECL = {
  F1: DECLARATION.HOSTILE,
  F2: DECLARATION.BOGEY,
  F3: DECLARATION.NEUTRAL,
  F4: DECLARATION.FRIENDLY,
}

const DECL_LABEL = {
  [DECLARATION.HOSTILE]:  'HO',
  [DECLARATION.BOGEY]:    'BO',
  [DECLARATION.NEUTRAL]:  'NE',
  [DECLARATION.FRIENDLY]: 'FR',
}

// .class classification letters — same f/n/b/h convention as ABM's
// .acq/.eng (b for BOGEY, MTTP brevity — not "u" for unknown), 2026-07-07.
const CLASS_LETTER = {
  f: DECLARATION.FRIENDLY,
  n: DECLARATION.NEUTRAL,
  b: DECLARATION.BOGEY,
  h: DECLARATION.HOSTILE,
}

// .autoclass (2026-07-08) — a unit's TRUE classification, straight off
// coalition: own side is FRIENDLY, coalition 0 (DCS's neutral) is NEUTRAL,
// anything else is an enemy, i.e. HOSTILE (not BOGEY — autoclass means no
// more fog-of-war ambiguity for that contact).
function trueDeclaration(unit, myCoalitionNum) {
  if (unit.coalition === myCoalitionNum) return DECLARATION.FRIENDLY
  if (unit.coalition === 0) return DECLARATION.NEUTRAL
  return DECLARATION.HOSTILE
}

const ROE_DISPLAY = {
  [ROE_STATE.FREE]:  'WEAPONS FREE',
  [ROE_STATE.TIGHT]: 'WEAPONS TIGHT',
  [ROE_STATE.HOLD]:  'WEAPONS HOLD',
}

const DECL_PICTURE = {
  [DECLARATION.HOSTILE]:  'H',
  [DECLARATION.BOGEY]:    'B',
  [DECLARATION.NEUTRAL]:  'NE',
  [DECLARATION.FRIENDLY]: 'FR',
}

const CARDINAL_ABBR = {
  NORTH: 'N', NORTHEAST: 'NE', EAST: 'E', SOUTHEAST: 'SE',
  SOUTH: 'S', SOUTHWEST: 'SW', WEST: 'W', NORTHWEST: 'NW',
}

// Abbreviates cardinal directions and LEAD/TRAIL in a group's display name.
// The formation amplifier line (e.g. "ECHELON WEST") is rendered separately
// from picture.amplifiers and is NOT run through this — it stays full-word.
const NAME_ABBR = { ...CARDINAL_ABBR, LEAD: 'L', TRAIL: 'T' }
function abbrGroupName(name) {
  return name.replace(' GROUP', '').split(' ').map(w => NAME_ABBR[w] ?? w).join(' ')
}

function speedFlags(unit) {
  const kts = (unit.speed ?? 0) * 1.94384
  const alt  = (unit.position?.alt ?? 0) * 3.28084
  const parts = []
  if (alt >= 40000)  parts.push('HIGH')
  if (kts >= 900)    parts.push('VERY FAST')
  else if (kts >= 600) parts.push('FAST')
  return parts.join('  ')
}


function picFillIns(g) {
  const parts = []
  if (g.isStack) parts.push(`STACK ${g.stackHighFt / 1000}K/${g.stackLowFt / 1000}K`)
  if (g.isHigh) parts.push('HIGH')
  if (g.isVeryFast) parts.push('VERY FAST')
  else if (g.isFast) parts.push('FAST')
  if (g.openingClosing) parts.push(g.openingClosing)
  return parts.join('  ')
}

function nmBetween(a, b) {
  const nmPerDegLng = 60 * Math.cos(a.lat * Math.PI / 180)
  const dN = (b.lat - a.lat) * 60
  const dE = (b.lng - a.lng) * nmPerDegLng
  return Math.hypot(dN, dE)
}

function findNearestBogey(fighterId, fighterUnit, units, declarations, myCoalitionNum) {
  if (!fighterUnit?.position) return null
  let nearestId = null, nearestDist = Infinity
  for (const [id, unit] of Object.entries(units)) {
    if (id === fighterId || !unit.position) continue
    const decl = declarations[id] ?? (unit.coalition === myCoalitionNum ? 'FRIENDLY' : 'BOGEY')
    if (decl === 'FRIENDLY' || decl === 'NEUTRAL') continue
    const nmPerDegLng = 60 * Math.cos(fighterUnit.position.lat * Math.PI / 180)
    const dN = (unit.position.lat - fighterUnit.position.lat) * 60
    const dE = (unit.position.lng - fighterUnit.position.lng) * nmPerDegLng
    const dist = Math.hypot(dN, dE)
    if (dist < nearestDist) { nearestDist = dist; nearestId = id }
  }
  return nearestId
}

const AGL_FLOOR_M = 30  // ≈ 100 ft — suppress ground contacts

function getAicVisibleUnits(units, myCoalitionNum, rwrEverDetected) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if ((c.detectionMethod & 4) || (c.detectionMethod & 32)) detectedIds.add(String(c.ID))
      if (c.detectionMethod & 16) rwrEverDetected?.add(String(c.ID))
    }
  }

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    if (unit.alive === false) continue
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    if (unit.agl !== undefined && unit.agl < AGL_FLOOR_M) continue
    const c = unit.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = unit
  }

  return result
}

function subcardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW']
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
}

function bearingRangeFromBullseye(lat, lng, bsLat, bsLng, declinationDeg, theatre) {
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(bsLat, bsLng, lat, lng, theatre)
  const magBrg = toMagneticFromTrue(gridBearingDeg, declinationDeg)
  return { brg: Math.round(magBrg) || 360, range: Math.round(rangeNm) }
}

export default function AicScope() {
  const wheelDir        = useWheelDirection()
  const mapCanvasRef    = useRef(null)
  const layersRef       = useRef(null)
  const contactsRef     = useRef(null)
  const interactiveRef  = useRef(null)
  const canvasAreaRef   = useRef(null)

  // ── External store hooks ──────────────────────────────────────────────────────
  const units      = useUnitsStore(s => s.units)
  const coalition  = useSessionStore(s => s.coalition)
  const mission    = useSessionStore(s => s.mission)
  const bullseyes  = useSessionStore(s => s.bullseyes)

  const declarations      = useAicStore(s => s.declarations)
  const roe               = useAicStore(s => s.roe)
  const autoClassify      = useAicStore(s => s.autoClassify)
  const braaList          = useAicStore(s => s.braaList)
  const pendingBraaFighter = useAicStore(s => s.pendingBraaFighter)
  const {
    setDeclaration, setRoe, setAutoClassify, addBraaPair, removeBraaPair, removeBraaPairsForUnit,
    setPendingBraaFighter, clearPendingBraa, getEffectiveDeclaration,
  } = useAicStore()

  const geoBoundaries  = useGeoStore(s => s.boundaries)
  const geoCoastlines  = useGeoStore(s => s.coastlines)
  const geoVisible     = useGeoStore(s => s.visible)
  const relief         = useReliefStore(s => s.relief)
  const reliefVisible  = useReliefStore(s => s.visible)
  const mapPalettes    = useMapsStore(s => s.palettes)

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  // ── Derived session values ────────────────────────────────────────────────────
  const myCoalitionNum = COALITION_NUM[coalition] ?? 2
  const theatre        = mission?.mission?.theatre
  const missionDate    = mission?.mission?.dateAndTime?.date ?? null

  // ── Mission clock — defaults to Zulu, click to toggle theatre-local ────────────
  const { timeStr, localTimeStr } = useMissionClock()
  const [showLocalTime, setShowLocalTime] = useState(false)
  const clockTime = showLocalTime ? localTimeStr : timeStr

  const bullseyeEntry = useMemo(() => {
    if (!bullseyes?.bullseyes) return null
    const coalStr = coalition === 'red' ? 'red' : 'blue'
    return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
        ?? Object.values(bullseyes.bullseyes)[0]
        ?? null
  }, [bullseyes, coalition])

  // .be override — lets the operator relocate bullseye off the mission's
  // real one (fix, explicit lat/lon, or a map click). Not persisted: it's a
  // mission-specific placement, not a saved preference.
  const [bullseyeOverride, setBullseyeOverride] = useState(null) // { lat, lng } | null

  const bullseyeLat = bullseyeOverride?.lat ?? bullseyeEntry?.latitude  ?? 0
  const bullseyeLng = bullseyeOverride?.lng ?? bullseyeEntry?.longitude ?? 0

  const centerOverridden = windowSettings?.centerOverridden ?? false
  const centerLat = centerOverridden ? (windowSettings?.centerLat ?? bullseyeLat) : bullseyeLat
  const centerLng = centerOverridden ? (windowSettings?.centerLng ?? bullseyeLng) : bullseyeLng

  useEffect(() => {
    if (!theatre) return
    useNavdataStore.getState().loadForTheatre(theatre)
    if (useRunwaysStore.getState().theatre !== theatre) useRunwaysStore.getState().loadForTheatre(theatre)
    useGeoStore.getState().loadForTheatre(theatre)
    useReliefStore.getState().loadForTheatre(theatre)
  }, [theatre])

  // declinationDeg (IGRF) is the only correction this app applies — see
  // utils/magvar.js: DCS's own heading readouts don't apply grid
  // convergence, so this app doesn't add it either.
  const declinationDeg = computeMagvar(centerLat, centerLng, missionDate)

  const centerLatRef = useRef(centerLat)
  const centerLngRef = useRef(centerLng)
  const declinationRef = useRef(declinationDeg)
  useEffect(() => { centerLatRef.current = centerLat }, [centerLat])
  useEffect(() => { centerLngRef.current = centerLng }, [centerLng])
  useEffect(() => { declinationRef.current = declinationDeg }, [declinationDeg])

  const rangeNm       = windowSettings?.rangeNm       ?? 120
  const ringSpacingNm = windowSettings?.ringSpacingNm ?? 20
  const ptlSeconds    = windowSettings?.ptlSeconds    ?? 60
  const symSize       = windowSettings?.symSize       ?? 3

  // IDs ever seen with the RWR detection bit (16) set — once a non-friendly
  // contact is RWR-detected, its type stays revealed even if RWR drops out.
  const rwrEverDetectedRef = useRef(new Set())
  const visibleUnits = useMemo(
    () => getAicVisibleUnits(units, myCoalitionNum, rwrEverDetectedRef.current),
    [units, myCoalitionNum]
  )
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])

  const declarationsRef = useRef(declarations)
  useEffect(() => { declarationsRef.current = declarations }, [declarations])

  // .autoclass (2026-07-08) — while on, any unit that becomes visible with
  // no explicit declaration yet gets one set to its TRUE classification.
  // Only touches undeclared units so it never stomps a manual override (or
  // its own prior auto-declaration) made after the fact. The bulk
  // reclassify-everything-visible-now pass runs once, in execCommand, at
  // the moment .autoclass is switched on.
  useEffect(() => {
    if (!autoClassify) return
    for (const [id, unit] of Object.entries(visibleUnits)) {
      if (declarationsRef.current[id] === undefined) setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
    }
  }, [visibleUnits, autoClassify, myCoalitionNum, setDeclaration])

  const [view, setView] = useState(null)
  const viewRef = useRef(null)
  useEffect(() => { viewRef.current = view }, [view])

  const buildView = useCallback((w, h) => {
    const container = canvasAreaRef.current
    if (!container) return null
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    if (!ws) return null
    const rawW = w ?? container.clientWidth
    const rawH = h ?? container.clientHeight
    if (!rawW || !rawH) return null
    const size = Math.min(rawW, rawH)
    for (const ref of [mapCanvasRef, layersRef, contactsRef]) {
      if (ref.current) {
        if (ref.current.width !== size)  ref.current.width  = size
        if (ref.current.height !== size) ref.current.height = size
        ref.current.style.width  = `${size}px`
        ref.current.style.height = `${size}px`
      }
    }
    if (interactiveRef.current) {
      interactiveRef.current.style.width  = `${size}px`
      interactiveRef.current.style.height = `${size}px`
    }
    return {
      centerLat:   centerLatRef.current,
      centerLng:   centerLngRef.current,
      rangeNm:     ws.rangeNm ?? 120,
      pixelsPerNm: rangeToPixelsPerNm(ws.rangeNm ?? 120, size, size),
      width: size, height: size,
      declinationDeg: declinationRef.current,
      theatre,
    }
  }, [theatre])

  // windowSettings is undefined (and the component returns null before the
  // canvas mounts) on the first render of a cold load — canvasAreaRef.current
  // is null then, so without this dep the observer would attach to nothing
  // and never re-attach once the canvas actually mounts.
  const hasWindowSettings = !!windowSettings
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setView(buildView(width, height))
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [hasWindowSettings]) // eslint-disable-line

  useEffect(() => { setView(buildView()) }, [centerLat, centerLng, declinationDeg, windowSettings?.rangeNm]) // eslint-disable-line

  useEffect(() => {
    let saved = null
    try { saved = JSON.parse(localStorage.getItem(AIC_SETTINGS_KEY) ?? 'null') } catch {}

    if (!windowSettings) {
      const defaults = {
        rangeNm: 120, ringSpacingNm: 20, ptlSeconds: 60, symSize: 3,
        centerLat: 0, centerLng: 0, centerOverridden: false,
        fadedSeconds: 30, threatRadius: 45,
      }
      const savedWin = saved
        ? Object.fromEntries(AIC_WIN_FIELDS.filter(k => saved[k] !== undefined).map(k => [k, saved[k]]))
        : {}
      displayStore.initWindow(WINDOW_ID, { ...defaults, ...savedWin })
    }
    if (saved?.geoVisible    != null) useGeoStore.getState().setVisible(saved.geoVisible)
    if (saved?.reliefVisible != null) useReliefStore.getState().setVisible(saved.reliefVisible)
    if (saved?.aspColorIdx && !useMapsStore.getState().palettes.length) {
      fetch('/api/navdata/palettes')
        .then(r => r.json())
        .then(palettes => useMapsStore.getState().setPalettes(palettes))
        .catch(() => {})
    }
  }, []) // eslint-disable-line

  useEffect(() => {
    let timer = null
    const save = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const ws = useDisplayStore.getState().windows[WINDOW_ID]
        if (!ws) return
        const entry = {}
        for (const k of AIC_WIN_FIELDS) entry[k] = ws[k]
        entry.geoVisible    = useGeoStore.getState().visible
        entry.reliefVisible = useReliefStore.getState().visible
        try { localStorage.setItem(AIC_SETTINGS_KEY, JSON.stringify(entry)) } catch {}
      }, 500)
    }
    const unsubDisplay = useDisplayStore.subscribe(save)
    const unsubGeo     = useGeoStore.subscribe(save)
    const unsubRelief  = useReliefStore.subscribe(save)
    return () => { clearTimeout(timer); unsubDisplay(); unsubGeo(); unsubRelief() }
  }, []) // eslint-disable-line

  // ── All state — declared before any effect that references them in deps ───────

  const [threatRings, setThreatRings] = useState(new Set())
  const toggleThreatRing = (unitId) =>
    setThreatRings(prev => { const n = new Set(prev); n.has(unitId) ? n.delete(unitId) : n.add(unitId); return n })
  const threatRadius = windowSettings?.threatRadius ?? 45

  // .autothreat (2026-07-10) — local UI toggle (not shared with other
  // controllers), persisted to its own localStorage key rather than via
  // AIC_SETTINGS_KEY since it isn't backed by a subscribed store. While on,
  // rings light automatically on every friendly aircraft within threatRadius
  // of a HOSTILE/BOGEY aircraft; auto-lit rings are tracked separately from
  // threatRings (manual Ctrl+Alt+click/.threat+click) and just union at draw
  // time, so auto fully owns a contact's ring for as long as the breach lasts.
  const [autoThreat, setAutoThreatState] = useState(() => {
    try { return localStorage.getItem(AIC_AUTOTHREAT_KEY) === 'true' } catch { return false }
  })
  const setAutoThreat = (enabled) => {
    setAutoThreatState(enabled)
    try { localStorage.setItem(AIC_AUTOTHREAT_KEY, String(enabled)) } catch {}
  }
  const [autoThreatRingIds, setAutoThreatRingIds] = useState(new Set())

  useEffect(() => {
    if (!autoThreat) { setAutoThreatRingIds(new Set()); return }
    const friendlies = []
    const hostiles   = []
    for (const [id, unit] of Object.entries(visibleUnits)) {
      if (!unit.position) continue
      const decl = getEffectiveDeclaration(id, unit, myCoalitionNum)
      if (decl === DECLARATION.FRIENDLY) friendlies.push([id, unit])
      else if (decl === DECLARATION.HOSTILE || decl === DECLARATION.BOGEY) hostiles.push(unit)
    }
    const breached = new Set()
    for (const [id, unit] of friendlies) {
      if (hostiles.some(h => nmBetween(unit.position, h.position) <= threatRadius)) breached.add(id)
    }
    setAutoThreatRingIds(breached)
  }, [visibleUnits, autoThreat, myCoalitionNum, threatRadius]) // eslint-disable-line

  // .centroid / .axis — debug toggles for the hostile-picture centroid and
  // the dynamic threat axis line derived from it (see computePicture.js).
  const [showCentroid, setShowCentroid] = useState(false)
  const [showAxis, setShowAxis] = useState(false)

  // .picture — toggles visibility of the PICTURE readout panel. Local UI
  // preference (not shared with other controllers), persisted to its own
  // localStorage key like .autothreat. Off by default.
  const [showPicture, setShowPictureState] = useState(() => {
    try { return localStorage.getItem(AIC_PICTURE_KEY) === 'true' } catch { return false }
  })
  const setShowPicture = (enabled) => {
    setShowPictureState(enabled)
    try { localStorage.setItem(AIC_PICTURE_KEY, String(enabled)) } catch {}
  }

  // .bec — bullseye-on-cursor readout that tracks the mouse pixel-for-pixel
  // (unlike the always-on cursorBullseye readout below, pinned to the top-
  // right corner). Off by default, persisted to its own localStorage key
  // like .autothreat/.picture above.
  const [becVisible, setBecVisibleState] = useState(() => {
    try { return localStorage.getItem(AIC_BEC_KEY) === 'true' } catch { return false }
  })
  const setBecVisible = (enabled) => {
    setBecVisibleState(enabled)
    try { localStorage.setItem(AIC_BEC_KEY, String(enabled)) } catch {}
  }
  const [cursorPixelPos, setCursorPixelPos] = useState(null)

  const fadedRef       = useRef({})
  const prevVisibleRef = useRef({})
  const [fadedTick, setFadedTick] = useState(0)

  const [findMarker, setFindMarker] = useState(null)

  // Sector: stored as TRUE bearings; input is magnetic, converted on entry.
  const [sector, setSector] = useState(null)
  const sectorRef = useRef(null)
  useEffect(() => { sectorRef.current = sector }, [sector])
  const [sectorVisible, setSectorVisible] = useState(true)
  const [sectorPreviewOrigin, setSectorPreviewOrigin] = useState(null)

  // Picture acknowledgment baseline
  const [ackPicture, setAckPicture] = useState(null)   // { labelKey, totalGroups }

  const [rbl, setRbl] = useState(null)

  const [hoveredUnit, setHoveredUnit] = useState(null)
  const [cursorLatLng, setCursorLatLng] = useState(null)

  const leftDragStartRef = useRef(null)

  const [pendingDeclaration, setPendingDeclaration] = useState(null)

  // Command buffer — must be declared before pendingSector useMemo
  const [cmdBuffer, setCmdBuffer] = useState('')
  const [cmdFeedback, setCmdFeedback] = useState('')
  // .define readout — kept separate from cmdFeedback since cmdFeedback gets
  // overwritten by every incidental click/command ack and a brevity
  // definition is meant to be read, not flashed. Dismissed only by Escape,
  // another .define, or clicking the readout itself.
  const [defineEntry, setDefineEntry] = useState(null) // { term, text }
  useEffect(() => { useBrevityStore.getState().load() }, [])
  const [cmdHistory, setCmdHistory] = useState([])
  const cmdHistoryRef = useRef([])
  useEffect(() => { cmdHistoryRef.current = cmdHistory }, [cmdHistory])
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1)
  const cmdHistoryIdxRef = useRef(-1)
  useEffect(() => { cmdHistoryIdxRef.current = cmdHistoryIdx }, [cmdHistoryIdx])
  const cmdDraftRef = useRef('')

  // Pending sector parsed from cmdBuffer (must be before contacts effect)
  const pendingSector = useMemo(() => {
    const trimmed = cmdBuffer.trim()

    // Bare ".sector" while a sector already exists — click to move it,
    // keeping its existing arc/range, rather than needing to retype it.
    if (/^\.sector$/i.test(trimmed) && sector) {
      const { fromBearing, toBearing, rangeNm, axisBearing } = sector
      return { fromBearing, toBearing, rangeNm, axisBearing }
    }

    const m = trimmed.match(/^\.sector\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/i)
    if (!m) return null
    const fromMag = parseFloat(m[1]) % 360
    const toMag   = parseFloat(m[2]) % 360
    const rng     = parseFloat(m[3])
    if (isNaN(fromMag) || isNaN(toMag) || isNaN(rng) || rng <= 0) return null
    // fromMag/toMag are user-typed magnetic bearings; convert via
    // toTrueFromMagnetic (== grid frame, DCS's own "true" — see
    // utils/bearing.js) for computePicture.js's _inSector, which compares
    // against grid-frame lat/lng-derived bearings.
    const fromTrue = toTrueFromMagnetic(fromMag, declinationDeg)
    const toTrue   = toTrueFromMagnetic(toMag, declinationDeg)
    return { fromBearing: fromTrue, toBearing: toTrue, rangeNm: rng, axisBearing: sectorAxisBearing(fromTrue, toTrue) }
  }, [cmdBuffer, declinationDeg, sector])

  // Ref so event callbacks can always read the current pendingSector value
  const pendingSectorRef = useRef(null)
  useEffect(() => { pendingSectorRef.current = pendingSector }, [pendingSector])

  // .be + click — armed live (before Enter) the moment cmdBuffer is exactly
  // ".be", same live-parse pattern as pendingSector above.
  const pendingBe = cmdBuffer.trim().toLowerCase() === '.be'
  const pendingBeRef = useRef(false)
  useEffect(() => { pendingBeRef.current = pendingBe }, [pendingBe])

  // ── Canvas effects ────────────────────────────────────────────────────────────

  // Faded contact tracking
  useEffect(() => {
    const now  = Date.now()
    const prev = prevVisibleRef.current
    const curr = visibleUnits
    for (const [id, unit] of Object.entries(prev)) {
      if (!curr[id] && !fadedRef.current[id]) {
        const decl = useAicStore.getState().getEffectiveDeclaration(id, unit, myCoalitionNum)
        fadedRef.current[id] = { unit: { ...unit }, disappearedAt: now, decl }
      }
    }
    for (const id of Object.keys(fadedRef.current)) {
      if (curr[id]) delete fadedRef.current[id]
    }
    prevVisibleRef.current = curr
  }, [visibleUnits])

  useEffect(() => {
    const id = setInterval(() => {
      const now          = Date.now()
      const fadedSeconds = useDisplayStore.getState().windows[WINDOW_ID]?.fadedSeconds ?? 30
      for (const unitId of Object.keys(fadedRef.current)) {
        if (now - fadedRef.current[unitId].disappearedAt > fadedSeconds * 1000)
          delete fadedRef.current[unitId]
      }
      setFadedTick(t => t + 1)
    }, 500)
    return () => clearInterval(id)
  }, []) // eslint-disable-line

  // GEO / RELIEF map canvas
  useEffect(() => {
    if (!view || !mapCanvasRef.current) return
    const ctx = mapCanvasRef.current.getContext('2d')
    ctx.clearRect(0, 0, view.width, view.height)
    const cx = view.width / 2
    const cy = view.height / 2
    const innerR = Math.max(0, (view.rangeNm - 10) * view.pixelsPerNm)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2)
    ctx.clip()
    const aspColorIdx  = windowSettings?.aspColorIdx ?? 0
    const activeColors = mapPalettes[aspColorIdx]?.colors ?? mapPalettes[0]?.colors ?? null
    drawRelief(ctx, view, relief, reliefVisible, 40, activeColors)
    drawGeo(ctx, view, geoBoundaries, geoCoastlines, geoVisible, 50, activeColors)
    ctx.restore()
  }, [view, geoBoundaries, geoCoastlines, geoVisible, relief, reliefVisible, mapPalettes, windowSettings?.aspColorIdx])

  // Layers: rings + dugout band + placed sector
  useEffect(() => {
    if (!view || !layersRef.current) return
    const ctx = layersRef.current.getContext('2d')
    drawAicLayers(ctx, view, view.rangeNm, ringSpacingNm, bullseyeLat, bullseyeLng, sectorVisible ? sector : null)
  }, [view, ringSpacingNm, bullseyeLat, bullseyeLng, sector, sectorVisible])

  const picture = useMemo(() => {
    if (!bullseyeEntry) return null
    return computePicture(
      visibleUnits,
      (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum),
      myCoalitionNum,
      sector,
      bullseyeLat, bullseyeLng,
      declinationDeg,
      theatre,
    )
  }, [visibleUnits, declarations, myCoalitionNum, sector, bullseyeLat, bullseyeLng, declinationDeg, theatre]) // eslint-disable-line

  // Contacts + sector preview
  useEffect(() => {
    if (!view || !contactsRef.current) return
    const ctx = contactsRef.current.getContext('2d')
    const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
    const mergedThreatRings = autoThreatRingIds.size
      ? new Set([...threatRings, ...autoThreatRingIds])
      : threatRings
    drawAicContacts(ctx, view, visibleUnits, getDecl, ptlSeconds, symSize, braaList, rangeNm, rbl, declinationDeg,
      mergedThreatRings, threatRadius, fadedRef.current, Date.now(), findMarker,
      showCentroid ? picture?.centroid : null,
      showAxis && picture?.axisOrigin ? { origin: picture.axisOrigin, axisBearing: picture.axisBearing } : null)
    if (pendingSector && sectorPreviewOrigin) {
      drawSector(ctx, view, { ...pendingSector, origin: sectorPreviewOrigin }, true)
    }
  }, [view, visibleUnits, declarations, ptlSeconds, symSize, braaList, rangeNm, myCoalitionNum, rbl, declinationDeg, threatRings, autoThreatRingIds, threatRadius, fadedTick, findMarker, pendingSector, sectorPreviewOrigin, showCentroid, showAxis, picture]) // eslint-disable-line

  // RBL drag (left-click) — only arms once the drag clears a threshold, so
  // plain left-clicks used for declare/BRAA/sector/etc. don't touch the RBL
  const rblRef = useRef(null)
  useEffect(() => { rblRef.current = rbl }, [rbl])
  const rblDragActiveRef = useRef(false)

  useEffect(() => {
    const onMove = (e) => {
      const start = leftDragStartRef.current
      if (!start) return
      if (!rblDragActiveRef.current) {
        const dist = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY)
        if (dist <= 5) return
        rblDragActiveRef.current = true
        setRbl({ anchor: { lat: start.lat, lng: start.lng }, end: null, fixed: false })
      }
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
      setRbl(prev => prev ? { ...prev, end: { lat, lng } } : null)
    }
    const onUp = (e) => {
      if (e.button !== 0) return
      const wasActive = rblDragActiveRef.current
      leftDragStartRef.current = null
      rblDragActiveRef.current = false
      if (!wasActive) return
      setRbl(prev => prev?.end ? { ...prev, fixed: true } : null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, []) // eslint-disable-line

  // ── Callbacks ──────────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect || !viewRef.current) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const hit = resolveSlew({ x, y }, visibleUnitsRef.current, viewRef.current)
    setHoveredUnit(hit ? { unitId: hit.unitId, unit: hit.unit } : null)
    const ll = canvasToLatLng(x, y, viewRef.current)
    setCursorLatLng(ll)
    setCursorPixelPos({ x, y })
    if (pendingSectorRef.current) setSectorPreviewOrigin(ll)
  }, [])

  function clearCmd() { setCmdBuffer(''); setCmdFeedback('') }

  function execCommand(raw) {
    const str = raw.trim().toLowerCase()

    if (str === '.center') {
      displayStore.updateWindow(WINDOW_ID, { centerOverridden: false })
      setCmdFeedback('CENTERED ON BULLSEYE')
    } else if (str.startsWith('.center ')) {
      const arg   = str.slice(8).trim()
      const parts = arg.split(/\s+/)
      if (parts.length === 2) {
        const brg = parseFloat(parts[0])
        const rng = parseFloat(parts[1])
        if (!isNaN(brg) && !isNaN(rng)) {
          const nmPerDegLng = 60 * Math.cos(bullseyeLat * Math.PI / 180)
          // brg is a user-typed magnetic bearing; convert to true for the lat/lng walk.
          const trueRad = ((brg + declinationRef.current) % 360) * Math.PI / 180
          const newLat  = bullseyeLat + (rng * Math.cos(trueRad)) / 60
          const newLng  = bullseyeLng + (rng * Math.sin(trueRad)) / nmPerDegLng
          displayStore.updateWindow(WINDOW_ID, { centerLat: newLat, centerLng: newLng, centerOverridden: true })
          setCmdFeedback(`CENTER ${Math.round(brg)}/${Math.round(rng)}`)
        } else { setCmdFeedback('INVALID: .CENTER <BRG> <RNG>') }
      } else {
        const result = useNavdataStore.getState().lookupFix(arg)
        if (result) {
          displayStore.updateWindow(WINDOW_ID, { centerLat: result.lat, centerLng: result.lon, centerOverridden: true })
          setCmdFeedback(`CENTER ${arg.toUpperCase()}`)
        } else { setCmdFeedback('NOT FOUND') }
      }
    } else if (str.startsWith('.find ')) {
      const result = useNavdataStore.getState().lookupFix(str.slice(6).trim())
      if (result) {
        setFindMarker(result)
        setCmdFeedback(`FIND ${result.id}`)
      } else { setCmdFeedback('NOT FOUND') }
    } else if (str === '.rr') {
      const next = ringSpacingNm > 0 ? 0 : 20
      displayStore.updateWindow(WINDOW_ID, { ringSpacingNm: next })
      setCmdFeedback(next === 0 ? 'RANGE RINGS OFF' : 'RANGE RINGS ON')
    } else if (str.startsWith('.rr ')) {
      const nm = parseFloat(str.slice(4))
      if (!isNaN(nm) && nm >= 0) {
        displayStore.updateWindow(WINDOW_ID, { ringSpacingNm: nm })
        setCmdFeedback(nm === 0 ? 'RANGE RINGS OFF' : `RR ${nm}NM`)
      } else { setCmdFeedback('INVALID: .RR <NM>') }
    } else if (str.startsWith('.ptl ')) {
      const s = parseInt(str.slice(5), 10)
      if (!isNaN(s) && s >= 0 && s <= 300) {
        displayStore.updateWindow(WINDOW_ID, { ptlSeconds: s })
        setCmdFeedback(`PTL ${s}S`)
      } else { setCmdFeedback('INVALID: .PTL 0-300') }
    } else if (str.startsWith('.sym ')) {
      const n = parseInt(str.slice(5), 10)
      if (n >= 1 && n <= 5) {
        displayStore.updateWindow(WINDOW_ID, { symSize: n })
        setCmdFeedback(`SYM ${n}`)
      } else { setCmdFeedback('INVALID: .SYM 1-5') }
    } else if (str.match(/^\.faded\s+\d+$/)) {
      const s = parseInt(str.split(/\s+/)[1], 10)
      displayStore.updateWindow(WINDOW_ID, { fadedSeconds: s })
      setCmdFeedback(`FADED ${s}S`)
    } else if (str === '.threat') {
      setThreatRings(new Set())
      setCmdFeedback('THREAT RINGS CLEARED')
    } else if (str.match(/^\.threat\s+\d+(\.\d+)?$/)) {
      const nm = parseFloat(str.split(/\s+/)[1])
      displayStore.updateWindow(WINDOW_ID, { threatRadius: nm })
      setCmdFeedback(`THREAT RING ${nm}NM`)
    } else if (str === '.clear') {
      setThreatRings(new Set())
      setRbl(null)
      setSector(null)
      setSectorVisible(true)
      setAckPicture(null)
      useAicStore.getState().braaList.forEach(p => removeBraaPair(p.id))
      setCmdFeedback('ALL CLEARED')
    } else if (str === '.class') {
      // Returns every explicit declaration to its fog-of-war default (2026-07-07).
      useAicStore.getState().resetDeclarations()
      setCmdFeedback('CLASS RESET')
    } else if (str.match(/^\.class\s+([fnbh])\s+([fnbh])$/)) {
      // `.class <old> <new>` reclassifies every currently-visible contact whose
      // *effective* declaration is <old> to <new> — e.g. `.class b h` turns
      // every bogey into a hostile (2026-07-07).
      const [, oldLetter, newLetter] = str.match(/^\.class\s+([fnbh])\s+([fnbh])$/)
      const oldDecl = CLASS_LETTER[oldLetter]
      const newDecl = CLASS_LETTER[newLetter]
      for (const [id, unit] of Object.entries(visibleUnitsRef.current)) {
        if (getEffectiveDeclaration(id, unit, myCoalitionNum) === oldDecl) {
          setDeclaration(id, newDecl)
        }
      }
      setCmdFeedback(`CLASS ${oldDecl} → ${newDecl}`)
    } else if (str === '.autoclass') {
      // Toggles autoclassification (2026-07-08). Turning it ON sets every
      // currently-visible contact to its TRUE (coalition-based) classification
      // right away; ongoing auto-declaration of newly-visible units happens in
      // the useEffect above. Turning it OFF does not revert anything already
      // classified, it just stops future auto-declaration. `.class` (no args)
      // overrides this and turns it back off.
      const next = !autoClassify
      setAutoClassify(next)
      if (next) {
        for (const [id, unit] of Object.entries(visibleUnitsRef.current)) {
          setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
        }
        setCmdFeedback('AUTOCLASS ON')
      } else {
        setCmdFeedback('AUTOCLASS OFF')
      }
    } else if (str === '.autothreat') {
      // Toggles automatic threat rings (2026-07-10): while on, every friendly
      // aircraft within threatRadius of a HOSTILE/BOGEY aircraft gets its ring
      // lit until the breach clears — see the useEffect above.
      const next = !autoThreat
      setAutoThreat(next)
      setCmdFeedback(next ? 'AUTOTHREAT ON' : 'AUTOTHREAT OFF')
    } else if (str === '.roe free') {
      setRoe(ROE_STATE.FREE)
      setCmdFeedback('WEAPONS FREE')
    } else if (str === '.roe tight') {
      setRoe(ROE_STATE.TIGHT)
      setCmdFeedback('WEAPONS TIGHT')
    } else if (str === '.roe hold') {
      setRoe(ROE_STATE.HOLD)
      setCmdFeedback('WEAPONS HOLD')
    } else if (str.startsWith('.aspcolors ')) {
      const name = str.slice(11).trim().toUpperCase()
      const loadAndApply = (palettes) => {
        const idx = palettes.findIndex(p => p.name.toUpperCase() === name)
        if (idx < 0) { setCmdFeedback('INVALID PALETTE'); return }
        displayStore.updateWindow(WINDOW_ID, { aspColorIdx: idx })
        setCmdFeedback(`COLORS ${palettes[idx].name.toUpperCase()}`)
      }
      const cached = useMapsStore.getState().palettes
      if (cached.length) {
        loadAndApply(cached)
      } else {
        fetch('/api/navdata/palettes')
          .then(r => r.json())
          .then(palettes => { useMapsStore.getState().setPalettes(palettes); loadAndApply(palettes) })
          .catch(() => setCmdFeedback('PALETTE LOAD FAILED'))
      }
    } else if (str === '.geo') {
      useGeoStore.getState().toggleVisible()
      setCmdFeedback(useGeoStore.getState().visible ? 'GEO ON' : 'GEO OFF')
    } else if (str === '.relief') {
      useReliefStore.getState().toggleVisible()
      setCmdFeedback(useReliefStore.getState().visible ? 'RELIEF ON' : 'RELIEF OFF')
    } else if (str === '.centroid') {
      setShowCentroid(!showCentroid)
      setCmdFeedback(!showCentroid ? 'CENTROID ON' : 'CENTROID OFF')
    } else if (str === '.axis') {
      setShowAxis(!showAxis)
      setCmdFeedback(!showAxis ? 'AXIS ON' : 'AXIS OFF')
    } else if (str === '.picture') {
      setShowPicture(!showPicture)
      setCmdFeedback(!showPicture ? 'PICTURE ON' : 'PICTURE OFF')
    } else if (str === '.bec') {
      setBecVisible(!becVisible)
      setCmdFeedback(!becVisible ? 'BULLSEYE-ON-CURSOR ON' : 'BULLSEYE-ON-CURSOR OFF')
    } else if (str === '.sector') {
      if (sectorRef.current) { setSectorVisible(true); setCmdFeedback('SECTOR ON') }
      else { setCmdFeedback('NO SECTOR') }
    } else if (str === '.sector clear' || str === '.sector off') {
      setSector(null)
      setSectorVisible(true)
      setSectorPreviewOrigin(null)
      setAckPicture(null)
      setCmdFeedback('SECTOR CLEARED')
    } else if (str.match(/^\.sector\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/)) {
      // Place at bullseye when Enter pressed with no prior click
      const parts = str.replace(/^\.sector\s+/, '').split(/\s+/)
      const fromMag  = parseFloat(parts[0]) % 360
      const toMag    = parseFloat(parts[1]) % 360
      const rng      = parseFloat(parts[2])
      // Same conversion as the pendingSector useMemo above (matching
      // computePicture.js's grid-referenced comparisons).
      const decl     = declinationRef.current
      const fromTrue = toTrueFromMagnetic(fromMag, decl)
      const toTrue   = toTrueFromMagnetic(toMag, decl)
      setSector({
        origin:      { lat: bullseyeLat, lng: bullseyeLng },
        fromBearing: fromTrue, toBearing: toTrue, rangeNm: rng,
        axisBearing: sectorAxisBearing(fromTrue, toTrue),
      })
      setSectorVisible(true)
      setSectorPreviewOrigin(null)
      setCmdFeedback(`SECTOR ${Math.round(fromMag)}/${Math.round(toMag)} ${Math.round(rng)}NM @BE`)
    } else if (str === '.be') {
      // Bare form (Enter, no click) clears the override and reverts to the
      // mission bullseye; typed bare and then clicked instead (see
      // pendingBe/handleMouseUp), it places the override at the click.
      setBullseyeOverride(null)
      setCmdFeedback('BULLSEYE RESET')
    } else if (str.match(/^\.be\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$/)) {
      const m = str.match(/^\.be\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/)
      const lat = parseFloat(m[1])
      const lng = parseFloat(m[2])
      setBullseyeOverride({ lat, lng })
      setCmdFeedback(`BULLSEYE SET ${lat.toFixed(2)}/${lng.toFixed(2)}`)
    } else if (str.match(/^\.be\s+(\S+)$/)) {
      const fixName = str.match(/^\.be\s+(\S+)$/)[1]
      const result  = useNavdataStore.getState().lookupFix(fixName)
      if (result) {
        setBullseyeOverride({ lat: result.lat, lng: result.lon })
        setCmdFeedback(`BULLSEYE SET @ ${result.id}`)
      } else {
        setCmdFeedback('FIX NOT FOUND')
      }
    } else if (str.startsWith('.define ')) {
      // Tactical brevity glossary lookup (ATP 1-02.1, see store/brevity.js).
      // Shown in its own readout, not cmdFeedback — see the comment at
      // defineEntry's declaration for why.
      const result = useBrevityStore.getState().lookup(str.slice(8).trim())
      if (result) { setDefineEntry(result); setCmdFeedback('') }
      else { setDefineEntry(null); setCmdFeedback('NOT FOUND') }
    } else {
      setCmdFeedback('UNKNOWN COMMAND')
    }
  }

  const handleKeyDown = useCallback((e) => {
    const fDecl = F_KEY_DECL[e.key]
    if (fDecl) {
      e.preventDefault()
      setPendingDeclaration(d => d === fDecl ? null : fDecl)
      clearPendingBraa()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (findMarker) { setFindMarker(null); return }
      if (defineEntry) { setDefineEntry(null); return }
      const previewClear = !pendingDeclaration && !pendingBraaFighter && !cmdBuffer && !cmdFeedback
      if (previewClear) {
        setRbl(null)
        setSectorVisible(false)
        setSectorPreviewOrigin(null)
      } else {
        setPendingDeclaration(null)
        clearPendingBraa()
        clearCmd()
        setSectorPreviewOrigin(null)
      }
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = cmdBuffer.trim()
      if (trimmed) {
        execCommand(trimmed)
        setCmdHistory(h => [trimmed, ...h.filter(c => c !== trimmed)].slice(0, 50))
      }
      setCmdBuffer('')
      setCmdHistoryIdx(-1)
      cmdHistoryIdxRef.current = -1
      cmdDraftRef.current = ''
      return
    }

    // While a .define readout is up, ArrowUp/ArrowDown browse the glossary
    // alphabetically instead of the command history, until Escape.
    if (defineEntry && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const result = useBrevityStore.getState().neighbor(defineEntry.term, e.key === 'ArrowUp' ? -1 : 1)
      if (result) setDefineEntry(result)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const hist = cmdHistoryRef.current
      if (!hist.length) return
      if (cmdHistoryIdxRef.current === -1) cmdDraftRef.current = cmdBuffer
      const next = Math.min(cmdHistoryIdxRef.current + 1, hist.length - 1)
      setCmdHistoryIdx(next)
      cmdHistoryIdxRef.current = next
      setCmdBuffer(hist[next])
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (cmdHistoryIdxRef.current === -1) return
      const next = cmdHistoryIdxRef.current - 1
      setCmdHistoryIdx(next)
      cmdHistoryIdxRef.current = next
      setCmdBuffer(next === -1 ? cmdDraftRef.current : cmdHistoryRef.current[next])
      return
    }

    if (e.key === 'Backspace') {
      e.preventDefault()
      setCmdBuffer(b => b.slice(0, -1))
      return
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      setPendingDeclaration(null)
      clearPendingBraa()
      setCmdFeedback('')
      setCmdBuffer(b => b + e.key)
    }
  }, [cmdBuffer, cmdFeedback, pendingDeclaration, pendingBraaFighter, findMarker, clearPendingBraa, defineEntry]) // eslint-disable-line

  const handleMouseUp = useCallback((e) => {
    if (e.button !== 0) return
    if (rblDragActiveRef.current) return // this mouseup is finishing an RBL drag, not a click
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect || !viewRef.current) return
    const pos    = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const target = resolveSlew(pos, visibleUnitsRef.current, viewRef.current)

    // .sector + click: place sector origin at cursor
    if (pendingSectorRef.current) {
      const ll = canvasToLatLng(pos.x, pos.y, viewRef.current)
      setSector({ ...pendingSectorRef.current, origin: ll })
      setSectorVisible(true)
      setSectorPreviewOrigin(null)
      clearCmd()
      return
    }

    // .be + click: place the bullseye override at the clicked point. Armed
    // live while cmdBuffer is exactly ".be" (see pendingBe above); typing
    // on past that (a fix name or coordinates) disarms it and the command
    // instead resolves on Enter via execCommand.
    if (pendingBeRef.current) {
      const ll = canvasToLatLng(pos.x, pos.y, viewRef.current)
      setBullseyeOverride({ lat: ll.lat, lng: ll.lng })
      clearCmd()
      setCmdFeedback(`BULLSEYE SET ${ll.lat.toFixed(2)}/${ll.lng.toFixed(2)}`)
      return
    }

    if (e.shiftKey && !e.altKey) {
      if (target) removeBraaPairsForUnit(target.unitId)
      return
    }

    if (e.ctrlKey && e.altKey) {
      if (target) { toggleThreatRing(target.unitId); clearCmd() }
      return
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (!target) { clearPendingBraa(); return }
      const pending = useAicStore.getState().pendingBraaFighter
      if (pending && target.unitId !== pending) { addBraaPair(pending, target.unitId); return }
      if (pending === target.unitId) clearPendingBraa()
      else setPendingBraaFighter(target.unitId)
      return
    }

    if (e.altKey && !e.ctrlKey) {
      if (!target) return
      const nearestId = findNearestBogey(
        target.unitId, target.unit,
        visibleUnitsRef.current, declarationsRef.current, myCoalitionNum,
      )
      if (nearestId) { addBraaPair(target.unitId, nearestId); setCmdFeedback('BOGEY DOPE') }
      else setCmdFeedback('NO BOGEY')
      return
    }

    const buf = cmdBuffer.trim().toLowerCase()

    if (buf === '.center') {
      const ll = canvasToLatLng(pos.x, pos.y, viewRef.current)
      displayStore.updateWindow(WINDOW_ID, { centerLat: ll.lat, centerLng: ll.lng, centerOverridden: true })
      setCmdFeedback('CENTERED')
      clearCmd()
      return
    }

    if (buf === '.threat' || buf.match(/^\.threat\s+\d+(\.\d+)?$/)) {
      if (target) {
        if (buf !== '.threat') {
          displayStore.updateWindow(WINDOW_ID, { threatRadius: parseFloat(buf.split(/\s+/)[1]) })
        }
        toggleThreatRing(target.unitId)
        clearCmd()
      }
      return
    }

    if (buf === '.rename' || buf.startsWith('.rename ')) {
      if (target) {
        const newCallsign = buf.slice(7).trim().toUpperCase() || null
        const { oldCallsign } = applyCallsignChange(target.unitId, target.unit, newCallsign)
        sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(target.unitId), oldCallsign, newCallsign })
        setCmdFeedback(newCallsign ? `RENAMED ${newCallsign}` : 'CALLSIGN RESET')
        setCmdBuffer('')
      }
      return
    }

    if (buf === '.dope') {
      if (!target) return
      const nearestId = findNearestBogey(
        target.unitId, target.unit,
        visibleUnitsRef.current, declarationsRef.current, myCoalitionNum,
      )
      if (nearestId) { addBraaPair(target.unitId, nearestId); setCmdFeedback('BOGEY DOPE') }
      else setCmdFeedback('NO BOGEY')
      setCmdBuffer('')
      return
    }

    const pending = useAicStore.getState().pendingBraaFighter
    if (pending && target && target.unitId !== pending) { addBraaPair(pending, target.unitId); return }
    if (pending && !target) { clearPendingBraa(); return }

    if (pendingDeclaration && target) {
      setDeclaration(target.unitId, pendingDeclaration)
      setPendingDeclaration(null)
    }
  }, [pendingDeclaration, cmdBuffer, myCoalitionNum, setDeclaration, addBraaPair, removeBraaPairsForUnit, setPendingBraaFighter, clearPendingBraa, toggleThreatRing, displayStore]) // eslint-disable-line

  const wheelHandlerRef = useRef(null)
  wheelHandlerRef.current = (e) => {
    e.preventDefault()
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    if (!ws) return
    const dir  = wheelDir(e)
    if (dir === null) return
    const step = e.ctrlKey ? 10 : 5
    const next = Math.max(10, Math.min(600, (ws.rangeNm ?? 120) + dir * step))
    displayStore.updateWindow(WINDOW_ID, { rangeNm: next })
  }

  useEffect(() => {
    const el = interactiveRef.current
    if (!el) return
    const fn = (e) => wheelHandlerRef.current(e)
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [!!windowSettings]) // eslint-disable-line

  // ── Derived display values ─────────────────────────────────────────────────────

  const readout = useMemo(() => {
    if (!hoveredUnit || !view) return null
    const { unitId, unit } = hoveredUnit
    if (!unit.position) return null

    const altFt      = Math.round((unit.position.alt ?? 0) * 3.28084)
    const altK       = Math.round(altFt / 1000)
    const trueTrkDeg = ((unit.track ?? 0) * 180 / Math.PI + 360) % 360
    const magTrkDeg  = Math.round(toMagneticFromTrue(trueTrkDeg, declinationDeg)) || 360
    const { brg, range } = bearingRangeFromBullseye(
      unit.position.lat, unit.position.lng, bullseyeLat, bullseyeLng, declinationDeg, theatre
    )
    const decl      = getEffectiveDeclaration(unitId, unit, myCoalitionNum)
    const isFriendly = decl === 'FRIENDLY'
    const typeRevealed = isFriendly || rwrEverDetectedRef.current.has(String(unitId))
    const typeName  = typeRevealed
      ? (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1')
      : null
    const callsign  = isFriendly ? resolveCallsign(unit) : null
    const spdKts    = Math.round((unit.speed ?? 0) * 1.94384)

    return {
      pos:      `${String(brg).padStart(3, '0')} / ${range}`,
      alt:      `${altK}k`,
      trk:      `${subcardinal(magTrkDeg)} ${String(magTrkDeg).padStart(3, '0')}`,
      decl,
      type:     typeName,
      spd:      `${spdKts}`,
      flags:    speedFlags(unit),
      callsign,
    }
  }, [hoveredUnit, view, bullseyeLat, bullseyeLng, declinationDeg, declarations, myCoalitionNum]) // eslint-disable-line

  const cursorBullseye = useMemo(() => {
    if (!cursorLatLng || !bullseyeEntry) return null
    const { brg, range } = bearingRangeFromBullseye(
      cursorLatLng.lat, cursorLatLng.lng, bullseyeLat, bullseyeLng, declinationDeg, theatre
    )
    return `${String(brg).padStart(3, '0')} / ${range}`
  }, [cursorLatLng, bullseyeLat, bullseyeLng, declinationDeg, bullseyeEntry])

  const isPictureAlert = useMemo(() => {
    if (!picture || picture.labelKey === 'CLEAN') return false
    if (!ackPicture) return picture.totalGroups > 0
    return picture.labelKey !== ackPicture.labelKey || picture.totalGroups !== ackPicture.totalGroups
  }, [picture, ackPicture])

  if (!windowSettings) return null

  // ── Picture group rows (column-aligned, min 3 spaces between fields) ───────────
  let pictureRows = []
  let namedGroupCount = 0
  if (picture) {
    // FOLLOW ON groups aren't listed as their own PICTURE rows — doctrine
    // reports them as a single trailing distance (picture.amplifiers.followOnNm).
    const namedGroups = picture.groups.filter(g => !g.isFollowOn)
    namedGroupCount = namedGroups.length
    pictureRows = namedGroups.slice(0, 6).map(g => ({
      name:       abbrGroupName(g.name),
      bs:         `${String(g.bullseye.brg).padStart(3, '0')} / ${g.bullseye.range}`,
      alt:        `${Math.round(g.altFt / 1000)}k`,
      trk:        g.trackDir ? (CARDINAL_ABBR[g.trackDir] ?? g.trackDir) : '-',
      decl:       DECL_PICTURE[g.decl] ?? '?',
      strength:   g.isHeavy ? 'HVY' : `${g.contactCount}`,
      fills:      picFillIns(g),
    }))
    const colWidth = key => Math.max(0, ...pictureRows.map(r => r[key].length)) + 3
    const wName = colWidth('name'), wBs = colWidth('bs'), wAlt = colWidth('alt'), wTrk = colWidth('trk'), wDecl = colWidth('decl')
    pictureRows = pictureRows.map(r => ({
      ...r,
      text: r.name.padEnd(wName) + r.bs.padEnd(wBs) + r.alt.padEnd(wAlt) + r.trk.padEnd(wTrk) + r.decl.padEnd(wDecl) + r.strength
          + (r.fills ? '   ' + r.fills : ''),
    }))
  }

  // ── Command area preview ──────────────────────────────────────────────────────
  let cmdPreview = ''
  if (pendingDeclaration) {
    cmdPreview = `${DECL_LABEL[pendingDeclaration]} +`
  } else if (pendingBraaFighter) {
    const fu = visibleUnits[pendingBraaFighter]
    cmdPreview = `BRAA: ${fu ? resolveCallsign(fu) : pendingBraaFighter} → ?`
  } else if (cmdBuffer) {
    cmdPreview = cmdBuffer
  }

  return (
    <div className="aic-scope">
      <div ref={canvasAreaRef} className="aic-canvas-area">
        <canvas ref={mapCanvasRef}  className="aic-layer" />
        <canvas ref={layersRef}     className="aic-layer" />
        <canvas ref={contactsRef}   className="aic-layer" />
        <div
          ref={interactiveRef}
          className="aic-layer aic-interactive"
          tabIndex={0}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            const rect = interactiveRef.current?.getBoundingClientRect()
            if (!rect || !viewRef.current) return
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
            leftDragStartRef.current = { clientX: e.clientX, clientY: e.clientY, lat, lng }
          }}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => { setHoveredUnit(null); setCursorLatLng(null); setCursorPixelPos(null) }}
          onKeyDown={handleKeyDown}
          onContextMenu={e => e.preventDefault()}
        >
          {becVisible && cursorBullseye && cursorPixelPos && (
            <div className="aic-bec-box" style={{ left: cursorPixelPos.x, top: cursorPixelPos.y }}>
              {cursorBullseye}
            </div>
          )}
        </div>

        {/* Contact info readout / cursor bullseye — top right */}
        {(readout || cursorBullseye) && (
          <div className="aic-readout">
            {readout ? (
              <>
                <div className="aic-readout-grid">
                  <span>{readout.pos}</span>
                  <span>{readout.alt}</span>
                  <span>{readout.trk}</span>
                  <span className={`aic-readout-decl${readout.decl ? ` aic-readout-decl--${readout.decl.toLowerCase()}` : ''}`}>{readout.decl}</span>
                  <span className="aic-readout-id">{readout.type}</span>
                  <span>{readout.spd}</span>
                </div>
                {readout.flags    && <div className="aic-readout-flags">{readout.flags}</div>}
                {readout.callsign && <div className="aic-readout-callsign">{readout.callsign}</div>}
              </>
            ) : (
              <div className="aic-readout-cursor-bs">{cursorBullseye}</div>
            )}
          </div>
        )}

        {/* ROE indicator — top left */}
        {roe && (
          <div className={`aic-roe aic-roe--${roe.toLowerCase()}`}>
            {ROE_DISPLAY[roe]}
          </div>
        )}

        {/* PICTURE readout — top left, below ROE. Click to acknowledge NEW PICTURE.
            Hidden by default; toggled with the .picture command. */}
        {showPicture && picture && (
          <div
            className="aic-picture"
            onClick={() => {
              if (picture.labelKey !== 'CLEAN' && picture.totalGroups > 0)
                setAckPicture({ labelKey: picture.labelKey, totalGroups: picture.totalGroups })
              interactiveRef.current?.focus()
            }}
          >
            <div className={`aic-picture-header${isPictureAlert ? ' aic-picture-header--alert' : ''}`}>
              {picture.autoSector ? '~ ' : ''}{picture.label}
              {picture.amplifiers?.dimensionStr ? `  ${picture.amplifiers.dimensionStr}` : ''}
            </div>
            {picture.labelKey !== 'CLEAN' && picture.amplifiers &&
              (picture.amplifiers.openingClosing || picture.amplifiers.weighted || picture.amplifiers.echelon) && (
              <div className="aic-picture-ampls">
                {[
                  picture.amplifiers.openingClosing,
                  picture.amplifiers.weighted && `WEIGHTED ${picture.amplifiers.weighted}`,
                  picture.amplifiers.echelon  && `ECHELON ${picture.amplifiers.echelon}`,
                ].filter(Boolean).join('  ')}
              </div>
            )}
            {pictureRows.map((r, i) => (
              <div key={i} className="aic-picture-group">
                {r.text}
              </div>
            ))}
            {namedGroupCount > 6 && (
              <div className="aic-picture-more">+{namedGroupCount - 6} MORE</div>
            )}
            {picture.amplifiers?.followOnNm != null && (
              <div className="aic-picture-ampls">FOLLOW ON {picture.amplifiers.followOnNm}</div>
            )}
          </div>
        )}

        {/* No bullseye warning */}
        {!bullseyeEntry && !bullseyeOverride && (
          <div className="aic-warn">NO BULLSEYE</div>
        )}


        {/* Mission clock — above cmd feedback/entry. Click to toggle Zulu/Local. */}
        <div
          className="aic-clock"
          onClick={() => { setShowLocalTime((v) => !v); interactiveRef.current?.focus() }}
          title="Click to toggle Zulu / Local time"
        >
          {clockTime ?? (showLocalTime ? '--:--:--L' : '--:--:--Z')}
        </div>

        {/* Command feedback — above cmd entry */}
        {cmdFeedback && (
          <div className="aic-cmd-feedback">{cmdFeedback}</div>
        )}

        {defineEntry && (
          <div className="aic-define" onClick={() => { setDefineEntry(null); interactiveRef.current?.focus() }}>
            <div className="aic-define-term">{defineEntry.term}</div>
            <div className="aic-define-text">{defineEntry.text}</div>
          </div>
        )}

        {/* Command entry — bottom left */}
        <div className="aic-cmd-area">
          <span className="aic-cmd-prompt">{'>'}</span>
          <span className={`aic-cmd-preview${pendingDeclaration ? ' aic-cmd-fkey' : ''}`}>
            {cmdPreview}
          </span>
          {!pendingDeclaration && <span className="aic-cmd-cursor">_</span>}
        </div>
      </div>
    </div>
  )
}
