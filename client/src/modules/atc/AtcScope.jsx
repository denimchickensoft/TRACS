import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useUnitsStore }       from '../../store/units.js'
import { useAtcStore }         from '../../store/atc.js'
import { useSessionStore }     from '../../store/session.js'
import { useControllersStore } from '../../store/controllers.js'
import { useDisplayStore }  from '../../store/display.js'
import { useOdsStore }      from '../../store/ods.js'
import { usePreviewStore }  from '../../store/preview.js'
import { getVisibleUnits }      from './visibleUnits.js'
import { rangeToPixelsPerNm, canvasToLatLng, latLngToCanvas } from './canvas/projection.js'
import { drawRangeRings }       from './canvas/drawRangeRings.js'
import { drawCompassRose }      from './canvas/drawCompassRose.js'
import { drawContacts }         from './canvas/drawContacts.js'
import { drawRbls }             from './canvas/drawRbls.js'
import { drawMinSep }          from './canvas/drawMinSep.js'
import { drawMaps }                   from './canvas/drawMaps.js'
import { drawExtendedCenterlines }    from './canvas/drawExtendedCenterlines.js'
import { drawObstructions }           from './canvas/drawObstructions.js'
import { useMapsStore }         from '../../store/maps.js'
import { useRunwaysStore }      from '../../store/runways.js'
import { DatablockOverlay }     from './DatablockOverlay.jsx'
import { InputHandler }         from './input/InputHandler.jsx'
import { PreviewArea }          from './PreviewArea.jsx'
import { Dcb }                  from './dcb/Dcb.jsx'
import { SSA }                  from './lists/SSA.jsx'
import { SignOnList }           from './lists/SignOnList.jsx'
import { FlightPlanList }       from './lists/FlightPlanList.jsx'
import { TowerLists }           from './lists/TowerList.jsx'
import { CoastList }            from './lists/CoastList.jsx'
import { AlertList }            from './lists/AlertList.jsx'
import { VFRList }              from './lists/VFRList.jsx'
import { resolveSlew }          from './input/slewResolver.js'
import { parseCommand }         from './input/commandParser.js'
import { dispatch as dispatchAction, INIT_CNTL } from './actions/index.js'
import { usePresetsStore }  from '../../store/presets.js'
import { useFpeStore }      from '../../store/fpe.js'
import { useNavdataStore }  from '../../store/navdata.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { FPE }             from '../../components/FPE/FPE.jsx'
import './AtcScope.css'

const WINDOW_ID  = 'atc-main'
const MAX_HISTORY = 10  // absolute max; display capped by historyLength setting

