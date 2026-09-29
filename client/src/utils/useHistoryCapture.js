import { useEffect, useRef } from 'react'
import { useUnitsStore } from '../store/units.js'

const MAX_HISTORY = 10  // absolute max; display capped by historyLength setting

/**
 * Per-contact position-history capture shared by the STARS, CATCC and ABM
 * scopes. Every 200 ms it checks whether fresh data has arrived in
 * `sourceStore` (its `lastUpdateTime` changed) and whether `historyRate`
 * seconds have passed since the last capture; if both, it prepends each
 * entity's current position to its trail (capped at MAX_HISTORY points).
 *
 * @param {{ current: Object }} entitiesRef  caller-owned, always-current ref
 *   to the map of id -> entity (with `.position`) to record
 * @param {number} historyRate  seconds between captures (default 4.5)
 * @param {object} [options]
 * @param {Function} [options.sourceStore]  zustand store whose
 *   `lastUpdateTime` marks fresh data (default: the units store; ABM passes
 *   the weapons store for missile trails)
 * @param {boolean} [options.pauseAtZeroRate]  true (default): a rate of 0 or
 *   less stops capturing. false: it captures on every fresh update instead
 *   (ABM's `.history <len> 0`).
 * @returns {{ current: Object }} ref to the id -> [{lat, lng}, ...] trails,
 *   newest first
 */
export function useHistoryCapture(entitiesRef, historyRate, { sourceStore = useUnitsStore, pauseAtZeroRate = true } = {}) {
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
      if (pauseAtZeroRate && rateSecs <= 0) return

      // Only capture when fresh data has arrived
      const { lastUpdateTime } = sourceStore.getState()
      if (!lastUpdateTime || lastUpdateTime === lastCaptureUpdateTime) return

      // Rate-gate in wall time
      const now = Date.now()
      if ((now - lastCaptureWall) < rateSecs * 1000) return

      lastCaptureWall = now
      lastCaptureUpdateTime = lastUpdateTime

      const current = entitiesRef.current
      historyRef.current = Object.fromEntries(
        Object.entries(current).map(([key, entity]) => {
          const prev = historyRef.current[key] || []
          const pos  = entity.position
          if (!pos) return [key, prev]
          return [key, [{ lat: pos.lat, lng: pos.lng }, ...prev].slice(0, MAX_HISTORY)]
        })
      )
    }, 200)
    return () => clearInterval(id)
  }, []) // eslint-disable-line -- entitiesRef is a stable ref; sourceStore/pauseAtZeroRate are fixed per caller

  return historyRef
}
