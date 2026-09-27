// Imported ATO/FRAG mission data for the ABM sidebar. Persisted to
// localStorage (survives a page refresh, browser crash, or full restart —
// the loaded mission and any in-store edits aren't lost, so it isn't a
// re-import-every-session flow like CATCC's MissionImport), and also synced
// live across same-machine windows (main window + undocked ATO/FRAG popups)
// via BroadcastChannel — same pattern as store/statusBoard.js. Flights are
// local to this controller's imported mission and aren't broadcast to other
// controllers, except for the IFF/manual-flight changes described below.
//
// "flights" not "packages": each entry is one DCS Mission Editor Group (one
// callsign, one route, one task) — a real-world "flight." DCS has no native
// concept of a multi-flight "package" (strikers+SEAD+escort coordinated for
// one mission), so that word never described what this data actually is.

import { create } from 'zustand'
import { resolveCallsign, stripAcid } from '../utils/callsign.js'
import { createBroadcastHook } from '../utils/broadcastRegistry.js'

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

// Full field shape a manual flight needs — must match AddAtoFlight.jsx's own
// addFlight() call exactly, since Frag.jsx/Ato.jsx read several of these
// fields (route, task, launch, recovery, ...) unconditionally, with no
// per-field fallback. A flight missing any of them crashes those components
// outright (found live: `flight.route.length` on a flight created via
// ensureManualRosterEntry before this shape existed). `units` stays a
// separate, deliberately-empty placeholder-count array here — see
// setUnitIff's comment for why a real per-aircraft roster can't live there
// for a manual flight; `iffRoster` is that real roster instead.
function MANUAL_FLIGHT_DEFAULTS(name, callsignPrefix, coalition) {
  return {
    manual: true,
    name,
    callsignPrefix,
    coalition,
    task: '',
    rawTask: '',
    frequency: null,
    lateActivation: false,
    uncontrolled: false,
    launch: { type: 'airstart' },
    recovery: { type: 'unknown' },
    route: [],
    units: [],
    iffRoster: [],
  }
}

const saved = loadSaved() ?? {}

// Cross-controller sync — the rest of this store is deliberately
// local-only (see header comment), but per-aircraft IFF assignments
// (Mode 1/2/3) need to reach every ABM controller, not just this browser's other windows.
// Scoped narrowly: only IFF-field changes and manual-flight roster
// creation/edits broadcast — mission import/routes/tasking stay exactly as
// local as they are today.
const { register: registerAbmMissionBroadcast, broadcast: broadcastAbmMission } = createBroadcastHook()
export { registerAbmMissionBroadcast }

