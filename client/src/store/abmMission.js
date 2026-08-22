// Imported ATO/FRAG mission data for the ABM sidebar. Persisted to
// localStorage (survives a page refresh, browser crash, or full restart —
// the loaded mission and any in-store edits aren't lost, so it isn't a
// re-import-every-session flow like CATCC's MissionImport), and also synced
// live across same-machine windows (main window + undocked ATO/FRAG popups)
// via BroadcastChannel — same pattern as store/statusBoard.js, minus the
// WebRTC broadcast (flights are local to this controller's imported
// mission, not shared with other controllers).
//
// "flights" not "packages": each entry is one DCS Mission Editor Group (one
// callsign, one route, one task) — a real-world "flight." DCS has no native
// concept of a multi-flight "package" (strikers+SEAD+escort coordinated for
// one mission), so that word never described what this data actually is.

import { create } from 'zustand'

const SB_KEY = 'tracs.abm.mission'

function serialize(s) {
  return {
    flights: s.flights, importedAt: s.importedAt, selectedGroupId: s.selectedGroupId, selectNonce: s.selectNonce,
    findRequest: s.findRequest, findNonce: s.findNonce, findKey: s.findKey,
    blinkIds: s.blinkIds,
    routeVisible: s.routeVisible,
    routeGroupIds: s.routeGroupIds,
    taskOverrides: s.taskOverrides,
    nextManualId: s.nextManualId,
  }
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SB_KEY) ?? 'null') } catch { return null }
}

const saved = loadSaved() ?? {}

