'use strict'

// Server-side port of the position-resolution and controllerId-minting
// algorithms the relay needs in order to be the sole registry authority for
// sessions running on the self-hosted ws-relay transport. Ported from, and
// must be KEPT IN SYNC with:
//   - client/src/webrtc/client.js's resolvePosition()
//   - client/src/store/controllers.js's registerController() minting formula
//     (nextAvailableLetter/globalUsedLetters/group-number assignment)
// Duplicated deliberately rather than shared (small, stable logic; the
// browser-ESM and Node-CommonJS runtimes don't share a build step) — see the
// feedback_webrtc_relay_sync_invariants project memory for the full
// rationale behind relay-side registry authority.

const ALL_LETTERS = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')

function nextAvailableLetter(usedLetters) {
  return ALL_LETTERS.find((l) => !usedLetters.has(l)) ?? null
}

function globalUsedLetters(registry) {
  return new Set(Object.values(registry).map((e) => e.letter).filter(Boolean))
}

// Mirrors client.js's resolvePosition() exactly — collision resolution
// against a list of already-occupied position strings. Callers pass only
// positions currently outside their eviction window (this relay's
// equivalent of client.js's effectiveClientList()), so a genuinely-departed
// position frees up immediately rather than waiting out the full window.
function resolvePosition(requested, occupiedPositions) {
  const taken = new Set(occupiedPositions)
  if (!taken.has(requested)) return requested
  // Insert collision index before the last underscore-delimited segment.
  // e.g. KLAS_APP → KLAS_1_APP, KLAS_2_APP, …
  const lastUnderscore = requested.lastIndexOf('_')
  const prefix = lastUnderscore >= 0 ? requested.slice(0, lastUnderscore) : requested
  const suffix = lastUnderscore >= 0 ? `_${requested.slice(lastUnderscore + 1)}` : ''
  let i = 1
  while (true) {
    const candidate = `${prefix}_${i}${suffix}`
    if (!taken.has(candidate)) return candidate
    i++
  }
}

// Mirrors controllers.js's registerController() minting formula. `hints` is
// the client-resolved { preferredLetter, canAssumeTrack, displayName } —
// the relay is a standalone, independently-deployed app not guaranteed to
// ship alongside client/public/positionTypes.json, so the client (which
// already loads that file for its own registerController() calls) resolves
// these and forwards them as part of the `register` message. See
// client/src/webrtc/client.js's positionTypeHints().
function mintEntry({ position, facility, suffix, frequency, hints, registry, groupAssignments, nextGroupNumber }) {
  let groupNumber = groupAssignments[facility]
  const newGroupAssignments = { ...groupAssignments }
  let newNextGroupNumber = nextGroupNumber
  if (groupNumber === undefined) {
    groupNumber = nextGroupNumber
    newGroupAssignments[facility] = groupNumber
    newNextGroupNumber = nextGroupNumber + 1
  }

  let letter = hints.preferredLetter ?? null
  if (letter !== null) {
    const used = globalUsedLetters(registry)
    if (used.has(letter)) letter = nextAvailableLetter(used)
  }

  const canAssumeTrack = hints.canAssumeTrack ?? false
  const controllerId   = (canAssumeTrack && letter) ? `${groupNumber}${letter}` : null

  const entry = {
    positionName: position,
    facility, suffix, frequency,
    letter, controllerId, positionSymbol: letter,
    canAssumeTrack, groupNumber,
    displayName: hints.displayName ?? suffix,
  }
  return { entry, groupAssignments: newGroupAssignments, nextGroupNumber: newNextGroupNumber }
}

module.exports = { resolvePosition, mintEntry, nextAvailableLetter, globalUsedLetters }
