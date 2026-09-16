import { create } from 'zustand'

/**
 * Controller registry.
 *
 * Tracks every controller in the session (currently just self — peers are
 * added when WebRTC is built). Derives controller IDs and position symbols
 * from facility prefix, position suffix, and sign-on order.
 *
 * Controller ID format:  {groupNumber}{typeLetter}  e.g. "1T", "2A"
 * Position symbol:       typeLetter                 e.g. "T", "A"
 *
 * Group numbers are assigned by order of first sign-on per unique facility
 * prefix and are sticky for the session (they never change or free up).
 *
 * Controllers whose position type has canAssumeTrack: false (GND, DEL) are
 * registered for display purposes only — they have no controllerId or
 * position symbol and cannot receive handoffs or assume tracks.
 *
 * Duplicate letter handling: letters are globally unique across the session —
 * no two controllers share a letter regardless of facility. Collisions are
 * resolved by assigning the next available letter in alphabetical order.
 */

const ALL_LETTERS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')

function nextAvailableLetter(usedLetters) {
  return ALL_LETTERS.find((l) => !usedLetters.has(l)) ?? null
}

function globalUsedLetters(registry) {
  return new Set(Object.values(registry).map((e) => e.letter).filter(Boolean))
}

// Deterministically resolve any duplicate controllerId across positionNames —
// e.g. from a split-brain P2P session where two independently-hosting peers
// each minted their own "1A" before merging. Keeps the entry that registered
// first (by clientList connectedAt, tie-broken by positionName so every peer
// computing this over the same inputs reaches the same answer), re-mints the
// loser(s) via the same nextAvailableLetter/globalUsedLetters machinery
// registerController uses. See feedback_webrtc_relay_sync_invariants memory,
// invariant #4 — this is the backstop for every registry merge, not just one
// call site, so it's wired into setRegistry() itself.
function dedupeByControllerId(registry, clientList) {
  const connectedAtByPos = Object.fromEntries(clientList.map((c) => [c.position, c.connectedAt ?? Infinity]))
  const byId = {}
  for (const [pos, entry] of Object.entries(registry)) {
    if (!entry.controllerId) continue
    ;(byId[entry.controllerId] ??= []).push(pos)
  }
  let next = registry
  for (const positions of Object.values(byId)) {
    if (positions.length < 2) continue
    const [, ...losers] = [...positions].sort((a, b) => {
      const da = connectedAtByPos[a] ?? Infinity, db = connectedAtByPos[b] ?? Infinity
      return da !== db ? da - db : a.localeCompare(b)
    })
    for (const pos of losers) {
      const entry  = next[pos]
      const letter = nextAvailableLetter(globalUsedLetters(next))
      next = {
        ...next,
        [pos]: {
          ...entry, letter, positionSymbol: letter,
          controllerId: (entry.canAssumeTrack && letter) ? `${entry.groupNumber}${letter}` : null,
        },
      }
      console.warn(`[controllers] duplicate controllerId collision resolved: re-minted ${pos}`)
    }
  }
  return next
}