export const useAbmMissionStore = create((set, get) => ({
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

  toggleRouteVisible: () => set((s) => ({ routeVisible: !s.routeVisible })),

  clearRouteVisible: () => set({ routeVisible: false }),

  requestFind: (ref, key = null) => set((s) => ({ findRequest: ref, findKey: key, findNonce: s.findNonce + 1 })),

  clearFind: () => set({ findRequest: null, findKey: null }),

  toggleBlink: (unitKey) => set((s) => {
    const next = new Set(s.blinkIds)
    next.has(unitKey) ? next.delete(unitKey) : next.add(unitKey)
    return { blinkIds: [...next] }
  }),

  toggleRouteGroup: (groupId) => set((s) => {
    const next = new Set(s.routeGroupIds)
    next.has(groupId) ? next.delete(groupId) : next.add(groupId)
    return { routeGroupIds: [...next] }
  }),

  clearRouteGroups: () => set({ routeGroupIds: [] }),

  // Live-unit-to-flight correlation. Olympus's unit.groupID is already a
  // real numeric DCS group ID (decoder.js) that matches flight.groupId
  // directly. Tacview's unit.groupID is free text (the ACMI `Group`
  // property — see tacviewCore.js), which can never equal a real numeric
  // groupId, so for that case this falls back to per-unit correlation
  // instead: NOT via unit.unitID (confirmed live to have zero
  // relationship to the mission file's unitId for statically-placed/AI
  // units — Tacview assigns its own object IDs from an internal enumeration
  // counter; see utils/callsign.js's buildLiveUnitLookup for the full
  // account and the real data that disproved the unitID approach), but via
  // normalized-callsign text matching, which does reliably correlate. Works
  // for any unit that existed in the original mission file; a unit spawned
  // only at runtime (never in the .miz) has no match either way, same as it
  // would for Olympus.
  resolveGroupIdForUnit: (unit) => {
    if (typeof unit?.groupID === 'number') return unit.groupID
    const liveCallsign = resolveCallsign(unit)
    if (!liveCallsign) return null
    const match = get().flights.find((f) => f.units?.some((u) => stripAcid(u.callsign ?? '') === liveCallsign))
    return match?.groupId ?? null
  },

  // Sets one unit's assigned Mode 1/2/3 IFF codes (edited from the FRAG
  // window). Imported flights store this directly on their
  // real `units[]` roster (parseMission.js-derived, one entry per aircraft).
  // Manual flights DON'T — their `units[]` is a lightweight placeholder-count
  // array Ato.jsx's NUM/TYPE column reads (`{unitId, type, rawType}`, no
  // callsign, built once at Add Flight time — see AddAtoFlight.jsx's own
  // comment), a completely different shape a real per-aircraft roster can't
  // safely share. Manual flights get their own `iffRoster: [{callsign, iff}]`
  // field instead, left untouched by anything reading `units`.
  //
  // Broadcasts differently per flight type: an imported flight only needs
  // its IFF delta synced (every controller already has the same roster from
  // their own mission import); a manual flight's whole iffRoster gets
  // re-broadcast, since other controllers have no local placeholder to merge
  // a bare delta into (FRAG is local-only otherwise — see header comment).
  setUnitIff: (groupId, unitCallsign, iff) => {
    let manual = false
    set((s) => ({
      flights: s.flights.map((f) => {
        if (f.groupId !== groupId) return f
        manual = !!f.manual
        if (manual) {
          const has = (f.iffRoster ?? []).some((u) => u.callsign === unitCallsign)
          const iffRoster = has
            ? f.iffRoster.map((u) => u.callsign !== unitCallsign ? u : { ...u, iff: { ...u.iff, ...iff } })
            : [...(f.iffRoster ?? []), { callsign: unitCallsign, iff }]
          return { ...f, iffRoster }
        }
        return {
          ...f,
          units: (f.units ?? []).map((u) => u.callsign !== unitCallsign ? u : { ...u, iff: { ...u.iff, ...iff } }),
        }
      }),
    }))
    const flight = get().flights.find((f) => f.groupId === groupId)
    if (!flight) return
    if (manual) broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { groupId, name: flight.name, callsignPrefix: flight.callsignPrefix, coalition: flight.coalition, iffRoster: flight.iffRoster })
    else broadcastAbmMission('FRAG_IFF_SET', { groupId, unitCallsign, iff })
  },

  // Bulk-assign codes from a CSV (matched by callsign against every unit
  // already known across all flights, imported or manual) — assign-only,
  // never creates a new flight/unit. Matched via stripAcid, not exact-equals
  // — the CSV's callsign column is normalized text (csvIffAssignments.js),
  // but an imported roster row's u.callsign is the raw mission-file string
  // (e.g. "HAVOC 1-1"); same normalization resolveGroupIdForUnit and
  // correlationEngine.js already use for the identical problem (manual rows'
  // iffRoster callsigns are already normalized, so stripAcid is a no-op for
  // those). Reuses setUnitIff (passing the row's own raw callsign, not the
  // CSV's normalized one, so setUnitIff's own exact match still finds it) so
  // the sync/broadcast behavior is identical to a manual/typed edit.
  // @returns {{ matched: string[], skipped: string[] }}
  applyIffCsv: (rows) => {
    const matched = []
    const skipped = []
    for (const row of rows) {
      let found = null
      for (const f of get().flights) {
        const u = f.manual
          ? f.iffRoster?.find((u) => stripAcid(u.callsign ?? '') === row.callsign)
          : f.units?.find((u) => stripAcid(u.callsign ?? '') === row.callsign)
        if (u) { found = { flight: f, unit: u }; break }
      }
      if (!found) { skipped.push(row.callsign); continue }
      matched.push(row.callsign)
      get().setUnitIff(found.flight.groupId, found.unit.callsign, { mode1: row.mode1, mode2: row.mode2, mode3: row.mode3 })
    }
    return { matched, skipped }
  },

  // Ctrl+Shift+Click's create-or-reconcile action (AbmScope.jsx) and Frag.jsx's
  // manual "add aircraft" row both call this. Checks across EVERY flight
  // (imported's units[], manual's iffRoster) first — if this exact aircraft
  // already has a roster row anywhere, just return that flight's groupId, no
  // mutation, no duplicate. Only when it's genuinely untracked does this
  // find-or-create the *manual* flight for this callsign-prefix group and
  // add the iffRoster row. Returns the flight's groupId so the caller can
  // select/open it.
  //
  // Real bug found live: a created flight with no `coalition` field is
  // silently invisible to Frag.jsx's own render gate (`found.coalition ===
  // sessionCoalition`, blue/red sessions only) — Ctrl+Shift+Click would open
  // the panel but it'd render nothing at all. `coalition` (the session's own
  // string coalition — AbmScope.jsx passes the caller's own side, or for
  // GM/Admin the clicked aircraft's own 'blue'/'red') must be set on creation, same as
  // AddAtoFlight.jsx's manual flights already do.
  ensureManualRosterEntry: (callsignPrefix, unitCallsign, coalition) => {
    // Imported rosters carry the mission file's callsign ("FORD 1-1") while
    // the caller passes the live one ("FORD11") — compare both normalized,
    // same as resolveGroupIdForUnit, or an imported aircraft never matches
    // and a duplicate manual flight gets created instead.
    const wanted = stripAcid(unitCallsign ?? '')
    const existing = get().flights.find((f) =>
      f.manual
        ? f.iffRoster?.some((u) => stripAcid(u.callsign ?? '') === wanted)
        : f.units?.some((u) => stripAcid(u.callsign ?? '') === wanted)
    )
    if (existing) {
      // Backfill a flight created before this shape was complete (a real
      // case hit live testing this session, not hypothetical — missing
      // `coalition` first, then `route`/`task`/etc. crashed Frag.jsx
      // outright since AddAtoFlight.jsx's manual flights always carry the
      // full MANUAL_FLIGHT_DEFAULTS shape and Frag.jsx reads several of
      // those fields unconditionally). Otherwise this fast path would keep
      // returning the same broken flight forever, never reaching the
      // creation branch below where the full shape actually gets set.
      const missingDefaults = existing.manual && existing.route === undefined
      const missingCoalition = existing.manual && existing.coalition == null && coalition != null
      if (missingDefaults || missingCoalition) {
        set((s) => ({
          flights: s.flights.map((f) => f.groupId !== existing.groupId ? f : {
            ...MANUAL_FLIGHT_DEFAULTS(f.name ?? f.callsignPrefix, f.callsignPrefix, f.coalition ?? coalition),
            ...f,
            coalition: f.coalition ?? coalition,
          }),
        }))
        const patched = get().flights.find((f) => f.groupId === existing.groupId)
        broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { groupId: patched.groupId, name: patched.name, callsignPrefix: patched.callsignPrefix, coalition: patched.coalition, iffRoster: patched.iffRoster })
      }
      return existing.groupId
    }

    let flight = get().flights.find((f) => f.manual && f.callsignPrefix === callsignPrefix)
    if (!flight) {
      const groupId = get().nextManualId
      flight = { groupId, ...MANUAL_FLIGHT_DEFAULTS(callsignPrefix, callsignPrefix, coalition) }
      set((s) => ({ flights: [...s.flights, flight], nextManualId: s.nextManualId - 1 }))
    }
    set((s) => ({
      flights: s.flights.map((f) => f.groupId !== flight.groupId ? f : { ...f, iffRoster: [...(f.iffRoster ?? []), { callsign: unitCallsign, iff: {} }] }),
    }))
    const finalFlight = get().flights.find((f) => f.groupId === flight.groupId)
    broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { groupId: finalFlight.groupId, name: finalFlight.name, callsignPrefix: finalFlight.callsignPrefix, coalition: finalFlight.coalition, iffRoster: finalFlight.iffRoster })
    return flight.groupId
  },

  // Removes one row from a manual flight's iffRoster (e.g. a mistyped
  // callsign added via Frag.jsx's "Add Aircraft" input) — the row's live
  // detection (if any, via callsign-prefix matching) is unaffected by this;
  // it just stops carrying an assigned IFF code / a pending pre-add entry.
  removeManualRosterEntry: (groupId, callsign) => {
    set((s) => ({
      flights: s.flights.map((f) => f.groupId !== groupId ? f : { ...f, iffRoster: (f.iffRoster ?? []).filter((u) => u.callsign !== callsign) }),
    }))
    const flight = get().flights.find((f) => f.groupId === groupId)
    if (!flight) return
    broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { groupId: flight.groupId, name: flight.name, callsignPrefix: flight.callsignPrefix, coalition: flight.coalition, iffRoster: flight.iffRoster })
  },

  // Applies an incoming FRAG_IFF_SET/FRAG_MANUAL_FLIGHT_SET broadcast from
  // another controller without re-broadcasting it.
  _applyIffSet: (groupId, unitCallsign, iff) => set((s) => ({
    flights: s.flights.map((f) => f.groupId !== groupId ? f : {
      ...f,
      units: (f.units ?? []).map((u) => u.callsign !== unitCallsign ? u : { ...u, iff: { ...u.iff, ...iff } }),
    }),
  })),

  // Never touches `units` (the placeholder-count array) — only `iffRoster`.
  // A brand-new flight arriving here (another controller's Ctrl+Shift+Click)
  // gets the full MANUAL_FLIGHT_DEFAULTS shape first, same reason the local
  // creation path needs it — the sync payload only ever carries
  // {name, callsignPrefix, coalition, iffRoster}, not route/task/etc., and
  // this receiving controller's own Frag.jsx would crash the same way
  // opening it otherwise.
  _applyManualFlightSet: (groupId, name, callsignPrefix, coalition, iffRoster) => set((s) => {
    const exists = s.flights.some((f) => f.groupId === groupId)
    if (exists) {
      return { flights: s.flights.map((f) => f.groupId !== groupId ? f : { ...f, name, callsignPrefix, coalition, iffRoster, manual: true }) }
    }
    return { flights: [...s.flights, { groupId, ...MANUAL_FLIGHT_DEFAULTS(name, callsignPrefix, coalition), iffRoster }] }
  }),
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

// Apply an incoming WebRTC FRAG_IFF_SET/FRAG_MANUAL_FLIGHT_SET payload
// (webrtc/handlers.js) without triggering re-broadcast — mirrors
// store/statusBoard.js's applyStatusBoardUpdate.
export function applyAbmMissionIffSet(payload) {
  _syncing = true
  try {
    useAbmMissionStore.getState()._applyIffSet(payload.groupId, payload.unitCallsign, payload.iff)
  } finally {
    _syncing = false
  }
}

export function applyAbmMissionManualFlightSet(payload) {
  _syncing = true
  try {
    useAbmMissionStore.getState()._applyManualFlightSet(payload.groupId, payload.name, payload.callsignPrefix, payload.coalition, payload.iffRoster)
  } finally {
    _syncing = false
  }
}
