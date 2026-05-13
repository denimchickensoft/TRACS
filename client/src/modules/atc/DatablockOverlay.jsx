import { memo, useMemo, useState, useEffect } from 'react'
import { useAtcStore }         from '../../store/atc.js'
import { useSessionStore }     from '../../store/session.js'
import { useControllersStore } from '../../store/controllers.js'
import { useDisplayStore }     from '../../store/display.js'
import { useFlightPlansStore } from '../../store/flightPlans.js'
import { useOdsStore }         from '../../store/ods.js'
import { latLngToCanvas }      from './canvas/projection.js'
import { resolveCallsign }     from '../../utils/callsign.js'
import { DIR_TO_ANGLE, RIGHT_ALIGN_ANGLES } from './constants.js'

const WINDOW_ID        = 'atc-main'
const M_PER_S_TO_KNOTS = 1.94384
const METERS_TO_FEET   = 3.28084

const DEFAULT_SEQUENCE  = [1, 2, 1, 3]
const DEFAULT_INTERVALS = [2, 2, 2, 2]

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtAlt(metres) {
  if (metres == null) return '   '
  const hundreds = Math.round(metres * METERS_TO_FEET / 100)
  return String(hundreds).padStart(3, '0')
}

function fmtSpd(mps) {
  if (mps == null) return '  '
  const kt = Math.round(mps * M_PER_S_TO_KNOTS / 10)
  return String(Math.min(kt, 99)).padStart(2, '0')
}

// ── Clock phase ──────────────────────────────────────────────────────────────

function getClockPhase(sequence, intervals) {
  const totalMs = intervals.reduce((acc, d) => acc + d * 1000, 0)
  if (totalMs <= 0) return 1
  const posMs = Date.now() % totalMs
  let elapsed = 0
  for (let i = 0; i < intervals.length; i++) {
    elapsed += intervals[i] * 1000
    if (posMs < elapsed) return sequence[i]
  }
  return sequence[0]
}

// ── Datablock type ───────────────────────────────────────────────────────────

function resolveDbType(uid, ownership, handoffs, pointOuts, quickLook, displayFdb, myId) {
  const owner = ownership[uid]
  if (!owner) return 'LDB'
  if (owner === myId) return 'FDB'
  if (handoffs[uid]?.to === myId) return 'FDB'
  if (displayFdb[uid]) return 'FDB'
  if (pointOuts[uid]?.to === myId) return 'FDB'
  if (quickLook.has(uid)) return 'FDB'
  return 'PDB'
}

// ── Handoff indicator ────────────────────────────────────────────────────────

function idLetter(id) {
  return id?.match(/[A-Z]/)?.[0] ?? '?'
}

function resolveHandoffId(uid, handoffs, myId) {
  const ho = handoffs[uid]
  if (!ho) return ' '
  if (ho.to === myId && ho.from) return idLetter(ho.from)
  if (ho.from === myId && ho.to) return idLetter(ho.to)
  return ' '
}

// ── Line 2 content ───────────────────────────────────────────────────────────
// Returns a single string: "[left 4 chars] [right 2-4 chars]"
// Left: altitude (3) + handoffId (1); phases 2-3 swap in scratchpad if set.
// Right: GS (2); phases 2-3 swap in actype if set.
// Empty substitution: if the phase-specific data is absent, falls back to the
// phase-1 value — the field never goes blank.

function computeLine2(phase, alt, sp1, handoffId, gs, actype) {
  const hid    = handoffId
  const sp1Set = sp1 && sp1.trim() !== ''
  const acSet  = actype && actype.trim() !== ''

  const left  = (phase === 1 || !sp1Set) ? (alt + hid) : (sp1.slice(0, 3).padEnd(3) + hid)
  const right = (phase === 1 || !acSet)  ? gs           : actype.slice(0, 4)

  return left + ' ' + right.padStart(4)
}

// ── Per-unit datablock ───────────────────────────────────────────────────────

