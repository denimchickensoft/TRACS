// Numbered view bookmarks for ABM (Ctrl+Alt+0-9 save / Ctrl+0-9 load), see
// AbmScope.jsx's handleKeyDown. Deliberately its own localStorage key(s) and
// its own tiny module rather than a field in abmPrefs.js/abmUiPrefs.js: those
// files persist last-used display settings and explicitly must NOT persist
// centerLat/centerLng as an auto-restored default (see abmPrefs.js header) —
// a bookmark is a different thing, an explicit user-triggered snapshot, not
// an auto-restored last-used view.
//
// Scoped per-theatre (own localStorage key per theatre) since a saved
// centerLat/centerLng/rangeNm is only meaningful within the theatre it was
// captured in — loading a bookmark after switching theatres would otherwise
// jump to an unrelated lat/lng in the new theatre's coordinate space.

const KEY_PREFIX = 'tracs.abm.bookmarks'
const SLOT_COUNT = 10

function keyFor(theatre) {
  return `${KEY_PREFIX}.${theatre ?? 'default'}`
}

function loadSlots(theatre) {
  try {
    const saved = JSON.parse(localStorage.getItem(keyFor(theatre)))
    return Array.isArray(saved) ? saved : Array(SLOT_COUNT).fill(null)
  } catch {
    return Array(SLOT_COUNT).fill(null)
  }
}

export function getAbmBookmark(theatre, n) {
  return loadSlots(theatre)[n] ?? null
}

export function saveAbmBookmark(theatre, n, data) {
  const slots = loadSlots(theatre)
  slots[n] = data
  try { localStorage.setItem(keyFor(theatre), JSON.stringify(slots)) } catch {}
}