export default function AtcScope() {
  const wheelDir         = useWheelDirection()
  const mapCanvasRef     = useRef(null)
  const ringCanvasRef    = useRef(null)
  const compassCanvasRef = useRef(null)
  const ctxCanvasRef     = useRef(null)
  const rblCanvasRef     = useRef(null)
  const interactiveRef   = useRef(null)

  const units        = useUnitsStore((s) => s.units)
  const ownership    = useAtcStore((s) => s.ownership)
  const handoffs     = useAtcStore((s) => s.handoffs)
  const blinkTracks  = useAtcStore((s) => s.blinkTracks)
  const displayFdb   = useAtcStore((s) => s.displayFdb)
  const coalition    = useSessionStore((s) => s.coalition)
  const positionName = useSessionStore((s) => s.positionName)
  const myControllerId = useControllersStore((s) => s.registry[positionName]?.controllerId ?? null)
  const mission         = useSessionStore((s) => s.mission)
  const airbases        = useSessionStore((s) => s.airbases)
  const facilityDcsName  = useSessionStore((s) => s.facilityDcsName)
  const facilityType     = useSessionStore((s) => s.facilityType)
  const positionSuffix   = useSessionStore((s) => s.positionSuffix)

  const maps       = useMapsStore((s) => s.maps)
  const mapColors  = useMapsStore((s) => s.colors)
  const mapVisible = useMapsStore((s) => s.visible)
  const centerlines   = useRunwaysStore((s) => s.centerlines)
  const cltrVisible   = useRunwaysStore((s) => s.cltrVisible)
  const obstructions  = useRunwaysStore((s) => s.obstructions)
  const obstVisible   = useRunwaysStore((s) => s.obstVisible)

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  const activeProfile = useOdsStore((s) => s.activeProfile)

  const [view,       setView]      = useState(null)
  const [dcbVisible, setDcbVisible] = useState(true)
  const [slewedPdbs, setSlewedPdbs] = useState(() => new Set())
  // Tick every 200ms to drive symbol blink redraws
  const [blinkTick, setBlinkTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setBlinkTick((t) => t + 1), 200)
    return () => clearInterval(id)
  }, [])

  const handlePdbToggle = useCallback((uid) => {
    setSlewedPdbs((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }, [])

  const viewRef      = useRef(null)    // always-current view for event handlers
  const panRef       = useRef({ dragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0 })
  const historyRef   = useRef({})
  const rblCursorRef = useRef(null)    // canvas-pixel cursor pos during RBL_P2 preview
  const coordsRef    = useRef(null)    // debug coords display div

  // Keep viewRef in sync
  useEffect(() => { viewRef.current = view }, [view])

  const tdmMode = windowSettings?.tdmMode ?? false

  // ── Visible units (filtered) ──────────────────────────────────────
  const visibleUnits    = useMemo(() => getVisibleUnits(units, coalition, tdmMode), [units, coalition, tdmMode])
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])


  // ── Contact symbol map ────────────────────────────────────────────
  // Each entry: { sym: string, mine: boolean }
  // sym  — '*' unassociated, position letter (e.g. 'T') when associated
  // mine — true when owned by this controller (drives white vs green)
  const symbolMap = useMemo(() => {
    const map = {}
    for (const id of Object.keys(visibleUnits)) {
      const owner = ownership[String(id)]
      // Treat as "mine" if owned by me, or if I have a sticky FDB (post-handoff sender)
      const mine  = owner === myControllerId || !!displayFdb[String(id)]
      // 2-char ID in either order (e.g. "1A" or "A1") — extract the letter
      const m   = owner?.length === 2 ? owner.match(/[A-Z]/) : null
      const sym = m ? m[0] : '*'
      map[id] = { sym, mine }
    }
    return map
  }, [visibleUnits, ownership, displayFdb, myControllerId])

  // ── Load presets from server on mount; apply default if set ──────
  useEffect(() => {
    usePresetsStore.getState().load().then(() => {
      const { slots, defaultSlot } = usePresetsStore.getState()
      if (defaultSlot !== null && slots[defaultSlot]?.settings) {
        const settings = slots[defaultSlot].settings
        displayStore.updateWindow(WINDOW_ID, {
          ...settings,
          offCntr:         false,
          rrCenterLat:     null,
          rrCenterLng:     null,
          rrOffCenter:     false,
          pendingAction:   null,
          dcbActiveSpinner: null,
        })
        if (settings.mapsVisible)
          useMapsStore.getState().setVisible(settings.mapsVisible)
        if (settings.previewPosition !== undefined)
          usePreviewStore.getState().setPosition(settings.previewPosition)
        usePresetsStore.getState().setActiveSlot(defaultSlot)
      }
    })
  }, []) // eslint-disable-line

  // ── Initialize display window ─────────────────────────────────────
  useEffect(() => {
    if (!windowSettings) {
      displayStore.initWindow(WINDOW_ID, activeProfile?.defaults ?? {})
    }
  }, []) // eslint-disable-line

  useEffect(() => {
    if (!activeProfile?.defaults || !windowSettings) return
    displayStore.applyProfileDefaults(WINDOW_ID, activeProfile.defaults)
  }, [activeProfile]) // eslint-disable-line

  // ── Build view ────────────────────────────────────────────────────
  const theatre    = mission?.mission?.theatre
  const facilityCl = centerlines.find((c) => c.airbase === facilityDcsName)
  const magvar     = facilityCl?.geoMagvar ?? facilityCl?.magvar ?? 0

  // Load fixes + navaids for the current theatre so .FIND lookups work
  useEffect(() => {
    if (theatre) useNavdataStore.getState().loadForTheatre(theatre)
  }, [theatre])

  const buildView = useCallback(() => {
    const canvas = ringCanvasRef.current
    if (!canvas || !windowSettings) return null
    const { rangeNm, centerLat, centerLng } = windowSettings
    const w = canvas.width
    const h = canvas.height
    if (!w || !h) return null
    const effectiveMagvar = typeof window.__magvarOverride === 'number' ? window.__magvarOverride : magvar
    return {
      centerLat: centerLat ?? 0,
      centerLng: centerLng ?? 0,
      pixelsPerNm: rangeToPixelsPerNm(rangeNm, w, h),
      width: w,
      height: h,
      magvar: effectiveMagvar,
    }
  }, [windowSettings, magvar])

  const canvasAreaRef = useRef(null)

  // ── Resize observer ───────────────────────────────────────────────
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      for (const ref of [mapCanvasRef, ringCanvasRef, compassCanvasRef, ctxCanvasRef, rblCanvasRef]) {
        if (ref.current) { ref.current.width = w; ref.current.height = h }
      }
      setView(buildView())
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [buildView])

  useEffect(() => { setView(buildView()) }, [buildView, blinkTick])

  // ── Auto-center on facility airbase ──────────────────────────────
  // Stores the facilityDcsName that was last auto-centered so that changing
  // facility triggers a re-center even if the scope is already off-zero.
  const autoCenteredRef = useRef(null)
  useEffect(() => {
    // FIR/CTR has no single center point — skip auto-center, let controller pan
    if (!windowSettings || facilityType === 'fir') return
    if (!facilityDcsName) return
    if (autoCenteredRef.current === facilityDcsName) return

    // Prefer a runway center point — more precise than the Olympus airbase position.
    // Falls back to Olympus position if runway data hasn't loaded yet or has no match
    // (effect re-fires when runways arrive via the dependency array).
    const facilityRunway = centerlines.find((c) => c.airbase === facilityDcsName)
    let centerLat, centerLng
    if (facilityRunway) {
      centerLat = (facilityRunway.rwyEnd1.lat + facilityRunway.rwyEnd2.lat) / 2
      centerLng = (facilityRunway.rwyEnd1.lng + facilityRunway.rwyEnd2.lng) / 2
    } else {
      const raw   = airbases?.airbases ?? airbases ?? {}
      const match = Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName)
      if (!match?.latitude || !match?.longitude) return
      centerLat = match.latitude
      centerLng = match.longitude
    }

    displayStore.updateWindow(WINDOW_ID, {
      centerLat,
      centerLng,
      homeCenterLat: centerLat,
      homeCenterLng: centerLng,
      offCntr:       false,
    })
    autoCenteredRef.current = facilityDcsName
  }, [airbases, facilityDcsName, centerlines, windowSettings, displayStore])

  // ── Load runway data when theatre or facility changes ────────────
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    const raw    = airbases?.airbases ?? airbases ?? {}
    const match  = facilityDcsName ? Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName) : null
    const facLat = match?.latitude  ?? null
    const facLng = match?.longitude ?? null
    const missionDate = mission?.mission?.dateAndTime?.date ?? null
    useRunwaysStore.getState().loadForTheatre(theatre, positionSuffix, facLat, facLng, facilityDcsName, missionDate)
  }, [mission?.mission?.theatre, mission?.mission?.dateAndTime?.date, facilityDcsName, positionSuffix, airbases])

  // ── Load airspace maps when theatre or facility changes ──────────
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    const raw    = airbases?.airbases ?? airbases ?? {}
    const match  = facilityDcsName ? Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName) : null
    const facLat = match?.latitude  ?? null
    const facLng = match?.longitude ?? null
    useMapsStore.getState().loadForTheatre(theatre, positionSuffix, facLat, facLng, positionName)
  }, [mission?.mission?.theatre, facilityDcsName, positionSuffix, airbases])


  // ── History capture ───────────────────────────────────────────────
  // Rate driven by windowSettings.historyRate (seconds). Uses a ref for the
  // current rate so the interval itself never needs to be torn down on change.
  const historyRateRef = useRef(4.5)
  useEffect(() => {
    historyRateRef.current = windowSettings?.historyRate ?? 4.5
  }, [windowSettings?.historyRate])

  useEffect(() => {
    let lastCaptureWall = 0
    let lastCaptureUpdateTime = 0
    const id = setInterval(() => {
      const rateSecs = historyRateRef.current
      if (rateSecs <= 0) return

      // Only capture when fresh Olympus data has arrived
      const { lastUpdateTime } = useUnitsStore.getState()
      if (!lastUpdateTime || lastUpdateTime === lastCaptureUpdateTime) return

      // Rate-gate in wall time
      const now = Date.now()
      if ((now - lastCaptureWall) < rateSecs * 1000) return

      lastCaptureWall = now
      lastCaptureUpdateTime = lastUpdateTime

      const current = visibleUnitsRef.current
      historyRef.current = Object.fromEntries(
        Object.entries(current).map(([uid, u]) => {
          const prev = historyRef.current[uid] || []
          const pos  = u.position
          if (!pos) return [uid, prev]
          return [uid, [{ lat: pos.lat, lng: pos.lng }, ...prev].slice(0, MAX_HISTORY)]
        })
      )
    }, 200)
    return () => clearInterval(id)
  }, []) // eslint-disable-line

  // ── Render range rings ────────────────────────────────────────────
  useEffect(() => {
    if (!view || !ringCanvasRef.current || !activeProfile) return
    const rrCenter = (windowSettings?.rrCenterLat != null && windowSettings?.rrCenterLng != null)
      ? { lat: windowSettings.rrCenterLat, lng: windowSettings.rrCenterLng }
      : { lat: windowSettings?.homeCenterLat ?? 0, lng: windowSettings?.homeCenterLng ?? 0 }
    drawRangeRings(
      ringCanvasRef.current.getContext('2d'),
      view, windowSettings?.rangeNm, windowSettings?.ringSpacingNm,
      activeProfile.visual, rrCenter, windowSettings?.briteRr ?? 70,
    )
  }, [view, windowSettings?.rangeNm, windowSettings?.ringSpacingNm, windowSettings?.briteRr,
      windowSettings?.rrCenterLat, windowSettings?.rrCenterLng,
      windowSettings?.homeCenterLat, windowSettings?.homeCenterLng, activeProfile])

  // ── Render geographic maps ────────────────────────────────────────
  useEffect(() => {
    if (!view || !mapCanvasRef.current) return
    const ctx = mapCanvasRef.current.getContext('2d')
    drawMaps(ctx, view, maps, mapVisible,
      windowSettings?.briteMapA ?? 80, windowSettings?.briteMapB ?? 50, windowSettings?.csMap ?? 2, mapColors,
      activeProfile?.visual?.mapPolygonFill ?? 0)
    drawExtendedCenterlines(ctx, view, centerlines, cltrVisible, windowSettings?.briteMapA ?? 80)
    drawObstructions(ctx, view, obstructions, obstVisible, windowSettings?.briteMapA ?? 80)
  }, [view, maps, mapColors, mapVisible, centerlines, cltrVisible, obstructions, obstVisible,
      windowSettings?.briteMapA, windowSettings?.briteMapB, windowSettings?.csMap])

  // ── Render compass rose ───────────────────────────────────────────
  useEffect(() => {
    if (!view || !compassCanvasRef.current) return
    drawCompassRose(compassCanvasRef.current.getContext('2d'), view,
      windowSettings?.briteCmp ?? 70, windowSettings?.csTools ?? 3)
  }, [view, windowSettings?.briteCmp, windowSettings?.csTools])

  // ── Render contacts ───────────────────────────────────────────────
  useEffect(() => {
    if (!view || !ctxCanvasRef.current || !activeProfile) return
    const ptlOpts = (activeProfile.features?.PTL && windowSettings?.ptlMode)
      ? { minutes: windowSettings?.ptlLength ?? 2, mode: windowSettings?.ptlMode,
          ownership, myPosition: myControllerId }
      : null

    // Units whose symbol should blink: incoming HO to me, or active post-accept timer
    const now = Date.now()
    const blinkingUids = new Set()
    for (const [uid, ho] of Object.entries(handoffs)) {
      if (ho.to === myControllerId) blinkingUids.add(String(uid))
    }
    for (const [uid, expiresAt] of Object.entries(blinkTracks)) {
      if (now < expiresAt) blinkingUids.add(String(uid))
    }

    const ctx = ctxCanvasRef.current.getContext('2d')
    drawContacts(
      ctx, view,
      visibleUnits, historyRef.current, activeProfile.visual,
      symbolMap, (windowSettings?.britePos ?? 80) / 100, windowSettings?.csPos ?? 3,
      ptlOpts, windowSettings?.historyLength ?? 5, (windowSettings?.briteHst ?? 80) / 100,
      blinkingUids, blinkOn,
    )

    // Draw .FIND marker — small green square centered on the found fix
    const marker = windowSettings?.findMarker
    if (marker) {
      const { x, y } = latLngToCanvas(marker.lat, marker.lon, view)
      ctx.fillStyle = '#00e000'
      ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8)
    }

  }, [visibleUnits, view, symbolMap, ownership, handoffs, blinkTracks, blinkTick,
      myControllerId, positionName,
      windowSettings?.britePos, windowSettings?.briteHst, windowSettings?.csPos,
      windowSettings?.ptlMode, windowSettings?.ptlLength, windowSettings?.historyLength,
      windowSettings?.findMarker,
      activeProfile])

  // ── RBL layer — rAF loop for smooth cursor tracking ───────────────
  useEffect(() => {
    let rafId
    let ctx = null
    let hadContent = false

    function loop() {
      // Resolve ctx lazily — canvas doesn't exist on first render (component returns null)
      if (!ctx) {
        const canvas = rblCanvasRef.current
        if (canvas) ctx = canvas.getContext('2d')
      }

      const view    = viewRef.current
      const win     = useDisplayStore.getState().windows[WINDOW_ID]
      const rbls    = win?.rbls    ?? []
      const rblWip  = win?.rblWip  ?? null
      const minSep  = win?.minSep  ?? null
      const minWip  = win?.minWip  ?? null
      const csTools = win?.csTools ?? 3
      const hasContent = rbls.length > 0 || rblWip != null || minSep != null || minWip != null

      if (ctx && (hasContent || hadContent)) {
        const canvas = rblCanvasRef.current
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (view && hasContent) {
          drawRbls(ctx, view, rbls, rblWip, rblCursorRef.current, visibleUnitsRef.current, csTools)
          drawMinSep(ctx, view, minSep, minWip, rblCursorRef.current, visibleUnitsRef.current, csTools)
        }
      }
      hadContent = hasContent
      rafId = requestAnimationFrame(loop)
    }

    rafId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafId)
  }, []) // eslint-disable-line

  // ── Command evaluation helper ─────────────────────────────────────
  const evaluateCommand = useCallback((trigger, canvasPos = null) => {
    const buffer  = usePreviewStore.getState().buffer
    const parsed  = parseCommand(buffer, trigger)
    if (!parsed) {
      if (trigger === 'ENTER') usePreviewStore.getState().setResponse('INVALID INPUT')
      return
    }

    const slewTarget = (trigger === 'SLEW' && canvasPos && viewRef.current)
      ? resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
      : null

    const canvasLatLng = (trigger === 'SLEW' && canvasPos && viewRef.current)
      ? canvasToLatLng(canvasPos.x, canvasPos.y, viewRef.current)
      : null

    const canvasSize = canvasAreaRef.current
      ? { w: canvasAreaRef.current.clientWidth, h: canvasAreaRef.current.clientHeight }
      : null

    dispatchAction(parsed, slewTarget, { positionName, canvasPos, canvasSize, canvasLatLng, windowId: WINDOW_ID })
  }, [positionName]) // eslint-disable-line

  // ── ENTER key handler (from InputHandler) ─────────────────────────
  const handleEnter = useCallback(() => {
    // When awaiting RBL second endpoint, ENTER with a non-empty buffer will resolve
    // it as a typed fix/ACID once fixes are implemented.
    if (windowSettings?.pendingAction === 'RBL_P2') {
      const buf = usePreviewStore.getState().buffer.trim()
      if (buf) {
        const result = useNavdataStore.getState().lookupFix(buf)
        if (!result) { usePreviewStore.getState().setResponse('NOT FOUND'); return }
        const rblWip = useDisplayStore.getState().windows[WINDOW_ID]?.rblWip
        if (!rblWip) { displayStore.updateWindow(WINDOW_ID, { pendingAction: null }); return }
        const currentRbls = windowSettings?.rbls ?? []
        displayStore.updateWindow(WINDOW_ID, {
          rbls:          [...currentRbls, { p0: rblWip.p0, p1: { lat: result.lat, lng: result.lon } }],
          rblWip:        null,
          pendingAction: null,
        })
        usePreviewStore.getState().clearAfterCommand()
        return
      }
    }

    const pending = usePresetsStore.getState().pendingMode
    if (pending?.type === 'name') {
      const name = usePreviewStore.getState().buffer.trim()
      if (!name) {
        usePresetsStore.getState().setPendingMode(null)
        usePreviewStore.getState().setResponse('CANCELLED')
        return
      }
      const win      = useDisplayStore.getState().windows[WINDOW_ID]
      const enriched = {
        ...win,
        mapsVisible:     useMapsStore.getState().visible,
        previewPosition: usePreviewStore.getState().position,
      }
      usePresetsStore.getState().saveToSlot(pending.slotIndex, name, enriched)
      usePreviewStore.getState().clear()
      usePreviewStore.getState().setResponse('PREF SAVED')
      return
    }
    evaluateCommand('ENTER')
  }, [evaluateCommand, windowSettings?.pendingAction])

  // ── ESC handler ───────────────────────────────────────────────────
  const handleEsc = useCallback(() => {
    const win     = useDisplayStore.getState().windows[WINDOW_ID]
    const pending = win?.pendingAction
    if (win?.findMarker) {
      displayStore.updateWindow(WINDOW_ID, { findMarker: null })
      return
    }
    if (pending === 'RBL_P2') {
      displayStore.updateWindow(WINDOW_ID, { pendingAction: null, rblWip: null })
    } else if (pending === 'MIN_P2') {
      displayStore.updateWindow(WINDOW_ID, { pendingAction: null, minWip: null })
    }
  }, [displayStore])

  // ── Immediate action handler (DCB-style keys) ─────────────────────
  const handleImmediateAction = useCallback((action) => {
    switch (action) {
      case 'RECENTER':
        // TODO: re-center to facility-defined center
        break
      case 'TOGGLE_DCB':
        setDcbVisible(v => !v)
        break
      case 'TOGGLE_TOPDOWN': {
        const current = useDisplayStore.getState().windows[WINDOW_ID]?.tdmMode ?? false
        displayStore.updateWindow(WINDOW_ID, { tdmMode: !current })
        break
      }
      default:
        break
    }
  }, [displayStore])

  // ── Mouse: LEFT click = slew, RIGHT drag = pan ────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button === 2) {
      // Right mouse — start pan
      panRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false }
      e.preventDefault()
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (rect) {
      const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      rblCursorRef.current = pos
      if (coordsRef.current && viewRef.current) {
        const { lat, lng } = canvasToLatLng(pos.x, pos.y, viewRef.current)
        const latStr = `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'}`
        const lngStr = `${Math.abs(lng).toFixed(6)}°${lng >= 0 ? 'E' : 'W'}`
        coordsRef.current.textContent = `${latStr}  ${lngStr}`
      }
    }

    if (!panRef.current.dragging || !viewRef.current || !windowSettings) return
    const dx = e.clientX - panRef.current.lastX
    const dy = e.clientY - panRef.current.lastY
    panRef.current.lastX = e.clientX
    panRef.current.lastY = e.clientY
    panRef.current.moved = true

    const v = viewRef.current
    const nmPerPx = 1 / v.pixelsPerNm
    const newLat  = v.centerLat + (dy * nmPerPx) / 60
    const newLng  = v.centerLng - (dx * nmPerPx) / (60 * Math.cos(v.centerLat * Math.PI / 180))
    displayStore.updateWindow(WINDOW_ID, { centerLat: newLat, centerLng: newLng, offCntr: true })
  }, [windowSettings, displayStore])

  const handleMouseUp = useCallback((e) => {
    if (e.button === 2) {
      panRef.current.dragging = false
      return
    }
    if (e.button === 0 && e.ctrlKey && e.shiftKey) {
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect) return
      const canvasPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      if (viewRef.current) {
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (target) INIT_CNTL({ slewTarget: target, positionName })
      }
      return
    }

    if (e.button === 0 && e.ctrlKey) {
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect) return
      const canvasPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      if (viewRef.current) {
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (target) {
          const aid      = resolveCallsign(target.unit)
          const owner    = useAtcStore.getState().ownership[target.unitId]
          const readOnly = !!(owner && owner !== myControllerId)
          useFpeStore.getState().openFpe({ aid, unitId: target.unitId, readOnly, scope: 'atc' })
        }
      }
      return
    }

    if (e.button === 0) {
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect) return
      const canvasPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }

      // Consume pending one-shot actions before falling through to slew
      const pending = windowSettings?.pendingAction
      if (pending === 'PLACE_RR' && viewRef.current) {
        const { lat, lng } = canvasToLatLng(canvasPos.x, canvasPos.y, viewRef.current)
        displayStore.updateWindow(WINDOW_ID, {
          rrCenterLat:   lat,
          rrCenterLng:   lng,
          rrOffCenter:   true,
          pendingAction: null,
        })
        return
      }

      if (pending === 'RBL_P2' && viewRef.current) {
        const rblWip = windowSettings?.rblWip
        if (!rblWip) { displayStore.updateWindow(WINDOW_ID, { pendingAction: null }); return }
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        const p1 = target
          ? { unitId: String(target.unitId) }
          : canvasToLatLng(canvasPos.x, canvasPos.y, viewRef.current)
        const currentRbls = windowSettings?.rbls ?? []
        displayStore.updateWindow(WINDOW_ID, {
          rbls:          [...currentRbls, { p0: rblWip.p0, p1 }],
          rblWip:        null,
          pendingAction: null,
        })
        usePreviewStore.getState().clearAfterCommand()
        return
      }

      if (pending === 'MIN_P2' && viewRef.current) {
        const minWip = windowSettings?.minWip
        if (!minWip) { displayStore.updateWindow(WINDOW_ID, { pendingAction: null }); return }
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (!target) return  // MIN requires a track; ignore empty-space clicks
        const ac1 = String(target.unitId)
        if (ac1 === minWip.ac0) return  // same track, ignore
        displayStore.updateWindow(WINDOW_ID, {
          minSep: { ac0: minWip.ac0, ac1 },
          minWip: null,
          pendingAction: null,
        })
        usePreviewStore.getState().clearAfterCommand()
        return
      }

      // Bare-slew handling — only when the buffer is empty (no command pending).
      if (viewRef.current && !usePreviewStore.getState().buffer.trim()) {
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (target) {
          const atcState = useAtcStore.getState()
          const uid      = String(target.unitId)
          const owner    = atcState.ownership[uid]
          const hoTo     = atcState.handoffs[uid]?.to

          // Sender dismissing sticky FDB: clear it, stop blink, expand to slewed PDB
          if (atcState.displayFdb[uid]) {
            atcState.clearDisplayFdb(uid)
            atcState.clearBlinkTrack(uid)
            if (!slewedPdbs.has(uid)) handlePdbToggle(uid)
            return
          }

          // PDB toggle: another controller's track, no pending handoff to me
          if (owner && owner !== myControllerId && hoTo !== myControllerId) {
            handlePdbToggle(uid)
            return
          }
        }
      }

      evaluateCommand('SLEW', canvasPos)
    }
    if (e.button === 1) {
      // Middle click — toggle highlight (STARS behaviour)
      // TODO: implement highlight toggle
    }
  }, [evaluateCommand, windowSettings, displayStore])

  // ── Zoom ──────────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    if (!windowSettings) return
    // Inhibit zoom while a DCB spinner is active — the DCB bar handles its own scroll
    if (windowSettings.dcbActiveSpinner) return
    const dir = wheelDir(e)
    if (dir === null) return
    const step     = e.ctrlKey ? 3 : 1
    const newRange = Math.max(6, Math.min(256, windowSettings.rangeNm + dir * step))
    displayStore.updateWindow(WINDOW_ID, { rangeNm: newRange })
  }, [windowSettings, displayStore, wheelDir])

  // Attach wheel listener as non-passive so preventDefault() works
  useEffect(() => {
    const el = interactiveRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  if (!windowSettings || !activeProfile) return null

  const previewEnabled = activeProfile.interaction?.previewArea?.enabled ?? false

  // Background brightness: 0 = black, 100 = medium gray (~#A0A0A0)
  const bkgGray = Math.round((windowSettings.briteBkg ?? 0) / 100 * 160)
  const bgColor = `rgb(${bkgGray},${bkgGray},${bkgGray})`

  // ldrLength stored as 0–7; convert to pixels (10px per unit). null → profile default.
  const ldrLength = windowSettings.ldrLength != null
    ? windowSettings.ldrLength * 10
    : activeProfile.visual.dataBlock?.leaderLength ?? 40
  // ldrAngleDeg stored as canvas degrees (0=right, CW). null → profile default.
  const ldrAngleDeg = windowSettings.ldrAngleDeg ?? activeProfile.visual.dataBlock?.leaderAngleDeg ?? -45

  // Datablock brightness (0–1 opacity)
  const briteFdb = (windowSettings.briteFdb ?? 80) / 100
  const briteLdb = (windowSettings.briteLdb ?? 70) / 100

  // DCB brightness (0–1 opacity)
  const briteDcb = (windowSettings.briteDcb ?? 80) / 100

  // Character size (0–5 scale; 3 = default)
  const csDatablocks = windowSettings.csDatablocks ?? 3
  const csDcb        = windowSettings.csDcb        ?? 3

  const dcbPos      = windowSettings.dcbPosition ?? 'top'
  const coordsVisible = windowSettings.coordsVisible ?? false

  // Computed once per render — shared by both canvas effect (closure) and SVG overlay (prop)
  // so the symbol letter and datablock always blink from the same value in the same frame.
  const blinkOn = Math.floor(Date.now() / 500) % 2 === 0

  return (
    <div className="atc-scope" data-dcb-pos={dcbVisible && activeProfile.dcb ? dcbPos : undefined} style={{ background: bgColor }}>
      {dcbVisible && activeProfile.dcb && <Dcb profile={activeProfile} briteDcb={briteDcb} csDcb={csDcb} />}

      <div ref={canvasAreaRef} className="atc-canvas-area">
        <canvas ref={mapCanvasRef}     className="atc-layer" />
        <canvas ref={ringCanvasRef}    className="atc-layer" />
        <canvas ref={compassCanvasRef} className="atc-layer" />
        <canvas ref={ctxCanvasRef}     className="atc-layer" />
        <canvas ref={rblCanvasRef}     className="atc-layer" />

        <DatablockOverlay
          units={visibleUnits} view={view} visual={activeProfile.visual}
          ldrLength={ldrLength} ldrAngleDeg={ldrAngleDeg}
          briteFdb={briteFdb} briteLdb={briteLdb}
          csDatablocks={csDatablocks}
          slewedPdbs={slewedPdbs}
          blinkOn={blinkOn}
        />

        <div
          ref={interactiveRef}
          className="atc-layer atc-interactive"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { panRef.current.dragging = false }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {activeProfile?.features?.coordinationLists && <>
          <SSA />
          <SignOnList />
          <FlightPlanList />
          <TowerLists />
          <CoastList />
          <AlertList />
          <VFRList />
        </>}

        {previewEnabled && <PreviewArea />}

        <FPE scope="atc" />

        {coordsVisible && <div ref={coordsRef} className="atc-coords-debug" />}
      </div>

      <InputHandler
        onEnter={handleEnter}
        onImmediateAction={handleImmediateAction}
        onEsc={handleEsc}
      />
    </div>
  )
}
