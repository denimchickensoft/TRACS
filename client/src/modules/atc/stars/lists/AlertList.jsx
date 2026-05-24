import { useDisplayStore } from '../../../../store/display.js'
import { useOdsStore }     from '../../../../store/ods.js'
import { ListPanel }       from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

/**
 * CA/MCI/LA alert list.
 * Conflict detection is not yet implemented — this renders the shell
 * and will populate once alert state is added to the atc store.
 */
export function AlertList() {
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.alert ?? { visible: true, xPct: 78, yPct: 25, lines: 5 }
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  // TODO: populate from atc store conflict/MSAW state
  const rows = []

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
