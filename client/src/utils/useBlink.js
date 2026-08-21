import { useState, useEffect } from 'react'

// Shared 200ms-tick / 500ms-on-off blink driver for datablock/handoff/point-out
// blink cues — used by any scope with a handoff-style workflow (STARS, ABM,
// CATCC). AIC and ASDE-X have no blink state — those scopes don't do handoffs.
export function useBlink() {
  const [blinkTick, setBlinkTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setBlinkTick((t) => t + 1), 200)
    return () => clearInterval(id)
  }, [])
  const blinkOn = Math.floor(Date.now() / 500) % 2 === 0
  return { blinkTick, blinkOn }
}
