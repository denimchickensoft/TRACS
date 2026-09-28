import { toMagneticFromTrue, gridBearingRangeNm } from './bearing.js'
import { M_TO_FT } from './units.js'

export const NM_TO_FEET = 6076.115

// Known DCS carrier unit type names (unit.name field from Olympus).
// Used to filter NavyUnits to carriers only, and to supply per-type metadata.
//
// deckImage/deckLoaFt/deckBeamFt are for the CATCC DECK tab (Deck.jsx):
// deckImage is a bow-right top-down plan view under client/public/carriers/,
// deckLoaFt/deckBeamFt are the effective length/beam used to calibrate
// aircraft positions onto it — see projectOntoDeck() below, which maps
// forwardFt/rightFt = 0 to the image's plain geometric center. A per-carrier
// origin correction was tried and dropped as not worth the complexity — see
// git history if revisiting.
//
// nimitz.png's numbers are measured, not textbook LOA/beam: deckLoaFt/
// deckBeamFt came out larger than published hull LOA/beam because the
// artwork depicts the flight deck outline (catwalks, sponsons, elevator
// overhang), not the waterline hull. Forrestal/Kuznetsov/Tarawa are still
// uncalibrated textbook approximations.
export const CARRIER_TYPES = {
  // Standard (non-supercarrier module)
  'Stennis':    { displayName: 'CVN-74 John C. Stennis',        tacticalName: 'Courage',      deckOffset: 9, deckHeightFt: 65, facilityId: 'CV74', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303 },
  'Forrestal':  { displayName: 'CV-59 Forrestal',               tacticalName: 'Forrestal',    deckOffset: 9, deckHeightFt: 65, facilityId: 'CV59', deckImage: 'forrestal.png',  deckLoaFt: 1039, deckBeamFt: 252 },
  'Kuznetsov':  { displayName: 'Admiral Kuznetsov',             tacticalName: 'Kuznetsov',    deckOffset: 0, deckHeightFt: 70, facilityId: 'KUZN', deckImage: 'kuznetsov.png',  deckLoaFt: 1001, deckBeamFt: 236 },
  'LHA_Tarawa': { displayName: 'LHA-1 Tarawa',                  tacticalName: 'Tarawa',       deckOffset: 0, deckHeightFt: 70, facilityId: 'LHA1', deckImage: 'tarawa.png',     deckLoaFt: 820,  deckBeamFt: 106 },
  // Supercarrier module (CVN_XX naming convention)
  'CVN_71':     { displayName: 'CVN-71 Theodore Roosevelt',     tacticalName: 'Rough Rider',  deckOffset: 9, deckHeightFt: 72, facilityId: 'CV71', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303 },
  'CVN_72':     { displayName: 'CVN-72 Abraham Lincoln',        tacticalName: 'Union',        deckOffset: 9, deckHeightFt: 72, facilityId: 'CV72', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303 },
  'CVN_73':     { displayName: 'CVN-73 George Washington',      tacticalName: 'Warfighter',   deckOffset: 9, deckHeightFt: 72, facilityId: 'CV73', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303 },
  'CVN_74':     { displayName: 'CVN-74 John C. Stennis',        tacticalName: 'Courage',      deckOffset: 9, deckHeightFt: 72, facilityId: 'CV74', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303 },
  'CVN_75':     { displayName: 'CVN-75 Harry S. Truman',        tacticalName: 'Lone Warrior', deckOffset: 9, deckHeightFt: 72, facilityId: 'CV75', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303 },
}

export function isCarrierUnit(unit) {
  return unit?.category === 'NavyUnit' && CARRIER_TYPES[unit.name] != null
}

// ≈2 kt — a non-airborne aircraft's (relative) ground speed above this
// counts as TAXI rather than GROUND (parked). Same value whether the
// comparison below ends up being absolute or carrier-relative.
const TAXI_THRESHOLD_MPS = 1.0

// Non-airborne ground state ('TAXI' | 'GROUND') for a single aircraft.
// For a carrier-based flight, compares the aircraft's velocity against the
// carrier's own (vector subtraction via speed+track) rather than absolute
// ground speed — a jet parked on a moving carrier otherwise reads as
// constantly "taxiing" at the ship's own speed. No deck-footprint check
// needed: a non-airborne aircraft whose flight's TASKUNIT is a carrier is
// necessarily on that carrier. carrierUnit is the carrier's live Olympus
// unit (the caller looks it up via the flight's base.carrierUnitId), or
// null/undefined if not yet live — falls back to absolute speed in that case.
export function groundState(unit, isCarrierBase, carrierUnit) {
  let speed = unit.speed ?? 0
  if (isCarrierBase && carrierUnit) {
    const acTrack = unit.track ?? 0
    const cvTrack = carrierUnit.track ?? 0
    const relVx = speed * Math.sin(acTrack) - (carrierUnit.speed ?? 0) * Math.sin(cvTrack)
    const relVy = speed * Math.cos(acTrack) - (carrierUnit.speed ?? 0) * Math.cos(cvTrack)
    speed = Math.hypot(relVx, relVy)
  }
  return speed > TAXI_THRESHOLD_MPS ? 'TAXI' : 'GROUND'
}

