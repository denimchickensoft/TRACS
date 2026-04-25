import './ListPanel.css'

const MAX_LINES_DEFAULT = 5

/**
 * Generic STARS list panel shell.
 *
 * Positioned absolutely within atc-canvas-area at (xPct%, yPct%).
 * Optionally renders a dimmed title row, then up to `maxLines` data rows.
 * Shows "MORE N/M" footer when rows exceed maxLines.
 *
 * Props:
 *   title    — string header (omit or pass null for no title row, e.g. SSA)
 *   rows     — string[]
 *   xPct     — horizontal position as % of canvas width
 *   yPct     — vertical position as % of canvas height
 *   maxLines — max visible data rows (default 5)
 *   brite    — brightness 0–1 (default 1)
 *   csLists  — character size scale 0–5 (null = default 3)
 *   color    — text color (should match pdbText from active profile)
 */
export function ListPanel({ title, rows = [], xPct = 2, yPct = 2, maxLines = MAX_LINES_DEFAULT, brite = 1, csLists = null, color = '#00cc00' }) {
  const visible  = rows.slice(0, maxLines)
  const total    = rows.length
  const more     = total > maxLines
  const fontPx   = 10 + (csLists ?? 3) * 2  // mirrors DatablockOverlay formula

  return (
    <div
      className="list-panel"
      style={{
        left:     `${xPct}%`,
        top:      `${yPct}%`,
        opacity:  brite,
        fontSize: `${fontPx}px`,
        color,
      }}
    >
      {title ? <div className="list-title">{title}</div> : null}
      {visible.map((row, i) => (
        <div key={i}>{row}</div>
      ))}
      {more && (
        <div className="list-more">MORE {maxLines}/{total}</div>
      )}
    </div>
  )
}
