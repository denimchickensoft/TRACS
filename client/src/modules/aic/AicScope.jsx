import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection }   from '../../utils/wheel.js'
import { useUnitsStore }       from '../../store/units.js'
import { useSessionStore }     from '../../store/session.js'
import { useDisplayStore }     from '../../store/display.js'
import { useAicStore, DECLARATION, ROE_STATE } from '../../store/aic.js'
import { useNavdataStore }       from '../../store/navdata.js'
import { useRunwaysStore }       from '../../store/runways.js'
import { latLngToCanvas, rangeToPixelsPerNm, canvasToLatLng } from '../atc/stars/canvas/projection.js'
import { resolveSlew }         from '../atc/stars/input/slewResolver.js'
import { computeMagvar, theatreConvergence } from '../../utils/magvar.js'
import { drawAicLayers, drawSector } from './canvas/drawAicLayers.js'
import { drawAicContacts }     from './canvas/drawAicContacts.js'
import { drawGeo }             from '../atc/stars/canvas/drawGeo.js'
import { drawRelief }          from '../atc/stars/canvas/drawRelief.js'
import { computePicture, sectorAxisBearing } from './canvas/computePicture.js'
import { useGeoStore }         from '../../store/geo.js'
import { useReliefStore }      from '../../store/relief.js'
import { useMapsStore }        from '../../store/maps.js'
import { BraaList }            from './BraaList.jsx'
import './AicScope.css'

const WINDOW_ID = 'aic-main'
const AIC_SETTINGS_KEY = 'aic-settings'
const AIC_WIN_FIELDS = [
  'rangeNm', 'ringSpacingNm', 'ptlSeconds', 'symSize',
  'fadedSeconds', 'threatRadius', 'centerLat', 'centerLng',
  'centerOverridden', 'aspColorIdx',
]

const COALITION_NUM = { blue: 2, red: 1, gm: 2, admin: 2 }

const F_KEY_DECL = {
  F1: DECLARATION.HOSTILE,
  F2: DECLARATION.UNKNOWN,
  F3: DECLARATION.NEUTRAL,
  F4: DECLARATION.FRIENDLY,
}

const DECL_LABEL = {
  [DECLARATION.HOSTILE]:  'HO',
  [DECLARATION.UNKNOWN]:  'UN',
  [DECLARATION.NEUTRAL]:  'NE',
  [DECLARATION.FRIENDLY]: 'FR',
}

const ROE_DISPLAY = {
  [ROE_STATE.FREE]:  'WEAPONS FREE',
  [ROE_STATE.TIGHT]: 'WEAPONS TIGHT',
  [ROE_STATE.HOLD]:  'WEAPONS HOLD',
}

const DECL_PICTURE = {
  [DECLARATION.HOSTILE]:  'HOSTILE',
  [DECLARATION.UNKNOWN]:  'UNKNOWN',
  [DECLARATION.NEUTRAL]:  'NEUTRAL',
  [DECLARATION.FRIENDLY]: 'FRIENDLY',
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
  if (g.contactCount === 2) parts.push('2 CONTACTS')
  else if (g.isHeavy) parts.push('HEAVY')
  if (g.isStack) parts.push(`STACK ${g.stackHighFt / 1000}K/${g.stackLowFt / 1000}K`)
  if (g.isHigh) parts.push('HIGH')
  if (g.isVeryFast) parts.push('VERY FAST')
  else if (g.isFast) parts.push('FAST')
  if (g.isBogeySpades) parts.push('SPADES')
  if (g.openingClosing) parts.push(g.openingClosing)
  return parts.join('  ')
}

