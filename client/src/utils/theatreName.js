// DCS names a few maps differently in a mission's `theatre` field (and so
// in what Olympus reports live, env.mission.theatre) than TRACS keys its
// map data by. Every TRACS lookup -- projection params, navdata, runways,
// airdromes, ICAO mapping -- is an exact match on the TRACS name, so a
// DCS-supplied name is translated once, where it enters the client.
// Confirmed against Mission Editor output, pydcs's terrain definitions and
// a live Olympus server on the Cold War Germany map.
const DCS_THEATRE_NAMES = {
  GermanyCW: 'Germany',
  Falklands: 'SouthAtlantic',
  SinaiMap:  'Sinai',
}

// The TRACS name for a DCS theatre name; any other name comes back as is.
export function canonicalTheatre(name) {
  return DCS_THEATRE_NAMES[name] ?? name
}
