import { useEffect, useRef } from 'react'
import { useScopeNotesStore, mapNotesKey, screenNotesKey } from '../../store/scopeNotes.js'
import { latLngToCanvas, canvasToLatLng } from '../../utils/projection.js'
import { noteAt } from './noteCommands.js'
import './ScopeNotes.css'

/**
 * .note — boxed text notes, shared by every scope (STARS, CATCC, AIC, ABM,
 * ASDE-X). Local to this browser and kept until cleared:
 *   .note TEXT  + click   pin a note to the map where you clicked
 *   .note* TEXT + click   pin a note to that spot on the screen
 *   .note + click on a note   remove it
 *   .notes                remove every note on this scope
 *   Shift+right-drag a note   move it
 *
 * <ScopeNotes> renders the notes over the scope's canvases (they take no
 * pointer events). Each scope routes its clicks through noteClick() and its
 * Enter through noteEnter() (noteCommands.js). Shift+right-drag is handled
 * here: a capture-phase listener on the scope area takes a Shift+right
 * mousedown that lands on a note before the scope sees it. Plain right-drag
 * (pan) and Ctrl+right-click (route) are left to the scope.
 */

const EMPTY = []

// Where a note's anchor point sits in the scope area.
function anchorOf(note, view) {
  return note.lat != null
    ? latLngToCanvas(note.lat, note.lng, view)
    : { x: note.fx * view.width, y: note.fy * view.height }
}

export function ScopeNotes({ module, theatre, windowId, view, color }) {
  const mapKey    = mapNotesKey(module, theatre)
  const screenKey = screenNotesKey(module, windowId)
  const ensure    = useScopeNotesStore((s) => s.ensure)
  const mapNotes    = useScopeNotesStore((s) => s.lists[mapKey]) ?? EMPTY
  const screenNotes = useScopeNotesStore((s) => s.lists[screenKey]) ?? EMPTY
  useEffect(() => { ensure(mapKey); ensure(screenKey) }, [ensure, mapKey, screenKey])

  const rootRef = useRef(null)
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])

  const hasNotes = mapNotes.length > 0 || screenNotes.length > 0
  const hasView  = !!view   // the notes (and their root) only render once both are true
  useEffect(() => {
    const root = rootRef.current
    const area = root?.parentElement
    if (!area) return

    const onMouseDown = (e) => {
      if (e.button !== 2 || !e.shiftKey || e.ctrlKey || e.altKey || !viewRef.current) return
      const origin = root.getBoundingClientRect()
      const hit = noteAt(root, e.clientX - origin.left, e.clientY - origin.top)
      if (!hit) return
      e.stopPropagation()
      e.preventDefault()

      const store = useScopeNotesStore.getState()
      const note  = store.list(hit.key).find((n) => String(n.id) === hit.id)
      if (!note) return
      // Keep the grab point under the cursor rather than snapping the anchor to it
      const a  = anchorOf(note, viewRef.current)
      const dx = a.x - (e.clientX - origin.left)
      const dy = a.y - (e.clientY - origin.top)

      const onMove = (ev) => {
        const v = viewRef.current
        if (!v) return
        const o = root.getBoundingClientRect()
        const x = ev.clientX - o.left + dx
        const y = ev.clientY - o.top  + dy
        const moved = note.lat != null
          ? { ...note, ...canvasToLatLng(x, y, v) }
          : { ...note, fx: Math.min(1, Math.max(0, x / v.width)), fy: Math.min(1, Math.max(0, y / v.height)) }
        const s = useScopeNotesStore.getState()
        s.write(hit.key, s.list(hit.key).map((n) => (String(n.id) === hit.id ? moved : n)))
      }
      const onUp = (ev) => {
        if (ev.button !== 2) return
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp, true)
        ev.stopPropagation()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp, true)
    }

    area.addEventListener('mousedown', onMouseDown, true)
    return () => area.removeEventListener('mousedown', onMouseDown, true)
  }, [hasNotes, hasView])

  if (!hasView || !hasNotes) return null
  const style = { color, borderColor: color }

  return (
    <div ref={rootRef} className="scope-notes">
      {mapNotes.map((n) => {
        const p = latLngToCanvas(n.lat, n.lng, view)
        if (p.x < -view.width || p.x > 2 * view.width || p.y < -view.height || p.y > 2 * view.height) return null
        return (
          <div key={n.id} className="scope-note" data-note-key={mapKey} data-note-id={n.id}
               style={{ ...style, left: p.x, top: p.y }}>
            {n.text}
          </div>
        )
      })}
      {screenNotes.map((n) => (
        // The box slides across its anchor in step with where the anchor sits
        // on the scope (left edge at the far left, right edge at the far
        // right), so it always stays on screen and moves smoothly when dragged.
        <div key={n.id} className="scope-note" data-note-key={screenKey} data-note-id={n.id}
             style={{
               ...style,
               left: n.fx * view.width,
               top:  n.fy * view.height,
               transform: `translate(${-n.fx * 100}%, ${-n.fy * 100}%)`,
             }}>
          {n.text}
        </div>
      ))}
    </div>
  )
}
