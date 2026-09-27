import { usePreviewStore } from '../../../store/preview.js'
import { useDisplayStore, DEFAULT_LISTS } from '../../../store/display.js'
import { useOdsStore }     from '../../../store/ods.js'
import { STARS_KEY_MAP }   from '../../../utils/starsKeys.js'

const WINDOW_ID = 'atc-main'

// Command-key tokens (HO, IC, MF, ...), longest first so prefixes can't shadow.
const COMMAND_TOKENS = STARS_KEY_MAP
  .filter((k) => k.token)
  .map((k) => k.token)
  .sort((a, b) => b.length - a.length)

/**
 * Split a buffer that starts with a command key into [header, remainder].
 * The header is the key's label on its own line; MF also absorbs the next
 * key (the function selector), so "MF SA TEXT" -> ["FS", "A TEXT"].
 * Returns null when the buffer doesn't start with a command key.
 */
function splitCommand(buffer) {
  if (!buffer) return null
  const token = COMMAND_TOKENS.find((t) => buffer.startsWith(t))
  if (!token) return null
  const rest = buffer.slice(token.length)
  if (token === 'MF ') {
    return rest ? [`F${rest[0]}`, rest.slice(1)] : ['F', null]
  }
  return [token.trim(), rest]
}

/**
 * Preview area — the STARS command entry and system response display.
 *
 * Positioned absolutely within atc-canvas-area at its lists.preview entry
 * (top-left corner, % of the canvas), like the lists; repositioned via
 * MF P + SLEW.
 * Styling matches list text (pdbText color, same font size scale).
 *
 * Layout:
 *   Line 1 (top):    system response (errors, confirmations)
 *   Line 2 (bottom): current buffer with blinking cursor
 *                    (a command key shows its label on its own line, with the
 *                    rest of the entry below; MF includes its selector: "FS")
 */
export function PreviewArea() {
  const { buffer, response, hasToken } = usePreviewStore()
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  const csLists = windowSettings?.csLists ?? null
  const fontPx  = 10 + (csLists ?? 3) * 2
  const color   = activeProfile?.visual?.colors?.pdbText ?? '#00cc00'

  const pos     = windowSettings?.lists?.preview ?? DEFAULT_LISTS.preview

  // Only split when a function key actually started the entry, not when
  // the same letters were typed by hand.
  const split = hasToken ? splitCommand(buffer) : null

  return (
    <div style={{
      position:      'absolute',
      left:          `${pos.xPct}%`,
      top:           `${pos.yPct}%`,
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
        <div>{response}</div>
      )}
      {split ? (
        <>
          <div>{split[0]}</div>
          {split[1] !== null && <div>{split[1] || '\u00A0'}</div>}
        </>
      ) : (
        <div>{buffer || '\u00A0'}</div>
      )}
    </div>
  )
}
