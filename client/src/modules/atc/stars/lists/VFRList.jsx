import { useFlightPlansStore } from '../../../../store/flightPlans.js'
import { useDisplayStore, DEFAULT_LISTS } from '../../../../store/display.js'
import { useOdsStore }         from '../../../../store/ods.js'
import { ListPanel }           from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

export function VFRList() {
  const plans          = useFlightPlansStore((s) => s.plans)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.vfr ?? DEFAULT_LISTS.vfr
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  // Unassociated VFR plans, sorted by first-seen (oldest first)
  const rows = Object.values(plans)
    .filter((p) => p.unitId === null && p.flightRules === 'VFR')
    .sort((a, b) => (a.firstSeen ?? 0) - (b.firstSeen ?? 0))
    .map((p) => {
      const bcn = p.bcn ? p.bcn.padStart(4, '0') : '----'
      return `${p.aid.padEnd(10)} ${bcn} VFR`
    })

  return (
    <ListPanel
      title="VFR"
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
