import { useEffect, useState } from 'react'

// Size for a popped-out panel that scales itself with CSS zoom, so it fills
// its window exactly at any zoom: px lengths are multiplied by zoom, so the
// window size divided by the zoom renders at the window size. Null when the
// panel isn't popped out.
export function usePopupFill(scale, active) {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  useEffect(() => {
    if (!active) return
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [active])
  return active ? { width: size.w / scale, height: size.h / scale } : null
}
