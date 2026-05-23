import { useSessionStore }     from '../../store/session.js'
import { useStatusBoardStore } from '../../store/statusBoard.js'
import { useMissionClock }     from '../../utils/useMissionClock.js'

const SEP = ' - '

export function CatccStatusText({ xPct, yPct, brc, fb, tacticalName }) {
  const { timeStr, dateStr } = useMissionClock()

  const positionTypeName = useSessionStore((s) => s.positionTypeName)
  const positionSuffix   = useSessionStore((s) => s.positionSuffix)

  const clg          = useStatusBoardStore((s) => s.clg)
  const vis          = useStatusBoardStore((s) => s.vis)
  const qnh          = useStatusBoardStore((s) => s.qnh)
  const caseLaunch   = useStatusBoardStore((s) => s.caseLaunch)
  const caseRecovery = useStatusBoardStore((s) => s.caseRecovery)
  const app          = useStatusBoardStore((s) => s.app)
  const twrBtn       = useStatusBoardStore((s) => s.twrBtn)
  const depBtn       = useStatusBoardStore((s) => s.depBtn)
  const rad          = useStatusBoardStore((s) => s.rad)

  const lines = []

  // Line 1: time + date
  const timePart = timeStr ?? '----Z'
  lines.push([timePart, dateStr].filter(Boolean).join(SEP))

  // Line 2: position callsign (tactical carrier name + position type)
  const callsign = [tacticalName, positionTypeName].filter(Boolean).join(' ')
  if (callsign) lines.push(callsign)

  // Line 3: weather
  const wx = []
  if (clg) wx.push(`CLG ${clg}`)
  if (vis) wx.push(`VIS ${vis}`)
  if (qnh) wx.push(`ALT ${qnh}`)
  if (wx.length) lines.push(wx.join(SEP))

  // Line 4: case recovery + departure
  const cases = []
  if (caseRecovery) cases.push(`CASE ${caseRecovery} REC`)
  if (caseLaunch)   cases.push(`CASE ${caseLaunch} DEP`)
  if (cases.length) lines.push(cases.join(SEP))

  // Line 5: recovery-dependent fields + position-based frequency
  const recCase = parseInt(caseRecovery, 10)
  if (!isNaN(recCase)) {
    const brcStr = brc != null ? String(Math.round(brc)).padStart(3, '0') : '---'
    const fbStr  = fb  != null ? String(Math.round(fb)).padStart(3, '0')  : '---'
    const radStr = rad || '---'

    const suffix = positionSuffix?.toUpperCase()
    let freqLabel = null
    let freqVal   = null
    if (suffix === 'MAR') { freqLabel = 'APP'; freqVal = app    }
    if (suffix === 'APP') { freqLabel = 'TWR'; freqVal = twrBtn }
    if (suffix === 'TWR') { freqLabel = 'DEP'; freqVal = depBtn }

    const navParts = recCase === 3
      ? [`RAD ${radStr}`, `FB ${fbStr}`]
      : [`BRC ${brcStr}`]
    if (freqLabel && freqVal) navParts.push(`${freqLabel} BTN ${freqVal}`)
    lines.push(navParts.join(SEP))
  }

  return (
    <div
      className="catcc-status-text"
      style={{ left: `${xPct}%`, top: `${yPct}%` }}
    >
      {lines.map((line, i) => (
        <div key={i}>{line.toUpperCase()}</div>
      ))}
    </div>
  )
}
