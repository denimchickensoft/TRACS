import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection }   from '../../utils/wheel.js'
import { nmBetween, findNearestBogey } from '../../utils/findNearestBogey.js'
import { useUnitsStore }       from '../../store/units.js'
import { useWeaponsStore }     from '../../store/weapons.js'
import { useSessionStore }     from '../../store/session.js'
import { useDisplayStore }     from '../../store/display.js'
import { useAicStore, DECLARATION, getAicEffectiveDeclaration } from '../../store/aic.js'
import { AUTO_DECLARE_MODE } from '../../utils/createDeclarationStore.js'
import { getIffStatus } from '../../utils/transponder.js'
import { useRoeStore, ROE_DISPLAY } from '../../store/roe.js'
import { useAicPrefsStore }    from '../../store/aicPrefs.js'
import { applyCallsignChange }  from '../../utils/callsignRename.js'
import { resolveCallsign }      from '../../utils/callsign.js'
import { sendWebrtcSessionEvent } from '../../webrtc/client.js'
import { useNavdataStore }       from '../../store/navdata.js'
import { useRunwaysStore }       from '../../store/runways.js'
import { rangeToPixelsPerNm, canvasToLatLng } from '../../utils/projection.js'
import { resolveSlew }         from '../atc/stars/input/slewResolver.js'
import { computeMagvar } from '../../utils/magvar.js'
import { gridBearingRangeNm, toMagneticFromTrue, toTrueFromMagnetic } from '../../utils/bearing.js'
import { drawAicLayers, drawSector } from './canvas/drawAicLayers.js'
import { drawAicContacts }     from './canvas/drawAicContacts.js'
import { drawAbmMissiles }     from '../../utils/declarationSymbols.js'
import { drawGeo }             from '../atc/stars/canvas/drawGeo.js'
import { drawRelief }          from '../atc/stars/canvas/drawRelief.js'
import { computePicture, sectorAxisBearing } from './canvas/computePicture.js'
import { useGeoStore }         from '../../store/geo.js'
import { useReliefStore }      from '../../store/relief.js'
import { useMapsStore }        from '../../store/maps.js'
import { useBrevityStore }     from '../../store/brevity.js'
import { useMissionClock }     from '../../utils/useMissionClock.js'
import { parseCommand }        from './input/commandParser.js'
import { dispatch }            from './actions/index.js'
import './AicScope.css'

const WINDOW_ID = 'aic-main'
const AIC_SETTINGS_KEY = 'aic-settings'
const AIC_WIN_FIELDS = [
  'rangeNm', 'ringSpacingNm', 'ptlSeconds', 'symSize',
  'fadedSeconds', 'threatRadius', 'centerLat', 'centerLng',
  'centerOverridden', 'aspColorIdx',
]

const COALITION_NUM = { blue: 2, red: 1, gm: 2, admin: 2 }
const EMPTY_ARRAY = []

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

