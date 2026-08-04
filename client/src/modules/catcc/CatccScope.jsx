import { useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useUnitsStore }         from '../../store/units.js'
import { useSessionStore }       from '../../store/session.js'
import { useDisplayStore }       from '../../store/display.js'
import { useAtcStore, HANDOFF_STATE } from '../../store/atc.js'
import { useControllersStore }   from '../../store/controllers.js'

import { useCorrelationStore }   from '../../store/correlation.js'
import { getVisibleUnits }       from '../atc/stars/visibleUnits.js'
import { rangeToPixelsPerNm }    from '../atc/stars/canvas/projection.js'
import { resolveSlew }           from '../atc/stars/input/slewResolver.js'
import { resolveCallsign }       from '../../utils/callsign.js'
import { useStatusBoardStore }   from '../../store/statusBoard.js'
import { useGeoStore }           from '../../store/geo.js'
import { useNavdataStore }       from '../../store/navdata.js'
import { useAbmAirspaceStore }   from '../../store/abmAirspace.js'
import { drawCatccLayers }       from './canvas/drawCatccLayers.js'
import { drawCatccContacts }     from './canvas/drawCatccContacts.js'
import { drawCatccDatablocks }   from './canvas/drawCatccDatablocks.js'
import { drawCompassRose }       from '../atc/stars/canvas/drawCompassRose.js'
import { drawGeo }               from '../atc/stars/canvas/drawGeo.js'
import { drawAbmAirspace }       from '../abm/canvas/drawAbmAirspace.js'
import { drawAbmFixSymbols }     from '../abm/canvas/drawAbmFixSymbols.js'
import { computeMagvar } from '../../utils/magvar.js'
import { CARRIER_TYPES, computeCarrierBrcFb } from '../../utils/carriers.js'
import { matchStarsKey, isTypedInput } from '../atc/stars/input/starsKeys.js'
import { processOdsCommand } from './odsCommands.js'
import { initCntl, termCntl, parseCatccSlew, dispatchCatccSlew } from './slewCommands.js'
import { usePreviewStore }       from '../../store/preview.js'
import { loadCatccPrefs }        from '../../store/catccPrefs.js'
import { CatccStatusText }       from './CatccStatusText.jsx'
import './CatccScope.css'

const WINDOW_ID    = 'catcc-main'
const MAX_HISTORY  = 10
const ODS_MAX_LINES = 5

// Reserved for history trails and PTL re-enable — do not delete.
// Colors and symbol dimensions for drawCatccContacts when those features are wired back in.
const CATCC_VISUAL = {
  colors: {
    contact:      '#FFD700',
    ptlLine:      '#FFD700',
    fdbText:      '#FFD700',
    ldbText:      '#FFD700',
    historyTrail: ['#AA8800', '#886600', '#664400', '#442200'],
  },
  symbol: {
    rotationDeg:     22.5,
    filled:          false,
    diameter:        13,
    historyDiameter: 8,
  },
}

