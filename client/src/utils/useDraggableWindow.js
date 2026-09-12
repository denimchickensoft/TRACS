import { useState, useRef, useCallback, useMemo } from 'react'
import { useWheelDirection } from './wheel.js'

// Scoped-down extraction of ControllerList.jsx's drag/resize/opacity logic
// (see components/ControllerList/ControllerList.jsx) for floating panels that
// don't need its edge-docking/snap-to-panel/localStorage-persistence concepts
// — currently just modules/abm/AbmFocusPanel.jsx. ControllerList/Messages are
// deliberately left on their own hand-rolled copies rather than migrated onto
// this, to avoid touching two already-working, unrelated features.

const OPACITY_STEP = 0.05
const OPACITY_MIN  = 0.2
const OPACITY_MAX  = 1.0

export function useDraggableWindow({ defaultPos, defaultSize, minWidth = 240, minHeight = 160 }) {
  const wheelDir = useWheelDirection()

  const [pos,         setPos]         = useState(defaultPos)
  const [size,        setSize]        = useState(defaultSize)
  const [opacity,     setOpacity]     = useState(1.0)
  const [opacityHint, setOpacityHint] = useState(false)

  const posRef         = useRef(pos)
  const sizeRef        = useRef(size)
  const opacityHintRef = useRef(null)
  const windowRef      = useRef(null)

  const handleDragStart = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const ox = e.clientX - posRef.current.x
    const oy = e.clientY - posRef.current.y
    const onMove = (ev) => {
      const par  = windowRef.current?.parentElement
      const maxX = par ? Math.max(0, par.clientWidth  - sizeRef.current.w) : Infinity
      const maxY = par ? Math.max(0, par.clientHeight - sizeRef.current.h) : Infinity
      const next = { x: Math.max(0, Math.min(maxX, ev.clientX - ox)), y: Math.max(0, Math.min(maxY, ev.clientY - oy)) }
      posRef.current = next
      setPos(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [])

  const handleOpacityWheel = useCallback((e) => {
    e.preventDefault()
    const dir = wheelDir(e)
    if (dir === null) return
    setOpacity((prev) => {
      const next = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, parseFloat((prev - dir * OPACITY_STEP).toFixed(2))))
      clearTimeout(opacityHintRef.current)
      setOpacityHint(true)
      opacityHintRef.current = setTimeout(() => setOpacityHint(false), 1200)
      return next
    })
  }, [wheelDir])

  const makeResizer = useCallback((dir) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const sp = { ...posRef.current }
    const ss = { ...sizeRef.current }
    const has = (d) => dir.includes(d)
    const onMove = (ev) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      let { x, y } = sp
      let { w, h } = ss
      if (has('e')) w = Math.max(minWidth,  ss.w + dx)
      if (has('s')) h = Math.max(minHeight, ss.h + dy)
      if (has('w')) { const nw = Math.max(minWidth,  ss.w - dx); x = sp.x + (ss.w - nw); w = nw }
      if (has('n')) { const nh = Math.max(minHeight, ss.h - dy); y = sp.y + (ss.h - nh); h = nh }
      posRef.current  = { x, y }
      sizeRef.current = { w, h }
      setPos({ x, y })
      setSize({ w, h })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [minWidth, minHeight])

  const resizers = useMemo(() => ({
    n:  makeResizer('n'),  s:  makeResizer('s'),  e:  makeResizer('e'),  w:  makeResizer('w'),
    ne: makeResizer('ne'), nw: makeResizer('nw'), se: makeResizer('se'), sw: makeResizer('sw'),
  }), [makeResizer])

  return { pos, size, opacity, opacityHint, windowRef, handleDragStart, handleOpacityWheel, resizers }
}
