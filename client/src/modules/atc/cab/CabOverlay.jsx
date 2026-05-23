import { useEffect, useRef, useCallback } from 'react'
import { createPortal }           from 'react-dom'
import { useMap }                 from 'react-leaflet'
import { useFlightPlansStore }    from '../../../store/flightPlans.js'
import { useDisplayStore }        from '../../../store/display.js'
import { useAtcStore }            from '../../../store/atc.js'
import { useSessionStore }        from '../../../store/session.js'
import { useControllersStore }    from '../../../store/controllers.js'
import { useFpeStore }            from '../../../store/fpe.js'
import { resolveCallsign }        from '../../../utils/callsign.js'
import { CAB_WINDOW_ID }          from './CabDcb.jsx'

const M_PER_S_TO_KT = 1.94384
const MAX_HISTORY   = 10
const SYMBOL_R      = 7
const SLEW_RADIUS   = 15
const RIGHT_ALIGN_ANGLES = new Set([90, 135, 180, -135])

function projectLatLng(lat, lng, trackRad, distNm) {
  const latRad = lat * Math.PI / 180
  return [
    lat + (distNm / 60) * Math.cos(trackRad),
    lng + (distNm / (60 * Math.cos(latRad))) * Math.sin(trackRad),
  ]
}

export function CabOverlay({ units }) {
  const map       = useMap()
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)

  // Keep all store state in refs — the rAF loop reads refs directly,
  // avoiding React render-cycle lag during Leaflet's zoom animation.
  const win            = useDisplayStore((s) => s.windows[CAB_WINDOW_ID])
  const plans          = useFlightPlansStore((s) => s.plans)
  const positionName   = useSessionStore((s) => s.positionName)
  const myControllerId = useControllersStore((s) => s.registry[positionName]?.controllerId ?? null)

  const winRef             = useRef(win)
  const plansRef           = useRef(plans)
  const unitsRef           = useRef(units)
  const myControllerIdRef  = useRef(myControllerId)
  const historyRef         = useRef({})
  const histRateRef        = useRef(win?.historyRate ?? 4.5)

  useEffect(() => { winRef.current            = win            }, [win])
  useEffect(() => { plansRef.current          = plans          }, [plans])
  useEffect(() => { unitsRef.current          = units          }, [units])
  useEffect(() => { myControllerIdRef.current = myControllerId }, [myControllerId])
  useEffect(() => { histRateRef.current       = win?.historyRate ?? 4.5 }, [win?.historyRate])

  // History capture
  useEffect(() => {
    let lastCapture = 0
    const id = setInterval(() => {
      const rate = histRateRef.current
      if (rate <= 0) return
      const now = Date.now()
      if (now - lastCapture < rate * 1000) return
      lastCapture = now
      const cur = unitsRef.current
      historyRef.current = Object.fromEntries(
        Object.entries(cur).map(([uid, u]) => {
          const prev = historyRef.current[uid] || []
          const pos  = u.position
          if (!pos) return [uid, prev]
          return [uid, [{ lat: pos.lat, lng: pos.lng }, ...prev].slice(0, MAX_HISTORY)]
        })
      )
    }, 500)
    return () => clearInterval(id)
  }, []) // eslint-disable-line

  // rAF draw loop — runs every frame, reads all state from refs
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const container = map.getContainer()
      const w = container.clientWidth
      const h = container.clientHeight
      if (canvas.width !== w)  canvas.width  = w
      if (canvas.height !== h) canvas.height = h

      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, w, h)

      const win          = winRef.current ?? {}
      const ldrAngleDeg  = win.ldrAngleDeg  ?? -45
      const ldrLengthPx  = win.ldrLength != null ? win.ldrLength * 10 : 20
      const ptlMinutes   = win.ptlLength    ?? 0.5
      const historyLimit = win.historyLength ?? 5

      const ldrAngleRad = ldrAngleDeg * Math.PI / 180
      const ldx         = Math.cos(ldrAngleRad) * ldrLengthPx
      const ldy         = Math.sin(ldrAngleRad) * ldrLengthPx
      const rightAlign  = RIGHT_ALIGN_ANGLES.has(ldrAngleDeg)

      const plansByUnit = {}
      for (const p of Object.values(plansRef.current)) {
        if (p.unitId != null) plansByUnit[String(p.unitId)] = p
      }

      ctx.font = '11px "Roboto Mono", monospace'

      for (const [id, unit] of Object.entries(unitsRef.current)) {
        const pos = unit.position
        if (!pos) continue

        // latLngToContainerPoint gives screen coords relative to the map container —
        // outside Leaflet's pane transform hierarchy, so no CSS zoom-animation skew.
        const { x, y } = map.latLngToContainerPoint([pos.lat, pos.lng])
        if (x < -60 || x > w + 60 || y < -60 || y > h + 60) continue

        // PTL
        if (ptlMinutes > 0 && unit.track != null && unit.speed) {
          const distNm    = (unit.speed * M_PER_S_TO_KT * ptlMinutes) / 60
          const [eLat, eLng] = projectLatLng(pos.lat, pos.lng, unit.track, distNm)
          const ep        = map.latLngToContainerPoint([eLat, eLng])
          ctx.beginPath()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth   = 0.8
          ctx.moveTo(x, y)
          ctx.lineTo(ep.x, ep.y)
          ctx.stroke()
        }

        // History dots
        const trail = historyRef.current[id] || []
        for (let i = 0; i < trail.length && i < historyLimit; i++) {
          const hp      = map.latLngToContainerPoint([trail[i].lat, trail[i].lng])
          const opacity = Math.max(0.15, 0.65 - i * 0.12)
          ctx.beginPath()
          ctx.fillStyle = `rgba(255,255,255,${opacity})`
          ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2)
          ctx.fill()
        }

        // Symbol — filled triangle rotated by heading
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(unit.track ?? 0)
        ctx.beginPath()
        ctx.moveTo(0, -7)
        ctx.lineTo(5, 5)
        ctx.lineTo(-5, 5)
        ctx.closePath()
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.restore()

        // Leader line
        const lx0 = x + Math.cos(ldrAngleRad) * SYMBOL_R
        const ly0 = y + Math.sin(ldrAngleRad) * SYMBOL_R
        const lx1 = x + ldx
        const ly1 = y + ldy
        ctx.beginPath()
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth   = 0.8
        ctx.moveTo(lx0, ly0)
        ctx.lineTo(lx1, ly1)
        ctx.stroke()

        // Datablock
        const cs   = resolveCallsign(unit).toUpperCase()
        const plan = plansByUnit[String(id)]
        const typ  = plan?.typ  ? plan.typ.trim()  : ''
        const dest = plan?.dest ? plan.dest.trim() : ''
        const line2Parts = [typ, dest].filter(Boolean)
        const line2      = line2Parts.length ? line2Parts.join(' ') : ''
        const tx         = lx1 + (rightAlign ? -2 : 2)

        ctx.fillStyle  = '#ffffff'
        ctx.textAlign  = rightAlign ? 'right' : 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(cs, tx, ly1)
        if (line2) ctx.fillText(line2, tx, ly1 + 13)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [map]) // eslint-disable-line

  // Ctrl+click — find nearest contact within SLEW_RADIUS
  const handleMapClick = useCallback((e) => {
    if (!e.originalEvent.ctrlKey) return
    const cp = e.containerPoint
    let nearest = null
    let nearestDist = SLEW_RADIUS

    for (const [id, unit] of Object.entries(unitsRef.current)) {
      const pos = unit.position
      if (!pos) continue
      const up   = map.latLngToContainerPoint([pos.lat, pos.lng])
      const dist = Math.hypot(up.x - cp.x, up.y - cp.y)
      if (dist < nearestDist) { nearestDist = dist; nearest = { id, unit } }
    }

    if (!nearest) return
    const aid     = resolveCallsign(nearest.unit).toUpperCase()
    const owner   = useAtcStore.getState().ownership[String(nearest.id)]
    const readOnly = !!(owner && owner !== myControllerIdRef.current)
    useFpeStore.getState().openFpe({ aid, unitId: Number(nearest.id), readOnly, scope: 'cab' })
  }, [map])

  useEffect(() => {
    map.on('click', handleMapClick)
    return () => map.off('click', handleMapClick)
  }, [map, handleMapClick])

  // Portal the canvas directly into the map container (outside Leaflet's pane
  // hierarchy) so it is never subject to Leaflet's CSS zoom-animation transforms.
  return createPortal(
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 450 }}
    />,
    map.getContainer()
  )
}
