// CATCC is always carrier-centered — there's no pan/offset state to capture,
// so a bookmark here is just a saved rangeNm. Its own tiny localStorage
// module rather than a field in catccPrefs.js, same reasoning as ABM's
// abmBookmarks.js: a bookmark is an explicit user-triggered snapshot, not an
// auto-restored last-used setting. Unlike ABM's lat/lng bookmarks, a saved
// range isn't theatre-dependent, so this uses one global key.
const KEY = 'tracs-catcc-bookmarks'
const SLOT_COUNT = 10

function loadSlots() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    return Array.isArray(saved) ? saved : Array(SLOT_COUNT).fill(null)
  } catch { return Array(SLOT_COUNT).fill(null) }
}

export function getCatccBookmark(n) { return loadSlots()[n] ?? null }

export function saveCatccBookmark(n, data) {
  const slots = loadSlots()
  slots[n] = data
  try { localStorage.setItem(KEY, JSON.stringify(slots)) } catch {}
}
