// Numbered view bookmarks for ABM (Ctrl+Alt+0-9 save / Ctrl+0-9 load), see
// AbmScope.jsx's handleKeyDown. Deliberately its own localStorage key and its
// own tiny module rather than a field in abmPrefs.js/abmUiPrefs.js: those
// files persist last-used display settings and explicitly must NOT persist
// centerLat/centerLng as an auto-restored default (see abmPrefs.js header) —
// a bookmark is a different thing, an explicit user-triggered snapshot, not
// an auto-restored last-used view.

const KEY = 'tracs-abm-bookmarks'
const SLOT_COUNT = 10

function loadSlots() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(saved) ? saved : Array(SLOT_COUNT).fill(null)
  } catch {
    return Array(SLOT_COUNT).fill(null)
  }
}

export function getAbmBookmark(n) {
  return loadSlots()[n] ?? null
}

export function saveAbmBookmark(n, data) {
  const slots = loadSlots()
  slots[n] = data
  try { localStorage.setItem(KEY, JSON.stringify(slots)) } catch {}
}
