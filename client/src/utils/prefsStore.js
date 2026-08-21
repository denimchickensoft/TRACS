// Shared plain-localStorage prefs pattern used by abmPrefs.js/asdexPrefs.js/
// catccPrefs.js/starsPrefs.js — a small persisted subset of each scope's
// display settings, deliberately not zustand's persist middleware since only
// part of each scope's state should survive a reload (see those files' own
// headers for what's excluded and why).
export function makePrefsStore(key, defaults) {
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(key))
      return saved ? { ...defaults, ...saved } : { ...defaults }
    } catch {
      return { ...defaults }
    }
  }

  function save(patch) {
    try {
      const current = JSON.parse(localStorage.getItem(key)) ?? {}
      localStorage.setItem(key, JSON.stringify({ ...current, ...patch }))
    } catch {}
  }

  return { load, save }
}
