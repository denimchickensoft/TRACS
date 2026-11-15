import { useScopeNotesStore, mapNotesKey, screenNotesKey, moduleOfNotesKey } from '../../store/scopeNotes.js'
import { canvasToLatLng } from '../../utils/projection.js'
import { recordRemoval, undoGroup } from '../../utils/removalUndo.js'

// .note command handling for every scope — see ScopeNotes.jsx.

export const MAX_TEXT = 80

// What a typed buffer asks for, or null if it isn't a note command.
export function parseNoteCommand(buffer) {
  const s = buffer.trim()
  if (/^\.notes$/i.test(s)) return { kind: 'clearAll' }
  if (/^\.note\*?$/i.test(s)) return { kind: 'clear' }
  const m = s.match(/^\.note(\*)?\s+(.+)$/i)
  return m ? { kind: 'add', screen: !!m[1], text: m[2].slice(0, MAX_TEXT) } : null
}

let nextId = Date.now()

/**
 * A click on the scope with a note command in the buffer.
 * scope: { module, theatre, windowId }; x/y: click position in the scope
 * area; el: the scope's interactive layer (its parent holds the notes).
 * delKey: the buffer is the DEL key's token (DEL + click removes the note
 * under the click, once, like `.note` + click).
 * Returns null if the buffer isn't a note command, else { ok, msg, oneShot }
 * (oneShot: the command is used up even though it failed).
 */
export function noteClick(buffer, scope, { x, y, view, el }, delKey = false) {
  if (delKey && buffer.trim() === 'DEL') {
    return removeNoteAt(el, x, y)
      ? { ok: true, msg: 'NOTE CLEARED' }
      : { ok: false, msg: 'NO NOTE', oneShot: true }
  }
  const cmd = parseNoteCommand(buffer)
  if (!cmd) return null
  if (cmd.kind === 'clearAll') return noteEnter(buffer, scope)
  if (!view) return { ok: false, msg: 'NO VIEW' }
  const store = useScopeNotesStore.getState()

  if (cmd.kind === 'clear') {
    return removeNoteAt(el, x, y) ? { ok: true, msg: 'NOTE CLEARED' } : { ok: false, msg: 'NO NOTE' }
  }

  const id = nextId++
  if (cmd.screen) {
    const key = screenNotesKey(scope.module, scope.windowId)
    const fx  = Math.min(1, Math.max(0, x / view.width))
    const fy  = Math.min(1, Math.max(0, y / view.height))
    store.write(key, [...store.list(key), { id, fx, fy, text: cmd.text }])
  } else {
    const key = mapNotesKey(scope.module, scope.theatre)
    const { lat, lng } = canvasToLatLng(x, y, view)
    store.write(key, [...store.list(key), { id, lat, lng, text: cmd.text }])
  }
  return { ok: true, msg: 'NOTE ADDED' }
}

/**
 * Enter with a note command in the buffer. Only .notes completes on Enter;
 * the other forms need a click. Returns null if the buffer isn't a note
 * command, else { ok, msg }.
 */
export function noteEnter(buffer, scope) {
  const cmd = parseNoteCommand(buffer)
  if (!cmd) return null
  if (cmd.kind !== 'clearAll') return { ok: false, msg: 'CLICK TO PLACE' }
  const store = useScopeNotesStore.getState()
  undoGroup(scope.module, 'NOTES', () => {
    for (const key of [mapNotesKey(scope.module, scope.theatre), screenNotesKey(scope.module, scope.windowId)]) {
      deleteNotes(key, store.list(key).map((n) => String(n.id)))
    }
  })
  return { ok: true, msg: 'NOTES CLEARED' }
}

// Removes the topmost note under a point in the scope area. True if one was.
export function removeNoteAt(el, x, y) {
  const hit = noteAt(el, x, y)
  if (!hit) return false
  deleteNotes(hit.key, [hit.id])
  return true
}

// Removes the notes with these ids from one list, so that Ctrl+Z can put
// them back where they were.
export function deleteNotes(key, ids) {
  const store = useScopeNotesStore.getState()
  const drop  = new Set(ids.map(String))
  const list  = store.list(key)
  const gone  = list.flatMap((note, index) => (drop.has(String(note.id)) ? [{ note, index }] : []))
  if (!gone.length) return
  store.write(key, list.filter((n) => !drop.has(String(n.id))))
  recordRemoval(moduleOfNotesKey(key), gone.length > 1 ? 'NOTES' : 'NOTE', () => {
    const s    = useScopeNotesStore.getState()
    const next = [...s.list(key)]
    for (const { note, index } of gone) {
      if (!next.some((n) => String(n.id) === String(note.id))) next.splice(Math.min(index, next.length), 0, note)
    }
    s.write(key, next)
  })
}

// The topmost note box under a point in the scope area, as { key, id }.
// el is any element covering the scope area whose parent holds the notes.
export function noteAt(el, x, y) {
  const area = el?.parentElement
  if (!area) return null
  const origin = el.getBoundingClientRect()
  const cx = origin.left + x
  const cy = origin.top  + y
  const boxes = [...area.querySelectorAll('.scope-note')].reverse()
  for (const box of boxes) {
    const r = box.getBoundingClientRect()
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      return { key: box.dataset.noteKey, id: box.dataset.noteId }
    }
  }
  return null
}
