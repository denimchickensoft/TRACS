import { useSessionStore }    from '../../../store/session.js'
import { useDisplayStore }    from '../../../store/display.js'
import { useOdsStore }        from '../../../store/ods.js'
import { useControllersStore } from '../../../store/controllers.js'
import { ListPanel }           from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

function formatSignOnTime(ms) {
  if (!ms) return '----'
  const d  = new Date(ms)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}${mm}`
}

export function SignOnList() {
  const positionName   = useSessionStore((s) => s.positionName)
  const signOnTime     = useSessionStore((s) => s.signOnTime)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)
  const getEntry       = useControllersStore((s) => s.getEntry)

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg   = lists?.signOn ?? { visible: true, xPct: 88, yPct: 88 }
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const entry        = positionName ? getEntry(positionName) : null
  const displayId    = entry?.controllerId ?? positionName
  const rows = displayId
    ? [`${displayId} ${formatSignOnTime(signOnTime)}`]
    : []

  return (
    <ListPanel
      title={null}
      rows={rows}
      xPct={cfg.xPct}
      yPct={cfg.yPct}
      maxLines={1}
      brite={brite}
      csLists={csLists}
      color={color}
    />
  )
}
