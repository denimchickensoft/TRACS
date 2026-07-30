import { toMagneticFromTrue, trueBearingRangeNm } from './bearing.js'

const NM_TO_FEET = 6076.115

// Known DCS carrier unit type names (unit.name field from Olympus).
// Used to filter NavyUnits to carriers only, and to supply per-type metadata.
//
// deckImage/deckLoaFt/deckBeamFt are for the CATCC DECK tab (Deck.jsx):
// deckImage is a bow-right top-down plan view under client/public/carriers/,
// deckLoaFt/deckBeamFt are the effective length/beam used to calibrate
// aircraft positions onto it — see projectOntoDeck() below. deckOriginOffsetFt
// (optional) corrects for the artwork's reference point not sitting exactly
// at the image's geometric center.
//
// nimitz.png's numbers are measured, not textbook LOA/beam: calibrated
// 2026-07-27 via least-squares fit against 4 live DCS aircraft at known
// lat/lng (ranging ~75-250ft from the carrier's reported position, both
// forward AND aft of it) matched to their actual pixel position in the
// artwork. An earlier pass used only 2 points, both forward of the
// reference — extrapolating that fit aft of the origin was wrong, hence
// fitting fwd+aft together here. deckLoaFt/deckBeamFt came out larger than
// published hull LOA/beam because the artwork depicts the flight deck
// outline (catwalks, sponsons, elevator overhang), not the waterline hull.
// The beam-axis fit is looser than the length-axis one (~20ft residual vs
// ~5ft) — good enough to be a large improvement, not perfect; a strongly
// port-offset data point would help tighten it further. Forrestal/Kuznetsov/
// Tarawa are still uncalibrated textbook approximations.
export const CARRIER_TYPES = {
  // Standard (non-supercarrier module)
  'Stennis':    { displayName: 'CVN-74 John C. Stennis',        tacticalName: 'Courage',      deckOffset: 9, deckHeightFt: 65, facilityId: 'CV74', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303, deckOriginOffsetFt: { forward: -14.5, right: 6.9 } },
  'Forrestal':  { displayName: 'CV-59 Forrestal',               tacticalName: 'Forrestal',    deckOffset: 9, deckHeightFt: 65, facilityId: 'CV59', deckImage: 'forrestal.png',  deckLoaFt: 1039, deckBeamFt: 252 },
  'Kuznetsov':  { displayName: 'Admiral Kuznetsov',             tacticalName: 'Kuznetsov',    deckOffset: 0, deckHeightFt: 70, facilityId: 'KUZN', deckImage: 'kuznetsov.png',  deckLoaFt: 1001, deckBeamFt: 236 },
  'LHA_Tarawa': { displayName: 'LHA-1 Tarawa',                  tacticalName: 'Tarawa',       deckOffset: 0, deckHeightFt: 70, facilityId: 'LHA1', deckImage: 'tarawa.png',     deckLoaFt: 820,  deckBeamFt: 106 },
  // Supercarrier module (CVN_XX naming convention)
  'CVN_71':     { displayName: 'CVN-71 Theodore Roosevelt',     tacticalName: 'Rough Rider',  deckOffset: 9, deckHeightFt: 72, facilityId: 'CV71', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303, deckOriginOffsetFt: { forward: -14.5, right: 6.9 } },
  'CVN_72':     { displayName: 'CVN-72 Abraham Lincoln',        tacticalName: 'Union',        deckOffset: 9, deckHeightFt: 72, facilityId: 'CV72', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303, deckOriginOffsetFt: { forward: -14.5, right: 6.9 } },
  'CVN_73':     { displayName: 'CVN-73 George Washington',      tacticalName: 'Warfighter',   deckOffset: 9, deckHeightFt: 72, facilityId: 'CV73', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303, deckOriginOffsetFt: { forward: -14.5, right: 6.9 } },
  'CVN_74':     { displayName: 'CVN-74 John C. Stennis',        tacticalName: 'Courage',      deckOffset: 9, deckHeightFt: 72, facilityId: 'CV74', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303, deckOriginOffsetFt: { forward: -14.5, right: 6.9 } },
  'CVN_75':     { displayName: 'CVN-75 Harry S. Truman',        tacticalName: 'Lone Warrior', deckOffset: 9, deckHeightFt: 72, facilityId: 'CV75', deckImage: 'nimitz.png',     deckLoaFt: 1148, deckBeamFt: 303, deckOriginOffsetFt: { forward: -14.5, right: 6.9 } },
}

export function isCarrierUnit(unit) {
  return unit?.category === 'NavyUnit' && CARRIER_TYPES[unit.name] != null
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
export function projectOntoDeck(pos, carrierLat, carrierLng, carrierHeadingDeg, loaFt, beamFt) {
  const { trueBearingDeg, rangeNm } = trueBearingRangeNm(carrierLat, carrierLng, pos.lat, pos.lng)
  const rangeFt        = rangeNm * NM_TO_FEET
  const relBearingRad  = ((trueBearingDeg - carrierHeadingDeg + 360) % 360) * Math.PI / 180
  const forwardFt = rangeFt * Math.cos(relBearingRad)
  const rightFt   = rangeFt * Math.sin(relBearingRad)
  const margin = 60 // ft
  const onDeck = Math.abs(forwardFt) <= loaFt / 2 + margin && Math.abs(rightFt) <= beamFt / 2 + margin
  return { forwardFt, rightFt, onDeck }
}