const Datablock = memo(function Datablock({
  id, unit, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks,
  ownership, handoffs, pointOuts, quickLook, displayFdb, scratchpads,
  myId, unitLeaderDir, globalLeaderDir,
  clockPhase, actype, slewed, isBlinking, blinkOn,
}) {
  const pos = unit.position
  if (!pos) return null

  const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
  if (x < -100 || x > view.width + 100 || y < -100 || y > view.height + 100) return null

  const uid = String(id)
  const { colors, symbol, dataBlock } = visual

  // ── Leader geometry ─────────────────────────────────────────────────
  const dir = unitLeaderDir ?? globalLeaderDir ?? null
  const angleDeg = dir != null
    ? (DIR_TO_ANGLE[dir] ?? (ldrAngleDeg ?? dataBlock.leaderAngleDeg ?? -45))
    : (ldrAngleDeg ?? dataBlock.leaderAngleDeg ?? -45)

  const leaderLen   = ldrLength ?? dataBlock.leaderLength ?? 40
  const leaderAngle = angleDeg * Math.PI / 180
  const symR        = (symbol.diameter ?? 13) / 2
  const fontPx      = 10 + (csDatablocks ?? 3) * 2
  const lh          = dataBlock.lineHeight ?? Math.round(fontPx * 1.2)
  const font        = `500 ${fontPx}px "Roboto Mono", monospace`

  const lx0 = x + Math.cos(leaderAngle) * symR
  const ly0 = y + Math.sin(leaderAngle) * symR
  const textDist = Math.max(leaderLen, symR)
  const lx1 = x + Math.cos(leaderAngle) * textDist
  const ly1 = y + Math.sin(leaderAngle) * textDist

  const rightAlign = RIGHT_ALIGN_ANGLES.has(angleDeg)
  const tx     = rightAlign ? lx1 - 2 : lx1 + 2
  const anchor = rightAlign ? 'end' : 'start'
  const style  = { font, dominantBaseline: 'alphabetic' }

  // ── Data ────────────────────────────────────────────────────────────
  const dbType    = resolveDbType(uid, ownership, handoffs, pointOuts, quickLook, displayFdb, myId)
  const alt       = fmtAlt(pos.alt)
  const gs        = fmtSpd(unit.speed)
  const sp1       = scratchpads[uid]?.sp1 ?? ''
  const handoffId = resolveHandoffId(uid, handoffs, myId)
  const cs        = resolveCallsign(unit).toUpperCase()
  const poActive  = pointOuts[uid]?.to === myId
  const line2     = computeLine2(clockPhase, alt, sp1, handoffId, gs, actype ?? '')

  const leader = leaderLen > 0
    ? <line x1={lx0} y1={ly0} x2={lx1} y2={ly1} stroke={colors.leaderLine} strokeWidth={0.8} />
    : null

  // ── LDB ─────────────────────────────────────────────────────────────
  if (dbType === 'LDB') {
    return (
      <g>
        {leader}
        <text x={tx} y={ly1} fill={colors.ldbText} opacity={briteLdb} textAnchor={anchor} style={style}>
          {`${alt} ${gs}`}
        </text>
      </g>
    )
  }

  // ── PDB ─────────────────────────────────────────────────────────────
  // Unslewed: leader attaches at the data line (single line).
  // Slewed: leader attaches at ACID line; data line drops below — same layout as FDB.
  if (dbType === 'PDB') {
    if (slewed) {
      return (
        <g>
          {leader}
          <text x={tx} y={ly1}      fill={colors.pdbText} opacity={briteLdb} textAnchor={anchor} style={style}>
            {cs}
          </text>
          <text x={tx} y={ly1 + lh} fill={colors.pdbText} opacity={briteLdb} textAnchor={anchor} style={style}>
            {line2}
          </text>
        </g>
      )
    }
    return (
      <g>
        {leader}
        <text x={tx} y={ly1} fill={colors.pdbText} opacity={briteLdb} textAnchor={anchor} style={style}>
          {line2}
        </text>
      </g>
    )
  }

  // ── FDB ─────────────────────────────────────────────────────────────
  // Leader attaches at the ACID line. Data line is one line below.
  // Blink states: incoming HO (continuous) or post-acceptance on sender (5s).
  // Both blink between white and light gray — never go invisible.
  const isIncomingHo = handoffs[uid]?.to === myId
  const shouldBlink  = isBlinking || isIncomingHo
  const fdbColor     = shouldBlink ? (blinkOn ? '#FFFFFF' : '#C0C0C0') : colors.fdbText
  const acidLine     = poActive ? cs + ' PO' : cs
  return (
    <g>
      {leader}
      <text x={tx} y={ly1}      fill={fdbColor} opacity={briteFdb} textAnchor={anchor} style={style}>
        {acidLine}
      </text>
      <text x={tx} y={ly1 + lh} fill={fdbColor} opacity={briteFdb} textAnchor={anchor} style={style}>
        {line2}
      </text>
    </g>
  )
})

