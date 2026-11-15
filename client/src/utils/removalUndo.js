// Ctrl+Z on a scope brings back what was last removed there: notes (every
// scope) and ABM drawings and marks. Each removal records how to restore
// itself, tagged with the module it belongs to; Ctrl+Z restores the most
// recent one for that module. Kept for this window only, last MAX_ENTRIES.
//
// A command that removes several things at once (.notes, `.dclear <name>`)
// wraps its removals in undoGroup() so one Ctrl+Z brings them all back.

const MAX_ENTRIES = 20

const stack = []     // [{ module, label, restores: [fn] }], oldest first
let group = null     // the entry being filled inside undoGroup()

// Records one removal. restore() puts it back (and must cope with it having
// come back some other way meanwhile).
export function recordRemoval(module, label, restore) {
  if (group) {
    group.restores.push(restore)
    return
  }
  stack.push({ module, label, restores: [restore] })
  if (stack.length > MAX_ENTRIES) stack.shift()
}

// Runs fn with every removal it records gathered into a single undo entry.
export function undoGroup(module, label, fn) {
  if (group) return fn()   // already inside a group: join it
  group = { module, label, restores: [] }
  try {
    return fn()
  } finally {
    const done = group
    group = null
    if (done.restores.length) {
      stack.push(done)
      if (stack.length > MAX_ENTRIES) stack.shift()
    }
  }
}

// Restores the latest removal for this module. Returns its label, or null if
// there was nothing to undo.
export function undoRemoval(module) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].module !== module) continue
    const [entry] = stack.splice(i, 1)
    for (const restore of [...entry.restores].reverse()) restore()
    return entry.label
  }
  return null
}

// Ctrl+Z, with no other modifier.
export function isUndoKey(e) {
  return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyZ'
}

// The command-line feedback for a Ctrl+Z.
export function undoFeedback(module) {
  const label = undoRemoval(module)
  return label ? `RESTORED ${label}` : 'NOTHING TO UNDO'
}

// Test hook
export function _resetRemovalUndo() { stack.length = 0; group = null }
