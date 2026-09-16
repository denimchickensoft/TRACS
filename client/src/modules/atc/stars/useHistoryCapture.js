import { useEffect, useRef } from 'react'
import { useUnitsStore } from '../../../store/units.js'

const MAX_HISTORY = 10  // absolute max; display capped by historyLength setting

/**
 * StarsScope's per-contact position-history capture, moved verbatim. Rate
 * driven by windowSettings.historyRate (seconds). Uses a ref for the
 * current rate so the interval itself never needs to be torn down on
 * change. `visibleUnitsRef` is StarsScope's own always-current ref, passed
 * in rather than owned here since other effects also sync it.
 */
export function useHistoryCapture(visibleUnitsRef, historyRate) {
  const historyRef = useRef({})
  const historyRateRef = useRef(4.5)
  useEffect(() => {
    historyRateRef.current = historyRate ?? 4.5
  }, [historyRate])

  useEffect(() => {
    let lastCaptureWall = 0
    let lastCaptureUpdateTime = 0
    const id = setInterval(() => {
      const rateSecs = historyRateRef.current
      if (rateSecs <= 0) return

      // Only capture when fresh Olympus data has arrived
      const { lastUpdateTime } = useUnitsStore.getState()
      if (!lastUpdateTime || lastUpdateTime === lastCaptureUpdateTime) return

      // Rate-gate in wall time
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
  }, []) // eslint-disable-line -- visibleUnitsRef is a stable ref passed in by the caller

  return historyRef
}