export const useControllersStore = create((set, get) => ({
  // { [positionName]: ControllerEntry }
  registry: {},

  // { [facilityPrefix]: groupNumber }  — sticky for session
  groupAssignments: {},
  nextGroupNumber: 1,

  // Loaded from /positionTypes.json
  positionTypes: [],

  // Last clientList passed to rebuildFromClientList — used to re-run if positionTypes
  // load after the first rebuild call (avoids null controllerId on late-load).
  _cachedClientList: [],

  // ── Load position type definitions ───────────────────────────────
  loadPositionTypes: async () => {
    try {
      const res  = await fetch('/positionTypes.json')
      const data = await res.json()
      set({ positionTypes: data.positionTypes ?? [] })
      const cached = get()._cachedClientList
      if (cached.length > 0) get().rebuildFromClientList(cached)
    } catch (err) {
      console.error('[controllers] Failed to load positionTypes.json', err)
    }
  },

  // ── Register a controller ─────────────────────────────────────────
  /**
   * @param {string} positionName  Constructed callsign, e.g. "UGKO_TWR"
   * @param {{ facility: string, suffix: string, frequency: string }} info
   */
  registerController: (positionName, { facility, suffix, frequency }) => {
    const { registry, groupAssignments, nextGroupNumber, positionTypes } = get()

    // Allow finalizing a pending stub (registerPendingController below) —
    // only a real, already-minted entry blocks re-registration.
    if (registry[positionName] && !registry[positionName].pending) return

    const typeDef = positionTypes.find((t) => t.suffix === suffix)

    // Assign group number for this facility (sticky once assigned)
    let groupNumber = groupAssignments[facility]
    const newGroupAssignments = { ...groupAssignments }
    let newNextGroupNumber = nextGroupNumber
    if (groupNumber === undefined) {
      groupNumber = nextGroupNumber
      newGroupAssignments[facility] = groupNumber
      newNextGroupNumber = nextGroupNumber + 1
    }

    // Determine type letter — globally unique across the session
    let letter = typeDef?.letter ?? null
    if (letter !== null) {
      const used = globalUsedLetters(registry)
      if (used.has(letter)) {
        letter = nextAvailableLetter(used)
      }
    }

    const canAssumeTrack = typeDef?.canAssumeTrack ?? false
    const controllerId   = (canAssumeTrack && letter) ? `${groupNumber}${letter}` : null
    const positionSymbol = letter  // single char; null for GND/DEL

    set({
      registry: {
        ...registry,
        [positionName]: {
          positionName,
          facility,
          suffix,
          frequency,
          letter,
          controllerId,
          positionSymbol,
          canAssumeTrack,
          groupNumber,
          displayName: typeDef?.displayName ?? suffix,
        },
      },
      groupAssignments: newGroupAssignments,
      nextGroupNumber:  newNextGroupNumber,
    })
  },

  // ── Register a pending controller (self-registration before authority is
  // known) ─────────────────────────────────────────────────────────────────
  // Called at sign-in (Login.jsx), before initWebrtc() has even run — i.e.
  // before we can know whether we're the session host (P2P/Nostr) or what
  // the relay's authoritative registry says (relay transport). Writes a
  // stub with no controllerId so nothing can self-mint against an
  // incomplete view (see feedback_webrtc_relay_sync_invariants memory,
  // invariant #2). finalizeController() below promotes this to a real,
  // minted entry once the actual authority is known. canAssumeTrack/
  // displayName are still safe to resolve immediately, since they're derived
  // purely from local positionTypes.json, not from any authority.
  registerPendingController: (positionName, { facility, suffix, frequency }) => {
    const { registry, positionTypes } = get()
    if (registry[positionName] && !registry[positionName].pending) return  // already finalized

    const typeDef        = positionTypes.find((t) => t.suffix === suffix)
    const canAssumeTrack = typeDef?.canAssumeTrack ?? false

    set({
      registry: {
        ...registry,
        [positionName]: {
          positionName, facility, suffix, frequency,
          letter: null, controllerId: null, positionSymbol: null,
          canAssumeTrack, groupNumber: null,
          displayName: typeDef?.displayName ?? suffix,
          pending: true,
        },
      },
    })
  },

  // Finalizes a pending stub written by registerPendingController(), using
  // the stub's own stored facility/suffix/frequency — i.e. re-runs
  // registerController() for real, now that its loosened guard allows a
  // pending entry through instead of no-op'ing.
  finalizeController: (positionName) => {
    const entry = get().registry[positionName]
    if (!entry?.pending) return
    get().registerController(positionName, {
      facility: entry.facility, suffix: entry.suffix, frequency: entry.frequency,
    })
  },

  // ── Rebuild from client list ──────────────────────────────────────
  // Called whenever the WebRTC client list changes. Additive — existing
  // registry entries are preserved and departed peers are removed. Only
  // new peers (not yet in the registry) have IDs assigned. This means
  // the host is the sole authority that ever mints new IDs; non-host
  // peers receive IDs via CLU (setRegistry) so their rebuildFromClientList
  // calls only prune departed entries without reassigning anything.
  rebuildFromClientList: (clientList) => {
    set({ _cachedClientList: clientList })
    const { registry: prevRegistry, groupAssignments: prevGroups, nextGroupNumber: prevNext, positionTypes } = get()
    if (positionTypes.length === 0) {
      console.warn('[controllers] rebuildFromClientList called before positionTypes loaded — IDs will be null until loadPositionTypes completes')
    }

    const positions = new Set(clientList.map((c) => c.position))

    // Start from existing registry, removing entries for departed peers.
    // Remaining entries are carried over unchanged — IDs are never reassigned.
    const registry = {}
    for (const [pos, entry] of Object.entries(prevRegistry)) {
      if (positions.has(pos)) registry[pos] = entry
    }

    // Group assignments are sticky — never reset or freed, even when all
    // controllers for a facility leave. This prevents group-number churn
    // if they reconnect later.
    const groupAssignments = { ...prevGroups }
    let nextGroupNumber    = prevNext

    // Assign IDs only for peers not yet in the registry (new arrivals).
    // On non-host peers this loop is effectively a no-op: new arrivals are
    // added to the registry via setRegistry (CLU) before syncPeers runs.
    const sorted = [...clientList].sort((a, b) => a.connectedAt - b.connectedAt)
    for (const client of sorted) {
      const { position, facility, suffix, frequency } = client
      if (registry[position]) continue  // preserve existing entry — no reassignment
      if (!facility || !suffix) continue

      const typeDef = positionTypes.find((t) => t.suffix === suffix)

      let groupNumber = groupAssignments[facility]
      if (groupNumber === undefined) {
        groupNumber = nextGroupNumber++
        groupAssignments[facility] = groupNumber
      }

      let letter = typeDef?.letter ?? null
      if (letter !== null) {
        const used = globalUsedLetters(registry)
        if (used.has(letter)) letter = nextAvailableLetter(used)
      }

      const canAssumeTrack = typeDef?.canAssumeTrack ?? false
      const controllerId   = (canAssumeTrack && letter) ? `${groupNumber}${letter}` : null

      registry[position] = {
        positionName:   position,
        facility,
        suffix,
        frequency,
        letter,
        controllerId,
        positionSymbol: letter,
        canAssumeTrack,
        groupNumber,
        displayName:    typeDef?.displayName ?? suffix,
      }
    }

    set({ registry, groupAssignments, nextGroupNumber })
  },

  // ── Apply host-assigned registry ──────────────────────────────────
  // Used by non-hosts when receiving a CLU or STATE_DUMP that carries
  // the host's authoritative registry (or, on relay transport, a
  // registry_update from the relay itself). Replaces local state wholesale
  // so the authority's group numbers and letters are canonical. Runs the
  // dedup backstop on every call — see dedupeByControllerId above — since
  // any caller could in principle be passing in a registry that unioned two
  // independently-minted views (e.g. a P2P split-brain host election).
  // clientList is only used for the dedup pass's connectedAt tie-break, not
  // stored.
  setRegistry: (registry, groupAssignments = {}, nextGroupNumber = 1, clientList = []) =>
    set({ registry: dedupeByControllerId(registry, clientList), groupAssignments, nextGroupNumber }),

  // ── Convenience selectors ─────────────────────────────────────────
  getEntry:          (positionName) => get().registry[positionName] ?? null,
  getPositionSymbol: (positionName) => get().registry[positionName]?.positionSymbol ?? null,
  canAssumeTrack:    (positionName) => get().registry[positionName]?.canAssumeTrack  ?? false,

  // Returns all registered controllers as an array, sorted by group then suffix
  getAll: () =>
    Object.values(get().registry).sort((a, b) =>
      a.groupNumber !== b.groupNumber
        ? a.groupNumber - b.groupNumber
        : a.suffix.localeCompare(b.suffix)
    ),
}))

// ── Cross-window registry sync ────────────────────────────────────────────────
// One-directional: main windows broadcast every rebuild but never apply incoming
// state. The correction path for main windows is STATE_DUMP → rebuildFromClientList,
// not BroadcastChannel. Popups have no WebRTC and rely entirely on receiving.
const _isPopup = !!new URLSearchParams(window.location.search).get('window')
const _ctrlCh  = new BroadcastChannel('tracs-controllers')
const _pick    = (s) => ({ registry: s.registry, groupAssignments: s.groupAssignments, nextGroupNumber: s.nextGroupNumber })

if (!_isPopup) {
  useControllersStore.subscribe((state) => _ctrlCh.postMessage({ type: 'STATE_UPDATE', state: _pick(state) }))
  _ctrlCh.onmessage = (e) => {
    if (e.data?.type === 'REQUEST_STATE') _ctrlCh.postMessage({ type: 'STATE_UPDATE', state: _pick(useControllersStore.getState()) })
  }
} else {
  _ctrlCh.onmessage = (e) => {
    if (e.data?.type === 'STATE_UPDATE') useControllersStore.setState(e.data.state)
  }
  _ctrlCh.postMessage({ type: 'REQUEST_STATE' })
}
