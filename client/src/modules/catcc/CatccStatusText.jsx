import { useSessionStore }     from '../../store/session.js'
import { useStatusBoardStore } from '../../store/statusBoard.js'
import { useMissionClock }     from '../../utils/useMissionClock.js'
import { effectiveRad, formatEat, isMarshalCase, appRadOf, btnOf, caseBtn } from './statusBoardColumns.js'

const SEP = ' - '

export function CatccStatusText({ xPct, yPct, brc, fb, tacticalName }) {
  const { timeStr, dateStr } = useMissionClock()

  const positionTypeName = useSessionStore((s) => s.positionTypeName)

  const qnh          = useStatusBoardStore((s) => s.qnh)
  const caseRecovery = useStatusBoardStore((s) => s.caseRecovery)
  const cvApp        = useStatusBoardStore((s) => s.cvApp)
  const rad          = useStatusBoardStore((s) => s.rad)
  const appBtn       = useStatusBoardStore((s) => s.app)
  const twrBtn       = useStatusBoardStore((s) => s.twrBtn)
  const focused      = useStatusBoardStore((s) => (s.focusId == null ? null : s.entries.find((e) => e.id === s.focusId) ?? null))

  const lines = []
  const deg3 = (v) => (v != null ? String(Math.round(v)).padStart(3, '0') : '---')

  // Line 1: time + date, plus the side number of the row whose green SIDE was
  // double-clicked, so the DME/ANG/EAT lines below say whose they are
  const timePart = timeStr ?? '----Z'
  lines.push([timePart, dateStr, focused?.sideNumber].filter(Boolean).join(SEP))

  // Line 2: position callsign (tactical carrier name + position type)
  const callsign = [tacticalName, positionTypeName].filter(Boolean).join(' ')
  if (callsign) lines.push(callsign)

  const recCase = parseInt(caseRecovery, 10)
  const marshal = isMarshalCase(caseRecovery)
  if (!isNaN(recCase)) {
    // Line 3: recovery case, plus the CV approach once aircraft use the marshal stack
    const caseParts = [`CASE ${caseRecovery} REC`]
    if (marshal && cvApp) caseParts.push(`CV ${cvApp} APP`)
    lines.push(caseParts.join(SEP))
  }

  // Line 4: the course aircraft fly, BRC visually (CASE 1/2) or FB on
  // instruments (CASE 3), and the altimeter
  const courseParts = []
  if (!isNaN(recCase)) courseParts.push(recCase === 3 ? `FB ${deg3(fb)}` : `BRC ${deg3(brc)}`)
  if (qnh) courseParts.push(`ALT ${qnh}`)
  if (courseParts.length) lines.push(courseParts.join(SEP))

  // Lines 5-6 (CASE 2/3): the marshal radial, then the radio button (CASE 3).
  // With an aircraft selected (its green SIDE or its contact double-clicked),
  // RAD and BTN are that aircraft's, and DME, ANGELS and EAT are added.
  if (marshal) {
    const boardRad = effectiveRad(rad, fb)
    const navParts = [`RAD ${(focused ? appRadOf(focused, boardRad) : boardRad) || '---'}`]
    if (focused?.dme)    navParts.push(`DME ${focused.dme}`)
    if (focused?.angels) navParts.push(`ANG ${focused.angels}`)
    lines.push(navParts.join(SEP))

    const eatParts = []
    if (focused?.eat)            eatParts.push(`EAT ${formatEat(focused.eat)}`)
    const boardBtn = caseBtn(caseRecovery, twrBtn, appBtn)
    const btn      = focused ? btnOf(focused, boardBtn) : boardBtn
    if (recCase === 3 && btn) eatParts.push(`BTN ${btn}`)
    if (eatParts.length) lines.push(eatParts.join(SEP))
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
