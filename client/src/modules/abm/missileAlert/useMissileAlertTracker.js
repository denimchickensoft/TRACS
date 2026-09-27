import { useEffect, useRef } from 'react'
import { startAlertTone, stopAlertTone } from '../../../audio/alertTone.js'
import { trueDeclaration } from '../../../utils/tacticalHelpers.js'
import { DECLARATION } from '../../../utils/createDeclarationStore.js'
import { useAbmMissileAlertStore } from '../../../store/abmMissileAlert.js'

const CHANNEL   = 'abm-missile-launch'
const FREQUENCY = 700 // Hz — distinct from STARS' 950Hz CA tone

/**
 * Detection + audio for ABM's enemy missile-launch alert. `isOwner` must be
 * true for exactly one open ABM window (AbmScope.jsx gates this on
 * `windowId === DEFAULT_windowId`) — a popped-out focus window
 * (AbmFocusWindow.jsx, via window.open()) is a genuinely separate renderer
 * with its own AudioContext, so if every window ran this independently, a
 * focus panel opened during an active alert would sound a second,
 * uncoordinated tone. Non-owner windows still see the alert (blink,
 * click-to-dismiss) by reading useAbmMissileAlertStore directly themselves —
 * this hook is always called (never conditionally, to respect the rules of
 * hooks) but no-ops internally when !isOwner.
 *
 * "Launch" = a hostile missile id newly appearing in visibleMissiles — ABM's
 * fog-of-war pipeline (utils/tacticalHelpers.js's getVisibleMissiles) already
 * gates enemy-weapon visibility on independent AWACS/EWR detection, so a
 * weapon appearing here already IS the detection event.
 *
 * An alert stays active until the missile leaves visibleMissiles
 * (impact/expiry/lost detection) or is dismissed by clicking its symbol on
 * any window (useAbmMissileAlertStore's dismiss()). `enabled` (.malert)
 * gates whether anything is tracked/sounded at all; `vol` (.vol, 0-10) only
 * scales the tone's gain.
 */
export function useMissileAlertTracker({ visibleMissiles, myCoalitionNum, enabled, vol, isOwner }) {
  const prevIdsRef = useRef(new Set())

  // Detection — reads the shared store's CURRENT value fresh each tick
  // (not a locally-cached copy) so a dismiss from another window isn't
  // clobbered by this window's own stale idea of what's active.
  useEffect(() => {
    if (!isOwner) return

    if (!enabled) {
      prevIdsRef.current = new Set()
      useAbmMissileAlertStore.getState().clear()
      return
    }

    const currentIds = new Set(Object.keys(visibleMissiles))
    const shared      = useAbmMissileAlertStore.getState().activeIds
    const next        = {}

    // Keep any still-visible active alert; one dropped from visibleMissiles
    // (impact/expiry/lost detection) or already dismissed simply isn't here.
    for (const id of Object.keys(shared)) {
      if (currentIds.has(id)) next[id] = true
    }
    // Newly-visible enemy missiles start a new alert.
    for (const id of currentIds) {
      if (prevIdsRef.current.has(id)) continue
      if (trueDeclaration(visibleMissiles[id], myCoalitionNum) === DECLARATION.HOSTILE) next[id] = true
    }

    useAbmMissileAlertStore.getState().setActiveIds(next)
    prevIdsRef.current = currentIds
  }, [visibleMissiles, myCoalitionNum, enabled, isOwner])

  // Audio — reacts instantly to the shared store (including a dismiss-click
  // fired from another window), decoupled from the detection tick above so
  // a dismiss doesn't wait for the next visibleMissiles poll to go quiet.
  const activeIds = useAbmMissileAlertStore((s) => s.activeIds)
  useEffect(() => {
    if (!isOwner) return
    if (enabled && Object.keys(activeIds).length > 0) {
      startAlertTone(CHANNEL, { frequency: FREQUENCY, getVolume: () => vol / 10 })
    } else {
      stopAlertTone(CHANNEL)
    }
  }, [activeIds, enabled, vol, isOwner])

  useEffect(() => {
    if (!isOwner) return
    return () => stopAlertTone(CHANNEL)
  }, [isOwner])
}
