import { create } from 'zustand'

// LittleNavMap (Navigraph) database status, from GET /api/navdata/lnm-config.
// Fixes, navaids, airways and procedures all come from this database, so
// command replies and the setup dialog both need to know whether one is set.
//
// lnmDbPath: undefined = not checked yet, null = none configured,
//            string    = the configured file.
export const useLnmStore = create((set) => ({
  lnmDbPath: undefined,
  busy:      false,   // a POST (validate + extract) is in flight
  error:     null,    // last save/extract error message, for the UI

  refresh: async () => {
    try {
      const r = await fetch('/api/navdata/lnm-config')
      if (!r.ok) return
      const data = await r.json()
      set({ lnmDbPath: data.lnmDbPath ?? null })
    } catch {
      // Server not reachable yet - leave the status unknown.
    }
  },

  // Validates the file and extracts its navdata (can take a while).
  // Resolves true on success; on failure resolves false with `error` set.
  setDbPath: async (lnmDbPath) => {
    set({ busy: true, error: null })
    try {
      const r = await fetch('/api/navdata/lnm-config', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ lnmDbPath }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        set({ busy: false, error: data.error || `Server returned ${r.status}` })
        return false
      }
      set({ busy: false, lnmDbPath })
      return true
    } catch (err) {
      set({ busy: false, error: err.message || 'Could not reach the TRACS server' })
      return false
    }
  },
}))

// "Don't ask again" for the first-run setup prompt. Per-machine convenience
// only; the Settings panel's Navigation data row works either way.
const DISMISSED_KEY = 'tracs.lnmPromptDismissed'

export function lnmPromptDismissed() {
  try { return localStorage.getItem(DISMISSED_KEY) === '1' } catch { return false }
}

export function dismissLnmPrompt() {
  try { localStorage.setItem(DISMISSED_KEY, '1') } catch { /* storage unavailable - nothing to remember */ }
}

// Every window that imports this store (main window and pop-outs alike)
// learns the status once at startup.
useLnmStore.getState().refresh()

// Reply for a failed navdata lookup: when no LNM database is configured the
// lookup can't succeed, so say that instead of a plain "not found".
export function navdataNotFound(notFoundText = 'NOT FOUND') {
  return useLnmStore.getState().lnmDbPath === null ? 'NO NAVDATA' : notFoundText
}
