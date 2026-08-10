import { useDisplayStore } from '../../../../store/display.js'
import { useOdsStore }     from '../../../../store/ods.js'
import { useUnitsStore }   from '../../../../store/units.js'
import { useStcaStore }    from '../../../../store/stca.js'
import { resolveCallsign } from '../../../../utils/callsign.js'
import { ListPanel }       from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'
const PAIR_COL_WIDTH = 20 // chars — pads "CS1*CS2" before the CA/MCI type

/**
 * CA/MCI/LA alert list.
 * LA (MSAW) is not implemented — no low-altitude alerting exists yet.
 */
export function AlertList() {
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)
  const units          = useUnitsStore((s) => s.units)
  const conflicts       = useStcaStore((s) => s.conflicts)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.alert ?? { visible: true, xPct: 78, yPct: 25, lines: 5 }
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const rows = conflicts.map((c) => {
    const csA = units[c.unitAId] ? resolveCallsign(units[c.unitAId]).toUpperCase() : c.unitAId
    const csB = units[c.unitBId] ? resolveCallsign(units[c.unitBId]).toUpperCase() : c.unitBId
    const pair = `${csA}*${csB}`
    return pair.length >= PAIR_COL_WIDTH ? `${pair} ${c.type}` : pair.padEnd(PAIR_COL_WIDTH) + c.type
  })

  return (
    <ListPanel
      title="CA/MCI/LA"
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
