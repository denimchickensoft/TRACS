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
 * Duplicate letter handling (two controllers with the same typeLetter in the
 * same group) is resolved at WebRTC merge time. For now only one controller
 * per client, so duplicates cannot occur locally.
 */

// Letters that are reserved for defined position types — duplicates must
// not reuse these.
const RESERVED = new Set(['C', 'A', 'D', 'R', 'T', 'G'])

// Ordered pool for duplicate assignment (excludes reserved letters)
const DUPE_POOL = Array.from('BEFHIJKLMNOPQSUVWXYZ')

function nextAvailableLetter(usedLetters) {
  return DUPE_POOL.find((l) => !usedLetters.has(l)) ?? null
}

export const useControllersStore = create((set, get) => ({
  // { [positionName]: ControllerEntry }
  registry: {},

  // { [facilityPrefix]: groupNumber }  — sticky for session
  groupAssignments: {},
  nextGroupNumber: 1,

  // Loaded from /positionTypes.json
  positionTypes: [],

  // ── Load position type definitions ───────────────────────────────
  loadPositionTypes: async () => {
    try {
      const res  = await fetch('/positionTypes.json')
      const data = await res.json()
      set({ positionTypes: data.positionTypes ?? [] })
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

    // Determine type letter — handle duplicates within the same group
    let letter = typeDef?.letter ?? null
    if (letter !== null) {
      // Check if this letter is already used by another controller in this group
      const usedInGroup = new Set(
        Object.values(registry)
          .filter((e) => e.groupNumber === groupNumber && e.letter !== null)
          .map((e) => e.letter)
      )
      if (usedInGroup.has(letter)) {
        // Duplicate — assign next available non-reserved letter
        letter = nextAvailableLetter(usedInGroup)
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
