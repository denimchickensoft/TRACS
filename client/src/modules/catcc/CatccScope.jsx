import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useUnitsStore }         from '../../store/units.js'
import { useSessionStore }       from '../../store/session.js'
import { useDisplayStore }       from '../../store/display.js'
import { useAtcStore }           from '../../store/atc.js'

import { useCorrelationStore }   from '../../store/correlation.js'
import { getVisibleUnits }       from '../atc/visibleUnits.js'
import { rangeToPixelsPerNm }    from '../atc/canvas/projection.js'
import { resolveSlew }           from '../atc/input/slewResolver.js'
import { resolveCallsign }       from '../../utils/callsign.js'
import { useStatusBoardStore }   from '../../store/statusBoard.js'
import { drawCatccLayers }       from './canvas/drawCatccLayers.js'
import { drawCatccContacts }     from './canvas/drawCatccContacts.js'
import { drawCatccDatablocks }   from './canvas/drawCatccDatablocks.js'
import { drawCompassRose }       from '../atc/canvas/drawCompassRose.js'
import { THEATRE_MAGVAR }        from '../../utils/magvar.js'
import { CARRIER_TYPES }         from '../../utils/carriers.js'
import { matchStarsKey, isTypedInput } from '../atc/input/starsKeys.js'
import { parseCommand }          from '../atc/input/commandParser.js'
import { dispatch as dispatchAction } from '../atc/actions/index.js'
import { usePreviewStore }       from '../../store/preview.js'
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

  const correlations      = useCorrelationStore((s) => s.correlations)

  const displayStore   = useDisplayStore()
  const windowSettings = displayStore.windows[WINDOW_ID]

  const theatre = mission?.mission?.theatre
  const magvar  = THEATRE_MAGVAR[theatre] ?? 0

  // Carrier unit — source of scope center and BRC
  const carrierUnit = carrierUnitId != null ? units[carrierUnitId] : null
  const carrierLat  = carrierUnit?.position?.lat ?? 0
  const carrierLng  = carrierUnit?.position?.lng ?? 0

  const carrierHeadingDeg = (carrierUnit?.heading ?? 0) * 180 / Math.PI
  const brc        = ((carrierHeadingDeg - magvar) % 360 + 360) % 360
  const deckOffset = CARRIER_TYPES[carrierUnit?.name]?.deckOffset ?? 9
  const fb             = ((brc - deckOffset) % 360 + 360) % 360
  const marshalBearing = (fb + 180) % 360

  const [view, setView] = useState(null)
  const viewRef = useRef(null)
  useEffect(() => { viewRef.current = view }, [view])

  // Refs for values that buildView and the ResizeObserver need to stay stable
  const carrierLatRef = useRef(carrierLat)
  const carrierLngRef = useRef(carrierLng)
  const magvarRef     = useRef(magvar)
  useEffect(() => { carrierLatRef.current = carrierLat }, [carrierLat])
  useEffect(() => { carrierLngRef.current = carrierLng }, [carrierLng])
  useEffect(() => { magvarRef.current     = magvar     }, [magvar])

  const visibleUnits = useMemo(() => getVisibleUnits(units, coalition), [units, coalition])
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])

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
      displayStore.initWindow(WINDOW_ID, { rangeNm: 50, ringSpacingNm: 10 })
    }
  }, []) // eslint-disable-line

  // ── Build view — reads dimensions from container so canvas default
  //    size (300×150) never produces a wrong view on remount ──────────
  const buildView = useCallback(() => {
    const container = canvasAreaRef.current
    if (!container) return null
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    if (!ws) return null
    const w = container.clientWidth
    const h = container.clientHeight
    if (!w || !h) return null
    // Keep canvas pixel dims in sync with container so draw functions agree
    for (const ref of [mapCanvasRef, layersCanvasRef, compassCanvasRef, contactsCanvasRef]) {
      if (ref.current && (ref.current.width !== w || ref.current.height !== h)) {
        ref.current.width = w; ref.current.height = h
      }
    }
    return {
      centerLat:   carrierLatRef.current,
      centerLng:   carrierLngRef.current,
      pixelsPerNm: rangeToPixelsPerNm(ws.rangeNm, w, h),
      width:  w,
      height: h,
      magvar: magvarRef.current,
    }
  }, []) // stable — all changing values read from refs/store

  // ── Resize observer — stable, never reconnects on carrier position change
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver(() => { setView(buildView()) })
    ro.observe(container)
    return () => ro.disconnect()
  }, []) // eslint-disable-line

  // Rebuild view when carrier position, zoom, or magvar changes
  useEffect(() => {
    setView(buildView())
  }, [carrierLat, carrierLng, magvar, windowSettings?.rangeNm]) // eslint-disable-line

  // ── Render CATCC layers (rings + CCZ/CCA + corridor + radial) ─────
  useEffect(() => {
    if (!view || !layersCanvasRef.current) return
    const ctx = layersCanvasRef.current.getContext('2d')
    drawCatccLayers(
      ctx, view, fb, marshalBearing,
      windowSettings?.rangeNm       ?? 50,
      windowSettings?.ringSpacingNm ?? 10,
      windowSettings?.briteRr       ?? 80,
    )
  }, [view, fb, marshalBearing,
      windowSettings?.rangeNm, windowSettings?.ringSpacingNm, windowSettings?.briteRr])

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
    // History trails and PTL are captured but not drawn — see drawCatccContacts.js
    drawCatccContacts(
      ctx, view, visibleUnits, trackMap,
      windowSettings?.britePos ?? 80,
      windowSettings?.csPos    ?? 3,
    )
    drawCatccDatablocks(
      ctx, view, visibleUnits, correlations,
      windowSettings?.britePos ?? 80,
      marshalBearing,
      windowSettings?.leaderDirs      ?? {},
      windowSettings?.globalLeaderDir ?? null,
    )
  }, [visibleUnits, view, trackMap, correlations,
      windowSettings?.britePos, windowSettings?.csPos])

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
      if (starsKey.token) usePreviewStore.getState().appendToken(starsKey.token)
      return
    }
    if (e.key === 'Escape')    { e.preventDefault(); usePreviewStore.getState().clear(); setOdsLines([]); return }
    if (e.key === 'Backspace') { e.preventDefault(); usePreviewStore.getState().backspace(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const parsed = parseCommand(usePreviewStore.getState().buffer, 'ENTER')
      if (parsed) {
        dispatchAction(parsed, null, { positionName, windowId: WINDOW_ID })
        if (!usePreviewStore.getState().response) setOdsLines([])
      }
      return
    }
    if (isTypedInput(e)) {
      e.preventDefault()
      usePreviewStore.getState().appendChar(e.key.toUpperCase())
    }
  }, [positionName])

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
      dispatchAction({ command: { id: 'INIT_CNTL' }, captures: {} }, target, { positionName, windowId: WINDOW_ID })
      return
    }

    // Shift+Click — drop track (mirrors F4/TC + slew)
    if (e.shiftKey && !e.ctrlKey) {
      dispatchAction({ command: { id: 'TERM_CNTL' }, captures: {} }, target, { positionName, windowId: WINDOW_ID })
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

    // STARS slew — parse ODS buffer as a SLEW command
    const view = viewRef.current
    const parsed = parseCommand(usePreviewStore.getState().buffer, 'SLEW')
    if (parsed) {
      dispatchAction(parsed, target, {
        positionName,
        canvasPos,
        canvasSize: { w: view.width, h: view.height },
        windowId: WINDOW_ID,
      })
      if (!usePreviewStore.getState().response) setOdsLines([])
    }
  }, [positionName])

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
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        />
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
  )
}
