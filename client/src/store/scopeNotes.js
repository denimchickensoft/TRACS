import { create } from 'zustand'

// .note / .note* — boxed text notes on a scope, local to this browser.
// Each list is stored under its own localStorage key:
//   map notes    tracs.notes.map.<module>.<theatre>     [{ id, lat, lng, text }]
//   screen notes tracs.notes.screen.<module>.<windowId> [{ id, fx, fy, text }]
// fx/fy are fractions of the scope area. Other windows of the same scope
// (e.g. a popped-out ABM focus window) pick up changes via the storage event.

const PREFIX = 'tracs.notes.'

export const mapNotesKey    = (module, theatre)  => `${PREFIX}map.${module}.${theatre ?? 'none'}`
export const screenNotesKey = (module, windowId) => `${PREFIX}screen.${module}.${windowId}`

function readStored(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export const useScopeNotesStore = create((set, get) => ({
  lists: {},

  // Loads a list from storage the first time it's asked for.
  ensure: (key) => {
    if (get().lists[key]) return
    set((s) => ({ lists: { ...s.lists, [key]: readStored(key) } }))
  },

  list: (key) => get().lists[key] ?? readStored(key),

  write: (key, list) => {
    set((s) => ({ lists: { ...s.lists, [key]: list } }))
    try {
      if (list.length) localStorage.setItem(key, JSON.stringify(list))
      else localStorage.removeItem(key)
    } catch { /* kept for this session only */ }
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(PREFIX)) return
    useScopeNotesStore.setState((s) => ({ lists: { ...s.lists, [e.key]: readStored(e.key) } }))
  })
}
