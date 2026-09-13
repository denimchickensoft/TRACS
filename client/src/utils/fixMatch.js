// Shared "is this named waypoint actually a real fix" check for flight-plan
// import (.miz / DTC route waypoints). Deliberately a name-lookup-plus-
// sanity-check, NOT a nearest-neighbor search: a mission-specific label like
// "REJOIN" that happens to sit near a real fix must never get silently
// rewritten to that unrelated fix. See resources/specs/pilot-flightplan-ingestion-spec.md §3.

import { useNavdataStore } from '../store/navdata.js'
import { nmBetween } from './findNearestBogey.js'

const MATCH_TOLERANCE_NM = 1

// Returns the matched fix id if `name` exists in the current theatre's
// navdata (fixes/navaids/runway centerlines/airports -- see
// useNavdataStore.lookupFix) AND its real position is within
// MATCH_TOLERANCE_NM of (lat, lng). Otherwise null -- caller should fall back
// to a raw coordinate token (see utils/coords.js formatIcaoRoutePoint).
export function matchFixName(name, lat, lng) {
  if (!name || lat == null || lng == null) return null
  const hit = useNavdataStore.getState().lookupFix(name)
  if (!hit) return null
  const dist = nmBetween({ lat, lng }, { lat: hit.lat, lng: hit.lon })
  return dist <= MATCH_TOLERANCE_NM ? hit.id : null
}

// CSV route tokens have no independent coordinate to sanity-check against --
// existence in navdata is the only signal available (see spec §5).
export function fixNameExists(name) {
  if (!name) return false
  return useNavdataStore.getState().lookupFix(name) != null
}
