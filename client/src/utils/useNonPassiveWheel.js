import { useEffect } from 'react'

// Attaches a non-passive wheel listener to a ref'd element so a DCB spinner
// can call preventDefault() to stop the scope beneath from zooming while the
// spinner itself is being scrolled — React's synthetic onWheel is passive by
// default and can't do that, hence the manual DOM listener.
export function useNonPassiveWheel(ref, handler) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [ref, handler])
}
