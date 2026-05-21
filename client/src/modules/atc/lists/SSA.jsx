import { useState, useEffect, useRef } from 'react'
import { useSessionStore }  from '../../../store/session.js'
import { useDisplayStore }  from '../../../store/display.js'
import { useOdsStore }      from '../../../store/ods.js'
import { ListPanel }        from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

function formatMissionTime(totalSeconds) {
  const s  = Math.floor(totalSeconds) % 86400
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}${mm}/${ss}`
}

export function SSA() {
  const connected      = useSessionStore((s) => s.connected)
  const facilityId     = useSessionStore((s) => s.facilityId)
  const mission        = useSessionStore((s) => s.mission)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  // Sync point: mission time in seconds + real-world ms when we received it
  const syncRef = useRef(null)
  const [displayTime, setDisplayTime] = useState('--:--/--')

  // Re-sync whenever mission data arrives
  useEffect(() => {
    const t = mission?.mission?.dateAndTime?.time
    if (!t) return
    const missionSeconds = (t.h ?? 0) * 3600 + (t.m ?? 0) * 60 + (t.s ?? 0)
    syncRef.current = { missionSeconds, wallMs: Date.now() }
  }, [mission])

  // Tick every second, deriving time from sync point + wall-clock delta
  useEffect(() => {
    function tick() {
      if (!syncRef.current) { setDisplayTime('--:--/--'); return }
      const elapsed = (Date.now() - syncRef.current.wallMs) / 1000
      setDisplayTime(formatMissionTime(syncRef.current.missionSeconds + elapsed))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  if (!windowSettings || !activeProfile) return null

  const { rangeNm, ptlLength, qnh, lists, briteLst, csLists, tdmMode } = windowSettings
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

  const rows = [
    `${displayTime} ${qnhStr}`,
    statusLine,
    `${rangeNm}NM PTL: ${Number(ptlLength).toFixed(1)}`,
    `001 600 U 001 600 A`,
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
