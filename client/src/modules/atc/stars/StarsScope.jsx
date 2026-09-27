import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection } from '../../../utils/wheel.js'
import { useBlink } from '../../../utils/useBlink.js'

import { useUnitsStore }       from '../../../store/units.js'
import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../../../store/atc.js'
import { useDisplayStore }  from '../../../store/display.js'
import { useOdsStore }      from '../../../store/ods.js'
import { usePreviewStore }  from '../../../store/preview.js'
import { getVisibleUnits }      from './visibleUnits.js'
import { useStarsAtcData, useStarsFacilityData, useStarsNavdataLayers } from './starsStoreSelectors.js'
import { computeStarsSymbolMap, computeStarsFilteredUnits } from './starsScopeHelpers.js'
import { useStarsNavdataLoading } from './starsNavdataLoading.js'
import { useStcaTracker } from './stca/useStcaCompute.js'
import { useHistoryCapture } from '../../../utils/useHistoryCapture.js'
import { rangeToPixelsPerNm, canvasToLatLng, latLngToCanvas } from '../../../utils/projection.js'
import { drawRangeRings }       from './canvas/drawRangeRings.js'
import { drawCompassRose }      from './canvas/drawCompassRose.js'
import { drawContacts }         from './canvas/drawContacts.js'
import { drawRbls }             from './canvas/drawRbls.js'
import { drawMinSep }          from './canvas/drawMinSep.js'
import { drawMaps }                   from './canvas/drawMaps.js'
import { drawExtendedCenterlines }    from './canvas/drawExtendedCenterlines.js'
import { drawHoldings }               from './canvas/drawHoldings.js'
import { drawAirways }                from './canvas/drawAirways.js'
import { drawMsa }                    from './canvas/drawMsa.js'
import { drawMora }                   from './canvas/drawMora.js'
import { drawRelief }                 from './canvas/drawRelief.js'
import { drawMva }                    from './canvas/drawMva.js'
import { drawGeo }                    from './canvas/drawGeo.js'
import { drawAbmFixSymbols }          from '../../abm/canvas/drawAbmFixSymbols.js'
import { drawProcedures }             from './canvas/drawProcedures.js'
import { resolveRoute }              from './canvas/routeResolver.js'
import { drawRoute }                 from './canvas/drawRoute.js'
import { snapshotLayerVisibility, applyLayerVisibility } from './layerVisibility.js'
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
import { parseCommand, looksLikeKnownCommand } from './input/commandParser.js'
import { dispatch as dispatchAction, INIT_CNTL, ackConflict, recenterScope } from '../actions/index.js'
import { useStcaStore }         from '../../../store/stca.js'
import { resolvePrimaryOnlyIds } from './stca/formations.js'
import { useAssociationStore }  from '../../../store/association.js'
import { usePresetsStore }  from '../../../store/presets.js'
import { useFpeStore }      from '../../../store/fpe.js'
import { useNavdataStore }      from '../../../store/navdata.js'
import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { findFlightPlanAid } from '../../../utils/callsign.js'
import { formatElevation } from '../../../utils/coords.js'
import { FPE }             from '../../../components/FPE/FPE.jsx'
import { loadStarsPrefs, saveStarsPrefs }  from '../../../store/starsPrefs.js'
import './StarsScope.css'
import { navdataNotFound } from '../../../store/lnm.js'

const WINDOW_ID  = 'atc-main'