export const useAbmMissionStore = create((set) => ({
  flights:         saved.flights         ?? [],
  importedAt:      saved.importedAt      ?? null,
  selectedGroupId: saved.selectedGroupId ?? null,
  // Bumped on every selectGroup() call, even reselecting the same group —
  // lets App.jsx's "open FRAG on selection" effect fire every time (a plain
  // selectedGroupId dependency wouldn't change, and the effect wouldn't
  // re-run, if the panel was closed and the same contact clicked again).
  selectNonce: saved.selectNonce ?? 0,

  // A FRAG panel's Base/route-waypoint click — request for AbmScope (the
  // only place holding theatre navdata/runway/unit data, and never undocked
  // itself) to resolve the ref to a position and drop a .find-style marker
  // on the scope. Bumped nonce so re-clicking the same ref re-fires even
  // though the ref object itself didn't change. findKey is a caller-supplied
  // id (e.g. "base-<groupId>" or "wp-<groupId>-<i>") FRAG compares against
  // to know which of its own rows is the currently-active find, so it can
  // hold that row's text green until the marker is cleared/replaced.
  findRequest: saved.findRequest ?? null,
  findNonce:   saved.findNonce   ?? 0,
  findKey:     saved.findKey     ?? null,

  // FRAG roster click — units-store ids currently blinking their datablock
  // on the ABM scope (STARS handoff/point-out-style cue). A Set of ids
  // rather than a single target, like AbmScope's own middle-click
  // toggleHighlight, so multiple aircraft can be called out at once; stored
  // as an array since Sets don't round-trip through JSON/BroadcastChannel.
  blinkIds: saved.blinkIds ?? [],

  // FRAG's ROUTE section header — click to toggle the selected flight's
  // route drawing on the ABM scope, same green-when-active convention as
  // Base/waypoint find. Reset to false on every selectGroup() (including
  // reselecting the same flight) so a newly-opened FRAG always starts with
  // the route hidden until the controller explicitly asks for it.
  routeVisible: saved.routeVisible ?? false,

  // Ctrl+right-click / .route + click / .route <callsign> — independent of
  // FRAG's own routeVisible+selectedGroupId toggle above (that one always
  // resets on selectGroup() and is tied to whichever flight the panel has
  // open). This is a Set of groupIds, same "multiple independent targets"
  // shape as blinkIds, so several contacts' routes can be shown on the scope
  // at once without opening FRAG or disturbing its own route toggle.
  routeGroupIds: saved.routeGroupIds ?? [],

  // FRAG's editable TASKING/Task field — a controller override of the
  // mission's own task string, keyed by groupId. ATO's TASK column reads
  // the same map so an edit in FRAG is immediately reflected there too.
  taskOverrides: saved.taskOverrides ?? {},

  // Manually-added flights (AddAtoFlight.jsx) get a negative groupId — real
  // DCS group IDs are always positive, so this can never collide with an
  // imported flight's own id. Monotonic and persisted so ids never get
  // reused even across a reload.
  nextManualId: saved.nextManualId ?? -1,

  // Replaces the imported set but keeps any manually-added flights —
  // loading a new mission shouldn't delete flights the controller typed in
  // by hand (AddAtoFlight.jsx), only the previously-imported ones.
  setFlights: (flights) => set((s) => ({
    flights: [...flights, ...s.flights.filter(f => f.manual)],
    importedAt: Date.now(),
    selectedGroupId: null,
  })),

  // Clear Mission — drops only the imported flights (and their task
  // overrides), leaving manually-added ones alone. Bare find/blink state is
  // still wiped either way, since a stale marker/blink has no meaning once
  // whatever it was pointing at is gone.
  clearFlights: () => set((s) => {
    const keep = new Set(s.flights.filter(f => f.manual).map(f => f.groupId))
    const overrides = {}
    for (const [gid, v] of Object.entries(s.taskOverrides)) {
      if (keep.has(Number(gid))) overrides[gid] = v
    }
    return {
      flights: s.flights.filter(f => f.manual),
      importedAt: null,
      selectedGroupId: keep.has(s.selectedGroupId) ? s.selectedGroupId : null,
      findRequest: null, findKey: null, blinkIds: [],
      routeGroupIds: s.routeGroupIds.filter(gid => keep.has(gid)),
      taskOverrides: overrides,
    }
  }),

  // Clear ALL — the CATCC status-board-style full wipe, including
  // manually-added flights. Gated behind a confirm step in the UI.
  clearAllFlights: () => set({
    flights: [], importedAt: null, selectedGroupId: null,
    findRequest: null, findKey: null, blinkIds: [], routeGroupIds: [], taskOverrides: {},
  }),

  // Appends one hand-entered flight (AddAtoFlight.jsx) — additive, unlike
  // setFlights which replaces the whole imported set.
  addFlight: (flight) => set((s) => ({
    flights: [...s.flights, { ...flight, groupId: s.nextManualId, manual: true }],
    nextManualId: s.nextManualId - 1,
  })),

  removeFlight: (groupId) => set((s) => {
    const next = { ...s.taskOverrides }
    delete next[groupId]
    return {
      flights: s.flights.filter(f => f.groupId !== groupId),
      selectedGroupId: s.selectedGroupId === groupId ? null : s.selectedGroupId,
      taskOverrides: next,
    }
  }),

  setTaskOverride: (groupId, value) => set((s) => {
    const next = { ...s.taskOverrides }
    if (value) next[groupId] = value
    else delete next[groupId]
    return { taskOverrides: next }
  }),

  selectGroup: (groupId) => set((s) => ({ selectedGroupId: groupId, selectNonce: s.selectNonce + 1, routeVisible: false })),

  clearSelection: () => set({ selectedGroupId: null, routeVisible: false }),

  toggleRouteVisible: () => set((s) => ({ routeVisible: !s.routeVisible })),

  clearRouteVisible: () => set({ routeVisible: false }),

  requestFind: (ref, key = null) => set((s) => ({ findRequest: ref, findKey: key, findNonce: s.findNonce + 1 })),

  clearFind: () => set({ findRequest: null, findKey: null }),

  toggleBlink: (unitKey) => set((s) => {
    const next = new Set(s.blinkIds)
    next.has(unitKey) ? next.delete(unitKey) : next.add(unitKey)
    return { blinkIds: [...next] }
  }),

  clearBlink: () => set({ blinkIds: [] }),

  toggleRouteGroup: (groupId) => set((s) => {
    const next = new Set(s.routeGroupIds)
    next.has(groupId) ? next.delete(groupId) : next.add(groupId)
    return { routeGroupIds: [...next] }
  }),

  clearRouteGroups: () => set({ routeGroupIds: [] }),
}))

// ── Cross-window sync (main window + undocked ATO/FRAG popups) ─────────────
let _syncing = false

const _ch = new BroadcastChannel('tracs-abm-mission')

useAbmMissionStore.subscribe((state) => {
  if (_syncing) return
  try { localStorage.setItem(SB_KEY, JSON.stringify(serialize(state))) } catch {}
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
