import { useState, useEffect, useRef } from 'react'

// ── Stability alert hook ──────────────────────────────────────────────────────
// Fires when cumulative deviation from the last stable baseline exceeds `threshold`.
// Stays true until `stabilityMs` of no movement, at which point baseline advances.
export function useStabilityAlert(value, { threshold = 5, stabilityMs = 20000, circular = false } = {}) {
  const baseRef    = useRef(value)  // last confirmed stable value; only updated by timer
  const prevRef    = useRef(value)  // previous poll value
  const currentRef = useRef(value)  // always latest; safe to read from timer callbacks
  const timerRef   = useRef(null)
  const alertedRef = useRef(false)
  const [alerted, setAlerted] = useState(false)

  useEffect(() => {
    currentRef.current = value

    const cumDelta = circular
      ? Math.abs(((value - baseRef.current + 540) % 360) - 180)
      : Math.abs(value - baseRef.current)

    const pollDelta = circular
      ? Math.abs(((value - prevRef.current + 540) % 360) - 180)
      : Math.abs(value - prevRef.current)
    prevRef.current = value

    // Trigger alert once cumulative drift from baseline exceeds threshold
    if (cumDelta > threshold && !alertedRef.current) {
      alertedRef.current = true
      setAlerted(true)
    }

    // Any movement resets the stability window; baseline advances only when timer fires
    if (pollDelta > 0) {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        baseRef.current = currentRef.current
        if (alertedRef.current) {
          alertedRef.current = false
          setAlerted(false)
        }
      }, stabilityMs)
    }
  }, [value, circular, threshold, stabilityMs])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return alerted
}
