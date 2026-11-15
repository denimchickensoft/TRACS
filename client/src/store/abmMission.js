// Imported ATO/FRAG mission data for the ABM sidebar. Persisted to
// localStorage (survives a page refresh, browser crash, or full restart —
// the loaded mission and any in-store edits aren't lost, so it isn't a
// re-import-every-session flow like CATCC's MissionImport), and also synced
// live across same-machine windows (main window + undocked ATO/FRAG popups)
// via BroadcastChannel — same pattern as store/statusBoard.js. Flights are
// local to this controller's imported mission and aren't broadcast to other
// controllers, except for the IFF/manual-flight changes described below.
//
// "flights" not "packages": each entry is the units of one DCS group that
// share a base unit name (parseMission.js findAtoFlights), so a group with
// ELVIS-5-x and HAWK-1-x is two flights, keyed by `flightId`. DCS has no
// native concept of a multi-flight "package" (strikers+SEAD+escort
// coordinated for one mission), so that word never described this data.

import { create } from 'zustand'
import { resolveCallsign, stripAcid } from '../utils/callsign.js'
import { createBroadcastHook } from '../utils/broadcastRegistry.js'
import { shallowEqual } from '../utils/storeSync.js'
import { mergeMissionFlights } from '../missionData/merge.js'
import { getFlightLinks } from '../utils/flightLinks.js'
import { useUnitsStore } from './units.js'

const SB_KEY = 'tracs.abm.mission'

function serialize(s) {
  return {
    flights: s.flights, importedAt: s.importedAt, selectedFlightId: s.selectedFlightId, selectNonce: s.selectNonce,
    findRequest: s.findRequest, findNonce: s.findNonce, findKey: s.findKey,
    blinkIds: s.blinkIds,
    routeVisible: s.routeVisible,
    routeFlightIds: s.routeFlightIds,
    taskOverrides: s.taskOverrides,
    nextManualId: s.nextManualId,
    missionId: s.missionId,
    version: 2,
  }
}

// State saved before flights were split out of DCS groups is keyed by
// groupId and has no unit names. Manual flights carry over under their old
// (negative) id; imported ones are dropped, so the mission is re-imported.
function migrate(saved) {
  if (!saved || saved.version === 2) return saved
  const flights = (saved.flights ?? []).filter((f) => f.manual).map(({ groupId, ...f }) => ({ ...f, flightId: f.flightId ?? groupId }))
  const keep = new Set(flights.map((f) => String(f.flightId)))
  const taskOverrides = Object.fromEntries(Object.entries(saved.taskOverrides ?? {}).filter(([id]) => keep.has(id)))
  return { flights, taskOverrides, nextManualId: saved.nextManualId, version: 2 }
}

function loadSaved() {
  try { return migrate(JSON.parse(localStorage.getItem(SB_KEY) ?? 'null')) } catch { return null }
}

const liveLinks = (flights) => getFlightLinks(flights, useUnitsStore.getState().units)

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

