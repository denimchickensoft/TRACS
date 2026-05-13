import { useRef, useCallback } from 'react'

// deltaMode !== 0 (line/page) or large pixel delta → discrete mouse wheel → fire immediately
// small pixel delta → trackpad → accumulate until threshold crossed
const MOUSE_MIN_PX      = 50
const TRACKPAD_THRESHOLD = 60

export function useWheelDirection(threshold = TRACKPAD_THRESHOLD) {
  const accRef = useRef(0)
  return useCallback((e) => {
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= MOUSE_MIN_PX) {
      accRef.current = 0
      return e.deltaY > 0 ? 1 : -1
    }
    accRef.current += e.deltaY
    if (Math.abs(accRef.current) >= threshold) {
      const dir = accRef.current > 0 ? 1 : -1
      accRef.current = 0
      return dir
    }
    return null
  }, [threshold])
}