// Carrier BRC (Base Recovery Course) and FB (Final Bearing), the single
// source of truth — this used to be reimplemented independently in
// CatccScope.jsx, StatusBoard.jsx, and Par.jsx, and only one of the three
// got it right.
//
// gridHeadingDeg is carrier.heading (radians -> degrees) — DCS telemetry.
// Declination is the only correction needed (see utils/magvar.js) — DCS's
// own displayed "True" heading matches this raw value, so treat it as the
// same true-referenced frame as everything else. Returns unrounded degrees;
// callers round/normalize (e.g. 0 -> 360) for their own display.
export function computeCarrierBrcFb(gridHeadingDeg, declinationDeg, deckOffsetDeg = 9) {
  const brc = toMagneticFromTrue(gridHeadingDeg, declinationDeg)
  const fb  = ((brc - deckOffsetDeg) % 360 + 360) % 360
  return { brc, fb }
}

// Projects an aircraft's lat/lng onto the carrier's own body-fixed frame —
// forwardFt positive toward the bow, rightFt positive toward starboard —
// for the CATCC DECK tab. Uses carrier.heading directly (not BRC/magnetic):
// this is a hull-relative frame, not a compass-relative one.
//
// onDeck is a generous hull-footprint bounding box (+60ft margin for
// catapult/sponson overhang beyond deckLoaFt/deckBeamFt) — callers should
// still gate on altitude (near carrierType.deckHeightFt) to exclude aircraft
// merely transiting overhead, e.g. in the bolter/groove.
// How far from the carrier's deck level an aircraft inside the hull
// footprint still counts as on deck. Asymmetric: an aircraft riding an
// elevator down to the hangar bay drops below deck level, and beyond
// ALT_BELOW_DECK_FT it's hidden rather than shown on deck.
const ALT_ABOVE_DECK_FT = 40
const ALT_BELOW_DECK_FT = 20

// The carrier's deck altitude in feet: its own live altitude plus the
// class's deck height above the hull.
export function carrierDeckAltFt(carrierUnit, carrierType) {
  return (carrierUnit.position.alt ?? 0) * M_TO_FT + carrierType.deckHeightFt
}

// Where an aircraft sits on the carrier's deck ({ forwardFt, rightFt }), or
// null when it isn't on deck: near deck-level altitude and inside the hull
// footprint. The DECK tab shows exactly these aircraft, and PAR leaves them
// out, so an aircraft is on one or the other, never both.
export function deckPosition(unit, carrierUnit, carrierType, theatre) {
  if (!unit.position || !carrierUnit?.position || !carrierType) return null
  const relAltFt = (unit.position.alt ?? 0) * M_TO_FT - carrierDeckAltFt(carrierUnit, carrierType)
  if (relAltFt > ALT_ABOVE_DECK_FT || relAltFt < -ALT_BELOW_DECK_FT) return null
  const carrierHeadingDeg = (carrierUnit.heading ?? 0) * 180 / Math.PI
  const { forwardFt, rightFt, onDeck } = projectOntoDeck(
    unit.position, carrierUnit.position.lat, carrierUnit.position.lng,
    carrierHeadingDeg, carrierType.deckLoaFt, carrierType.deckBeamFt, theatre,
  )
  return onDeck ? { forwardFt, rightFt } : null
}

export function projectOntoDeck(pos, carrierLat, carrierLng, carrierHeadingDeg, loaFt, beamFt, theatre) {
  // carrierHeadingDeg is raw grid heading (unit.heading, uncorrected) — the
  // bearing to the aircraft needs to be in that same grid frame, not real
  // geographic true, or the relative angle (and therefore forwardFt/rightFt)
  // is skewed by the local grid convergence. See utils/bearing.js.
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(carrierLat, carrierLng, pos.lat, pos.lng, theatre)
  const rangeFt        = rangeNm * NM_TO_FEET
  const relBearingRad  = ((gridBearingDeg - carrierHeadingDeg + 360) % 360) * Math.PI / 180
  const forwardFt = rangeFt * Math.cos(relBearingRad)
  const rightFt   = rangeFt * Math.sin(relBearingRad)
  const margin = 60 // ft
  const onDeck = Math.abs(forwardFt) <= loaFt / 2 + margin && Math.abs(rightFt) <= beamFt / 2 + margin
  return { forwardFt, rightFt, onDeck }
}
