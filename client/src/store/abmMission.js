// Imported ATO/FRAG mission data for the ABM sidebar. Not persisted across
// reloads (re-import each session, same as CATCC's MissionImport flow), but
// IS synced across same-machine windows (main window + undocked ATO/FRAG
// popups) via localStorage + BroadcastChannel — same pattern as
// store/statusBoard.js, minus the WebRTC broadcast (packages are local to
// this controller's imported mission, not shared with other controllers).

import { create } from 'zustand'

const SB_KEY = 'tracs.abm.mission'

function serialize(s) {
  return { packages: s.packages, importedAt: s.importedAt, selectedGroupId: s.selectedGroupId, selectNonce: s.selectNonce }
}

function loadSaved() {
  try { return JSON.parse(sessionStorage.getItem(SB_KEY) ?? 'null') } catch { return null }
}

const saved = loadSaved() ?? {}

export const useAbmMissionStore = create((set) => ({
  packages:        saved.packages        ?? [],
  importedAt:      saved.importedAt      ?? null,
  selectedGroupId: saved.selectedGroupId ?? null,
  // Bumped on every selectGroup() call, even reselecting the same group —
  // lets App.jsx's "open FRAG on selection" effect fire every time (a plain
  // selectedGroupId dependency wouldn't change, and the effect wouldn't
  // re-run, if the panel was closed and the same contact clicked again).
  selectNonce: saved.selectNonce ?? 0,

  setPackages: (packages) => set({ packages, importedAt: Date.now(), selectedGroupId: null }),

  selectGroup: (groupId) => set((s) => ({ selectedGroupId: groupId, selectNonce: s.selectNonce + 1 })),

  clearSelection: () => set({ selectedGroupId: null }),
}))

// ── Cross-window sync (main window + undocked ATO/FRAG popups) ─────────────
let _syncing = false

const _ch = new BroadcastChannel('tracs-abm-mission')

useAbmMissionStore.subscribe((state) => {
  if (_syncing) return
  try { sessionStorage.setItem(SB_KEY, JSON.stringify(serialize(state))) } catch {}
  _ch.postMessage({ type: 'STATE_UPDATE', state: serialize(state) })
})

_ch.onmessage = (e) => {
  if (e.data?.type === 'STATE_UPDATE') {
    _syncing = true
    useAbmMissionStore.setState(e.data.state)
    _syncing = false
  } else if (e.data?.type === 'REQUEST_STATE') {
    _ch.postMessage({ type: 'STATE_UPDATE', state: serialize(useAbmMissionStore.getState()) })
  }
}
_ch.postMessage({ type: 'REQUEST_STATE' })