// .autodec — a unit's TRUE declaration, straight off
// coalition: own side is FRIENDLY, coalition 0 (DCS's neutral) is NEUTRAL,
// anything else is an enemy, i.e. HOSTILE (not BOGEY — autodec means no
// more fog-of-war ambiguity for that contact).
function trueDeclaration(unit, myCoalitionNum) {
  if (unit.coalition === myCoalitionNum) return DECLARATION.FRIENDLY
  if (unit.coalition === 0) return DECLARATION.NEUTRAL
  return DECLARATION.HOSTILE
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

// Missile tracking — same fog-of-war shape as getAicVisibleUnits above, but
// reads unit.missileContacts (not unit.contacts): server/src/missileDetection.js
// deliberately writes to a separate field — see that module's header for why
// (avoids colliding with Olympus's own independent 1s-cadence refresh of a
// unit's real contacts). Local copy, not shared, per this file's existing
// getAicVisibleUnits convention.
function getAicVisibleMissiles(weapons, units, myCoalitionNum) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.missileContacts) continue
    for (const c of unit.missileContacts) detectedIds.add(String(c.ID))
  }

  for (const [id, weapon] of Object.entries(weapons)) {
    if (!weapon.position) continue
    const c = weapon.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = weapon
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
  const roe               = useRoeStore(s => s.roe)
  const autoDeclareMode   = useAicStore(s => s.autoDeclareMode)
  const braaList          = useAicStore(s => s.braaList)
  const pendingBraaFighter = useAicStore(s => s.pendingBraaFighter)
  const setDeclaration         = useAicStore(s => s.setDeclaration)
  const addBraaPair            = useAicStore(s => s.addBraaPair)
  const removeBraaPairsForUnit = useAicStore(s => s.removeBraaPairsForUnit)
  const setPendingBraaFighter  = useAicStore(s => s.setPendingBraaFighter)
  const clearPendingBraa       = useAicStore(s => s.clearPendingBraa)
  const getEffectiveDeclaration = getAicEffectiveDeclaration

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
  // mission-specific placement, not a saved preference. Lives in
  // displayStore's windows[WINDOW_ID] (not local state) so it's reachable
  // from actions/index.js-style standalone command handlers.
  const bullseyeOverride = windowSettings?.bullseyeOverride ?? null // { lat, lng } | null

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

  // Missile tracking — own-coalition/neutral always visible, enemy gated by
  // server/src/missileDetection.js's AWACS/EWR-only detection.
  const weapons = useWeaponsStore(s => s.weapons)
  const visibleMissiles = useMemo(
    () => getAicVisibleMissiles(weapons, units, myCoalitionNum),
    [weapons, units, myCoalitionNum]
  )

  const declarationsRef = useRef(declarations)
  useEffect(() => { declarationsRef.current = declarations }, [declarations])

  // .autodec / .autodec iff —
  // while a mode is active, any unit that becomes visible with no explicit
  // declaration yet gets auto-declared: 'coalition' mode declares every unit
  // to its TRUE declaration unconditionally; 'iff' mode only ever declares
  // FRIENDLY, and only when an srsCapable unit's live Mode 4 reply is VALID
  // (utils/transponder.js's getIffStatus — never HOSTILE/NEUTRAL/BOGEY,
  // under any condition). Only touches undeclared units so it never stomps
  // a manual override (or its own prior auto-declaration) made after the
  // fact. The bulk apply-to-everything-visible-now pass runs once, in
  // actions/index.js, at the moment a mode is switched on.
  useEffect(() => {
    if (autoDeclareMode === AUTO_DECLARE_MODE.OFF) return
    for (const [id, unit] of Object.entries(visibleUnits)) {
      if (declarationsRef.current[id] !== undefined) continue
      if (autoDeclareMode === AUTO_DECLARE_MODE.COALITION) {
        setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
      } else if (autoDeclareMode === AUTO_DECLARE_MODE.IFF) {
        if (trueDeclaration(unit, myCoalitionNum) !== DECLARATION.FRIENDLY) continue
        if (unit.srsCapable && getIffStatus(unit, myCoalitionNum) !== 'VALID') continue
        setDeclaration(id, DECLARATION.FRIENDLY)
      }
    }
  }, [visibleUnits, autoDeclareMode, myCoalitionNum, setDeclaration])

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
        fadedSeconds: 30, threatRadius: 35,
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
  }, [])

  // ── All state — declared before any effect that references them in deps ───────

  // threatRings/showCentroid/showAxis/sector/sectorVisible/sectorPreviewOrigin/
  // ackPicture/rbl/findMarker/defineEntry live in displayStore's
  // windows[WINDOW_ID] (not local useState) so they're reachable from
  // actions/index.js-style standalone command handlers.
  // autoThreat/showPicture/becVisible similarly live in their own reactive
  // store (store/aicPrefs.js) since,
  // unlike ABM/STARS/CATCC/ASDE-X's equivalent prefs, these need to be
  // readable/writable without a closure too.
  const threatRings = windowSettings?.threatRings ?? EMPTY_ARRAY
  const threatRingSet = useMemo(() => new Set(threatRings), [threatRings])
  const toggleThreatRing = useCallback((unitId) => {
    const current = useDisplayStore.getState().windows[WINDOW_ID]?.threatRings ?? []
    const next = current.includes(unitId) ? current.filter(id => id !== unitId) : [...current, unitId]
    useDisplayStore.getState().updateWindow(WINDOW_ID, { threatRings: next })
  }, [])
  const threatRadius = windowSettings?.threatRadius ?? 35

  // .autothreat — local UI toggle (not shared with other
  // controllers). While on, rings light automatically on every friendly
  // aircraft within threatRadius of a HOSTILE/BOGEY aircraft; auto-lit rings
  // are tracked separately from threatRings (manual Ctrl+Alt+click/.threat+
  // click) and just union at draw time, so auto fully owns a contact's ring
  // for as long as the breach lasts.
  const autoThreat = useAicPrefsStore(s => s.autoThreat)
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
  const showCentroid = windowSettings?.showCentroid ?? false
  const showAxis = windowSettings?.showAxis ?? false

  // .picture — toggles visibility of the PICTURE readout panel. Local UI
  // preference (not shared with other controllers). Off by default.
  const showPicture = useAicPrefsStore(s => s.showPicture)

  // .roe (no args) — toggles visibility of the ROE readout badge. Local UI
  // preference (not shared with other controllers). On by default.
  const roeVisible = useAicPrefsStore(s => s.roeVisible)

  // .bec — bullseye-on-cursor readout that tracks the mouse pixel-for-pixel
  // (unlike the always-on cursorBullseye readout below, pinned to the top-
  // right corner). Off by default.
  const becVisible = useAicPrefsStore(s => s.becVisible)
  const [cursorPixelPos, setCursorPixelPos] = useState(null)

  const fadedRef       = useRef({})
  const prevVisibleRef = useRef({})
  const [fadedTick, setFadedTick] = useState(0)

  const findMarker = windowSettings?.findMarker ?? null

  // Sector: stored as TRUE bearings; input is magnetic, converted on entry.
  const sector = windowSettings?.sector ?? null
  const sectorRef = useRef(null)
  useEffect(() => { sectorRef.current = sector }, [sector])
  const sectorVisible = windowSettings?.sectorVisible ?? true
  const sectorPreviewOrigin = windowSettings?.sectorPreviewOrigin ?? null

  // Picture acknowledgment baseline
  const ackPicture = windowSettings?.ackPicture ?? null   // { labelKey, totalGroups }

  const rbl = windowSettings?.rbl ?? null

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
  const defineEntry = windowSettings?.defineEntry ?? null // { term, text }
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
        const decl = getAicEffectiveDeclaration(id, unit, myCoalitionNum)
        fadedRef.current[id] = { unit: { ...unit }, disappearedAt: now, decl }
      }
    }
    for (const id of Object.keys(fadedRef.current)) {
      if (curr[id]) delete fadedRef.current[id]
    }
    prevVisibleRef.current = curr
  }, [visibleUnits, myCoalitionNum])

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
  }, [])

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
      ? new Set([...threatRingSet, ...autoThreatRingIds])
      : threatRingSet
    drawAicContacts(ctx, view, visibleUnits, getDecl, ptlSeconds, symSize, braaList, rangeNm, rbl, declinationDeg,
      mergedThreatRings, threatRadius, fadedRef.current, Date.now(), findMarker,
      showCentroid ? picture?.centroid : null,
      showAxis && picture?.axisOrigin ? { origin: picture.axisOrigin, axisBearing: picture.axisBearing } : null)
    drawAbmMissiles(ctx, view, visibleMissiles, (id, weapon) => trueDeclaration(weapon, myCoalitionNum), ptlSeconds)
    if (pendingSector && sectorPreviewOrigin) {
      drawSector(ctx, view, { ...pendingSector, origin: sectorPreviewOrigin }, true)
    }
  }, [view, visibleUnits, visibleMissiles, declarations, ptlSeconds, symSize, braaList, rangeNm, myCoalitionNum, rbl, declinationDeg, threatRingSet, autoThreatRingIds, threatRadius, fadedTick, findMarker, pendingSector, sectorPreviewOrigin, showCentroid, showAxis, picture]) // eslint-disable-line

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
        useDisplayStore.getState().updateWindow(WINDOW_ID, { rbl: { anchor: { lat: start.lat, lng: start.lng }, end: null, fixed: false } })
      }
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
      const prevRbl = useDisplayStore.getState().windows[WINDOW_ID]?.rbl
      if (prevRbl) useDisplayStore.getState().updateWindow(WINDOW_ID, { rbl: { ...prevRbl, end: { lat, lng } } })
    }
    const onUp = (e) => {
      if (e.button !== 0) return
      const wasActive = rblDragActiveRef.current
      leftDragStartRef.current = null
      rblDragActiveRef.current = false
      if (!wasActive) return
      const prevRbl = useDisplayStore.getState().windows[WINDOW_ID]?.rbl
      useDisplayStore.getState().updateWindow(WINDOW_ID, { rbl: prevRbl?.end ? { ...prevRbl, fixed: true } : null })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

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
    if (pendingSectorRef.current) useDisplayStore.getState().updateWindow(WINDOW_ID, { sectorPreviewOrigin: ll })
  }, [])

  function clearCmd() { setCmdBuffer(''); setCmdFeedback('') }

  // Parses + dispatches via input/commandParser.js + actions/index.js — each
  // action reads/writes state via .getState(), no closures, and returns its
  // feedback string; this wrapper just supplies the render-derived context
  // values actions have no independent store to read from.
  async function execCommand(raw) {
    const parsed = parseCommand(raw)
    if (!parsed) { setCmdFeedback('UNKNOWN COMMAND'); return }
    const context = {
      bullseyeLat, bullseyeLng,
      declinationDeg: declinationRef.current,
      myCoalitionNum,
      visibleUnits: visibleUnitsRef.current,
    }
    const feedback = await dispatch(parsed, context)
    setCmdFeedback(feedback)
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
      if (findMarker) { displayStore.updateWindow(WINDOW_ID, { findMarker: null }); return }
      if (defineEntry) { displayStore.updateWindow(WINDOW_ID, { defineEntry: null }); return }
      const previewClear = !pendingDeclaration && !pendingBraaFighter && !cmdBuffer && !cmdFeedback
      if (previewClear) {
        displayStore.updateWindow(WINDOW_ID, { rbl: null, sectorVisible: false, sectorPreviewOrigin: null })
      } else {
        setPendingDeclaration(null)
        clearPendingBraa()
        clearCmd()
        displayStore.updateWindow(WINDOW_ID, { sectorPreviewOrigin: null })
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
      if (result) displayStore.updateWindow(WINDOW_ID, { defineEntry: result })
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
      displayStore.updateWindow(WINDOW_ID, {
        sector: { ...pendingSectorRef.current, origin: ll },
        sectorVisible: true,
        sectorPreviewOrigin: null,
      })
      clearCmd()
      return
    }

    // .be + click: place the bullseye override at the clicked point. Armed
    // live while cmdBuffer is exactly ".be" (see pendingBe above); typing
    // on past that (a fix name or coordinates) disarms it and the command
    // instead resolves on Enter via execCommand.
    if (pendingBeRef.current) {
      const ll = canvasToLatLng(pos.x, pos.y, viewRef.current)
      displayStore.updateWindow(WINDOW_ID, { bullseyeOverride: { lat: ll.lat, lng: ll.lng } })
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
        target.unitId, target.unit, visibleUnitsRef.current,
        (id, unit) => getAicEffectiveDeclaration(id, unit, myCoalitionNum),
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
        target.unitId, target.unit, visibleUnitsRef.current,
        (id, unit) => getAicEffectiveDeclaration(id, unit, myCoalitionNum),
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
  }, [pendingDeclaration, cmdBuffer, myCoalitionNum, setDeclaration, addBraaPair, removeBraaPairsForUnit, setPendingBraaFighter, clearPendingBraa, toggleThreatRing, displayStore])

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
    // Callsign/type reveal is no longer gated purely on the Declaration — a
    // VALID Mode 4 IFF reply reveals identity too, independent of whether
    // the contact has actually been declared FRIENDLY yet. The Declaration
    // field itself (`decl` above) is never touched by this — it only ever
    // reflects the actual effective/explicit declaration state.
    //
    // Reveal is decoupled from declaration for srsCapable contacts (same
    // rule as ABM): a sticky FRIENDLY declaration (manual F4 or .autodec iff)
    // does NOT by itself keep the callsign revealed — only a currently
    // VALID Mode 4 reply does, AIC's equivalent of ABM's live "correlated"
    // signal. If Mode 4 later drops, the callsign hides again even though
    // the Declaration stays FRIENDLY. Non-srsCapable contacts are
    // unaffected — declaration alone still reveals unconditionally, same
    // as always (no live IFF concept exists for those).
    const iffStatus  = getIffStatus(unit, myCoalitionNum) // 'VALID' | 'INVALID' | 'NO_REPLY' | null (not srsCapable)
    const revealed   = unit.srsCapable ? iffStatus === 'VALID' : decl === DECLARATION.FRIENDLY
    const typeRevealed = revealed || rwrEverDetectedRef.current.has(String(unitId))
    const typeName  = typeRevealed
      ? (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1')
      : null
    const callsign  = revealed ? resolveCallsign(unit) : null
    // No 'VALID REPLY' text — the callsign being shown at all already is
    // the evidence of a valid reply (revealed === iffStatus === 'VALID'
    // for an srsCapable contact); only the non-revealing statuses need a
    // word on the line.
    const iffText   = iffStatus === 'INVALID' ? 'INVALID REPLY' : iffStatus === 'NO_REPLY' ? 'NO REPLY' : null
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
      iff:      iffText,
    }
  }, [hoveredUnit, view, bullseyeLat, bullseyeLng, declinationDeg, declarations, myCoalitionNum]) // eslint-disable-line

  const cursorBullseye = useMemo(() => {
    if (!cursorLatLng || !bullseyeEntry) return null
    const { brg, range } = bearingRangeFromBullseye(
      cursorLatLng.lat, cursorLatLng.lng, bullseyeLat, bullseyeLng, declinationDeg, theatre
    )
    return `${String(brg).padStart(3, '0')} / ${range}`
  }, [cursorLatLng, bullseyeLat, bullseyeLng, declinationDeg, bullseyeEntry, theatre])

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
                {readout.flags && <div className="aic-readout-flags">{readout.flags}</div>}
                {(readout.callsign || readout.iff) && (
                  <div className="aic-readout-callsign">
                    {[readout.callsign, readout.iff].filter(Boolean).join(' ')}
                  </div>
                )}
              </>
            ) : (
              <div className="aic-readout-cursor-bs">{cursorBullseye}</div>
            )}
          </div>
        )}

        {/* ROE indicator — top left. Visibility toggled by bare .roe. */}
        {roeVisible && roe && (
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
                displayStore.updateWindow(WINDOW_ID, { ackPicture: { labelKey: picture.labelKey, totalGroups: picture.totalGroups } })
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
          <div className="aic-define" onClick={() => { displayStore.updateWindow(WINDOW_ID, { defineEntry: null }); interactiveRef.current?.focus() }}>
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