// ── Overlay ──────────────────────────────────────────────────────────────────

export function DatablockOverlay({ units, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks, slewedPdbs, blinkOn }) {
  const ownership   = useAtcStore((s) => s.ownership)
  const handoffs    = useAtcStore((s) => s.handoffs)
  const pointOuts   = useAtcStore((s) => s.pointOuts)
  const quickLook   = useAtcStore((s) => s.quickLook)
  const displayFdb  = useAtcStore((s) => s.displayFdb)
  const scratchpads = useAtcStore((s) => s.scratchpads)
  const blinkTracks = useAtcStore((s) => s.blinkTracks)

  const positionName    = useSessionStore((s) => s.positionName)
  const myId            = useControllersStore((s) => s.registry[positionName]?.controllerId ?? null)

  const leaderDirs      = useDisplayStore((s) => s.windows[WINDOW_ID]?.leaderDirs      ?? {})
  const globalLeaderDir = useDisplayStore((s) => s.windows[WINDOW_ID]?.globalLeaderDir ?? null)

  const plans = useFlightPlansStore((s) => s.plans)
  const plansByUnit = useMemo(() => {
    const map = {}
    for (const p of Object.values(plans)) {
      if (p.unitId != null) map[String(p.unitId)] = p
    }
    return map
  }, [plans])

  const clockSeq  = useOdsStore((s) => s.activeProfile?.datablocks?.clockPhase?.sequence  ?? DEFAULT_SEQUENCE)
  const clockInts = useOdsStore((s) => s.activeProfile?.datablocks?.clockPhase?.intervals ?? DEFAULT_INTERVALS)

  // Tick every 200ms so clock phase stays current
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 200)
    return () => clearInterval(id)
  }, [])

  const clockPhase = getClockPhase(clockSeq, clockInts)
  const now        = Date.now()

  const entries = useMemo(() => Object.entries(units), [units])

  if (!view) return null

  return (
    <svg
      className="atc-layer"
      style={{ pointerEvents: 'none' }}
      width={view.width}
      height={view.height}
    >
      {entries.map(([id, unit]) => (
        <Datablock
          key={id}
          id={id}
          unit={unit}
          view={view}
          visual={visual}
          ldrLength={ldrLength}
          ldrAngleDeg={ldrAngleDeg}
          briteFdb={briteFdb}
          briteLdb={briteLdb}
          csDatablocks={csDatablocks}
          ownership={ownership}
          handoffs={handoffs}
          pointOuts={pointOuts}
          quickLook={quickLook}
          displayFdb={displayFdb}
          scratchpads={scratchpads}
          myId={myId}
          unitLeaderDir={leaderDirs[String(id)] ?? null}
          globalLeaderDir={globalLeaderDir}
          clockPhase={clockPhase}
          actype={plansByUnit[String(id)]?.typ ?? ''}
          slewed={slewedPdbs?.has(String(id)) ?? false}
          isBlinking={!!blinkTracks[String(id)] && now < blinkTracks[String(id)]}
          blinkOn={blinkOn}
        />
      ))}
    </svg>
  )
}
