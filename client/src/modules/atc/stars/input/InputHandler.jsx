import { useEffect } from 'react'
import { usePreviewStore }  from '../../../../store/preview.js'
import { useFpeStore }      from '../../../../store/fpe.js'
import { matchStarsKey, isTypedInput } from './starsKeys.js'

/**
 * Keyboard input handler for the STARS ODS.
 *
 * Attaches a document-level keydown listener. Ignores events when focus
 * is inside an input/textarea/select element.
 *
 * Does NOT handle slew (canvas click) — that lives in AtcScope.
 * Does NOT dispatch commands — that happens at slew/enter time in AtcScope.
 *
 * Responsibilities:
 *   - STARS key presses  → appendToken to preview buffer
 *   - Alphanumeric keys  → appendChar to preview buffer
 *   - ESC               → clear buffer
 *   - Backspace         → backspace buffer
 *   - ENTER             → trigger ENTER-type command evaluation (via callback)
 *   - Immediate actions → fire onImmediateAction callback
 */
export function InputHandler({ onEnter, onImmediateAction, onEsc }) {
  // Store actions are read via getState() inside the handler, not a
  // subscription: subscribing made the listener re-attach on every keystroke
  // (each one changes the preview buffer).
  useEffect(() => {
    function handleKeyDown(e) {
      const preview = usePreviewStore.getState()
      // FPE takes precedence over all STARS input while open
      if (useFpeStore.getState().open) return

      // Ignore when typing in form elements
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // ESC — cancel any pending mode, then clear buffer
      if (e.key === 'Escape') {
        e.preventDefault()
        onEsc?.()
        preview.clear()
        return
      }

      // Backspace — remove last character
      if (e.key === 'Backspace') {
        e.preventDefault()
        preview.backspace()
        return
      }

      // Enter — evaluate buffer as ENTER-triggered command
      if (e.key === 'Enter') {
        e.preventDefault()
        onEnter?.()
        return
      }

      // Check STARS key map first
      const starsKey = matchStarsKey(e)
      if (starsKey) {
        e.preventDefault()
        if (starsKey.action) {
          onImmediateAction?.(starsKey.action)
        } else if (starsKey.token) {
          preview.appendToken(starsKey.token)
        }
        return
      }

      // Typed alphanumeric input → append to buffer
      if (isTypedInput(e)) {
        e.preventDefault()
        preview.appendChar(e.key.toUpperCase())
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onEnter, onImmediateAction, onEsc])

  return null  // no DOM output — purely a side-effect component
}
