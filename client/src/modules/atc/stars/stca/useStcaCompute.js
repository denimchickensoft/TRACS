import { useEffect, useRef } from 'react'
import { useUnitsStore }   from '../../../../store/units.js'
import { useAtcStore }     from '../../../../store/atc.js'
import { useDisplayStore } from '../../../../store/display.js'
import { useStcaStore }    from '../../../../store/stca.js'
import { useFlightPlansStore } from '../../../../store/flightPlans.js'
import { useAssociationStore } from '../../../../store/association.js'
import { useStarsAlertsStore } from '../../../../store/starsAlerts.js'
import { caDisabledFor, mciSuppressedFor } from '../../../../utils/conflictInhibit.js'
import { sendWebrtcEvent } from '../../../../webrtc/client.js'
import { plansByUnit } from '../alerts/useStarsAlerts.js'
import { computeConflicts } from './computeConflicts.js'
import { buildSuppressionZones, isSuppressed } from './suppressionZones.js'
import { resolvePrimaryOnlyIds } from './formations.js'
import { startAlertTone, stopAlertTone } from '../../../../audio/alertTone.js'

const WINDOW_ID     = 'atc-main'
const STCA_TICK_MS  = 1000
// A new conflict's tone sounds for this long, or until acknowledged
const CA_TONE_MS    = 5000

// CA K / CA M set on a track before it had a flight plan move onto the plan
// once one is bound, so they're shared and follow the track through
// handoffs like any other plan setting.
function carryConflictInhibitsToPlans(planOf) {
  const atc    = useAtcStore.getState()
  const alerts = useStarsAlertsStore.getState()
  const fps    = useFlightPlansStore.getState()
  const amend = (plan, patch) => {
    fps.update(plan.aid, patch)
    sendWebrtcEvent('FLIGHT_PLAN_AMEND', useFlightPlansStore.getState().plans[plan.aid])
  }
  for (const uid of Object.keys(atc.caInhibited)) {
    const plan = planOf[uid]
    if (!plan) continue
    if (!plan.caDisabled) amend(plan, { caDisabled: true, mciSuppressedCode: '' })
    atc.toggleCaInhibit(uid)
  }
  for (const [uid, code] of Object.entries(alerts.trackMciSuppressed)) {
    const plan = planOf[uid]
    if (!plan) continue
    if (plan.mciSuppressedCode !== code) amend(plan, { mciSuppressedCode: code, caDisabled: false })
    alerts.setTrackMciSuppressed(uid, '')
  }
}

/**
 * StarsScope's conflict alert compute loop + alert tone. Opt-in
 * (.CA / starsPrefs.stcaEnabled) — see stca/computeConflicts.js. Runs on its
 * own ~1s interval (independent of the 200ms blink tick) to bound cost;
 * reads fresh store state each tick rather than closing over reactive
 * props, since the interval callback outlives any single render.
 */
export function useStcaTracker({ visibleUnitsRef, centerlines, conflicts, conflictAcks, ownership, myControllerId, vol, stcaEnabled, simWingmenStandby }) {
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
      const associated = useAssociationStore.getState().associated
      carryConflictInhibitsToPlans(plansByUnit(useFlightPlansStore.getState().plans, associated))
      const planOf      = plansByUnit(useFlightPlansStore.getState().plans, associated)
      const caInhibited = useAtcStore.getState().caInhibited
      const trackMci    = useStarsAlertsStore.getState().trackMciSuppressed
      const result = computeConflicts({
        units:             visibleUnitsRef.current ?? {},
        isAssociated:      (uid) => !!planOf[uid] || liveOwnership[uid] !== undefined,
        caDisabled:        (uid) => caDisabledFor(planOf[uid], caInhibited[uid]),
        mciSuppressedCode: (uid) => mciSuppressedFor(planOf[uid], trackMci[uid]),
        suppressionZones:  zones,
        isSuppressed,
        wingmanIds:        liveWingmen,
        latched:           latchedRef.current,
      })
      useStcaStore.getState().setConflicts(result)
      useAtcStore.getState().pruneConflictAcks(result.map((c) => c.id))
    }
    tick()
    const id = setInterval(tick, STCA_TICK_MS)
    return () => clearInterval(id)
  }, [stcaEnabled, simWingmenStandby, centerlines, visibleUnitsRef])

  // ── Conflict alert tone ──────────────────────────────────────────────
  // Sector-specific: only sounds on a window whose controller owns unit A
  // or B, for CA_TONE_MS from the conflict's start or until acknowledged.
  // The conflicts list is rewritten every tick, so this re-checks each second.
  useEffect(() => {
    const now = Date.now()
    const hasUnacked = conflicts.some((c) =>
      !conflictAcks[c.id] && now < c.start + CA_TONE_MS &&
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
