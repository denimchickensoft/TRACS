import { useEffect } from 'react'
import { useAsdexPreviewStore } from '../../../store/asdexPreview.js'
import { isTypedInput }        from '../stars/input/starsKeys.js'
import { toggleAllDatablocks } from './asdexDatablockToggle.js'

export function AsdexInputHandler({ onEnter, onEsc }) {
  // Store actions are read via getState() inside the handler, not a
  // subscription: subscribing made the listener re-attach on every keystroke.
  useEffect(() => {
    function handleKeyDown(e) {
      const preview = useAsdexPreviewStore.getState()
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // CRC ASDE-X: F6 toggles all Data Blocks, F7 is MULTIFUNC (same MF token as STARS)
      if (e.code === 'F6' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        toggleAllDatablocks()
        return
      }
      if (e.code === 'F7' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        preview.appendToken('MF ')
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        onEsc?.()
        preview.clear()
        return
      }
      if (e.key === 'Backspace') {
        e.preventDefault()
        preview.backspace()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        onEnter?.()
        return
      }
      if (isTypedInput(e)) {
        e.preventDefault()
        preview.appendChar(e.key.toUpperCase())
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onEnter, onEsc])

  return null
}
