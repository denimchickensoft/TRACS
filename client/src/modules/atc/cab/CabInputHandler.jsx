import { useEffect } from 'react'
import { useCabPreviewStore }   from '../../../store/cabPreview.js'
import { isTypedInput }         from '../input/starsKeys.js'

export function CabInputHandler({ onEnter, onEsc }) {
  const preview = useCabPreviewStore()

  useEffect(() => {
    function handleKeyDown(e) {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

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
  }, [preview, onEnter, onEsc])

  return null
}
