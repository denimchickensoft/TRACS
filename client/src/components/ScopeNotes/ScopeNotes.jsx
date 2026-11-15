import { useEffect, useRef, useState } from 'react'
import { useScopeNotesStore, mapNotesKey, screenNotesKey } from '../../store/scopeNotes.js'
import { latLngToCanvas, canvasToLatLng } from '../../utils/projection.js'
import { noteAt, MAX_TEXT } from './noteCommands.js'
import './ScopeNotes.css'

/**
 * .note — boxed text notes, shared by every scope (STARS, CATCC, AIC, ABM,
 * ASDE-X). Local to this browser and kept until cleared:
 *   .note TEXT  + click   pin a note to the map where you clicked
 *   .note* TEXT + click   pin a note to that spot on the screen
 *   .note + click on a note   remove it
 *   .notes                remove every note on this scope
 *   left-drag or Shift+right-drag a note   move it
 *   double-click a note   edit its text (Shift+Enter adds a line, Enter or
 *                         click away saves, Esc cancels, empty text removes
 *                         the note)
 *
 * <ScopeNotes> renders the notes over the scope's canvases (they take no
 * pointer events, except the one being edited). Each scope routes its clicks
 * through noteClick() and its Enter through noteEnter() (noteCommands.js).
 * Dragging and double-click are handled here, by capture-phase listeners on
 * the scope area that take a gesture landing on a note before the scope sees
 * it. A plain left press on a note is kept from the scope (so it doesn't
 * start the scope's own left-drag), but a release without moving still
 * reaches the scope as a click, so click commands aimed at a note work.
 * Plain right-drag (pan) and Ctrl+right-click (route) are left to the scope.
 */

const EMPTY = []
const LEFT_DRAG_THRESHOLD_PX = 3

// Where a note's anchor point sits in the scope area.
function anchorOf(note, view) {
  return note.lat != null
    ? latLngToCanvas(note.lat, note.lng, view)
    : { x: note.fx * view.width, y: note.fy * view.height }
}

const isPlain = (e) => !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
const inEditor = (e) => !!e.target?.closest?.('.scope-note-input')

// Swallows the click the browser sends right after a drag's release.
function swallowNextClick() {
  const swallow = (e) => { e.stopPropagation(); e.preventDefault() }
  window.addEventListener('click', swallow, true)
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

function NoteEditor({ text, onDone }) {
  const [value, setValue] = useState(text)
  const inputRef = useRef(null)
  const doneRef  = useRef(false)
  useEffect(() => { inputRef.current?.select() }, [])

  const finish = (save, fromBlur = false) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(save ? value : null, fromBlur)
  }

  // Sized to the text (the font is monospace) so the box grows as you type
  const lines = value.split('\n')
  const cols  = Math.max(1, ...lines.map((l) => l.length)) + 1

  return (
    <textarea
      ref={inputRef}
      className="scope-note-input"
      autoFocus
      spellCheck={false}
      maxLength={MAX_TEXT}
      value={value}
      rows={lines.length}
      style={{ width: `${cols}ch` }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        // Shift+Enter falls through to the textarea and adds a line
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true) }
        if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      }}
      onBlur={() => finish(true, true)}
    />
  )
}

