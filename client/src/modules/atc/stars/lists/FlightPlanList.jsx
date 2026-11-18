import { useFlightPlansStore } from '../../../../store/flightPlans.js'
import { useShallow }          from 'zustand/react/shallow'
import { useAssociationStore } from '../../../../store/association.js'
import { useDisplayStore, DEFAULT_LISTS } from '../../../../store/display.js'
import { useOdsStore }         from '../../../../store/ods.js'
import { ListPanel }           from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

export function FlightPlanList() {
  const plans          = useFlightPlansStore((s) => s.plans)
  const associated     = useAssociationStore(useShallow((s) => s.associated))
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.tab ?? DEFAULT_LISTS.tab
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  // Unassociated IFR plans only, sorted by callsign
  // Bound = associated with a contact, or tied to one by an FPE save.
  const bound = new Set(Object.values(associated))
  for (const p of Object.values(plans)) if (p.unitId != null) bound.add(p.aid)
  const rows = Object.values(plans)
    .filter((p) => !bound.has(p.aid) && p.flightRules === 'IFR')
    .sort((a, b) => a.aid.localeCompare(b.aid))
    .map((p) => {
      const bcn = p.bcn ? p.bcn.padStart(4, '0') : '----'
      return `${p.aid.padEnd(10)} ${bcn}`
    })

  return (
    <ListPanel
      title="FLIGHT PLAN"
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
