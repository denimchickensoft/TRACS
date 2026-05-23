import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/session.js'

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

export function useMissionClock() {
  const mission  = useSessionStore((s) => s.mission)
  const syncRef  = useRef(null)
  const [timeStr, setTimeStr] = useState(null)

  useEffect(() => {
    const t = mission?.mission?.dateAndTime?.time
    if (!t) { syncRef.current = null; return }
    syncRef.current = {
      missionSeconds: (t.h ?? 0) * 3600 + (t.m ?? 0) * 60 + (t.s ?? 0),
      wallMs: Date.now(),
    }
  }, [mission])

  useEffect(() => {
    function tick() {
      if (!syncRef.current) { setTimeStr(null); return }
      const elapsed = (Date.now() - syncRef.current.wallMs) / 1000
      const total   = Math.floor(syncRef.current.missionSeconds + elapsed) % 86400
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      setTimeStr(
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}Z`
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const rawDate = mission?.mission?.dateAndTime?.date ?? null
  const dateStr = rawDate
    ? `${String(rawDate.Day).padStart(2,'0')} ${MONTHS[rawDate.Month - 1]} ${rawDate.Year}`
    : null

  return { timeStr, dateStr }
}
