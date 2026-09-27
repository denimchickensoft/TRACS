import { useEffect, useRef, useState, useMemo } from 'react'
import { useUnitsStore }       from '../../store/units.js'
import { useSessionStore }     from '../../store/session.js'
import { useCorrelationStore } from '../../store/correlation.js'
import { getVisibleUnits }     from '../../utils/visibleUnits.js'
import { resolveCallsign }     from '../../utils/callsign.js'
import { CARRIER_TYPES, projectOntoDeck } from '../../utils/carriers.js'
import './Deck.css'
import { M_TO_FT as METERS_TO_FEET } from '../../utils/units.js'

const ALT_ABOVE_DECK_FT  = 40  // how far above deck level still counts as "on deck" (vs. overflying)
const ALT_BELOW_DECK_FT  = 20  // how far below deck level still counts — beyond this, treat as on
                                // the elevator/in the hangar bay and hide it
const SYMBOL_R         = 7   // same triangle size as AsdexScope's drawAsdexContacts.js
const CONTACT_COLOR    = 'rgb(0,200,80)'  // CATCC range-ring green (drawCatccLayers.js)

// Zoom is relative to the fit-to-container size computed below (box), which
// is fixed at 1x — zooming out further than a full fit-to-panel view isn't
// useful, so 1 is a hard floor, not just a default.
const ZOOM_MIN  = 1
const ZOOM_MAX  = 4
const ZOOM_STEP = 0.2

// Cache of rotated (bow-up) deck backgrounds keyed by image src, so each
// carrier class's PNG is only decoded + rotated once no matter how often
// Deck mounts/remounts. Source PNGs are bow-right — rotating -90deg (CCW) here puts the bow up and
// swaps the footprint to tall/narrow, a better fit for a docked side panel.
// projectOntoDeck()'s forward/right axes are mapped to match: forward -> up
// (-y), right -> +x, so aircraft plotted directly in this canvas's pixel
// space line up with the rotated art without any further transform.
const bgCache = new Map()

// In popup mode, coalition/carrierUnitId arrive via URL param, not the session
// store — the session BroadcastChannel deliberately doesn't broadcast these
// (see store/session.js: they're per-scope, not session-wide, same reasoning
// as facilityDcsName in AsdexScope.jsx).
const _urlParams          = new URLSearchParams(window.location.search)
const _URL_COALITION      = _urlParams.get('coalition')
const _URL_CARRIER_UNITID = _urlParams.get('carrierUnitId')

function loadRotatedBackground(src, onReady) {
  const cached = bgCache.get(src)
  if (cached) { onReady(cached); return }
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width  = img.naturalHeight
    canvas.height = img.naturalWidth
    const ctx = canvas.getContext('2d')
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
    const entry = { canvas, w: canvas.width, h: canvas.height }
    bgCache.set(src, entry)
    onReady(entry)
  }
  img.src = src
}

