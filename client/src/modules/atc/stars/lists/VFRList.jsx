import { useFlightPlansStore } from '../../../../store/flightPlans.js'
import { useShallow }          from 'zustand/react/shallow'
import { useAssociationStore } from '../../../../store/association.js'
import { useDisplayStore, DEFAULT_LISTS } from '../../../../store/display.js'
import { useOdsStore }         from '../../../../store/ods.js'
import { ListPanel }           from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

export function VFRList() {
  const plans          = useFlightPlansStore((s) => s.plans)
  const associated     = useAssociationStore(useShallow((s) => s.associated))
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.vfr ?? DEFAULT_LISTS.vfr
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  // Unassociated VFR plans, sorted by first-seen (oldest first)
  // Bound = associated with a contact, or tied to one by an FPE save.
  const bound = new Set(Object.values(associated))
  for (const p of Object.values(plans)) if (p.unitId != null) bound.add(p.aid)
  const rows = Object.values(plans)
    .filter((p) => !bound.has(p.aid) && p.flightRules === 'VFR')
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
