// This window's declarations, kept so they survive a page reload. They live
// in sessionStorage, so closing the tab or app drops them; signing out or
// changing position drops them too (webrtc/client.js), and a different room
// (coalition) or mission never gets them back. Only ever restored when this
// controller is alone in the room: with anyone else there, the room's own
// declarations arrive in their dump instead.
const KEY = 'tracs.declarations'

export function saveDeclarations(room, mission, declarations) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ room, mission, declarations }))
  } catch {
    // storage unavailable or full: they just won't survive a reload
  }
}

// The saved declarations for this room and mission, or null.
export function loadDeclarations(room, mission) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    if (!saved || saved.room !== room || saved.mission !== mission) return null
    return saved.declarations && typeof saved.declarations === 'object' ? saved.declarations : null
  } catch {
    return null
  }
}

export function clearSavedDeclarations() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