export function Deck({ docked = true, width, onResize, onUndock, onHide }) {
  const units             = useUnitsStore((s) => s.units)
  const _sessionCoalition = useSessionStore((s) => s.coalition)
  const _sessionCarrierId = useSessionStore((s) => s.carrierUnitId)
  const mission        = useSessionStore((s) => s.mission)
  const theatre        = mission?.mission?.theatre
  const coalition     = _URL_COALITION || _sessionCoalition
  const carrierUnitId = _URL_CARRIER_UNITID ? Number(_URL_CARRIER_UNITID) : _sessionCarrierId
  const correlations  = useCorrelationStore((s) => s.correlations)

  const carrierUnit = carrierUnitId != null ? units[carrierUnitId] : null
  const carrierType = CARRIER_TYPES[carrierUnit?.name]

  const containerRef = useRef(null)
  const canvasRef     = useRef(null)
  const [bg,  setBg]  = useState(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [containerSize, setContainerSize] = useState({ cw: 0, ch: 0 })
  const [zoom, setZoom] = useState(ZOOM_MIN)

  // Load (and cache) the rotated background for the active carrier class
  useEffect(() => {
    if (!carrierType?.deckImage) { setBg(null); return }
    let cancelled = false
    setBg(null)
    loadRotatedBackground(`/carriers/${carrierType.deckImage}`, (entry) => {
      if (!cancelled) setBg(entry)
    })
    return () => { cancelled = true }
  }, [carrierType?.deckImage])

  // Fit the (tall, narrow) rotated background into the available panel area
  useEffect(() => {
    const container = containerRef.current
    if (!container || !bg) return
    const compute = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      if (!cw || !ch) return
      setContainerSize({ cw, ch })
      const aspect = bg.w / bg.h
      let w = cw, h = w / aspect
      if (h > ch) { h = ch; w = h * aspect }
      setBox({ w: Math.round(w), h: Math.round(h) })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(container)
    return () => ro.disconnect()
  }, [bg])

  // New deck background (carrier class switch) → back out to the fit-to-panel view
  useEffect(() => { setZoom(ZOOM_MIN) }, [bg])

  // Scroll to zoom in on the deck; ZOOM_MIN (fit-to-panel) is a hard floor —
  // zooming out further than the panel fit isn't useful.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e) => {
      e.preventDefault()
      const dir = e.deltaY < 0 ? 1 : -1
      setZoom((z) => Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + dir * ZOOM_STEP)) * 100) / 100)
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  // Right-click-hold to pan when zoomed. Drives the container's native
  // scrollLeft/scrollTop directly rather than tracking an offset in state —
  // the browser clamps those to [0, scrollWidth/Height - clientWidth/Height]
  // for free, which is exactly "don't pan past the edges of the png".
  const dragRef = useRef(null)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onMouseDown = (e) => {
      if (e.button !== 2) return
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startScrollLeft: container.scrollLeft,
        startScrollTop:  container.scrollTop,
      }
      container.style.cursor = 'grabbing'
    }
    const onMouseMove = (e) => {
      if (!dragRef.current) return
      container.scrollLeft = dragRef.current.startScrollLeft - (e.clientX - dragRef.current.startX)
      container.scrollTop  = dragRef.current.startScrollTop  - (e.clientY - dragRef.current.startY)
    }
    const onMouseUp = (e) => {
      if (e.button !== 2) return
      dragRef.current = null
      container.style.cursor = ''
    }
    const onContextMenu = (e) => e.preventDefault()
    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // getVisibleUnits(..., true) bypasses the 100ft-AGL floor: a jet sitting on
  // a ~65-72ft deck reads as under that floor against sea-level terrain and
  // would otherwise be suppressed.
  const visibleUnits = useMemo(() => getVisibleUnits(units, coalition, true), [units, coalition])

  // Aircraft currently on this carrier's deck — near deck-level altitude and
  // within the hull footprint (see projectOntoDeck).
  const deckAircraft = useMemo(() => {
    if (!carrierUnit?.position || !carrierType) return []
    const carrierHeadingRad = carrierUnit.heading ?? 0
    const carrierHeadingDeg = carrierHeadingRad * 180 / Math.PI
    // Deck reference altitude — the carrier's own live altitude, not an
    // assumed sea-level 0, plus the class's deck height above the hull.
    const deckAltFt = (carrierUnit.position.alt ?? 0) * METERS_TO_FEET + carrierType.deckHeightFt
    const out = []
    for (const [uid, unit] of Object.entries(visibleUnits)) {
      if (!unit.position) continue
      const altFt   = (unit.position.alt ?? 0) * METERS_TO_FEET
      const relAltFt = altFt - deckAltFt
      // Asymmetric: a jet riding the elevator down into the hangar bay drops
      // below deck level while still inside the hull footprint, so cut off
      // sharply below deck rather than reusing the same tolerance as above.
      if (relAltFt > ALT_ABOVE_DECK_FT || relAltFt < -ALT_BELOW_DECK_FT) continue
      const { forwardFt, rightFt, onDeck } = projectOntoDeck(
        unit.position, carrierUnit.position.lat, carrierUnit.position.lng,
        carrierHeadingDeg, carrierType.deckLoaFt, carrierType.deckBeamFt, theatre,
      )
      if (!onDeck) continue
      // Canvas "up" is the ship's bow, not true north — rotate the symbol by
      // the aircraft's heading relative to the carrier's. Uses raw heading,
      // not track: track is derived from position deltas and is only
      // meaningful in motion, but deck aircraft are parked most of the time.
      const headingRad = (unit.heading ?? 0) - carrierHeadingRad
      out.push({ uid, forwardFt, rightFt, headingRad, label: correlations[uid] || resolveCallsign(unit) })
    }
    return out
  }, [visibleUnits, carrierUnit, carrierType, correlations, theatre])

  // Zoomed render size — box is the fit-to-panel (1x) size, this is what's
  // actually drawn/scrolled. Kept separate from box so the ResizeObserver fit
  // above doesn't have to account for zoom.
  const renderW = Math.round(box.w * zoom)
  const renderH = Math.round(box.h * zoom)

  // Center the canvas via margin, not flexbox align/justify-center: browsers
  // treat centered flex/grid overflow as "unsafe" alignment by default and
  // clip the before-center portion from the scrollable area, so a zoomed,
  // centered canvas can't be dragged all the way to its near edge. Margins
  // sidestep that — clamped to 0 once the canvas outgrows the container on
  // that axis, at which point native scrollLeft/scrollTop already cover the
  // full 0..(scrollSize - clientSize) range, i.e. edge-to-edge and no further.
  const marginLeft = Math.max(0, (containerSize.cw - renderW) / 2)
  const marginTop  = Math.max(0, (containerSize.ch - renderH) / 2)

  // ── Draw background + contacts ─────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bg || !renderW || !renderH || !carrierType) return
    if (canvas.width  !== renderW) canvas.width  = renderW
    if (canvas.height !== renderH) canvas.height = renderH
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, renderW, renderH)
    ctx.drawImage(bg.canvas, 0, 0, renderW, renderH)

    const pxPerFtForward = renderH / carrierType.deckLoaFt
    const pxPerFtRight   = renderW / carrierType.deckBeamFt
    const cx = renderW / 2
    const cy = renderH / 2

    ctx.font         = '10px "Roboto Mono", monospace'
    ctx.textAlign    = 'center'
    ctx.textBaseline = 'bottom'
    for (const ac of deckAircraft) {
      const x = cx + ac.rightFt   * pxPerFtRight
      const y = cy - ac.forwardFt * pxPerFtForward

      // Symbol — same filled triangle as AsdexScope's drawAsdexContacts.js
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(ac.headingRad)
      ctx.beginPath()
      ctx.moveTo(0, -SYMBOL_R)
      ctx.lineTo(SYMBOL_R - 2, SYMBOL_R - 2)
      ctx.lineTo(-(SYMBOL_R - 2), SYMBOL_R - 2)
      ctx.closePath()
      ctx.fillStyle = CONTACT_COLOR
      ctx.fill()
      ctx.restore()

      // Label — centered directly above the symbol
      ctx.fillStyle = CONTACT_COLOR
      ctx.fillText(ac.label, x, y - SYMBOL_R - 3)
    }
  }, [bg, renderW, renderH, deckAircraft, carrierType])

  const windowStyle = docked && width ? { width, minWidth: width } : {}

  return (
    <div className={`deck-window${docked ? ' deck-window--docked' : ''}`} style={windowStyle}>
      {docked && <div className="deck-resize-handle" onMouseDown={onResize} />}

      {docked && (
        <div className="deck-drawer-header">
          <span className="deck-drawer-title">DECK</span>
          <div className="deck-drawer-btns">
            {onUndock && <button className="deck-drawer-btn" onClick={onUndock} title="Undock">⬡</button>}
            {onHide   && <button className="deck-drawer-btn" onClick={onHide}   title="Hide">›</button>}
          </div>
        </div>
      )}

      <div ref={containerRef} className="deck-canvas-area">
        {!carrierUnit && <div className="deck-empty">No carrier assigned</div>}
        {carrierUnit && !carrierType && <div className="deck-empty">Unknown carrier type</div>}
        {carrierUnit && carrierType && !carrierType.deckImage && <div className="deck-empty">No deck image for this carrier</div>}
        {bg && <canvas ref={canvasRef} className="deck-canvas" style={{ width: renderW, height: renderH, marginLeft, marginTop }} />}
      </div>
    </div>
  )
}
