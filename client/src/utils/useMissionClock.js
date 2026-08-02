import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../store/session.js'
import { toUtcDateTime, getTheatreUtcOffset } from './theatreTime.js'

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

function fmtDate(date) {
  return `${String(date.Day).padStart(2,'0')} ${MONTHS[date.Month - 1]} ${date.Year}`
}

export function useMissionClock() {
  const mission  = useSessionStore((s) => s.mission)
  const syncRef  = useRef(null)
  const [timeStr,      setTimeStr]      = useState(null)
  const [dateStr,      setDateStr]      = useState(null)
  const [localTimeStr, setLocalTimeStr] = useState(null)
  const [localDateStr, setLocalDateStr] = useState(null)
  const [utcSeconds,   setUtcSeconds]   = useState(null) // seconds since UTC midnight
  const [localSeconds, setLocalSeconds] = useState(null) // seconds since theatre-local midnight

  useEffect(() => {
    const t = mission?.mission?.dateAndTime?.time
    const d = mission?.mission?.dateAndTime?.date
    const theatre = mission?.mission?.theatre
    if (!t || !d) {
      syncRef.current = null
      setDateStr(null)
      setLocalDateStr(null)
      return
    }
    const utc = toUtcDateTime(d, t, theatre)
    syncRef.current = {
      missionSecondsUtc: utc.time.h * 3600 + utc.time.m * 60 + utc.time.s,
      offsetSeconds: getTheatreUtcOffset(theatre) * 3600,
      wallMs: Date.now(),
    }
    setDateStr(fmtDate(utc.date))
    setLocalDateStr(fmtDate(d))
  }, [mission])

  useEffect(() => {
    function tick() {
      if (!syncRef.current) {
        setTimeStr(null); setLocalTimeStr(null)
        setUtcSeconds(null); setLocalSeconds(null)
        return
      }
      const { missionSecondsUtc, offsetSeconds, wallMs } = syncRef.current
      const elapsed  = (Date.now() - wallMs) / 1000
      const totalUtc = Math.floor(missionSecondsUtc + elapsed) % 86400
      const totalLoc = ((totalUtc + offsetSeconds) % 86400 + 86400) % 86400
      const fmt = (total, suffix) => {
        const h = Math.floor(total / 3600)
        const m = Math.floor((total % 3600) / 60)
        const s = total % 60
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${suffix}`
      }
      setTimeStr(fmt(totalUtc, 'Z'))
      setLocalTimeStr(fmt(totalLoc, 'L'))
      setUtcSeconds(totalUtc)
      setLocalSeconds(totalLoc)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  return { timeStr, dateStr, localTimeStr, localDateStr, utcSeconds, localSeconds }
}
