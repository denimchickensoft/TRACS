// Known DCS carrier unit type names (unit.name field from Olympus).
// Used to filter NavyUnits to carriers only, and to supply per-type metadata.
export const CARRIER_TYPES = {
  // Standard (non-supercarrier module)
  'Stennis':    { displayName: 'CVN-74 John C. Stennis',        tacticalName: 'Courage',      deckOffset: 9, deckHeightFt: 65, facilityId: 'CV74' },
  'Forrestal':  { displayName: 'CV-59 Forrestal',               tacticalName: 'Forrestal',    deckOffset: 9, deckHeightFt: 65, facilityId: 'CV59' },
  'Kuznetsov':  { displayName: 'Admiral Kuznetsov',             tacticalName: 'Kuznetsov',    deckOffset: 0, deckHeightFt: 70, facilityId: 'KUZN' },
  'LHA_Tarawa': { displayName: 'LHA-1 Tarawa',                  tacticalName: 'Tarawa',       deckOffset: 0, deckHeightFt: 70, facilityId: 'LHA1' },
  // Supercarrier module (CVN_XX naming convention)
  'CVN_71':     { displayName: 'CVN-71 Theodore Roosevelt',     tacticalName: 'Rough Rider',  deckOffset: 9, deckHeightFt: 65, facilityId: 'CV71' },
  'CVN_72':     { displayName: 'CVN-72 Abraham Lincoln',        tacticalName: 'Union',        deckOffset: 9, deckHeightFt: 65, facilityId: 'CV72' },
  'CVN_73':     { displayName: 'CVN-73 George Washington',      tacticalName: 'Warfighter',   deckOffset: 9, deckHeightFt: 65, facilityId: 'CV73' },
  'CVN_74':     { displayName: 'CVN-74 John C. Stennis',        tacticalName: 'Courage',      deckOffset: 9, deckHeightFt: 65, facilityId: 'CV74' },
  'CVN_75':     { displayName: 'CVN-75 Harry S. Truman',        tacticalName: 'Lone Warrior', deckOffset: 9, deckHeightFt: 65, facilityId: 'CV75' },
}

export function isCarrierUnit(unit) {
  return unit?.category === 'NavyUnit' && CARRIER_TYPES[unit.name] != null
}
