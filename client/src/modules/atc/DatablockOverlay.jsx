import { memo, useMemo } from 'react'
import { useAtcStore }     from '../../store/atc.js'
import { useSessionStore } from '../../store/session.js'
import { latLngToCanvas }  from './canvas/projection.js'
import { resolveCallsign } from '../../utils/callsign.js'

const M_PER_S_TO_KNOTS = 1.94384
const METERS_TO_FEET   = 3.28084

function fmtAlt(metres) {
  if (metres == null) return '---'
  const hundreds = Math.round(metres * METERS_TO_FEET / 100)
  return String(hundreds).padStart(3, '0')
}

function fmtSpd(mps) {
  if (mps == null) return '--'
  const kt = Math.round(mps * M_PER_S_TO_KNOTS / 10)
  return String(Math.min(kt, 99)).padStart(2, '0')
}

// ── Per-unit datablock ────────────────────────────────────────────────────────
const Datablock = memo(function Datablock({ id, unit, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks, ownership, myPosition }) {
  const pos = unit.position
  if (!pos) return null

  const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
  if (x < -100 || x > view.width + 100 || y < -100 || y > view.height + 100) return null

  const { colors, symbol, dataBlock } = visual
  const leaderLen   = ldrLength ?? dataBlock.leaderLength  ?? 40
  const leaderAngle = (ldrAngleDeg ?? dataBlock.leaderAngleDeg ?? -45) * Math.PI / 180
  const symbolRadius = (symbol.diameter ?? 13) / 2
  const fontPx = 10 + (csDatablocks ?? 3) * 2
  const lh     = Math.round(fontPx * 1.2)
  const font   = `500 ${fontPx}px "Roboto Mono", monospace`

  const lx0 = x + Math.cos(leaderAngle) * symbolRadius
  const ly0 = y + Math.sin(leaderAngle) * symbolRadius
  // Text anchor is always at least at the symbol edge so it never overlaps the contact
  const textDist = Math.max(leaderLen, symbolRadius)
  const lx1 = x + Math.cos(leaderAngle) * textDist
  const ly1 = y + Math.sin(leaderAngle) * textDist

  // S/SW/W/NW: leader attaches to the RIGHT side of the datablock — right-align text
  const angleDeg = ldrAngleDeg ?? dataBlock.leaderAngleDeg ?? -45
  const rightAlign = [90, 135, 180, -135].includes(angleDeg)

  const owner     = ownership[String(id)]
  const isOwned   = owner === myPosition
  const isTracked = owner && owner !== myPosition

  const alt = fmtAlt(pos.alt)
  const spd = fmtSpd(unit.speed)
  const cs  = resolveCallsign(unit).toUpperCase()

  let lines, color, textOpacity
  if (isOwned) {
    lines       = [cs, `${alt}  ${spd}`]
    color       = colors.fdbText
    textOpacity = briteFdb ?? 1
  } else if (isTracked) {
    lines       = [`${cs}  ${alt}`]
    color       = colors.pdbText
    textOpacity = briteLdb ?? 1
  } else {
    lines       = [`${alt}  ${spd}`]
    color       = colors.ldbText
    textOpacity = briteLdb ?? 1
  }

  return (
    <g>
      {leaderLen > 0 && (
        <line
          x1={lx0} y1={ly0} x2={lx1} y2={ly1}
          stroke={colors.leaderLine}
          strokeWidth={0.8}
          opacity={textOpacity}
        />
      )}
      {lines.map((line, i) => (
        <text
          key={i}
          x={rightAlign ? lx1 - 2 : lx1 + 2}
          y={ly1 + i * lh}
          fill={color}
          opacity={textOpacity}
          textAnchor={rightAlign ? 'end' : 'start'}
          style={{ font, dominantBaseline: 'alphabetic' }}
        >
          {line}
        </text>
      ))}
    </g>
  )
})

// ── Overlay ───────────────────────────────────────────────────────────────────
export function DatablockOverlay({ units, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks }) {
  const ownership  = useAtcStore((s) => s.ownership)
  const myPosition = useSessionStore((s) => s.positionName)

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
          myPosition={myPosition}
        />
      ))}
    </svg>
  )
}