// The roster row a normalized callsign names, across every flight: a manual
// flight's iffRoster row by its callsign; an imported unit by its linked live
// unit's callsign, else its unit name. `key` is what setUnitIff takes.
function findRosterRow(flights, wanted) {
  if (!wanted) return null
  const links = liveLinks(flights)
  for (const f of flights) {
    if (f.manual) {
      const u = f.iffRoster?.find((r) => stripAcid(r.callsign ?? '') === wanted)
      if (u) return { flight: f, key: u.callsign }
      continue
    }
    const i = (f.units ?? []).findIndex((u, idx) => {
      const live = links.live(f, idx)
      return (live && resolveCallsign(live.unit) === wanted) || stripAcid(u.unitName ?? '') === wanted
    })
    if (i >= 0) return { flight: f, key: f.units[i].unitName }
  }
  return null
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
  selectedFlightId: saved.selectedFlightId ?? null,
  // Bumped on every selectFlight() call, even reselecting the same group —
  // lets App.jsx's "open FRAG on selection" effect fire every time (a plain
  // selectedFlightId dependency wouldn't change, and the effect wouldn't
  // re-run, if the panel was closed and the same contact clicked again).
  selectNonce: saved.selectNonce ?? 0,

  // A FRAG panel's Base/route-waypoint click — request for AbmScope (the
  // only place holding theatre navdata/runway/unit data, and never undocked
  // itself) to resolve the ref to a position and drop a .find-style marker
  // on the scope. Bumped nonce so re-clicking the same ref re-fires even
  // though the ref object itself didn't change. findKey is a caller-supplied
  // id (e.g. "base-<flightId>" or "wp-<flightId>-<i>") FRAG compares against
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
  // Base/waypoint find. Reset to false on every selectFlight() (including
  // reselecting the same flight) so a newly-opened FRAG always starts with
  // the route hidden until the controller explicitly asks for it.
  routeVisible: saved.routeVisible ?? false,

  // Ctrl+right-click / .route + click / .route <callsign> — independent of
  // FRAG's own routeVisible+selectedFlightId toggle above (that one always
  // resets on selectFlight() and is tied to whichever flight the panel has
  // open). This is a Set of flightIds, same "multiple independent targets"
  // shape as blinkIds, so several contacts' routes can be shown on the scope
  // at once without opening FRAG or disturbing its own route toggle.
  routeFlightIds: saved.routeFlightIds ?? [],

  // FRAG's editable TASKING/Task field — a controller override of the
  // mission's own task string, keyed by flightId. ATO's TASK column reads
  // the same map so an edit in FRAG is immediately reflected there too.
  taskOverrides: saved.taskOverrides ?? {},

  // Manually-added flights (AddAtoFlight.jsx) get a negative flightId — real
  // DCS group IDs are always positive, so this can never collide with an
  // imported flight's own id. Monotonic and persisted so ids never get
  // reused even across a reload.
  nextManualId: saved.nextManualId ?? -1,
  // The running mission whose flights were auto-loaded (missionData/areas.js),
  // null after a manual load or a clear.
  missionId: saved.missionId ?? null,

  // Replaces the previous .miz's flights but keeps any manually-added ones —
  // loading a new mission shouldn't delete flights the controller typed in
  // by hand (AddAtoFlight.jsx) — and any stacked static-template flights.
  setFlights: (flights) => set((s) => ({
    flights: [...flights, ...s.flights.filter(f => f.manual || f.source === 'stm')],
    importedAt: Date.now(),
    selectedFlightId: null,
    missionId: null,
  })),

  // A mission auto-load: a different mission than the one auto-loaded last
  // replaces the imported flights as setFlights does; the same one (or
  // after a manual load) only adds flights not loaded yet, so edits to the
  // ones already there stay.
  loadMissionFlights: (flights, missionId) => set((s) => {
    const { flights: next, replaced } = mergeMissionFlights(s, flights, missionId)
    return { flights: next, importedAt: Date.now(), missionId, ...(replaced ? { selectedFlightId: null } : {}) }
  }),

  // Static-template (.stm) flights stack across loads: each squadron's file
  // adds its own flights, and a flight already loaded under the same flightId
  // (same coalition + group name, see parseMission.js's templateGroupId) is
  // replaced, so a resent file updates its flights instead of duplicating.
  mergeTemplateFlights: (flights) => set((s) => {
    const incoming = new Set(flights.map(f => f.flightId))
    return {
      flights: [...s.flights.filter(f => !incoming.has(f.flightId)), ...flights],
      importedAt: Date.now(),
      selectedFlightId: null,
    }
  }),

  // Clear Mission — drops only the imported flights (and their task
  // overrides), leaving manually-added ones alone. Bare find/blink state is
  // still wiped either way, since a stale marker/blink has no meaning once
  // whatever it was pointing at is gone.
  clearFlights: () => set((s) => {
    const keep = new Set(s.flights.filter(f => f.manual).map(f => f.flightId))
    const overrides = {}
    for (const [gid, v] of Object.entries(s.taskOverrides)) {
      if (keep.has(Number(gid))) overrides[gid] = v
    }
    return {
      flights: s.flights.filter(f => f.manual),
      importedAt: null,
      missionId: null,
      selectedFlightId: keep.has(s.selectedFlightId) ? s.selectedFlightId : null,
      findRequest: null, findKey: null, blinkIds: [],
      routeFlightIds: s.routeFlightIds.filter(gid => keep.has(gid)),
      taskOverrides: overrides,
    }
  }),

  // Clear ALL — the CATCC status-board-style full wipe, including
  // manually-added flights. Gated behind a confirm step in the UI.
  clearAllFlights: () => set({
    flights: [], importedAt: null, missionId: null, selectedFlightId: null,
    findRequest: null, findKey: null, blinkIds: [], routeFlightIds: [], taskOverrides: {},
  }),

  // Appends one hand-entered flight (AddAtoFlight.jsx) — additive, unlike
  // setFlights which replaces the whole imported set.
  addFlight: (flight) => set((s) => ({
    flights: [...s.flights, { ...flight, flightId: s.nextManualId, manual: true }],
    nextManualId: s.nextManualId - 1,
  })),

  removeFlight: (flightId) => set((s) => {
    const next = { ...s.taskOverrides }
    delete next[flightId]
    return {
      flights: s.flights.filter(f => f.flightId !== flightId),
      selectedFlightId: s.selectedFlightId === flightId ? null : s.selectedFlightId,
      taskOverrides: next,
    }
  }),

  setTaskOverride: (flightId, value) => set((s) => {
    const next = { ...s.taskOverrides }
    if (value) next[flightId] = value
    else delete next[flightId]
    return { taskOverrides: next }
  }),

  selectFlight: (flightId) => set((s) => ({ selectedFlightId: flightId, selectNonce: s.selectNonce + 1, routeVisible: false })),

  toggleRouteVisible: () => set((s) => ({ routeVisible: !s.routeVisible })),

  clearRouteVisible: () => set({ routeVisible: false }),

  requestFind: (ref, key = null) => set((s) => ({ findRequest: ref, findKey: key, findNonce: s.findNonce + 1 })),

  clearFind: () => set({ findRequest: null, findKey: null }),

  toggleBlink: (unitKey) => set((s) => {
    const next = new Set(s.blinkIds)
    next.has(unitKey) ? next.delete(unitKey) : next.add(unitKey)
    return { blinkIds: [...next] }
  }),

  // Start a blink without toggling — a transponder IDENT onset (see
  // AssociationOwner.jsx) must never cancel one already running from FRAG.
  addBlink: (unitKey) => set((s) => (
    s.blinkIds.includes(unitKey) ? s : { blinkIds: [...s.blinkIds, unitKey] }
  )),

  toggleRouteFlight: (flightId) => set((s) => {
    const next = new Set(s.routeFlightIds)
    next.has(flightId) ? next.delete(flightId) : next.add(flightId)
    return { routeFlightIds: [...next] }
  }),

  clearRouteFlights: () => set({ routeFlightIds: [] }),

  // Live-unit-to-flight correlation for imported flights: group, then unit
  // name, then the element digit of a player's callsign (utils/flightLinks.js).
  resolveFlightIdForUnit: (unit) => {
    if (unit?.id == null) return null
    return liveLinks(get().flights).flightOf(String(unit.id))?.flightId ?? null
  },

  // The setUnitIff key of a live unit's row in `flight`: an imported
  // flight's linked unit name, a manual flight's iffRoster callsign.
  rosterKeyForUnit: (flight, unit) => {
    if (!flight || !unit) return null
    if (flight.manual) {
      const cs = resolveCallsign(unit)
      return flight.iffRoster?.find((u) => stripAcid(u.callsign ?? '') === cs)?.callsign ?? null
    }
    const slot = liveLinks(get().flights).flightOf(String(unit.id))
    return slot?.flightId === flight.flightId ? (flight.units?.[slot.unitIndex]?.unitName ?? null) : null
  },

  // resolveFlightIdForUnit plus manual flights, which have no group ID to
  // match — those correlate by callsign prefix, same rule Ato.jsx/Frag.jsx
  // use (matchLiveByPrefix).
  resolveFlightForUnit: (unit) => {
    const flights = get().flights
    const flightId = get().resolveFlightIdForUnit(unit)
    const byGroup = flightId != null ? flights.find((f) => f.flightId === flightId) : null
    if (byGroup) return byGroup
    const liveCallsign = resolveCallsign(unit)
    if (!liveCallsign) return null
    return flights.find((f) => f.manual && f.callsignPrefix && liveCallsign.startsWith(stripAcid(f.callsignPrefix))) ?? null
  },

  // Assigned/requested altitude for a whole flight — `{ lo, hi }` in 3-digit
  // hundreds of feet (hi null for a hard altitude), or null to clear. Synced
  // to every ABM controller like IFF codes; manual flights carry their
  // callsignPrefix too, since their flightId is minted per controller.
  setFlightAlt: (flightId, alt) => {
    set((s) => ({ flights: s.flights.map((f) => f.flightId !== flightId ? f : { ...f, alt: alt ?? null }) }))
    const flight = get().flights.find((f) => f.flightId === flightId)
    if (!flight) return
    broadcastAbmMission('FRAG_ALT_SET', { flightId, manual: !!flight.manual, callsignPrefix: flight.callsignPrefix ?? null, alt: alt ?? null })
  },

  _applyFlightAlt: ({ flightId, manual, callsignPrefix, alt }) => set((s) => {
    let target = s.flights.find((f) => f.flightId === flightId && !!f.manual === !!manual)
    if (!target && manual && callsignPrefix) target = s.flights.find((f) => f.manual && f.callsignPrefix === callsignPrefix)
    if (!target) return s
    return { flights: s.flights.map((f) => f !== target ? f : { ...f, alt: alt ?? null }) }
  }),

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
  // `unitKey` is the unit name for an imported flight, the callsign for a
  // manual flight's iffRoster row.
  setUnitIff: (flightId, unitKey, iff) => {
    let manual = false
    set((s) => ({
      flights: s.flights.map((f) => {
        if (f.flightId !== flightId) return f
        manual = !!f.manual
        if (manual) {
          const has = (f.iffRoster ?? []).some((u) => u.callsign === unitKey)
          const iffRoster = has
            ? f.iffRoster.map((u) => u.callsign !== unitKey ? u : { ...u, iff: { ...u.iff, ...iff } })
            : [...(f.iffRoster ?? []), { callsign: unitKey, iff }]
          return { ...f, iffRoster }
        }
        return {
          ...f,
          units: (f.units ?? []).map((u) => u.unitName !== unitKey ? u : { ...u, iff: { ...u.iff, ...iff } }),
        }
      }),
    }))
    const flight = get().flights.find((f) => f.flightId === flightId)
    if (!flight) return
    if (manual) broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { flightId, name: flight.name, callsignPrefix: flight.callsignPrefix, coalition: flight.coalition, iffRoster: flight.iffRoster, alt: flight.alt ?? null })
    else broadcastAbmMission('FRAG_IFF_SET', { flightId, unitName: unitKey, iff })
  },

  // Bulk-assign codes from a CSV (matched by callsign against every unit
  // already known across all flights, imported or manual) - assign-only,
  // never creates a new flight/unit. The CSV's callsign column is normalized
  // text (csvIffAssignments.js): an imported unit matches by its live
  // callsign when linked (a player's "HAWK11"), else by its unit name;
  // a manual row by its own (already normalized) callsign. Reuses setUnitIff
  // so the sync/broadcast behavior is identical to a typed edit.
  // @returns {{ matched: string[], skipped: string[] }}
  applyIffCsv: (rows) => {
    const matched = []
    const skipped = []
    for (const row of rows) {
      const found = findRosterRow(get().flights, row.callsign)
      if (!found) { skipped.push(row.callsign); continue }
      matched.push(row.callsign)
      // An undefined mode is a code the parser dropped as invalid - that
      // mode is left as-is rather than cleared.
      const patch = {}
      for (const mode of ['mode1', 'mode2', 'mode3']) {
        if (row[mode] !== undefined) patch[mode] = row[mode]
      }
      if (Object.keys(patch).length) get().setUnitIff(found.flight.flightId, found.key, patch)
    }
    return { matched, skipped }
  },

  // Ctrl+Shift+Click's create-or-reconcile action (AbmScope.jsx) and Frag.jsx's
  // manual "add aircraft" row both call this. Checks across EVERY flight
  // (imported's units[], manual's iffRoster) first — if this exact aircraft
  // already has a roster row anywhere, just return that flight's flightId, no
  // mutation, no duplicate. Only when it's genuinely untracked does this
  // find-or-create the *manual* flight for this callsign-prefix group and
  // add the iffRoster row. Returns the flight's flightId so the caller can
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
    // The caller passes the live callsign ("FORD11"); an imported aircraft
    // matches through its live link or unit name (findRosterRow), or a
    // duplicate manual flight would get created instead.
    const existing = findRosterRow(get().flights, stripAcid(unitCallsign ?? ''))?.flight
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
          flights: s.flights.map((f) => f.flightId !== existing.flightId ? f : {
            ...MANUAL_FLIGHT_DEFAULTS(f.name ?? f.callsignPrefix, f.callsignPrefix, f.coalition ?? coalition),
            ...f,
            coalition: f.coalition ?? coalition,
          }),
        }))
        const patched = get().flights.find((f) => f.flightId === existing.flightId)
        broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { flightId: patched.flightId, name: patched.name, callsignPrefix: patched.callsignPrefix, coalition: patched.coalition, iffRoster: patched.iffRoster, alt: patched.alt ?? null })
      }
      return existing.flightId
    }

    let flight = get().flights.find((f) => f.manual && f.callsignPrefix === callsignPrefix)
    if (!flight) {
      const flightId = get().nextManualId
      flight = { flightId, ...MANUAL_FLIGHT_DEFAULTS(callsignPrefix, callsignPrefix, coalition) }
      set((s) => ({ flights: [...s.flights, flight], nextManualId: s.nextManualId - 1 }))
    }
    set((s) => ({
      flights: s.flights.map((f) => f.flightId !== flight.flightId ? f : { ...f, iffRoster: [...(f.iffRoster ?? []), { callsign: unitCallsign, iff: {} }] }),
    }))
    const finalFlight = get().flights.find((f) => f.flightId === flight.flightId)
    broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { flightId: finalFlight.flightId, name: finalFlight.name, callsignPrefix: finalFlight.callsignPrefix, coalition: finalFlight.coalition, iffRoster: finalFlight.iffRoster, alt: finalFlight.alt ?? null })
    return flight.flightId
  },

  // Removes one row from a manual flight's iffRoster (e.g. a mistyped
  // callsign added via Frag.jsx's "Add Aircraft" input) — the row's live
  // detection (if any, via callsign-prefix matching) is unaffected by this;
  // it just stops carrying an assigned IFF code / a pending pre-add entry.
  removeManualRosterEntry: (flightId, callsign) => {
    set((s) => ({
      flights: s.flights.map((f) => f.flightId !== flightId ? f : { ...f, iffRoster: (f.iffRoster ?? []).filter((u) => u.callsign !== callsign) }),
    }))
    const flight = get().flights.find((f) => f.flightId === flightId)
    if (!flight) return
    broadcastAbmMission('FRAG_MANUAL_FLIGHT_SET', { flightId: flight.flightId, name: flight.name, callsignPrefix: flight.callsignPrefix, coalition: flight.coalition, iffRoster: flight.iffRoster, alt: flight.alt ?? null })
  },

  // Applies an incoming FRAG_IFF_SET/FRAG_MANUAL_FLIGHT_SET broadcast from
  // another controller without re-broadcasting it.
  _applyIffSet: (flightId, unitName, iff) => set((s) => ({
    flights: s.flights.map((f) => f.flightId !== flightId ? f : {
      ...f,
      units: (f.units ?? []).map((u) => u.unitName !== unitName ? u : { ...u, iff: { ...u.iff, ...iff } }),
    }),
  })),

  // Never touches `units` (the placeholder-count array) — only `iffRoster`.
  // A brand-new flight arriving here (another controller's Ctrl+Shift+Click)
  // gets the full MANUAL_FLIGHT_DEFAULTS shape first, same reason the local
  // creation path needs it — the sync payload only ever carries
  // {name, callsignPrefix, coalition, iffRoster}, not route/task/etc., and
  // this receiving controller's own Frag.jsx would crash the same way
  // opening it otherwise.
  // `alt` is absent from older clients' payloads — leave the local value alone then.
  _applyManualFlightSet: (flightId, name, callsignPrefix, coalition, iffRoster, alt) => set((s) => {
    const altPatch = alt === undefined ? {} : { alt }
    const exists = s.flights.some((f) => f.flightId === flightId)
    if (exists) {
      return { flights: s.flights.map((f) => f.flightId !== flightId ? f : { ...f, name, callsignPrefix, coalition, iffRoster, ...altPatch, manual: true }) }
    }
    return { flights: [...s.flights, { flightId, ...MANUAL_FLIGHT_DEFAULTS(name, callsignPrefix, coalition), iffRoster, ...altPatch }] }
  }),
}))

// ── Cross-window sync (main window + undocked ATO/FRAG popups) ─────────────
let _syncing = false

const _ch = new BroadcastChannel('tracs-abm-mission')

useAbmMissionStore.subscribe((state, prev) => {
  if (_syncing || shallowEqual(serialize(state), serialize(prev))) return
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
    useAbmMissionStore.getState()._applyIffSet(payload.flightId, payload.unitName, payload.iff)
  } finally {
    _syncing = false
  }
}

export function applyAbmMissionManualFlightSet(payload) {
  _syncing = true
  try {
    useAbmMissionStore.getState()._applyManualFlightSet(payload.flightId, payload.name, payload.callsignPrefix, payload.coalition, payload.iffRoster, payload.alt)
  } finally {
    _syncing = false
  }
}

export function applyAbmMissionFlightAlt(payload) {
  _syncing = true
  try {
    useAbmMissionStore.getState()._applyFlightAlt(payload)
  } finally {
    _syncing = false
  }
}
