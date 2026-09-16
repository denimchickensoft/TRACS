import { useEffect, useRef } from 'react'
import { useUnitsStore }   from '../../../../store/units.js'
import { useAtcStore }     from '../../../../store/atc.js'
import { useDisplayStore } from '../../../../store/display.js'
import { useStcaStore }    from '../../../../store/stca.js'
import { computeConflicts } from './computeConflicts.js'
import { buildSuppressionZones, isSuppressed } from './suppressionZones.js'
import { resolvePrimaryOnlyIds } from './formations.js'
import { startAlertTone, stopAlertTone } from '../../../../audio/alertTone.js'

const WINDOW_ID     = 'atc-main'
const STCA_TICK_MS  = 1000

/**
 * StarsScope's STCA compute loop + alert tone, moved verbatim. Opt-in
 * (.CA / starsPrefs.stcaEnabled) — see stca/computeConflicts.js. Runs on its
 * own ~1s interval (independent of the 200ms blink tick) to bound cost;
 * reads fresh store state each tick rather than closing over reactive
 * props, since the interval callback outlives any single render.
 */
export function useStcaTracker({ centerlines, conflicts, conflictAcks, ownership, myControllerId, vol, stcaEnabled, simWingmenStandby }) {
  const vertRatesRef = useRef(new Map())
  const latchedRef   = useRef(new Map())
  useEffect(() => {
    if (!stcaEnabled) {
      // Disabling only hides/silences active alerts — it does NOT forget
      // them. The latch (and its wider hysteresis clear-margin) survives,
      // so re-enabling resumes instantly instead of forcing every still-
      // active pair to re-qualify from scratch under the tight trigger
      // thresholds, which is what caused a several-second re-alert delay.
      useStcaStore.getState().setConflicts([])
      return
    }
    const zones = buildSuppressionZones(centerlines)
    const tick = () => {
      const liveUnits     = useUnitsStore.getState().units
      const liveOwnership = useAtcStore.getState().ownership
      // Read simWingmenStandby/manualWingmen fresh each tick rather than off
      // the closed-over `windowSettings` — manualWingmen changes (the .WNG
      // two-click flow below) don't restart this effect, so a stale closure
      // here would miss them until something else happened to re-arm it.
      const liveWinSettings = useDisplayStore.getState().windows[WINDOW_ID]
      const liveWingmen = resolvePrimaryOnlyIds(
        liveUnits, liveOwnership, liveWinSettings?.manualWingmen, !!liveWinSettings?.simWingmenStandby
      )
      const result = computeConflicts({
        units:            liveUnits,
        ownership:        liveOwnership,
        suppressionZones: zones,
        isSuppressed,
        wingmanIds:       liveWingmen,
        vertRates:        vertRatesRef.current,
        latched:          latchedRef.current,
      })
      useStcaStore.getState().setConflicts(result)
      useAtcStore.getState().pruneConflictAcks(result.map((c) => c.id))
    }
    tick()
    const id = setInterval(tick, STCA_TICK_MS)
    return () => clearInterval(id)
  }, [stcaEnabled, simWingmenStandby, centerlines])

  // ── STCA alert tone ──────────────────────────────────────────────────
  // Sector-specific: only sounds on a window whose controller owns unit A
  // or B of an unacknowledged pair.
  useEffect(() => {
    const hasUnacked = conflicts.some((c) =>
      !conflictAcks[c.id] &&
      (ownership[c.unitAId] === myControllerId || ownership[c.unitBId] === myControllerId)
    )
    if (hasUnacked) {
      startAlertTone('stars-ca', { getVolume: () => (vol ?? 10) / 10 })
    } else {
      stopAlertTone('stars-ca')
    }
  }, [conflicts, conflictAcks, ownership, myControllerId, vol])

  useEffect(() => () => stopAlertTone('stars-ca'), [])
}