function findNearestBogey(fighterId, fighterUnit, units, declarations, myCoalitionNum) {
  if (!fighterUnit?.position) return null
  let nearestId = null, nearestDist = Infinity
  for (const [id, unit] of Object.entries(units)) {
    if (id === fighterId || !unit.position) continue
    const decl = declarations[id] ?? (
      unit.coalition === myCoalitionNum ? 'FRIENDLY' :
      unit.coalition === 0 ? 'NEUTRAL' : 'HOSTILE'
    )
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

function getAicVisibleUnits(units, myCoalitionNum) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if ((c.detectionMethod & 4) || (c.detectionMethod & 32)) detectedIds.add(String(c.ID))
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

function bearingRangeFromBullseye(lat, lng, bsLat, bsLng, magvar) {
  const nmPerDegLng = 60 * Math.cos(bsLat * Math.PI / 180)
  const dN = (lat - bsLat) * 60
  const dE = (lng - bsLng) * nmPerDegLng
  const trueBrg = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
  const magBrg  = ((trueBrg - magvar) + 360) % 360
  const range   = Math.hypot(dN, dE)
  return { brg: Math.round(magBrg) || 360, range: Math.round(range) }
}

function resolveCallsignDisplay(unit) {
  return unit.callsign || unit.unitName || unit.name || '?'
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
  const braaList          = useAicStore(s => s.braaList)
  const pendingBraaFighter = useAicStore(s => s.pendingBraaFighter)
  const {
    setDeclaration, setRoe, addBraaPair, removeBraaPair, removeBraaPairsForUnit,
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

  const bullseyeEntry = useMemo(() => {
    if (!bullseyes?.bullseyes) return null
    const coalStr = coalition === 'red' ? 'red' : 'blue'
    return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
        ?? Object.values(bullseyes.bullseyes)[0]
        ?? null
  }, [bullseyes, coalition])

  const bullseyeLat = bullseyeEntry?.latitude  ?? 0
  const bullseyeLng = bullseyeEntry?.longitude ?? 0

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

  const magvar      = computeMagvar(centerLat, centerLng, missionDate)
  const convergence = theatre ? theatreConvergence(theatre, centerLat, centerLng) : 0
  const effectiveMagvar = magvar + convergence

  const centerLatRef = useRef(centerLat)
  const centerLngRef = useRef(centerLng)
  const magvarRef    = useRef(effectiveMagvar)
  useEffect(() => { centerLatRef.current = centerLat }, [centerLat])
  useEffect(() => { centerLngRef.current = centerLng }, [centerLng])
  useEffect(() => { magvarRef.current = effectiveMagvar }, [effectiveMagvar])

  const rangeNm       = windowSettings?.rangeNm       ?? 120
  const ringSpacingNm = windowSettings?.ringSpacingNm ?? 20
  const ptlSeconds    = windowSettings?.ptlSeconds    ?? 60
  const symSize       = windowSettings?.symSize       ?? 3

  const visibleUnits = useMemo(() => getAicVisibleUnits(units, myCoalitionNum), [units, myCoalitionNum])
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])

  const declarationsRef = useRef(declarations)
  useEffect(() => { declarationsRef.current = declarations }, [declarations])

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
      magvar: magvarRef.current,
    }
  }, [])

  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setView(buildView(width, height))
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, []) // eslint-disable-line

  useEffect(() => { setView(buildView()) }, [centerLat, centerLng, effectiveMagvar, windowSettings?.rangeNm]) // eslint-disable-line

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
  }, []) // eslint-disable-line

  // ── All state — declared before any effect that references them in deps ───────

  const [threatRings, setThreatRings] = useState(new Set())
  const toggleThreatRing = (unitId) =>
    setThreatRings(prev => { const n = new Set(prev); n.has(unitId) ? n.delete(unitId) : n.add(unitId); return n })
  const threatRadius = windowSettings?.threatRadius ?? 35

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

  const rightDragStartRef = useRef(null)

  const [pendingDeclaration, setPendingDeclaration] = useState(null)

  // Command buffer — must be declared before pendingSector useMemo
  const [cmdBuffer, setCmdBuffer] = useState('')
  const [cmdFeedback, setCmdFeedback] = useState('')
  const [cmdHistory, setCmdHistory] = useState([])
  const cmdHistoryRef = useRef([])
  useEffect(() => { cmdHistoryRef.current = cmdHistory }, [cmdHistory])
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1)
  const cmdHistoryIdxRef = useRef(-1)
  useEffect(() => { cmdHistoryIdxRef.current = cmdHistoryIdx }, [cmdHistoryIdx])
  const cmdDraftRef = useRef('')

  // Pending sector parsed from cmdBuffer (must be before contacts effect)
  const pendingSector = useMemo(() => {
    const m = cmdBuffer.trim().match(/^\.sector\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/i)
    if (!m) return null
    const fromMag = parseFloat(m[1]) % 360
    const toMag   = parseFloat(m[2]) % 360
    const rng     = parseFloat(m[3])
    if (isNaN(fromMag) || isNaN(toMag) || isNaN(rng) || rng <= 0) return null
    const fromTrue = (fromMag + effectiveMagvar + 360) % 360
    const toTrue   = (toMag   + effectiveMagvar + 360) % 360
    return { fromBearing: fromTrue, toBearing: toTrue, rangeNm: rng, axisBearing: sectorAxisBearing(fromTrue, toTrue) }
  }, [cmdBuffer, effectiveMagvar])

  // Ref so event callbacks can always read the current pendingSector value
  const pendingSectorRef = useRef(null)
  useEffect(() => { pendingSectorRef.current = pendingSector }, [pendingSector])

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

  // Contacts + sector preview
  useEffect(() => {
    if (!view || !contactsRef.current) return
    const ctx = contactsRef.current.getContext('2d')
    const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
    drawAicContacts(ctx, view, visibleUnits, getDecl, ptlSeconds, symSize, braaList, rangeNm, rbl, effectiveMagvar,
      threatRings, threatRadius, fadedRef.current, Date.now(), findMarker)
    if (pendingSector && sectorPreviewOrigin) {
      drawSector(ctx, view, { ...pendingSector, origin: sectorPreviewOrigin }, true)
    }
  }, [view, visibleUnits, declarations, ptlSeconds, symSize, braaList, rangeNm, myCoalitionNum, rbl, effectiveMagvar, threatRings, threatRadius, fadedTick, findMarker, pendingSector, sectorPreviewOrigin]) // eslint-disable-line

  // RBL drag (right-click)
  const rblRef = useRef(null)
  useEffect(() => { rblRef.current = rbl }, [rbl])

  useEffect(() => {
    const onMove = (e) => {
      if (!rightDragStartRef.current) return
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
      setRbl(prev => prev ? { ...prev, end: { lat, lng } } : null)
    }
    const onUp = (e) => {
      if (e.button !== 2) return
      const start = rightDragStartRef.current
      rightDragStartRef.current = null
      if (!start) return
      const dragged = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > 5
      if (dragged) {
        setRbl(prev => prev?.end ? { ...prev, fixed: true } : null)
      } else {
        setRbl(null)
      }
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
          const magv    = magvarRef.current
          const trueRad = ((brg + magv) % 360) * Math.PI / 180
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
      const magv     = magvarRef.current
      const fromTrue = (fromMag + magv + 360) % 360
      const toTrue   = (toMag   + magv + 360) % 360
      setSector({
        origin:      { lat: bullseyeLat, lng: bullseyeLng },
        fromBearing: fromTrue, toBearing: toTrue, rangeNm: rng,
        axisBearing: sectorAxisBearing(fromTrue, toTrue),
      })
      setSectorVisible(true)
      setSectorPreviewOrigin(null)
      setCmdFeedback(`SECTOR ${Math.round(fromMag)}/${Math.round(toMag)} ${Math.round(rng)}NM @BS`)
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
  }, [cmdBuffer, cmdFeedback, pendingDeclaration, pendingBraaFighter, findMarker, clearPendingBraa]) // eslint-disable-line

  const handleMouseUp = useCallback((e) => {
    if (e.button !== 0) return
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

    if (e.ctrlKey && e.shiftKey && !e.altKey) {
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
    const altRounded = Math.round(altFt / 100) * 100
    const trueTrkDeg = ((unit.track ?? 0) * 180 / Math.PI + 360) % 360
    const magTrkDeg  = Math.round(((trueTrkDeg - effectiveMagvar) + 360) % 360) || 360
    const { brg, range } = bearingRangeFromBullseye(
      unit.position.lat, unit.position.lng, bullseyeLat, bullseyeLng, effectiveMagvar
    )
    const decl      = getEffectiveDeclaration(unitId, unit, myCoalitionNum)
    const isFriendly = decl === 'FRIENDLY'
    const typeName  = (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1')
    const callsign  = isFriendly ? resolveCallsignDisplay(unit) : null
    const spdKts    = Math.round((unit.speed ?? 0) * 1.94384)

    return {
      pos:      `${String(brg).padStart(3, '0')} / ${range}`,
      alt:      `${altRounded}`,
      trk:      `${subcardinal(magTrkDeg)} ${String(magTrkDeg).padStart(3, '0')}`,
      decl,
      type:     typeName,
      spd:      `${spdKts}`,
      flags:    speedFlags(unit),
      callsign,
    }
  }, [hoveredUnit, view, bullseyeLat, bullseyeLng, effectiveMagvar, declarations, myCoalitionNum]) // eslint-disable-line

  const cursorBullseye = useMemo(() => {
    if (!cursorLatLng || !bullseyeEntry) return null
    const { brg, range } = bearingRangeFromBullseye(
      cursorLatLng.lat, cursorLatLng.lng, bullseyeLat, bullseyeLng, effectiveMagvar
    )
    return `${String(brg).padStart(3, '0')} / ${range}`
  }, [cursorLatLng, bullseyeLat, bullseyeLng, effectiveMagvar, bullseyeEntry])

  const picture = useMemo(() => {
    if (!bullseyeEntry) return null
    return computePicture(
      visibleUnits,
      (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum),
      myCoalitionNum,
      sector,
      bullseyeLat, bullseyeLng,
      effectiveMagvar,
    )
  }, [visibleUnits, declarations, myCoalitionNum, sector, bullseyeLat, bullseyeLng, effectiveMagvar]) // eslint-disable-line

  const isPictureAlert = useMemo(() => {
    if (!picture || picture.labelKey === 'CLEAN') return false
    if (!ackPicture) return picture.totalGroups > 0
    return picture.labelKey !== ackPicture.labelKey || picture.totalGroups !== ackPicture.totalGroups
  }, [picture, ackPicture])

  if (!windowSettings) return null

  // ── Command area preview ──────────────────────────────────────────────────────
  let cmdPreview = ''
  if (pendingDeclaration) {
    cmdPreview = `${DECL_LABEL[pendingDeclaration]} +`
  } else if (pendingBraaFighter) {
    const fu = visibleUnits[pendingBraaFighter]
    cmdPreview = `BRAA: ${fu ? resolveCallsignDisplay(fu) : pendingBraaFighter} → ?`
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
            if (e.button !== 2) return
            const rect = interactiveRef.current?.getBoundingClientRect()
            if (!rect || !viewRef.current) return
            const x = e.clientX - rect.left
            const y = e.clientY - rect.top
            const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
            rightDragStartRef.current = { clientX: e.clientX, clientY: e.clientY, lat, lng }
            setRbl({ anchor: { lat, lng }, end: null, fixed: false })
          }}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => { setHoveredUnit(null); setCursorLatLng(null) }}
          onKeyDown={handleKeyDown}
          onContextMenu={e => e.preventDefault()}
        />

        {/* Contact info readout / cursor bullseye — top right */}
        {(readout || cursorBullseye) && (
          <div className="aic-readout">
            {readout ? (
              <>
                <div className="aic-readout-line1">
                  <span>{readout.pos}</span>
                  <span>{readout.alt}</span>
                  <span>{readout.trk}</span>
                </div>
                <div className="aic-readout-line2">
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

        {/* PICTURE readout — top left, below ROE. Click to acknowledge NEW PICTURE. */}
        {picture && (
          <div
            className="aic-picture"
            onClick={() => {
              if (picture.labelKey !== 'CLEAN' && picture.totalGroups > 0)
                setAckPicture({ labelKey: picture.labelKey, totalGroups: picture.totalGroups })
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
            {picture.groups.slice(0, 6).map((g, i) => {
              const name  = g.name.replace(' GROUP', '')
              const bs    = `${String(g.bullseye.brg).padStart(3, '0')}/${String(g.bullseye.range).padStart(3)}`
              const alt   = `${Math.round(g.altFt / 1000)}K`.padStart(4)
              const trk   = g.trackDir ?? '-'
              const decl  = DECL_PICTURE[g.decl] ?? 'UNKNOWN'
              const fills = picFillIns(g)
              return (
                <div key={i} className={`aic-picture-group${g.isFollowOn ? ' aic-picture-group--followon' : ''}`}>
                  {`${name}  ${bs}  ${alt}  ${trk}  ${decl}${fills ? '  ' + fills : ''}`}
                </div>
              )
            })}
            {picture.totalGroups > 6 && (
              <div className="aic-picture-more">+{picture.totalGroups - 6} MORE</div>
            )}
          </div>
        )}

        {/* No bullseye warning */}
        {!bullseyeEntry && (
          <div className="aic-warn">NO BULLSEYE</div>
        )}


        {/* Command feedback — above cmd entry */}
        {cmdFeedback && (
          <div className="aic-cmd-feedback">{cmdFeedback}</div>
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
