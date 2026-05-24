import { usePreviewStore } from '../../../store/preview.js'
import { useDisplayStore } from '../../../store/display.js'
import { useOdsStore }     from '../../../store/ods.js'

const WINDOW_ID = 'atc-main'

/**
 * Preview area — the STARS command entry and system response display.
 *
 * Positioned absolutely within atc-canvas-area.
 * Defaults to bottom-left; repositioned via MF P + SLEW.
 * Styling matches list text (pdbText color, same font size scale).
 *
 * Layout:
 *   Line 1 (top):    system response (errors, confirmations)
 *   Line 2 (bottom): current buffer with blinking cursor
 */
export function PreviewArea({ defaultX = 12 }) {
  const { buffer, response, position } = usePreviewStore()
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  const csLists = windowSettings?.csLists ?? null
  const fontPx  = 10 + (csLists ?? 3) * 2
  const color   = activeProfile?.visual?.colors?.pdbText ?? '#00cc00'

  const x = position?.x ?? defaultX

  return (
    <div style={{
      position:      'absolute',
      left:          x,
      bottom:        position ? undefined : 40,
      top:           position ? position.y : undefined,
      fontFamily:    '"Roboto Mono", monospace',
      fontWeight:    500,
      fontSize:      `${fontPx}px`,
      lineHeight:    `${Math.round(fontPx * 1.4)}px`,
      color,
      background:    'transparent',
      pointerEvents: 'none',
      userSelect:    'none',
      whiteSpace:    'pre',
      minWidth:      '10ch',
    }}>
      {response && (
        <div style={{ color: '#FF4444' }}>{response}</div>
      )}
      <div>
        {buffer ? buffer.replace(/^MF /, 'F') : '\u00A0'}
      </div>
    </div>
  )
}
