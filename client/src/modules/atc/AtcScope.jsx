import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useUnitsStore }       from '../../store/units.js'
import { useAtcStore }         from '../../store/atc.js'
import { useSessionStore }     from '../../store/session.js'
import { useControllersStore } from '../../store/controllers.js'
import { useDisplayStore }  from '../../store/display.js'
import { useOdsStore }      from '../../store/ods.js'
import { usePreviewStore }  from '../../store/preview.js'
import { getVisibleUnits }      from './visibleUnits.js'
import { rangeToPixelsPerNm, canvasToLatLng } from './canvas/projection.js'
import { drawRangeRings }       from './canvas/drawRangeRings.js'
import { drawCompassRose }      from './canvas/drawCompassRose.js'
import { drawContacts }         from './canvas/drawContacts.js'
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
import { usePresetsStore } from '../../store/presets.js'
import { useFpeStore }     from '../../store/fpe.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { THEATRE_MAGVAR }  from '../../utils/magvar.js'
import { FPE }             from '../../components/FPE/FPE.jsx'
import './AtcScope.css'

const WINDOW_ID  = 'atc-main'
const MAX_HISTORY = 10  // absolute max; display capped by historyLength setting

export default function AtcScope() {
  const mapCanvasRef     = useRef(null)
  const ringCanvasRef    = useRef(null)
  const compassCanvasRef = useRef(null)
  const ctxCanvasRef     = useRef(null)
  const interactiveRef   = useRef(null)

  const units        = useUnitsStore((s) => s.units)
  const ownership    = useAtcStore((s) => s.ownership)
  const coalition    = useSessionStore((s) => s.coalition)
  const positionName = useSessionStore((s) => s.positionName)
  const mission         = useSessionStore((s) => s.mission)
  const airbases        = useSessionStore((s) => s.airbases)
  const facilityDcsName  = useSessionStore((s) => s.facilityDcsName)
  const facilityType     = useSessionStore((s) => s.facilityType)
  const positionSuffix   = useSessionStore((s) => s.positionSuffix)

  const maps       = useMapsStore((s) => s.maps)
  const mapVisible = useMapsStore((s) => s.visible)
  const centerlines   = useRunwaysStore((s) => s.centerlines)
  const cltrVisible   = useRunwaysStore((s) => s.cltrVisible)
  const obstructions  = useRunwaysStore((s) => s.obstructions)
  const obstVisible   = useRunwaysStore((s) => s.obstVisible)
  const getPositionSymbol = useControllersStore((s) => s.getPositionSymbol)

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  const activeProfile = useOdsStore((s) => s.activeProfile)

  const [view,       setView]      = useState(null)
  const [dcbVisible, setDcbVisible] = useState(true)

  const viewRef   = useRef(null)    // always-current view for event handlers
  const panRef    = useRef({ dragging: false, startX: 0, startY: 0, lastX: 0, lastY: 0 })
  const historyRef = useRef({})

  // Keep viewRef in sync
  useEffect(() => { viewRef.current = view }, [view])

  // ── Visible units (filtered) ──────────────────────────────────────
  const visibleUnits    = useMemo(() => getVisibleUnits(units, coalition), [units, coalition])
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
      const mine  = owner === positionName
      const sym   = owner ? (getPositionSymbol(owner) ?? '*') : '*'
      map[id] = { sym, mine }
    }
    return map
  }, [visibleUnits, ownership, positionName, getPositionSymbol])

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
  const theatre = mission?.mission?.theatre
  const magvar  = THEATRE_MAGVAR[theatre] ?? 0

  const buildView = useCallback(() => {
    const canvas = ringCanvasRef.current
    if (!canvas || !windowSettings) return null
    const { rangeNm, centerLat, centerLng } = windowSettings
    const w = canvas.width
    const h = canvas.height
    if (!w || !h) return null
    return {
      centerLat: centerLat ?? 0,
      centerLng: centerLng ?? 0,
      pixelsPerNm: rangeToPixelsPerNm(rangeNm, w, h),
      width: w,
      height: h,
      magvar,
    }
  }, [windowSettings])

  const canvasAreaRef = useRef(null)

  // ── Resize observer ───────────────────────────────────────────────
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      for (const ref of [mapCanvasRef, ringCanvasRef, compassCanvasRef, ctxCanvasRef]) {
        if (ref.current) { ref.current.width = w; ref.current.height = h }
      }
      setView(buildView())
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [buildView])

  useEffect(() => { setView(buildView()) }, [buildView])

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
    useRunwaysStore.getState().loadForTheatre(theatre, positionSuffix, facLat, facLng, facilityDcsName)
  }, [mission?.mission?.theatre, facilityDcsName, positionSuffix, airbases])

  // ── Load airspace maps when theatre or facility changes ──────────
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    const raw    = airbases?.airbases ?? airbases ?? {}
    const match  = facilityDcsName ? Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName) : null
    const facLat = match?.latitude  ?? null
    const facLng = match?.longitude ?? null
    useMapsStore.getState().loadForTheatre(theatre, positionSuffix, facLat, facLng)
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
      windowSettings?.briteMapA ?? 80, windowSettings?.briteMapB ?? 50, windowSettings?.csMap ?? 2)
    drawExtendedCenterlines(ctx, view, centerlines, cltrVisible, windowSettings?.briteMapA ?? 80)
    drawObstructions(ctx, view, obstructions, obstVisible, windowSettings?.briteMapA ?? 80)
  }, [view, maps, mapVisible, centerlines, cltrVisible, obstructions, obstVisible,
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
          ownership, myPosition: positionName }
      : null
    drawContacts(
      ctxCanvasRef.current.getContext('2d'), view,
      visibleUnits, historyRef.current, activeProfile.visual,
      symbolMap, (windowSettings?.britePos ?? 80) / 100, windowSettings?.csPos ?? 3,
      ptlOpts, windowSettings?.historyLength ?? 5, (windowSettings?.briteHst ?? 80) / 100,
    )
  }, [visibleUnits, view, symbolMap, ownership, positionName,
      windowSettings?.britePos, windowSettings?.briteHst, windowSettings?.csPos,
      windowSettings?.ptlMode, windowSettings?.ptlLength, windowSettings?.historyLength,
      activeProfile])

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

    const canvasSize = canvasAreaRef.current
      ? { w: canvasAreaRef.current.clientWidth, h: canvasAreaRef.current.clientHeight }
      : null

    dispatchAction(parsed, slewTarget, { positionName, canvasPos, canvasSize })
  }, [positionName])

  // ── ENTER key handler (from InputHandler) ─────────────────────────
  const handleEnter = useCallback(() => {
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
  }, [evaluateCommand])

  // ── Immediate action handler (DCB-style keys) ─────────────────────
  const handleImmediateAction = useCallback((action) => {
    switch (action) {
      case 'RECENTER':
        // TODO: re-center to facility-defined center
        break
      case 'TOGGLE_DCB':
        setDcbVisible(v => !v)
        break
      default:
        break
    }
  }, [])

  // ── Mouse: LEFT click = slew, RIGHT drag = pan ────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button === 2) {
      // Right mouse — start pan
      panRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false }
      e.preventDefault()
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
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
          const readOnly = !!(owner && owner !== positionName)
          useFpeStore.getState().openFpe({ aid, unitId: target.unitId, readOnly })
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
    const step   = e.ctrlKey ? 3 : 1
    const delta  = e.deltaY > 0 ? step : -step
    const newRange = Math.max(6, Math.min(256, windowSettings.rangeNm + delta))
    displayStore.updateWindow(WINDOW_ID, { rangeNm: newRange })
  }, [windowSettings, displayStore])

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

  const dcbPos = windowSettings.dcbPosition ?? 'top'

  return (
    <div className="atc-scope" data-dcb-pos={dcbVisible && activeProfile.dcb ? dcbPos : undefined} style={{ background: bgColor }}>
      {dcbVisible && activeProfile.dcb && <Dcb profile={activeProfile} briteDcb={briteDcb} csDcb={csDcb} />}

      <div ref={canvasAreaRef} className="atc-canvas-area">
        <canvas ref={mapCanvasRef}     className="atc-layer" />
        <canvas ref={ringCanvasRef}    className="atc-layer" />
        <canvas ref={compassCanvasRef} className="atc-layer" />
        <canvas ref={ctxCanvasRef}     className="atc-layer" />

        <DatablockOverlay
          units={visibleUnits} view={view} visual={activeProfile.visual}
          ldrLength={ldrLength} ldrAngleDeg={ldrAngleDeg}
          briteFdb={briteFdb} briteLdb={briteLdb}
          csDatablocks={csDatablocks}
        />

        <div
          ref={interactiveRef}
          className="atc-layer atc-interactive"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { panRef.current.dragging = false }}
          onWheel={handleWheel}
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

        <FPE />
      </div>

      <InputHandler
        onEnter={handleEnter}
        onImmediateAction={handleImmediateAction}
      />
    </div>
  )
}
