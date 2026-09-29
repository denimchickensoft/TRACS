// Tracks whose owner no longer holds a controller ID in the registry, e.g.
// the owner closed TRACS or came back under a different ID. Nothing drops
// these automatically: right after joining, or during a network split, the
// registry can be incomplete and every track would look orphaned, so a
// controller decides with .FORCEDROP ALL.
//
// ownership: { [unitId]: controllerId }, knownIds: Set of controller IDs.
export function findOrphanedTracks(ownership, knownIds) {
  return Object.entries(ownership)
    .filter(([, owner]) => owner && !knownIds.has(owner))
    .map(([unitId]) => unitId)
}