export default function CatccScope() {
  const wheelDir          = useWheelDirection()
  const mapCanvasRef      = useRef(null)
  const layersCanvasRef   = useRef(null)
  const compassCanvasRef  = useRef(null)
  const contactsCanvasRef = useRef(null)
  const interactiveRef    = useRef(null)
  const canvasAreaRef     = useRef(null)

  const units          = useUnitsStore((s) => s.units)
  const coalition      = useSessionStore((s) => s.coalition)
  const mission        = useSessionStore((s) => s.mission)
  const carrierUnitId  = useSessionStore((s) => s.carrierUnitId)
  const positionName   = useSessionStore((s) => s.positionName)

  const ownership         = useAtcStore((s) => s.ownership)
  const handoffs          = useAtcStore((s) => s.handoffs)
  const blinkTracks       = useAtcStore((s) => s.blinkTracks)
  const myControllerId    = useControllersStore((s) => s.registry[positionName]?.controllerId ?? null)

  const correlations      = useCorrelationStore((s) => s.correlations)
  const sbEntries         = useStatusBoardStore((s) => s.entries)

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  const theatre     = mission?.mission?.theatre
  const missionDate = mission?.mission?.dateAndTime?.date ?? null

  // ── Navdata layers (.asp/.sua/.classc/etc, .fixes, .geo) — reused directly
  // from ABM's stores/draw functions (store/abmAirspace.js, store/geo.js,
  // store/navdata.js, modules/abm/canvas/drawAbmAirspace.js,
  // modules/abm/canvas/drawAbmFixSymbols.js): flat theatre-wide data with no
  // facility/DCB concept, same reason ABM bypasses STARS' bucketed useMapsStore.
  // Visibility is driven by this window's own settings (odsCommands.js), not
  // useGeoStore's shared `visible` flag — CATCC never calls setVisible on it,
  // so toggling .geo here can't fight with STARS' DCB or ABM's always-on geo
  // in another window.
  const geoBoundaries    = useGeoStore((s) => s.boundaries)
  const geoCoastlines    = useGeoStore((s) => s.coastlines)
  const fixes            = useNavdataStore((s) => s.fixes)
  const airspaceFeatures = useAbmAirspaceStore((s) => s.features)
  const airspacePalettes = useAbmAirspaceStore((s) => s.palettes)
  // Default to the all-yellow "CATCC" palette (server/navdata/config/
  // airspace_colors.json) by name, unless .aspcolors has set an explicit
  // index (windowSettings.aspColorIdx) — that always wins once set.
  const airspacePalette = windowSettings?.aspColorIdx != null
    ? airspacePalettes[windowSettings.aspColorIdx]
    : (airspacePalettes.find((p) => p.name === 'CATCC') ?? airspacePalettes[0])
  const airspaceColors = airspacePalette?.colors ?? null

  useEffect(() => {
    if (!theatre) return
    useGeoStore.getState().loadForTheatre(theatre)
    useNavdataStore.getState().loadForTheatre(theatre)
    useAbmAirspaceStore.getState().loadForTheatre(theatre)
  }, [theatre])

  // Carrier unit — source of scope center and BRC
  const carrierUnit = carrierUnitId != null ? units[carrierUnitId] : null
  const carrierLat  = carrierUnit?.position?.lat ?? 0
  const carrierLng  = carrierUnit?.position?.lng ?? 0
  // Declination (IGRF) — the only correction applied anywhere (canvas
  // rotation, BRC/FB). See utils/magvar.js: DCS's own heading readouts don't
  // apply grid convergence, so this app doesn't add it either.
  const declinationDeg = computeMagvar(carrierLat, carrierLng, missionDate)

  const carrierHeadingDeg = (carrierUnit?.heading ?? 0) * 180 / Math.PI
  const deckOffset = CARRIER_TYPES[carrierUnit?.name]?.deckOffset ?? 9
  const { brc, fb } = computeCarrierBrcFb(carrierHeadingDeg, declinationDeg, deckOffset)

  const marshalBearing = (fb + 180) % 360

  const sbRad = useStatusBoardStore((s) => s.rad)
  const radNum = sbRad ? parseInt(sbRad, 10) : NaN
  // RAD is a radial (bearing FROM the carrier) — use directly, no +180.
  // Snap to the exact float when RAD is within 3° of marshalBearing so the two
  // line segments visually continue. The 3° window covers any map convergence
  // correction without masking intentional custom radials.
  const _radDiff = isNaN(radNum) ? 0 : (d => Math.min(d, 360 - d))(Math.abs((radNum - marshalBearing + 360) % 360))
  const radialBearing = (!isNaN(radNum) && _radDiff > 3)
    ? radNum
    : marshalBearing

  const [blinkTick, setBlinkTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setBlinkTick((t) => t + 1), 200)
    return () => clearInterval(id)
  }, [])

  const [view, setView] = useState(null)
  const viewRef = useRef(null)
  useEffect(() => { viewRef.current = view }, [view])

  // Refs for values that buildView and the ResizeObserver need to stay stable
  const carrierLatRef  = useRef(carrierLat)
  const carrierLngRef  = useRef(carrierLng)
  const declinationRef = useRef(declinationDeg)
  useEffect(() => { carrierLatRef.current  = carrierLat  }, [carrierLat])
  useEffect(() => { carrierLngRef.current  = carrierLng  }, [carrierLng])
  useEffect(() => { declinationRef.current = declinationDeg }, [declinationDeg])

  const tdmMode = windowSettings?.tdmMode ?? false

  const visibleUnits = useMemo(() => getVisibleUnits(units, coalition, tdmMode), [units, coalition, tdmMode])

  // Auto-correlate: match live contact callsigns to modexes from mission import.
  // Manual store correlations take priority over auto-matched ones.
  const effectiveCorrelations = useMemo(() => {
    const result = { ...correlations }
    for (const [unitId, unit] of Object.entries(visibleUnits)) {
      if (result[String(unitId)]) continue
      const cs = resolveCallsign(unit)
      const entry = sbEntries.find((e) => e.callsign === cs && e.sideNumber)
      if (entry) result[String(unitId)] = entry.sideNumber
    }
    return result
  }, [correlations, visibleUnits, sbEntries])
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])

  const effectiveCorrelationsRef = useRef(effectiveCorrelations)
  useEffect(() => { effectiveCorrelationsRef.current = effectiveCorrelations }, [effectiveCorrelations])

  // Tracked contacts: unitId → position letter (M/A/D/T). Absent = untracked.
  // ownership[unitId] is a controllerId like "1M" — extract the letter directly.
  const trackMap = useMemo(() => {
    const map = {}
    for (const id of Object.keys(visibleUnits)) {
      const owner = ownership[String(id)]
      if (!owner) continue
      const m = owner.length === 2 ? owner.match(/[A-Z]/) : null
      map[id] = m ? m[0] : '?'
    }
    return map
  }, [visibleUnits, ownership])

  const historyRef = useRef({})

  // ── Initialize display window ──────────────────────────────────────
  useEffect(() => {
    if (!windowSettings) {
      const catccPrefs = loadCatccPrefs()
      displayStore.initWindow(WINDOW_ID, {
        rangeNm: 50, ringSpacingNm: 10, statusTextXPct: 50, statusTextYPct: 2, showHistory: true, historyRate: 4.5,
        dbca: catccPrefs.dbca,
        asVisible: catccPrefs.asVisible, aspColorIdx: catccPrefs.aspColorIdx, labelsVisible: catccPrefs.labelsVisible,
        fixesVisible: catccPrefs.fixesVisible, geoVisible: catccPrefs.geoVisible,
        fillVisible: catccPrefs.fillVisible, fillPct: catccPrefs.fillPct,
        pinnedFixes: catccPrefs.pinnedFixes,
      })
    }
  }, []) // eslint-disable-line

  // ── Build view — reads canvas attribute (set by ResizeObserver before
  //    this is called) so all draw functions agree on the same dimensions ──
  const buildView = useCallback(() => {
    const canvas = layersCanvasRef.current
    if (!canvas) return null
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    if (!ws) return null
    const w = canvas.width
    const h = canvas.height
    if (!w || !h) return null
    return {
      centerLat:   carrierLatRef.current,
      centerLng:   carrierLngRef.current,
      rangeNm:     ws.rangeNm,
      pixelsPerNm: rangeToPixelsPerNm(ws.rangeNm, w, h),
      width:  w,
      height: h,
      declinationDeg: declinationRef.current,
      theatre,
    }
  }, [theatre]) // all other changing values read from refs/store

  // ── Sync canvas pixel dimensions to the container's current size ───
  const syncCanvasSize = useCallback(() => {
    const container = canvasAreaRef.current
    if (!container) return false
    const w = container.clientWidth
    const h = container.clientHeight
    let resized = false
    for (const ref of [mapCanvasRef, layersCanvasRef, compassCanvasRef, contactsCanvasRef]) {
      if (ref.current) {
        if (ref.current.width  !== w) { ref.current.width  = w; resized = true }
        if (ref.current.height !== h) { ref.current.height = h; resized = true }
      }
    }
    return resized
  }, [])

  // windowSettings is undefined until initWindow's effect runs, and the
  // component returns null before that — so canvasAreaRef.current is null
  // on that first render. syncCanvasSize/buildView are intentionally stable
  // (read from refs), so without this flag as a dep, the effects below would
  // fire exactly once on that null render and never re-arm once the canvas
  // actually mounts, leaving it stuck at the browser's default 300×150 size.
  const hasWindowSettings = !!windowSettings

  // ── Size canvases synchronously before paint so the mount-time "rebuild
  //    view" effect below never sees the browser's default 300×150 canvas
  //    size — the ResizeObserver's own first callback fires too late (after
  //    that effect) to prevent a warped initial render ──────────────────
  useLayoutEffect(() => {
    syncCanvasSize()
  }, [syncCanvasSize, hasWindowSettings])

  // ── Resize observer — sets canvas sizes first, then builds view so that
  //    buildView's canvas.width read and every draw function's ctx.canvas.width
  //    are always the same value in the same render cycle ─────────────────
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      if (syncCanvasSize()) setView(buildView())
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [syncCanvasSize, hasWindowSettings]) // eslint-disable-line

  // Rebuild view when carrier position, zoom, or declination changes
  useEffect(() => {
    setView(buildView())
  }, [carrierLat, carrierLng, declinationDeg, windowSettings?.rangeNm]) // eslint-disable-line

  // ── Render navdata layers (geo/airspace/fixes) — bottom canvas, under the
  //    rings/CCZ/CCA layer, same stacking ABM uses for its mapRef ──────────
  useEffect(() => {
    if (!view || !mapCanvasRef.current) return
    const ctx = mapCanvasRef.current.getContext('2d')
    ctx.clearRect(0, 0, view.width, view.height)
    drawGeo(ctx, view, geoBoundaries, geoCoastlines, windowSettings?.geoVisible ?? false, 50)
    // Per-feature stroke, no edge de-dup — see drawAbmAirspace.js for the
    // dedupe option if dense theatres read as double/uneven lines.
    drawAbmAirspace(ctx, view, airspaceFeatures, windowSettings?.asVisible ?? {}, 80, false, airspaceColors, windowSettings?.labelsVisible ?? false,
      windowSettings?.fillVisible ? (windowSettings?.fillPct ?? 30) : 0)
    // .FIX-pinned fixes (per-theatre — see odsCommands.js .FIX) always draw
    // regardless of .fixes, same override ABM's own .fix command gives.
    const pinnedIds   = new Set(windowSettings?.pinnedFixes?.[theatre] ?? [])
    const fixesToDraw = (windowSettings?.fixesVisible ?? false) ? fixes : fixes.filter((f) => pinnedIds.has(f.id.toUpperCase()))
    drawAbmFixSymbols(ctx, view, fixesToDraw, fixesToDraw.length > 0, '#66CCFF', 60, windowSettings?.labelsVisible ?? false)
  }, [view, geoBoundaries, geoCoastlines, windowSettings?.geoVisible,
      airspaceFeatures, airspaceColors, windowSettings?.asVisible, windowSettings?.labelsVisible,
      windowSettings?.fillVisible, windowSettings?.fillPct,
      fixes, windowSettings?.fixesVisible, windowSettings?.pinnedFixes, theatre])

  // ── Render CATCC layers (rings + CCZ/CCA + corridor + radial) ─────
  useEffect(() => {
    if (!view || !layersCanvasRef.current) return
    const ctx = layersCanvasRef.current.getContext('2d')
    drawCatccLayers(
      ctx, view, fb, marshalBearing,
      view.rangeNm                  ?? 50,
      windowSettings?.ringSpacingNm ?? 10,
      windowSettings?.briteRr       ?? 80,
      radialBearing,
    )
  }, [view, fb, marshalBearing, radialBearing,
      windowSettings?.ringSpacingNm, windowSettings?.briteRr])

  // ── Render compass rose ────────────────────────────────────────────
  useEffect(() => {
    if (!view || !compassCanvasRef.current) return
    drawCompassRose(
      compassCanvasRef.current.getContext('2d'), view,
      windowSettings?.briteCmp ?? 70,
      windowSettings?.csTools  ?? 3,
      0.625,
    )
  }, [view, windowSettings?.briteCmp, windowSettings?.csTools])

  // ── History capture ────────────────────────────────────────────────
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
      const { lastUpdateTime } = useUnitsStore.getState()
      if (!lastUpdateTime || lastUpdateTime === lastCaptureUpdateTime) return
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

  // ── Render contacts + data blocks ─────────────────────────────────
  useEffect(() => {
    if (!view || !contactsCanvasRef.current) return
    const ctx = contactsCanvasRef.current.getContext('2d')
    ctx.clearRect(0, 0, view.width, view.height)
    const now     = Date.now()
    const blinkOn = Math.floor(now / 500) % 2 === 0

    const blinkingUids = new Set()
    for (const [uid, ho] of Object.entries(handoffs)) {
      if (ho.state === HANDOFF_STATE.RECEIVING && ho.to === myControllerId) blinkingUids.add(String(uid))
    }
    for (const [uid, expiresAt] of Object.entries(blinkTracks)) {
      if (now < expiresAt) blinkingUids.add(String(uid))
    }

    drawCatccContacts(
      ctx, view, visibleUnits, trackMap,
      windowSettings?.britePos    ?? 80,
      windowSettings?.csPos       ?? 3,
      blinkingUids,
      blinkOn,
      ownership,
      myControllerId,
      (windowSettings?.showHistory ?? true) ? historyRef.current : {},
      windowSettings?.historyLength ?? 5,
      windowSettings?.briteHst      ?? 80,
    )
    drawCatccDatablocks(
      ctx, view, visibleUnits, effectiveCorrelations,
      windowSettings?.britePos ?? 80,
      marshalBearing,
      windowSettings?.leaderDirs      ?? {},
      windowSettings?.globalLeaderDir ?? null,
      blinkingUids,
      blinkOn,
      ownership,
      myControllerId,
      windowSettings?.catccLeaderLen  ?? 16,
      windowSettings?.dbca ?? true,
    )
  }, [visibleUnits, view, trackMap, effectiveCorrelations, ownership, handoffs, blinkTracks, blinkTick,
      myControllerId, marshalBearing, windowSettings?.britePos, windowSettings?.csPos,
      windowSettings?.globalLeaderDir, windowSettings?.catccLeaderLen, windowSettings?.dbca])

  // ── Marking MOMS — bullseye readout from carrier to cursor ───────
  const [momsReadout, setMomsReadout] = useState('')

  const handleMouseMove = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect || !viewRef.current) return
    const { width, height, pixelsPerNm } = viewRef.current
    const dx = (e.clientX - rect.left) - width  / 2
    const dy = (e.clientY - rect.top)  - height / 2
    const distNm  = Math.sqrt(dx * dx + dy * dy) / pixelsPerNm
    const bearDeg = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360
    const brg  = Math.round(bearDeg) || 360
    const dist = Math.round(distNm)
    setMomsReadout(`${String(brg).padStart(3, '0')}/${dist}`)
  }, [])

  // ── ODS (preview area) — shares STARS buffer + key map ───────────
  const odsBuffer   = usePreviewStore((s) => s.buffer)
  const odsResponse = usePreviewStore((s) => s.response)
  const [odsLines, setOdsLines] = useState([])

  // Push action error responses into the ODS history
  useEffect(() => {
    if (odsResponse) {
      setOdsLines((prev) => [...prev, odsResponse].slice(-ODS_MAX_LINES))
    }
  }, [odsResponse])

  const handleKeyDown = useCallback((e) => {
    const starsKey = matchStarsKey(e)
    if (starsKey) {
      e.preventDefault()
      if (starsKey.action === 'TOGGLE_TOPDOWN') {
        const current = useDisplayStore.getState().windows[WINDOW_ID]?.tdmMode ?? false
        displayStore.updateWindow(WINDOW_ID, { tdmMode: !current })
        return
      }
      if (starsKey.token) usePreviewStore.getState().appendToken(starsKey.token)
      return
    }
    if (e.key === 'Escape')    { e.preventDefault(); usePreviewStore.getState().clear(); setOdsLines([]); return }
    if (e.key === 'Backspace') { e.preventDefault(); usePreviewStore.getState().backspace(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const buf = usePreviewStore.getState().buffer
      // Every ENTER-triggered CATCC command is local (odsCommands.js) — no
      // shared STARS parser/dispatcher involved. processOdsCommand always
      // returns a Promise (some handlers, e.g. .ASPCOLORS/.REFRESH, hit the
      // server), so the buffer/preview clear immediately and the result
      // lines land in odsLines whenever it resolves.
      processOdsCommand(buf, {
        visibleUnits: visibleUnitsRef.current,
        correlations: effectiveCorrelationsRef.current,
        positionName,
      }).then((output) => {
        setOdsLines((prev) => (output.length ? [...prev, ...output].slice(-ODS_MAX_LINES) : []))
      })
      usePreviewStore.getState().clear()
      return
    }
    if (isTypedInput(e)) {
      e.preventDefault()
      usePreviewStore.getState().appendChar(e.key.toUpperCase())
    }
  }, [positionName, displayStore])

  // ── Mouse interactions ─────────────────────────────────────────────
  const handleMouseUp = useCallback((e) => {
    if (e.button !== 0) return
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect) return
    const canvasPos = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    if (!viewRef.current) return
    const target = resolveSlew(canvasPos, visibleUnitsRef.current, viewRef.current)

    // Ctrl+Shift+Click — initiate track (mirrors F3/IC + slew)
    if (e.ctrlKey && e.shiftKey) {
      initCntl(target)
      return
    }

    // Shift+Click — drop track (mirrors F4/TC + slew)
    if (e.shiftKey && !e.ctrlKey) {
      termCntl(target)
      return
    }

    // Ctrl+Click — add contact to status board (CATCC-specific, no STARS equivalent)
    if (e.ctrlKey && !e.shiftKey) {
      if (target) {
        const callsign = resolveCallsign(target.unit)
        useStatusBoardStore.getState().addEntry(callsign, target.unitId)
      }
      return
    }

    // MF S — relocate status text
    if (usePreviewStore.getState().buffer.trim().toUpperCase() === 'MF S') {
      const v = viewRef.current
      if (v) {
        useDisplayStore.getState().updateWindow(WINDOW_ID, {
          statusTextXPct: (canvasPos.x / v.width)  * 100,
          statusTextYPct: (canvasPos.y / v.height) * 100,
        })
        usePreviewStore.getState().clear()
        setOdsLines([])
      }
      return
    }

    // Slew commands — parse ODS buffer against CATCC's own local slew table
    // (IC/TC/HO <tcp>/point-outs/leader-line/scratchpad — see slewCommands.js)
    const parsed = parseCatccSlew(usePreviewStore.getState().buffer)
    if (parsed) {
      dispatchCatccSlew(parsed, target)
      if (!usePreviewStore.getState().response) setOdsLines([])
    }
  }, [])

  // ── Zoom ───────────────────────────────────────────────────────────
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    if (!windowSettings) return
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

  if (!windowSettings) return null

  const bkgGray = Math.round((windowSettings.briteBkg ?? 0) / 100 * 160)
  const bgColor = `rgb(${bkgGray},${bkgGray},${bkgGray})`

  return (
    <div className="catcc-scope" style={{ background: bgColor }}>
      <div ref={canvasAreaRef} className="catcc-canvas-area">
        <canvas ref={mapCanvasRef}      className="catcc-layer" />
        <canvas ref={layersCanvasRef}   className="catcc-layer" />
        <canvas ref={compassCanvasRef}  className="catcc-layer" />
        <canvas ref={contactsCanvasRef} className="catcc-layer" />
        <div
          ref={interactiveRef}
          className="catcc-layer catcc-interactive"
          tabIndex={0}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setMomsReadout('')}
          onKeyDown={handleKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        />
        <CatccStatusText
          xPct={windowSettings?.statusTextXPct ?? 50}
          yPct={windowSettings?.statusTextYPct ?? 2}
          brc={carrierUnit ? brc : null}
          fb={carrierUnit ? fb : null}
          tacticalName={CARRIER_TYPES[carrierUnit?.name]?.tacticalName ?? null}
        />
        <div className="catcc-ods-stack">
          <div className="catcc-moms">{momsReadout || ' '}</div>
          <div className="catcc-ods">
            {odsLines.map((line, i) => (
              <div key={i} className="catcc-ods-line">{line}</div>
            ))}
            <div className="catcc-ods-input">
              <span className="catcc-ods-prompt">{'>'}</span>
              <span className="catcc-ods-preview">{odsBuffer}</span>
              <span className="catcc-ods-cursor">_</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
