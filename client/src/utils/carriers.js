// Known DCS carrier unit type names (unit.name field from Olympus).
// Used to filter NavyUnits to carriers only, and to supply per-type metadata.
export const CARRIER_TYPES = {
  // Standard (non-supercarrier module)
  'Stennis':    { displayName: 'CVN-74 John C. Stennis',        deckOffset: 9, facilityId: 'CV74' },
  'Forrestal':  { displayName: 'CV-59 Forrestal',               deckOffset: 9, facilityId: 'CV59' },
  'Kuznetsov':  { displayName: 'Admiral Kuznetsov',             deckOffset: 0, facilityId: 'KUZN' },
  'LHA_Tarawa': { displayName: 'LHA-1 Tarawa',                  deckOffset: 0, facilityId: 'LHA1' },
  // Supercarrier module (CVN_XX naming convention)
  'CVN_71':     { displayName: 'CVN-71 Theodore Roosevelt',     deckOffset: 9, facilityId: 'CV71' },
  'CVN_72':     { displayName: 'CVN-72 Abraham Lincoln',        deckOffset: 9, facilityId: 'CV72' },
  'CVN_73':     { displayName: 'CVN-73 George Washington',      deckOffset: 9, facilityId: 'CV73' },
  'CVN_74':     { displayName: 'CVN-74 John C. Stennis',        deckOffset: 9, facilityId: 'CV74' },
  'CVN_75':     { displayName: 'CVN-75 Harry S. Truman',        deckOffset: 9, facilityId: 'CV75' },
}

export function isCarrierUnit(unit) {
  return unit?.category === 'NavyUnit' && CARRIER_TYPES[unit.name] != null
}
