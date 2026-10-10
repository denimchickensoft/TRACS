import { useFlightPlansStore } from '../../../../store/flightPlans.js'
import { useUnitsStore }       from '../../../../store/units.js'
import { useStarsAlertsStore } from '../../../../store/starsAlerts.js'
import { useDisplayStore, DEFAULT_LISTS } from '../../../../store/display.js'
import { useOdsStore }         from '../../../../store/ods.js'
import { resolveCallsign }     from '../../../../utils/callsign.js'
import { ListPanel }           from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

/**
 * MCI suppression list (MULTI FUNC TQ): every flight with an MCI-suppressed
 * beacon code (CA M), from flight plans and from tracks with no plan.
 */
export function MciSuppressionList() {
  const plans          = useFlightPlansStore((s) => s.plans)
  const units          = useUnitsStore((s) => s.units)
  const trackSuppressed = useStarsAlertsStore((s) => s.trackMciSuppressed)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  // Merged over the default: a window saved before this list existed, or one
  // where it was only relocated, has a partial entry
  const cfg = { ...DEFAULT_LISTS.mciSuppression, ...lists?.mciSuppression }
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const rows = [
    ...Object.values(plans)
      .filter((p) => p.mciSuppressedCode)
      .map((p) => `${p.aid.padEnd(10)} ${p.mciSuppressedCode}`),
    ...Object.entries(trackSuppressed)
      .filter(([uid]) => units[uid])
      .map(([uid, code]) => `${resolveCallsign(units[uid]).toUpperCase().padEnd(10)} ${code}`),
  ].sort()

  return (
    <ListPanel
      title="MCI SUPPRESSION"
      rows={rows}
      xPct={cfg.xPct}
      yPct={cfg.yPct}
      maxLines={cfg.lines ?? 5}
      brite={brite}
      csLists={csLists}
      color={color}
    />
  )
}
