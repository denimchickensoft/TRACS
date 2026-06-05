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
import { drawAicLayers }       from './canvas/drawAicLayers.js'
import { drawAicContacts }     from './canvas/drawAicContacts.js'
import { BraaList }            from './BraaList.jsx'
import './AicScope.css'

const WINDOW_ID = 'aic-main'

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

function speedFlags(unit) {
  const kts = (unit.speed ?? 0) * 1.94384
  const alt  = (unit.position?.alt ?? 0) * 3.28084
  const parts = []
  if (alt >= 40000)  parts.push('HIGH')
  if (kts >= 900)    parts.push('VERY FAST')
  else if (kts >= 600) parts.push('FAST')
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
  const layersRef       = useRef(null)
  const contactsRef     = useRef(null)
  const interactiveRef  = useRef(null)
  const canvasAreaRef   = useRef(null)

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

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  const myCoalitionNum = COALITION_NUM[coalition] ?? 2
  const theatre        = mission?.mission?.theatre
  const missionDate    = mission?.mission?.dateAndTime?.date ?? null

  // Bullseye position (our coalition)
  const bullseyeEntry = useMemo(() => {
    if (!bullseyes?.bullseyes) return null
    const coalStr = coalition === 'red' ? 'red' : 'blue'
    return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
        ?? Object.values(bullseyes.bullseyes)[0]
        ?? null
  }, [bullseyes, coalition])

  const bullseyeLat = bullseyeEntry?.latitude  ?? 0
  const bullseyeLng = bullseyeEntry?.longitude ?? 0

  // Scope center: bullseye unless overridden
  const centerOverridden = windowSettings?.centerOverridden ?? false
  const centerLat = centerOverridden ? (windowSettings?.centerLat ?? bullseyeLat) : bullseyeLat
  const centerLng = centerOverridden ? (windowSettings?.centerLng ?? bullseyeLng) : bullseyeLng

  useEffect(() => {
    if (!theatre) return
    useNavdataStore.getState().loadForTheatre(theatre)
    if (useRunwaysStore.getState().theatre !== theatre) useRunwaysStore.getState().loadForTheatre(theatre)
  }, [theatre])

  const magvar     = computeMagvar(centerLat, centerLng, missionDate)
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
    for (const ref of [layersRef, contactsRef]) {
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
    if (!windowSettings) {
      displayStore.initWindow(WINDOW_ID, {
        rangeNm: 120, ringSpacingNm: 20, ptlSeconds: 60, symSize: 3,
        centerLat: 0, centerLng: 0, centerOverridden: false,
        fadedSeconds: 30, threatRadius: 35,
      })
    }
  }, []) // eslint-disable-line

  // ── Draw layers (rings + gold band + bullseye) ────────────────────────────────
  useEffect(() => {
    if (!view || !layersRef.current) return
    const ctx = layersRef.current.getContext('2d')
    drawAicLayers(ctx, view, rangeNm, ringSpacingNm, bullseyeLat, bullseyeLng)
  }, [view, rangeNm, ringSpacingNm, bullseyeLat, bullseyeLng])

  // ── Threat rings ──────────────────────────────────────────────────────────────
  const [threatRings, setThreatRings] = useState(new Set())
  const toggleThreatRing = (unitId) =>
    setThreatRings(prev => { const n = new Set(prev); n.has(unitId) ? n.delete(unitId) : n.add(unitId); return n })
  const threatRadius = windowSettings?.threatRadius ?? 35

  // ── Faded / coasting contacts ─────────────────────────────────────────────────
  const fadedRef         = useRef({})   // { [unitId]: { unit, disappearedAt } }
  const prevVisibleRef   = useRef({})
  const [fadedTick, setFadedTick] = useState(0)

  // Detect contacts entering / leaving visibleUnits
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

  // Coast timer — expire old faded contacts + trigger canvas redraws
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

  // ── Find marker ───────────────────────────────────────────────────────────────
  const [findMarker, setFindMarker] = useState(null)

  // ── Range-bearing line (RBL) — declared before the contacts effect that uses it ─
  // null | { anchor:{lat,lng}, end:{lat,lng}|null, fixed:boolean }
  const [rbl, setRbl] = useState(null)

  // ── Draw contacts ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!view || !contactsRef.current) return
    const ctx = contactsRef.current.getContext('2d')
    const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
    drawAicContacts(ctx, view, visibleUnits, getDecl, ptlSeconds, symSize, braaList, rangeNm, rbl, effectiveMagvar,
      threatRings, threatRadius, fadedRef.current, Date.now(), findMarker)
  }, [view, visibleUnits, declarations, ptlSeconds, symSize, braaList, rangeNm, myCoalitionNum, rbl, effectiveMagvar, threatRings, threatRadius, fadedTick, findMarker]) // eslint-disable-line

  // ── Hover readout ─────────────────────────────────────────────────────────────
  const [hoveredUnit, setHoveredUnit] = useState(null)
  const [cursorLatLng, setCursorLatLng] = useState(null)
  const rblRef        = useRef(null)
  useEffect(() => { rblRef.current = rbl }, [rbl])

  const rightDragStartRef = useRef(null)  // { clientX, clientY, lat, lng }

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
        // Anchor the line where it currently is
        setRbl(prev => prev?.end ? { ...prev, fixed: true } : null)
      } else {
        // Plain right-click — clear existing fixed line
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

  const handleMouseMove = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect || !viewRef.current) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const pos = { x, y }
    const hit = resolveSlew(pos, visibleUnitsRef.current, viewRef.current)
    setHoveredUnit(hit ? { unitId: hit.unitId, unit: hit.unit } : null)
    setCursorLatLng(canvasToLatLng(x, y, viewRef.current))
  }, [])

  // ── Declaration mode (F1-F4) ──────────────────────────────────────────────────
  const [pendingDeclaration, setPendingDeclaration] = useState(null)

  // ── Command buffer ────────────────────────────────────────────────────────────
  const [cmdBuffer, setCmdBuffer] = useState('')
  const [cmdFeedback, setCmdFeedback] = useState('')

  function clearCmd() { setCmdBuffer(''); setCmdFeedback('') }

  function execCommand(raw) {
    const str = raw.trim().toLowerCase()
    const ws  = useDisplayStore.getState().windows[WINDOW_ID]

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
          const bsLat = bullseyeLat, bsLng = bullseyeLng
          const nmPerDegLng = 60 * Math.cos(bsLat * Math.PI / 180)
          const magv = magvarRef.current
          const trueRad = ((brg + magv) % 360) * Math.PI / 180
          const newLat  = bsLat + (rng * Math.cos(trueRad)) / 60
          const newLng  = bsLng + (rng * Math.sin(trueRad)) / nmPerDegLng
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
    } else if (str === '.clear all') {
      setThreatRings(new Set())
      setRbl(null)
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
    } else {
      setCmdFeedback('UNKNOWN COMMAND')
    }
  }

  const handleKeyDown = useCallback((e) => {
    // F-key declarations
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
      } else {
        setPendingDeclaration(null)
        clearPendingBraa()
        clearCmd()
      }
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (cmdBuffer.trim()) execCommand(cmdBuffer)
      setCmdBuffer('')
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

    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      if (target) removeBraaPairsForUnit(target.unitId)
      return
    }

    // CTRL+ALT+click — toggle threat ring
    if (e.ctrlKey && e.altKey) {
      if (target) { toggleThreatRing(target.unitId); clearCmd() }
      return
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (!target) { clearPendingBraa(); return }
      const pending = useAicStore.getState().pendingBraaFighter
      if (pending === target.unitId) clearPendingBraa()
      else setPendingBraaFighter(target.unitId)
      return
    }

    // ALT+click — bogey dope: find nearest bogey to clicked fighter
    if (e.altKey && !e.ctrlKey) {
      if (!target) return
      const nearestId = findNearestBogey(
        target.unitId, target.unit,
        visibleUnitsRef.current,
        declarationsRef.current,
        myCoalitionNum,
      )
      if (nearestId) {
        addBraaPair(target.unitId, nearestId)
        setCmdFeedback('BOGEY DOPE')
      } else {
        setCmdFeedback('NO BOGEY')
      }
      return
    }

    const buf = cmdBuffer.trim().toLowerCase()

    // .threat [N] + click — toggle threat ring (optionally set radius first)
    if (buf === '.threat' || buf.match(/^\.threat\s+\d+(\.\d+)?$/)) {
      if (target) {
        if (buf !== '.threat') {
          const nm = parseFloat(buf.split(/\s+/)[1])
          displayStore.updateWindow(WINDOW_ID, { threatRadius: nm })
        }
        toggleThreatRing(target.unitId)
        clearCmd()
      }
      return
    }

    // .dope + click — bogey dope
    if (buf === '.dope') {
      if (!target) return
      const nearestId = findNearestBogey(
        target.unitId, target.unit,
        visibleUnitsRef.current,
        declarationsRef.current,
        myCoalitionNum,
      )
      if (nearestId) {
        addBraaPair(target.unitId, nearestId)
        setCmdFeedback('BOGEY DOPE')
      } else {
        setCmdFeedback('NO BOGEY')
      }
      setCmdBuffer('')
      return
    }

    // Plain click — complete BRAA pair if one is pending
    const pending = useAicStore.getState().pendingBraaFighter
    if (pending && target && target.unitId !== pending) { addBraaPair(pending, target.unitId); return }
    if (pending && !target) { clearPendingBraa(); return }

    if (pendingDeclaration && target) {
      setDeclaration(target.unitId, pendingDeclaration)
      setPendingDeclaration(null)
      return
    }
  }, [pendingDeclaration, cmdBuffer, myCoalitionNum, setDeclaration, addBraaPair, removeBraaPairsForUnit, setPendingBraaFighter, clearPendingBraa, toggleThreatRing, displayStore]) // eslint-disable-line

  // Non-passive wheel handler — must be attached via addEventListener, not onWheel prop,
  // because React 17+ registers onWheel as passive at the root, preventing preventDefault.
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
  }, []) // eslint-disable-line

  // ── Readout: hovered unit info ────────────────────────────────────────────────
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
    const decl        = getEffectiveDeclaration(unitId, unit, myCoalitionNum)
    const declLabel   = decl  // already uppercase: HOSTILE / UNKNOWN / NEUTRAL / FRIENDLY
    const isFriendly  = decl === 'FRIENDLY'
    const typeName    = (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1')
    const callsign    = isFriendly ? resolveCallsignDisplay(unit) : null

    const spdKts = Math.round((unit.speed ?? 0) * 1.94384)
    const flags  = speedFlags(unit)

    return {
      pos:      `${String(brg).padStart(3, '0')} / ${range}`,
      alt:      `${altRounded}`,
      trk:      `${subcardinal(magTrkDeg)} ${String(magTrkDeg).padStart(3, '0')}`,
      decl:     declLabel,
      type:     typeName,
      spd:      `${spdKts}`,
      flags,
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
  } else if (cmdFeedback) {
    cmdPreview = cmdFeedback
  }

  return (
    <div className="aic-scope">
      <div ref={canvasAreaRef} className="aic-canvas-area">
        <canvas ref={layersRef}   className="aic-layer" />
        <canvas ref={contactsRef} className="aic-layer" />
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

        {/* Contact info readout — top right, only when hovered */}
        {readout && (
          <div className="aic-readout">
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
          </div>
        )}

        {/* ROE indicator — top left */}
        {roe && (
          <div className={`aic-roe aic-roe--${roe.toLowerCase()}`}>
            {ROE_DISPLAY[roe]}
          </div>
        )}

        {/* No bullseye warning */}
        {!bullseyeEntry && (
          <div className="aic-warn">NO BULLSEYE</div>
        )}

        {/* Cursor bullseye readout — bottom right */}
        {cursorBullseye && (
          <div className="aic-cursor-bs">{cursorBullseye}</div>
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