export default function StarsScope() {
  const wheelDir         = useWheelDirection()
  const mapCanvasRef     = useRef(null)
  const routeCanvasRef   = useRef(null)
  const ringCanvasRef    = useRef(null)
  const compassCanvasRef = useRef(null)
  const ctxCanvasRef     = useRef(null)
  const rblCanvasRef     = useRef(null)
  const interactiveRef   = useRef(null)

  const {
    units, ownership, handoffs, pointOuts, blinkTracks, displayFdb, conflictAcks,
    scratchpads, conflicts, coalition, positionName, myControllerId,
  } = useStarsAtcData()
  const {
    mission, airbases, facilityDcsName, facilityType, positionSuffix, facilityId,
  } = useStarsFacilityData()
  const {
    maps, mapPalettes, mapVisible,
    holdings, holdsVisible, airways, airwaysVisible, msa, msaVisible,
    mora, moraVisible, relief, reliefVisible, mva, mvaVisible,
    geoBoundaries, geoCoastlines, geoVisible, fixes, fixesVisible,
    procRaw, procSidGroups, procStarGroups, procAppchGroups, procVisible, procCommandVisible,
    centerlines, cltrVisible,
  } = useStarsNavdataLayers()

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  const activeProfile   = useOdsStore((s) => s.activeProfile)
  const activeProfileId = useOdsStore((s) => s.activeProfileId)

  const [view,       setView]      = useState(null)
  const [dcbVisible, setDcbVisible] = useState(true)
  const [slewedPdbs, setSlewedPdbs] = useState(() => new Set())
  // Middle-click highlight (STARS behaviour) — session-local, not persisted;
  // toggles a contact's symbol/datablock to HIGHLIGHT_TEAL (constants.js).
  const [highlightedUids, setHighlightedUids] = useState(() => new Set())
  const toggleHighlight = (uid) =>
    setHighlightedUids(s => { const n = new Set(s); n.has(uid) ? n.delete(uid) : n.add(uid); return n })
  const [routeProcData, setRouteProcData] = useState({})  // { [icao]: raw | null }

  const routeDisplayedUids = useMemo(
    () => new Set(windowSettings?.routeDisplayedUids ?? []),
    [windowSettings?.routeDisplayedUids]
  )

  // Tick every 200ms to drive symbol blink redraws. blinkOn is computed once per
  // render — shared by both canvas effect (closure) and SVG overlay (prop) so the
  // symbol letter and datablock always blink from the same value in the same frame.
  const { blinkTick, blinkOn } = useBlink()

  // ── Primary-only (no datablock) contacts ────────────────────────────
  // Real transponder standby (srsCapable units reporting status 0) is
  // always shown regardless of .WNG — it's ground truth, not a simulation.
  // The groupID-based guess remains opt-in (.WNG / starsPrefs.simWingmenStandby)
  // and only ever applies to non-srsCapable units. See stca/formations.js.
  const wingmanIds = useMemo(() => {
    return resolvePrimaryOnlyIds(units, ownership, windowSettings?.manualWingmen, !!windowSettings?.simWingmenStandby)
  }, [units, ownership, windowSettings?.simWingmenStandby, windowSettings?.manualWingmen])

  // ── STCA compute loop + alert tone — see stca/useStcaCompute.js ───────
  useStcaTracker({
    centerlines, conflicts, conflictAcks, ownership, myControllerId,
    vol: windowSettings?.vol, stcaEnabled: windowSettings?.stcaEnabled,
    simWingmenStandby: windowSettings?.simWingmenStandby,
  })

  // Ctrl+F → open blank FPE
  useEffect(() => {
    function onKeyDown(e) {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        const s = useFpeStore.getState()
        if (!s.open) s.openFpe({ scope: 'atc' })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
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
  const panAccumRef  = useRef({ dx: 0, dy: 0 })  // pixel delta accumulated since last rAF flush
  const panRafRef    = useRef(null)              // pending rAF id for the coalesced pan flush
  const rblCursorRef = useRef(null)    // canvas-pixel cursor pos during RBL_P2 preview
  const coordsRef    = useRef(null)    // debug coords display div
  const elevRef            = useRef(null)  // last-fetched elevation (m) at cursor, .coords
  const lastElevFetchRef   = useRef(null)  // throttle key so we don't re-fetch every pixel

  // Keep viewRef in sync
  useEffect(() => { viewRef.current = view }, [view])

  const tdmMode = windowSettings?.tdmMode ?? false

  // ── Visible units (filtered) ──────────────────────────────────────
  const visibleUnits    = useMemo(() => getVisibleUnits(units, coalition, tdmMode), [units, coalition, tdmMode])
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])


  // ── Contact symbol map — see starsScopeHelpers.js's computeStarsSymbolMap ──
  const associated = useAssociationStore((s) => s.associated)
  const symbolMap = useMemo(
    () => computeStarsSymbolMap(visibleUnits, ownership, displayFdb, myControllerId, associated),
    [visibleUnits, ownership, displayFdb, myControllerId, associated]
  )

  // ── Beacon code readout ("Beaconator") — press-and-hold F1 ──────────
  // Momentary: forces every beacon track (real, active squawk) to appear
  // regardless of the altitude filter, forces PDB->FDB, and swaps the
  // callsign for the beacon code — see DatablockOverlay.jsx for the
  // datablock-content half of this.
  const [beaconReadout, setBeaconReadout] = useState(false)
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'F1' && !e.ctrlKey) { e.preventDefault(); setBeaconReadout(true) }
    }
    function onKeyUp(e) {
      if (e.key === 'F1') setBeaconReadout(false)
    }
    // Also release on window blur — otherwise alt-tabbing away mid-hold
    // leaves the readout stuck on with no keyup ever delivered.
    function onBlur() { setBeaconReadout(false) }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // ── Altitude filter (MULTI FUNC F / FC) — see starsScopeHelpers.js's
  // computeStarsFilteredUnits ─────────────────────────────────────────
  const filteredUnits = useMemo(() => computeStarsFilteredUnits(visibleUnits, symbolMap, beaconReadout, {
    loU: windowSettings?.altFilterLowU  ?? 1,
    hiU: windowSettings?.altFilterHighU ?? 600,
    loA: windowSettings?.altFilterLowA  ?? 1,
    hiA: windowSettings?.altFilterHighA ?? 600,
  }), [visibleUnits, symbolMap, beaconReadout,
      windowSettings?.altFilterLowU, windowSettings?.altFilterHighU,
      windowSettings?.altFilterLowA, windowSettings?.altFilterHighA])

  // ── Load presets from server on mount; apply default once per session ──
  // `load()` (refreshing the slot list) is harmless to rerun on every mount,
  // but applying the default slot's settings to the window is NOT — StarsScope
  // remounts on every STARS<->ASDE-X toggle (see App.jsx), and without the
  // defaultAppliedThisSession guard this would silently stomp the window's
  // live rangeNm/center/etc. back to the saved default on every round trip.
  useEffect(() => {
    usePresetsStore.getState().load().then(() => {
      const { slots, defaultSlot, defaultAppliedThisSession } = usePresetsStore.getState()
      if (defaultAppliedThisSession) return
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
        applyLayerVisibility(settings)
        if (settings.previewPosition !== undefined)
          usePreviewStore.getState().setPosition(settings.previewPosition)
        usePresetsStore.getState().setActiveSlot(defaultSlot)
      }
      usePresetsStore.getState().markDefaultApplied()
    })
  }, []) // eslint-disable-line

  // ── Initialize display window ─────────────────────────────────────
  useEffect(() => {
    if (!windowSettings) {
      const starsPrefs = loadStarsPrefs()
      displayStore.initWindow(WINDOW_ID, {
        ...activeProfile?.defaults,
        dbca: starsPrefs.dbca,
        fillVisible: starsPrefs.fillVisible,
        fillPct: starsPrefs.fillPct,
        pinnedFixes: starsPrefs.pinnedFixes,
        stcaEnabled: starsPrefs.stcaEnabled,
        simWingmenStandby: starsPrefs.simWingmenStandby,
        manualWingmen: starsPrefs.manualWingmen,
        altFilterLowU: starsPrefs.altFilterLowU,
        altFilterHighU: starsPrefs.altFilterHighU,
        altFilterLowA: starsPrefs.altFilterLowA,
        altFilterHighA: starsPrefs.altFilterHighA,
      })
    }
  }, []) // eslint-disable-line

  // Tracks the ODS profile id last applied to this window, seeded from the
  // current id on mount so a fresh StarsScope instance (remounted whenever
  // App.jsx swaps STARS/ASDE-X -- a real unmount/remount, not a CSS hide)
  // doesn't reapply defaults over the live rangeNm/etc. already sitting in
  // windowSettings just because this is the component's first render. Only a
  // genuine profile switch while mounted (activeProfileId actually changing)
  // should reapply.
  const appliedProfileIdRef = useRef(activeProfileId)

  useEffect(() => {
    if (!activeProfile?.defaults || !windowSettings) return
    if (activeProfileId === appliedProfileIdRef.current) return
    appliedProfileIdRef.current = activeProfileId
    displayStore.applyProfileDefaults(WINDOW_ID, activeProfile.defaults)
  }, [activeProfileId]) // eslint-disable-line

  // ── Build view ────────────────────────────────────────────────────
  const theatre    = mission?.mission?.theatre
  const facilityCl = centerlines.find((c) => c.airbase === facilityDcsName)
  // Declination only (from the runway database) — used for the canvas
  // rotation and for any bearing derived from lat/lng or unit.track. See
  // utils/magvar.js: DCS's own heading readouts don't apply grid
  // convergence, so this app doesn't add it either.
  const declinationDeg = facilityCl?.declinationDeg ?? 0

  // ── Theatre/facility-driven navdata loading — see starsNavdataLoading.js ──
  useStarsNavdataLoading({ theatre, mission, airbases, facilityDcsName, facilityId, positionSuffix, positionName })

  const buildView = useCallback(() => {
    const canvas = ringCanvasRef.current
    if (!canvas || !windowSettings) return null
    const { rangeNm, centerLat, centerLng } = windowSettings
    const w = canvas.width
    const h = canvas.height
    if (!w || !h) return null
    const effectiveDeclination = typeof window.__magvarOverride === 'number' ? window.__magvarOverride : declinationDeg
    return {
      centerLat: centerLat ?? 0,
      centerLng: centerLng ?? 0,
      rangeNm,
      pixelsPerNm: rangeToPixelsPerNm(rangeNm, w, h),
      width: w,
      height: h,
      declinationDeg: effectiveDeclination,
      theatre,
    }
  }, [windowSettings, declinationDeg, theatre])

  const canvasAreaRef = useRef(null)

  // ── Resize observer ───────────────────────────────────────────────
  // Deps include buildView so the observer is re-established when windowSettings
  // first becomes available (component returns null until then, so canvasAreaRef
  // is null on the very first mount). Canvas assignments are guarded so the
  // reconnection's initial notification only clears canvases when size truly changed.
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth
      const h = container.clientHeight
      let resized = false
      for (const ref of [mapCanvasRef, routeCanvasRef, ringCanvasRef, compassCanvasRef, ctxCanvasRef, rblCanvasRef]) {
        if (ref.current) {
          if (ref.current.width  !== w) { ref.current.width  = w; resized = true }
          if (ref.current.height !== h) { ref.current.height = h; resized = true }
        }
      }
      if (resized) setView(buildView())
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [buildView])

  // blinkTick fires every 200ms and doesn't itself affect buildView's output
  // (it's only here to catch window.__magvarOverride changes, which aren't
  // reactive). Bail out when the rebuilt view is field-identical to the
  // current one so its reference stays stable and doesn't force every
  // view-dependent layer (map/relief/geo/etc.) to redraw 5x/sec for nothing.
  useEffect(() => {
    const next = buildView()
    setView((prev) => (prev && next &&
      prev.centerLat === next.centerLat &&
      prev.centerLng === next.centerLng &&
      prev.rangeNm === next.rangeNm &&
      prev.pixelsPerNm === next.pixelsPerNm &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.declinationDeg === next.declinationDeg &&
      prev.theatre === next.theatre)
      ? prev
      : next)
  }, [buildView, blinkTick])

  // ── Auto-center on facility airbase ──────────────────────────────
  // Tracks the facilityDcsName last auto-centered in windowSettings.autoCenteredFacility
  // (the module-level display store, which survives the STARS<->ASDE-X unmount/
  // remount) rather than a component ref, so a genuine facility change still
  // triggers a re-center but a bare remount doesn't clobber a live pan.
  useEffect(() => {
    // FIR/CTR has no single center point — skip auto-center, let controller pan
    if (!windowSettings || facilityType === 'fir') return
    if (!facilityDcsName) return
    if (windowSettings.autoCenteredFacility === facilityDcsName) return

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
      autoCenteredFacility: facilityDcsName,
    })
  }, [airbases, facilityDcsName, centerlines, windowSettings, displayStore, facilityType])

  // ── History capture — see useHistoryCapture.js ────────────────────
  const historyRef = useHistoryCapture(visibleUnitsRef, windowSettings?.historyRate)

  // ── Render range rings ────────────────────────────────────────────
  useEffect(() => {
    if (!view || !ringCanvasRef.current || !activeProfile) return
    const rrCenter = (windowSettings?.rrCenterLat != null && windowSettings?.rrCenterLng != null)
      ? { lat: windowSettings.rrCenterLat, lng: windowSettings.rrCenterLng }
      : { lat: windowSettings?.homeCenterLat ?? 0, lng: windowSettings?.homeCenterLng ?? 0 }
    drawRangeRings(
      ringCanvasRef.current.getContext('2d'),
      view, view.rangeNm, windowSettings?.ringSpacingNm,
      activeProfile.visual, rrCenter, windowSettings?.briteRr ?? 70,
    )
  }, [view, windowSettings?.ringSpacingNm, windowSettings?.briteRr,
      windowSettings?.rrCenterLat, windowSettings?.rrCenterLng,
      windowSettings?.homeCenterLat, windowSettings?.homeCenterLng, activeProfile])

  // ── Render geographic maps ────────────────────────────────────────
  useEffect(() => {
    if (!view || !mapCanvasRef.current) return
    const aspColorIdx  = windowSettings?.aspColorIdx ?? 0
    const activeColors = mapPalettes[aspColorIdx]?.colors ?? mapPalettes[0]?.colors ?? null
    const briteB = windowSettings?.briteMapB ?? 50
    const csMap  = windowSettings?.csMap ?? 2
    const ctx = mapCanvasRef.current.getContext('2d')
    drawMaps(ctx, view, maps, mapVisible,
      windowSettings?.briteMapA ?? 50, briteB, csMap, activeColors,
      windowSettings?.fillVisible ? (windowSettings?.fillPct ?? 30) : 0)
    drawExtendedCenterlines(ctx, view, centerlines, cltrVisible, briteB)
    drawHoldings(ctx, view, holdings, holdsVisible, briteB, csMap, activeColors)
    drawAirways(ctx, view, airways, airwaysVisible, briteB, activeColors, mapVisible.lbl, csMap)
    drawMsa(ctx, view, msa.filter(r => r.ident === facilityId), msaVisible, briteB, csMap, activeColors)
    drawMora(ctx, view, mora, moraVisible, briteB, activeColors)
    drawRelief(ctx, view, relief, reliefVisible, briteB, activeColors)
    drawGeo(ctx, view, geoBoundaries, geoCoastlines, geoVisible, briteB, activeColors)
    drawMva(ctx, view, mva, mvaVisible, briteB, activeColors)
    drawProcedures(ctx, view, procRaw, procSidGroups, procStarGroups, procAppchGroups, procVisible, briteB, csMap, activeColors, procCommandVisible)
    // FIXES DCB toggle gates the whole theatre point layer; .FIX-pinned fixes
    // (windowSettings.pinnedFixes, per-theatre — see actions/index.js
    // TOGGLE_FIX) always draw regardless of that toggle, same override
    // CATCC/ABM's own .fix command gives their .fixes toggle.
    const pinnedIds  = new Set(windowSettings?.pinnedFixes?.[theatre] ?? [])
    const fixesToDraw = fixesVisible ? fixes : fixes.filter((f) => pinnedIds.has(f.id.toUpperCase()))
    drawAbmFixSymbols(ctx, view, fixesToDraw, fixesToDraw.length > 0, '#66CCFF', 60, mapVisible.lbl)
  }, [view, maps, mapPalettes, mapVisible, centerlines, cltrVisible,
      holdings, holdsVisible, airways, airwaysVisible, msa, msaVisible, mora, moraVisible, relief, reliefVisible, geoBoundaries, geoCoastlines, geoVisible, mva, mvaVisible, facilityId,
      procRaw, procSidGroups, procStarGroups, procAppchGroups, procVisible, procCommandVisible,
      fixes, fixesVisible, windowSettings?.pinnedFixes, theatre,
      windowSettings?.briteMapA, windowSettings?.briteMapB, windowSettings?.csMap, windowSettings?.aspColorIdx,
      windowSettings?.fillVisible, windowSettings?.fillPct])

  // ── Load procedure data for displayed routes (async, per-ICAO cache) ────
  useEffect(() => {
    if (routeDisplayedUids.size === 0) return
    const plans = useFlightPlansStore.getState().plans
    const allUnits = useUnitsStore.getState().units
    const icaosNeeded = new Set()
    for (const uid of routeDisplayedUids) {
      const unit = Object.values(allUnits).find(u => String(u.id) === uid)
      const aid  = unit ? findFlightPlanAid(unit, plans) : null
      const fpl  = (aid ? plans[aid] : null)
                ?? Object.values(plans).find(p => String(p.unitId) === uid)
      if (fpl?.dep)  icaosNeeded.add(fpl.dep.toUpperCase())
      if (fpl?.dest) icaosNeeded.add(fpl.dest.toUpperCase())
    }
    const missing = [...icaosNeeded].filter(icao => !(icao in routeProcData))
    if (!missing.length) return
    Promise.all(missing.map(async icao => {
      try {
        const res = await fetch(`/api/navdata/procedures?icao=${encodeURIComponent(icao)}`)
        return { icao, raw: res.ok ? await res.json() : null }
      } catch {
        return { icao, raw: null }
      }
    })).then(results => {
      setRouteProcData(prev => {
        const next = { ...prev }
        for (const { icao, raw } of results) next[icao] = raw
        return next
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes routeProcData to avoid fetch loop
  }, [routeDisplayedUids])

  // ── Render flight plan routes ──────────────────────────────────
  useEffect(() => {
    const canvas = routeCanvasRef.current
    if (!canvas || !view) return
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (routeDisplayedUids.size === 0) return

    const plans      = useFlightPlansStore.getState().plans
    const navdata    = useNavdataStore.getState()
    const aspColorIdx = windowSettings?.aspColorIdx ?? 0
    const activeColors = mapPalettes[aspColorIdx]?.colors ?? mapPalettes[0]?.colors ?? null
    const briteB     = windowSettings?.briteMapB ?? 50
    const csMap      = windowSettings?.csMap ?? 2

    const allUnits = useUnitsStore.getState().units
    const routesByUid = new Map()
    for (const uid of routeDisplayedUids) {
      const unit = Object.values(allUnits).find(u => String(u.id) === uid)
      const aid  = unit ? findFlightPlanAid(unit, plans) : null
      const fpl  = (aid ? plans[aid] : null)
                ?? Object.values(plans).find(p => String(p.unitId) === uid)
      if (!fpl) continue
      const depProcs  = fpl.dep  ? (routeProcData[fpl.dep.toUpperCase()]  ?? null) : null
      const destProcs = fpl.dest ? (routeProcData[fpl.dest.toUpperCase()] ?? null) : null
      routesByUid.set(uid, resolveRoute({
        fpl,
        lookupFix: navdata.lookupFix,
        airways,
        depProcs,
        destProcs,
      }))
    }

    drawRoute(ctx, view, routesByUid, briteB, csMap, activeColors)
  }, [routeDisplayedUids, routeProcData, view, airways, mapPalettes,
      windowSettings?.aspColorIdx, windowSettings?.briteMapB, windowSettings?.csMap])

  // ── Render compass rose ───────────────────────────────────────────
  useEffect(() => {
    if (!view || !compassCanvasRef.current) return
    drawCompassRose(compassCanvasRef.current.getContext('2d'), view,
      windowSettings?.briteCmp ?? 70, windowSettings?.csTools ?? 3)
  }, [view, windowSettings?.briteCmp, windowSettings?.csTools])

  // ── Render contacts ───────────────────────────────────────────────
  useEffect(() => {
    if (!view || !ctxCanvasRef.current || !activeProfile) return
    // MF R per-track PTLs draw regardless of the facility-wide ptlMode
    const perTrackPtl = new Set()
    for (const [uid, sp] of Object.entries(scratchpads)) {
      if (sp?._ptl) perTrackPtl.add(String(uid))
    }
    const ptlOpts = (activeProfile.features?.PTL && (windowSettings?.ptlMode || perTrackPtl.size > 0))
      ? { minutes: windowSettings?.ptlLength ?? 2, mode: windowSettings?.ptlMode ?? null,
          ownership, myPosition: myControllerId, perTrack: perTrackPtl }
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

    // Units whose symbol should blink yellow: incoming PO to me
    const poReceivingUids = new Set()
    for (const [uid, po] of Object.entries(pointOuts)) {
      if (po.state === POINTOUT_STATE.RECEIVING && po.to === myControllerId) {
        poReceivingUids.add(String(uid))
      }
      // Rejected PO (sender side) uses white blink, same as handoffs
      if (po.state === POINTOUT_STATE.REJECTED && po.from === myControllerId) {
        blinkingUids.add(String(uid))
      }
    }

    const ctx = ctxCanvasRef.current.getContext('2d')
    drawContacts(
      ctx, view,
      filteredUnits, historyRef.current, activeProfile.visual,
      symbolMap, (windowSettings?.britePos ?? 80) / 100, windowSettings?.csPos ?? 3,
      ptlOpts, windowSettings?.historyLength ?? 5, (windowSettings?.briteHst ?? 80) / 100,
      blinkingUids, blinkOn, poReceivingUids, highlightedUids, wingmanIds,
    )

    // Draw .FIND marker — small green square centered on the found fix
    const marker = windowSettings?.findMarker
    if (marker) {
      const { x, y } = latLngToCanvas(marker.lat, marker.lon, view)
      ctx.fillStyle = '#00e000'
      ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8)
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- historyRef is a stable ref returned by useHistoryCapture
  }, [filteredUnits, view, symbolMap, ownership, handoffs, pointOuts, blinkTracks, blinkTick, blinkOn, scratchpads,
      myControllerId, positionName,
      windowSettings?.britePos, windowSettings?.briteHst, windowSettings?.csPos,
      windowSettings?.ptlMode, windowSettings?.ptlLength, windowSettings?.historyLength,
      windowSettings?.findMarker,
      activeProfile, highlightedUids, wingmanIds])

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
  }, [])

  // ── Command evaluation helper ─────────────────────────────────────
  const evaluateCommand = useCallback((trigger, canvasPos = null) => {
    const { buffer, hasToken } = usePreviewStore.getState()
    const parsed  = parseCommand(buffer, trigger, hasToken)
    if (!parsed) {
      if (trigger === 'ENTER') {
        const trimmed = buffer.trim().toUpperCase()
        usePreviewStore.getState().setResponse(looksLikeKnownCommand(trimmed) ? 'FORMAT' : 'INVALID INPUT')
      } else if (trigger === 'SLEW' && buffer.trim()) {
        usePreviewStore.getState().setResponse('FORMAT')
      }
      return
    }

    const slewTarget = (trigger === 'SLEW' && canvasPos && viewRef.current)
      ? resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
      : null

    // Any typed SLEW command targeting a contact acknowledges its IDENT
    // blink too — same gesture as the bare-click handler above.
    if (slewTarget) {
      const uid = String(slewTarget.unitId)
      if (useAtcStore.getState().identUnacked[uid]) useAtcStore.getState().clearIdent(uid)
    }

    const canvasLatLng = (trigger === 'SLEW' && canvasPos && viewRef.current)
      ? canvasToLatLng(canvasPos.x, canvasPos.y, viewRef.current)
      : null

    const canvasSize = canvasAreaRef.current
      ? { w: canvasAreaRef.current.clientWidth, h: canvasAreaRef.current.clientHeight }
      : null

    dispatchAction(parsed, slewTarget, { positionName, canvasPos, canvasSize, canvasLatLng, windowId: WINDOW_ID })
  }, [positionName])

  // ── ENTER key handler (from InputHandler) ─────────────────────────
  const handleEnter = useCallback(() => {
    // When awaiting RBL second endpoint, ENTER with a non-empty buffer will resolve
    // it as a typed fix/ACID once fixes are implemented.
    if (windowSettings?.pendingAction === 'RBL_P2') {
      const buf = usePreviewStore.getState().buffer.trim()
      if (buf) {
        const result = useNavdataStore.getState().lookupFix(buf)
        if (!result) { usePreviewStore.getState().setResponse(navdataNotFound()); return }
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
        ...snapshotLayerVisibility(),
        previewPosition: usePreviewStore.getState().position,
      }
      usePresetsStore.getState().saveToSlot(pending.slotIndex, name, enriched)
      usePreviewStore.getState().clear()
      usePreviewStore.getState().setResponse('PREF SAVED')
      return
    }
    evaluateCommand('ENTER')
  }, [evaluateCommand, windowSettings?.pendingAction, displayStore, windowSettings?.rbls])

  // ── ESC handler ───────────────────────────────────────────────────
  const handleEsc = useCallback(() => {
    const win     = useDisplayStore.getState().windows[WINDOW_ID]
    const pending = win?.pendingAction
    if (win?.routeDisplayedUids?.length > 0) {
      displayStore.updateWindow(WINDOW_ID, { routeDisplayedUids: [] })
      return
    }
    if (win?.findMarker) {
      displayStore.updateWindow(WINDOW_ID, { findMarker: null })
      return
    }
    if (pending === 'RBL_P2') {
      displayStore.updateWindow(WINDOW_ID, { pendingAction: null, rblWip: null })
    } else if (pending === 'MIN_P2') {
      displayStore.updateWindow(WINDOW_ID, { pendingAction: null, minWip: null })
    } else if (pending === 'WNG_P2') {
      displayStore.updateWindow(WINDOW_ID, { pendingAction: null, wngWip: null })
    } else if (pending === 'PLACE_CNTR' || pending === 'PLACE_RR') {
      displayStore.updateWindow(WINDOW_ID, { pendingAction: null })
    }
  }, [displayStore])

  // ── Immediate action handler (DCB-style keys) ─────────────────────
  const handleImmediateAction = useCallback((action) => {
    switch (action) {
      case 'RECENTER':
        recenterScope(WINDOW_ID)
        break
      case 'TOGGLE_DCB':
        setDcbVisible(v => !v)
        break
      case 'TOGGLE_TOPDOWN': {
        const current = useDisplayStore.getState().windows[WINDOW_ID]?.tdmMode ?? false
        displayStore.updateWindow(WINDOW_ID, { tdmMode: !current })
        break
      }
      default: {
        const setMatch = action.match(/^SET_BOOKMARK_(\d)$/)
        if (setMatch) {
          const n = parseInt(setMatch[1], 10)
          const win = useDisplayStore.getState().windows[WINDOW_ID]
          usePresetsStore.getState().setBookmark(n, {
            centerLat:      win?.centerLat,
            centerLng:      win?.centerLng,
            offCntr:        win?.offCntr ?? false,
            rangeNm:        win?.rangeNm,
            tdmMode:        win?.tdmMode ?? false,
            ...snapshotLayerVisibility(),
          })
          usePreviewStore.getState().setResponse('BOOKMARK SAVED')
          break
        }
        const loadMatch = action.match(/^LOAD_BOOKMARK_(\d)$/)
        if (loadMatch) {
          const n = parseInt(loadMatch[1], 10)
          const bm = usePresetsStore.getState().getBookmark(n)
          if (!bm) break
          displayStore.updateWindow(WINDOW_ID, {
            centerLat: bm.centerLat,
            centerLng: bm.centerLng,
            offCntr:   bm.offCntr ?? false,
            rangeNm:   bm.rangeNm,
            tdmMode:   bm.tdmMode,
          })
          applyLayerVisibility(bm)
          break
        }
        break
      }
    }
  }, [displayStore])

  // ── Mouse: LEFT click = slew, RIGHT drag = pan ────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button === 2 && e.ctrlKey) {
      // Ctrl+right-click — toggle that contact's filed route on the scope.
      // Same convention as ABM's AbmScope.jsx. Takes priority over starting
      // a pan-drag; a plain right-click (no Ctrl) still pans.
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (rect && viewRef.current) {
        const canvasPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (target) {
          const uid     = String(target.unitId)
          const current = windowSettings?.routeDisplayedUids ?? []
          const next    = new Set(current)
          if (next.has(uid)) next.delete(uid)
          else               next.add(uid)
          displayStore.updateWindow(WINDOW_ID, { routeDisplayedUids: [...next] })
        }
      }
      e.preventDefault()
      return
    }
    if (e.button === 2) {
      // Right mouse — start pan
      panRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false }
      e.preventDefault()
    }
    // Middle mouse — suppress the browser's autoscroll/paste behaviour so
    // mouseup's highlight toggle (below) is the only effect.
    if (e.button === 1) e.preventDefault()
  }, [windowSettings, displayStore])

  const handleMouseMove = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (rect) {
      const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      rblCursorRef.current = pos
      if (coordsRef.current && viewRef.current) {
        const { lat, lng } = canvasToLatLng(pos.x, pos.y, viewRef.current)
        const latStr = `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'}`
        const lngStr = `${Math.abs(lng).toFixed(6)}°${lng >= 0 ? 'E' : 'W'}`
        const elevStr = formatElevation(elevRef.current, 'feet')
        coordsRef.current.textContent = `${latStr}  ${lngStr}  ${elevStr}`

        // Throttle elevation lookups to ~100m cells (same pattern as ABM's .coords).
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`
        if (key !== lastElevFetchRef.current) {
          lastElevFetchRef.current = key
          fetch(`/api/elevation?lat=${lat}&lng=${lng}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { elevRef.current = data?.elevationM ?? null })
            .catch(() => {})
        }
      }
    }

    if (!panRef.current.dragging || !viewRef.current || !windowSettings) return
    const dx = e.clientX - panRef.current.lastX
    const dy = e.clientY - panRef.current.lastY
    panRef.current.lastX = e.clientX
    panRef.current.lastY = e.clientY
    panRef.current.moved = true

    // Native mousemove can fire far faster than the display refreshes.
    // Accumulate pixel deltas here (cheap) and only commit the resulting
    // pan to the store once per animation frame, so the full map/relief/geo
    // redraw it triggers runs at most at display refresh rate instead of
    // once per raw input event.
    panAccumRef.current.dx += dx
    panAccumRef.current.dy += dy

    if (panRafRef.current == null) {
      panRafRef.current = requestAnimationFrame(() => {
        panRafRef.current = null
        const { dx: adx, dy: ady } = panAccumRef.current
        panAccumRef.current = { dx: 0, dy: 0 }
        const v = viewRef.current
        if (!v) return
        const nmPerPx = 1 / v.pixelsPerNm
        const newLat  = v.centerLat + (ady * nmPerPx) / 60
        const newLng  = v.centerLng - (adx * nmPerPx) / (60 * Math.cos(v.centerLat * Math.PI / 180))
        displayStore.updateWindow(WINDOW_ID, { centerLat: newLat, centerLng: newLng, offCntr: true })
      })
    }
  }, [windowSettings, displayStore])

  // Cancel any pending coalesced pan flush on unmount.
  useEffect(() => () => {
    if (panRafRef.current != null) cancelAnimationFrame(panRafRef.current)
  }, [])

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
          const aid      = findFlightPlanAid(target.unit, useFlightPlansStore.getState().plans)
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
      if (pending === 'PLACE_CNTR' && viewRef.current) {
        const { lat, lng } = canvasToLatLng(canvasPos.x, canvasPos.y, viewRef.current)
        displayStore.updateWindow(WINDOW_ID, {
          centerLat:     lat,
          centerLng:     lng,
          offCntr:       true,
          pendingAction: null,
        })
        return
      }
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

      // .WNG + click lead + click wingman — manual primary-only override for
      // aircraft that don't share a DCS group (formations.js can't otherwise
      // pair them). Second click toggles that unit's manual designation.
      if (pending === 'WNG_P2' && viewRef.current) {
        const wngWip = windowSettings?.wngWip
        if (!wngWip) { displayStore.updateWindow(WINDOW_ID, { pendingAction: null }); return }
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (!target) return  // WNG requires a track; ignore empty-space clicks
        const wingId = String(target.unitId)
        if (wingId === wngWip.leadId) return  // same track, ignore

        const current = new Set(windowSettings?.manualWingmen ?? [])
        if (current.has(wingId)) current.delete(wingId)
        else current.add(wingId)
        const next = [...current]
        displayStore.updateWindow(WINDOW_ID, { manualWingmen: next, wngWip: null, pendingAction: null })
        saveStarsPrefs({ manualWingmen: next })
        usePreviewStore.getState().clearAfterCommand()
        return
      }

      // Bare-slew handling — only when the buffer is empty (no command pending).
      if (viewRef.current && !usePreviewStore.getState().buffer.trim()) {
        const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
        if (target) {
          const atcState = useAtcStore.getState()
          const uid      = String(target.unitId)

          // Slewing acknowledges an active IDENT blink — same gesture as
          // dismissing other slew-driven states below, regardless of which
          // branch handles the rest of this click.
          if (atcState.identUnacked[uid]) atcState.clearIdent(uid)

          // Acknowledging an active conflict is the click's sole effect —
          // it does not also fall through to the PDB toggle below.
          const activeConflict = useStcaStore.getState().conflicts
            .find((c) => (c.unitAId === uid || c.unitBId === uid) && !atcState.conflictAcks[c.id])
          if (activeConflict) {
            ackConflict(activeConflict.id)
            return
          }

          const ho       = atcState.handoffs[uid]
          const po       = atcState.pointOuts[uid]

          // If there's a pending HO or PO action, let BARE_SLEW handle it
          const hasPendingAction =
            (ho?.state === HANDOFF_STATE.RECEIVING  && ho.to   === myControllerId) ||
            (ho?.state === HANDOFF_STATE.INITIATED  && ho.from === myControllerId) ||
            (po?.state === POINTOUT_STATE.RECEIVING && po.to   === myControllerId) ||
            (po?.state === POINTOUT_STATE.SENT      && po.from === myControllerId) ||
            (po?.state === POINTOUT_STATE.REJECTED  && po.from === myControllerId)

          if (!hasPendingAction) {
            // Sender dismissing sticky FDB: clear it, stop blink, expand to slewed PDB
            if (atcState.displayFdb[uid]) {
              atcState.clearDisplayFdb(uid)
              atcState.clearBlinkTrack(uid)
              if (!slewedPdbs.has(uid)) handlePdbToggle(uid)
              return
            }

            // PDB toggle for any track with no pending action
            handlePdbToggle(uid)
            return
          }
        }
      }

      evaluateCommand('SLEW', canvasPos)
    }
    if (e.button === 1) {
      // Middle click — toggle highlight (STARS behaviour)
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const canvasPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)
      if (target) toggleHighlight(String(target.unitId))
    }
  }, [evaluateCommand, windowSettings, displayStore, handlePdbToggle, myControllerId, positionName, slewedPdbs])

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

  return (
    <div className="atc-scope" data-dcb-pos={dcbVisible && activeProfile.dcb ? dcbPos : undefined} style={{ background: bgColor }}>
      {dcbVisible && activeProfile.dcb && <Dcb profile={activeProfile} briteDcb={briteDcb} csDcb={csDcb} />}

      <div ref={canvasAreaRef} className="atc-canvas-area">
        <canvas ref={mapCanvasRef}     className="atc-layer" />
        <canvas ref={routeCanvasRef}   className="atc-layer" />
        <canvas ref={ringCanvasRef}    className="atc-layer" />
        <canvas ref={compassCanvasRef} className="atc-layer" />
        <canvas ref={ctxCanvasRef}     className="atc-layer" />
        <canvas ref={rblCanvasRef}     className="atc-layer" />

        <DatablockOverlay
          units={filteredUnits} view={view} visual={activeProfile.visual}
          ldrLength={ldrLength} ldrAngleDeg={ldrAngleDeg}
          briteFdb={briteFdb} briteLdb={briteLdb}
          csDatablocks={csDatablocks}
          slewedPdbs={slewedPdbs}
          blinkOn={blinkOn}
          highlightedUids={highlightedUids}
          wingmanIds={wingmanIds}
          beaconReadout={beaconReadout}
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
