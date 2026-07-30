import { useEffect, useRef, useState, useMemo } from 'react'
import { useUnitsStore }       from '../../store/units.js'
import { useSessionStore }     from '../../store/session.js'
import { useCorrelationStore } from '../../store/correlation.js'
import { getVisibleUnits }     from '../atc/stars/visibleUnits.js'
import { resolveCallsign }     from '../../utils/callsign.js'
import { CARRIER_TYPES, projectOntoDeck } from '../../utils/carriers.js'
import './Deck.css'

const METERS_TO_FEET     = 3.28084
const ALT_ABOVE_DECK_FT  = 40  // how far above deck level still counts as "on deck" (vs. overflying)
const ALT_BELOW_DECK_FT  = 20  // how far below deck level still counts — beyond this, treat as on
                                // the elevator/in the hangar bay and hide it
const SYMBOL_R         = 7   // same triangle size as AsdexScope's drawAsdexContacts.js
const CONTACT_COLOR    = 'rgb(0,200,80)'  // CATCC range-ring green (drawCatccLayers.js)

// Cache of rotated (bow-up) deck backgrounds keyed by image src, so each
// carrier class's PNG is only decoded + rotated once no matter how often
// Deck mounts/remounts. Source PNGs are bow-right (see project memory on the
// carrier deck asset flip) — rotating -90deg (CCW) here puts the bow up and
// swaps the footprint to tall/narrow, a better fit for a docked side panel.
// projectOntoDeck()'s forward/right axes are mapped to match: forward -> up
// (-y), right -> +x, so aircraft plotted directly in this canvas's pixel
// space line up with the rotated art without any further transform.
const bgCache = new Map()

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
  const units         = useUnitsStore((s) => s.units)
  const coalition     = useSessionStore((s) => s.coalition)
  const carrierUnitId = useSessionStore((s) => s.carrierUnitId)
  const correlations  = useCorrelationStore((s) => s.correlations)

  const carrierUnit = carrierUnitId != null ? units[carrierUnitId] : null
  const carrierType = CARRIER_TYPES[carrierUnit?.name]

  const containerRef = useRef(null)
  const canvasRef     = useRef(null)
  const [bg,  setBg]  = useState(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

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
        carrierHeadingDeg, carrierType.deckLoaFt, carrierType.deckBeamFt,
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
  }, [visibleUnits, carrierUnit, carrierType, correlations])

  // ── Draw background + contacts ─────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !bg || !box.w || !box.h || !carrierType) return
    canvas.width  = box.w
    canvas.height = box.h
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, box.w, box.h)
    ctx.drawImage(bg.canvas, 0, 0, box.w, box.h)

    const pxPerFtForward = box.h / carrierType.deckLoaFt
    const pxPerFtRight   = box.w / carrierType.deckBeamFt
    // Reference-point correction — the artwork's true "forwardFt/rightFt = 0"
    // point doesn't always land exactly at the image's geometric center.
    const originFt = carrierType.deckOriginOffsetFt ?? { forward: 0, right: 0 }
    const cx = box.w / 2 + originFt.right   * pxPerFtRight
    const cy = box.h / 2 - originFt.forward * pxPerFtForward

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
  }, [bg, box, deckAircraft, carrierType])

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
        {bg && <canvas ref={canvasRef} className="deck-canvas" style={{ width: box.w, height: box.h }} />}
      </div>
    </div>
  )
}