export function ScopeNotes({ module, theatre, windowId, view, color }) {
  const mapKey    = mapNotesKey(module, theatre)
  const screenKey = screenNotesKey(module, windowId)
  const ensure    = useScopeNotesStore((s) => s.ensure)
  const mapNotes    = useScopeNotesStore((s) => s.lists[mapKey]) ?? EMPTY
  const screenNotes = useScopeNotesStore((s) => s.lists[screenKey]) ?? EMPTY
  useEffect(() => { ensure(mapKey); ensure(screenKey) }, [ensure, mapKey, screenKey])

  const [editing, setEditing] = useState(null)   // { key, id } of the note being edited

  const rootRef = useRef(null)
  const viewRef = useRef(view)
  useEffect(() => { viewRef.current = view }, [view])

  const hasNotes = mapNotes.length > 0 || screenNotes.length > 0
  const hasView  = !!view   // the notes (and their root) only render once both are true
  useEffect(() => {
    const root = rootRef.current
    const area = root?.parentElement
    if (!area) return

    const hitAt = (e) => {
      const origin = root.getBoundingClientRect()
      return noteAt(root, e.clientX - origin.left, e.clientY - origin.top)
    }

    // Moves the note under the cursor until `button` is released. With a
    // threshold, the move only starts once the cursor has travelled that far;
    // a release before then is left alone, so the scope sees it as a click.
    const trackDrag = (hit, e, button, threshold) => {
      const note = useScopeNotesStore.getState().list(hit.key).find((n) => String(n.id) === hit.id)
      if (!note) return
      // Keep the grab point under the cursor rather than snapping the anchor to it
      const origin = root.getBoundingClientRect()
      const a  = anchorOf(note, viewRef.current)
      const dx = a.x - (e.clientX - origin.left)
      const dy = a.y - (e.clientY - origin.top)
      let active = threshold === 0

      const onMove = (ev) => {
        if (!active) {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) <= threshold) return
          active = true
        }
        const v = viewRef.current
        if (!v) return
        const o = root.getBoundingClientRect()
        const x = ev.clientX - o.left + dx
        const y = ev.clientY - o.top  + dy
        const moved = note.lat != null
          ? { ...note, ...canvasToLatLng(x, y, v) }
          : { ...note, fx: Math.min(1, Math.max(0, x / v.width)), fy: Math.min(1, Math.max(0, y / v.height)) }
        const s = useScopeNotesStore.getState()
        s.write(hit.key, s.list(hit.key).map((n) => (String(n.id) === hit.id ? { ...moved, text: n.text } : n)))
      }
      const onUp = (ev) => {
        if (ev.button !== button) return
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp, true)
        if (!active) return
        ev.stopPropagation()
        if (button === 0) swallowNextClick()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp, true)
    }

    const onMouseDown = (e) => {
      if (!viewRef.current || inEditor(e)) return
      const shiftRight = e.button === 2 && e.shiftKey && !e.ctrlKey && !e.altKey
      const plainLeft  = e.button === 0 && isPlain(e)
      if (!shiftRight && !plainLeft) return
      const hit = hitAt(e)
      if (!hit) return
      e.stopPropagation()
      if (shiftRight) {
        e.preventDefault()
        trackDrag(hit, e, 2, 0)
      } else {
        // No preventDefault: the scope still takes focus and double-click still fires
        trackDrag(hit, e, 0, LEFT_DRAG_THRESHOLD_PX)
      }
    }

    const onDoubleClick = (e) => {
      if (e.button !== 0 || !isPlain(e) || inEditor(e)) return
      const hit = hitAt(e)
      if (!hit) return
      e.stopPropagation()
      e.preventDefault()
      setEditing(hit)
    }

    area.addEventListener('mousedown', onMouseDown, true)
    area.addEventListener('dblclick', onDoubleClick, true)
    return () => {
      area.removeEventListener('mousedown', onMouseDown, true)
      area.removeEventListener('dblclick', onDoubleClick, true)
    }
  }, [hasNotes, hasView])

  const finishEdit = (text, fromBlur) => {
    const target = editing
    const area   = rootRef.current?.parentElement
    setEditing(null)
    if (target && text != null) {
      const s = useScopeNotesStore.getState()
      const trimmed = text.trim()
      s.write(target.key, trimmed
        ? s.list(target.key).map((n) => (String(n.id) === target.id ? { ...n, text: trimmed } : n))
        : s.list(target.key).filter((n) => String(n.id) !== target.id))
    }
    // Hand the keyboard back to the scope's command line (a click away has
    // already put focus where it belongs)
    if (!fromBlur) area?.querySelector('[tabindex]')?.focus()
  }

  if (!hasView || !hasNotes) return null
  const style = { color, borderColor: color }

  const body = (key, n) => {
    const isEditing = editing && editing.key === key && editing.id === String(n.id)
    return {
      className: isEditing ? 'scope-note editing' : 'scope-note',
      children:  isEditing ? <NoteEditor text={n.text} onDone={finishEdit} /> : n.text,
    }
  }

  return (
    <div ref={rootRef} className="scope-notes">
      {mapNotes.map((n) => {
        const p = latLngToCanvas(n.lat, n.lng, view)
        if (p.x < -view.width || p.x > 2 * view.width || p.y < -view.height || p.y > 2 * view.height) return null
        const { className, children } = body(mapKey, n)
        return (
          <div key={n.id} className={className} data-note-key={mapKey} data-note-id={n.id}
               style={{ ...style, left: p.x, top: p.y }}>
            {children}
          </div>
        )
      })}
      {screenNotes.map((n) => {
        const { className, children } = body(screenKey, n)
        // The box slides across its anchor in step with where the anchor sits
        // on the scope (left edge at the far left, right edge at the far
        // right), so it always stays on screen and moves smoothly when dragged.
        return (
          <div key={n.id} className={className} data-note-key={screenKey} data-note-id={n.id}
               style={{
                 ...style,
                 left: n.fx * view.width,
                 top:  n.fy * view.height,
                 transform: `translate(${-n.fx * 100}%, ${-n.fy * 100}%)`,
               }}>
            {children}
          </div>
        )
      })}
    </div>
  )
}
