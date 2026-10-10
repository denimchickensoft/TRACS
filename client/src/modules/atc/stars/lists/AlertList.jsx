import { useDisplayStore, DEFAULT_LISTS } from '../../../../store/display.js'
import { useOdsStore }     from '../../../../store/ods.js'
import { useUnitsStore }   from '../../../../store/units.js'
import { useStcaStore }    from '../../../../store/stca.js'
import { useStarsAlertsStore } from '../../../../store/starsAlerts.js'
import { resolveCallsign } from '../../../../utils/callsign.js'
import { ListPanel }       from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'
const PAIR_COL_WIDTH = 20 // chars — pads "CS1*CS2" before the CA/MCI type

/**
 * CA/MCI/LA alert list, oldest alert first; an inhibited MSAW alert drops off.
 */
export function AlertList() {
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)
  const units          = useUnitsStore((s) => s.units)
  const conflicts       = useStcaStore((s) => s.conflicts)
  const msaw            = useStarsAlertsStore((s) => s.msaw)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.alert ?? DEFAULT_LISTS.alert
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const fmt = (label, type) =>
    label.length >= PAIR_COL_WIDTH ? `${label} ${type}` : label.padEnd(PAIR_COL_WIDTH) + type
  const entries = conflicts.map((c) => {
    const csA = units[c.unitAId] ? resolveCallsign(units[c.unitAId]).toUpperCase() : c.unitAId
    const csB = units[c.unitBId] ? resolveCallsign(units[c.unitBId]).toUpperCase() : c.unitBId
    return { start: c.start ?? 0, text: fmt(`${csA}*${csB}`, c.type) }
  })
  for (const [uid, a] of Object.entries(msaw)) {
    if (!a.active || a.inhibit || !units[uid]) continue
    entries.push({ start: a.start, text: fmt(resolveCallsign(units[uid]).toUpperCase(), 'LA') })
  }
  // Oldest alert first
  const rows = entries.sort((x, y) => x.start - y.start).map((e) => e.text)

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
