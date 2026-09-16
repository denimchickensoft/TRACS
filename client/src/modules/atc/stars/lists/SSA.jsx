import { useSessionStore }  from '../../../../store/session.js'
import { useDisplayStore }  from '../../../../store/display.js'
import { useOdsStore }      from '../../../../store/ods.js'
import { useMissionClock }  from '../../../../utils/useMissionClock.js'
import { ListPanel }        from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

function formatMissionTime(totalSeconds) {
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const ss = String(totalSeconds % 60).padStart(2, '0')
  return `${hh}${mm}/${ss}`
}

export function SSA() {
  const connected      = useSessionStore((s) => s.connected)
  const facilityId     = useSessionStore((s) => s.facilityId)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  // STARS SSA time is always UTC — real ATC scopes never show theatre-local time.
  const { utcSeconds } = useMissionClock()
  const displayTime = utcSeconds == null ? '--:--/--' : formatMissionTime(utcSeconds)

  if (!windowSettings || !activeProfile) return null

  const {
    rangeNm, ptlLength, qnh, atis, giText, lists, briteLst, csLists, tdmMode,
    altFilterLowU, altFilterHighU, altFilterLowA, altFilterHighA,
  } = windowSettings
  const pos    = lists?.ssa ?? { xPct: 2, yPct: 2 }
  const brite  = (briteLst ?? 80) / 100
  const color  = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const qnhStr = qnh ?? '29.92'

  const statusBase = connected ? 'OK/OK/NA' : 'NA/NA/NA'
  const statusLine = (
    <>
      <span style={{ color: connected ? color : '#ff3333' }}>{statusBase} </span>
      <span style={{ color }}>{`FUSED${tdmMode ? ' TDM' : ''}`}</span>
    </>
  )

  const pad3 = (n) => String(n ?? 0).padStart(3, '0')
  const altFilterLine =
    `${pad3(altFilterLowU)} ${pad3(altFilterHighU)} U ${pad3(altFilterLowA)} ${pad3(altFilterHighA)} A`

  const rows = [
    `${displayTime} ${qnhStr}`,
    ...(atis || giText ? [`${atis ?? ''} ${giText ?? ''}`] : []),
    statusLine,
    `${rangeNm}NM PTL: ${Number(ptlLength).toFixed(1)}`,
    altFilterLine,
    `${facilityId || '----'} ${qnhStr}`,
  ]

  return (
    <ListPanel
      rows={rows}
      xPct={pos.xPct}
      yPct={pos.yPct}
      maxLines={rows.length}
      brite={brite}
      csLists={csLists}
      color={color}
    />
  )
}
