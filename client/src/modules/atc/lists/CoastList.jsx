import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { useDisplayStore }     from '../../../store/display.js'
import { useOdsStore }         from '../../../store/ods.js'
import { ListPanel }           from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

export function CoastList() {
  const plans          = useFlightPlansStore((s) => s.plans)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.coast ?? { visible: false, xPct: 78, yPct: 65, lines: 5 }
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const rows = Object.values(plans)
    .filter((p) => p.suspended)
    .sort((a, b) => (a.suspendIndex ?? 0) - (b.suspendIndex ?? 0))
    .map((p) => {
      const bcn = p.bcn ? p.bcn.padStart(4, '0') : '----'
      const idx = p.suspendIndex != null ? String(p.suspendIndex).padStart(2, '0') : '--'
      return `${p.aid.padEnd(10)} C ${bcn} ${idx}`
    })

  return (
    <ListPanel
      title="COAST/SUS"
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
