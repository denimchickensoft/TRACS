import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

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

    if (registry[positionName]) return  // already registered

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

  // ── Rebuild from client list ──────────────────────────────────────
  // Called whenever the WebRTC client list changes. Deterministic — all
  // peers arrive at the same IDs from the same sorted client list.
  rebuildFromClientList: (clientList) => {
    set({ _cachedClientList: clientList })
    const { positionTypes } = get()
    if (positionTypes.length === 0) {
      console.warn('[controllers] rebuildFromClientList called before positionTypes loaded — IDs will be null until loadPositionTypes completes')
    }

    const sorted = [...clientList].sort((a, b) => a.connectedAt - b.connectedAt)

    const registry        = {}
    const groupAssignments = {}
    let nextGroupNumber   = 1

    for (const client of sorted) {
      const { position, facility, suffix, frequency } = client
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
        if (used.has(letter)) {
          letter = nextAvailableLetter(used)
        }
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

syncStore(useControllersStore, 'tracs-controllers', (s) => ({
  registry:        s.registry,
  groupAssignments: s.groupAssignments,
  nextGroupNumber:  s.nextGroupNumber,
}))
