// Finds a flight callsign in a multiplayer unit name by its shape, wherever it
// sits and however it's written: "Colt 1-1 | Denim", "203 | COLT 1-1 | DENIM",
// "DENIM | COLT 1-1 | 203", "COLT 1-1 - DENIM", "COLT11 DENIM", "COLT1-1-DENIM"
// all give COLT11. A callsign is a word of 3+ letters, then a flight digit and
// an element digit, with any spaces, hyphens or pipes between the parts.
// Shape only, no list of callsign words, so nothing needs maintaining.
// Digits-only (modex) and letters-only (pilot name) segments never match, nor
// does a flight with no element digit ("COLT1"). The 3-letter minimum keeps
// airframe names such as "F16" from reading as callsign F16.

const SHAPE = /(?<![A-Z])([A-Z]{3,})[\s|-]*([1-9])([\s|-]*)([1-9])(?![0-9])/gi

export function stripAcid(s) {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// The callsign match in `unitName`, as { acid, index, length }, or null.
// With several matches ("VIPER21 | COLT 1-1"), the first of these wins:
//   1. the one agreeing with the unit's DCS callsign field, when it has one
//   2. one written with a separator between the digits ("1-1", "1 1"), since
//      callsigns usually are and pilot names like "DENIM12" never are. A
//      hint, not proof, so it only breaks ties.
//   3. the first
export function findShapedCallsign(unitName, dcsCallsign) {
  if (!unitName) return null
  const matches = [...unitName.matchAll(SHAPE)].map((m) => ({
    acid:      `${m[1]}${m[2]}${m[4]}`.toUpperCase(),
    index:     m.index,
    length:    m[0].length,
    separated: m[3].length > 0,
  }))
  if (matches.length === 0) return null
  const wanted = dcsCallsign ? stripAcid(dcsCallsign) : ''
  return matches.find((m) => m.acid === wanted)
    ?? matches.find((m) => m.separated)
    ?? matches[0]
}

// The AID for a unit when "Use DCS Multiplayer Names" is on: the
// callsign-shaped part of its name, else its DCS callsign field, else the
// text left of the first pipe, else its unit ID.
export function callsignFromDcsName(unit) {
  const shaped = findShapedCallsign(unit.unitName, unit.callsign)
  if (shaped) return shaped.acid
  const fromField = stripAcid(unit.callsign ?? '')
  if (fromField) return fromField
  return parseUnitName(unit.unitName).acid || String(unit.id)
}

// Split a multiplayer unit name into callsign and pilot name.
//   "Colt 1-1 | Denim"        -> { acid: 'COLT11', pilotName: 'Denim' }
//   "203 | COLT 1-1 | DENIM"  -> { acid: 'COLT11', pilotName: 'DENIM' }
// With no callsign-shaped part, falls back to the text left of the first pipe
// as the callsign and the text right of it as the pilot name.
export function parseUnitName(unitName, dcsCallsign) {
  if (!unitName) return { acid: '', pilotName: null }
  const shaped = findShapedCallsign(unitName, dcsCallsign)
  if (shaped) {
    const rest = unitName.slice(0, shaped.index) + '|' + unitName.slice(shaped.index + shaped.length)
    const pilotName = rest.split('|')
      .map((seg) => seg.replace(/^[\s-]+|[\s-]+$/g, ''))
      .filter((seg) => /\p{L}/u.test(seg))
      .join(' ') || null
    return { acid: shaped.acid, pilotName }
  }
  const pipeIdx = unitName.indexOf('|')
  if (pipeIdx === -1) return { acid: stripAcid(unitName), pilotName: null }
  return {
    acid:      stripAcid(unitName.slice(0, pipeIdx).trim()),
    pilotName: unitName.slice(pipeIdx + 1).trim() || null,
  }
}
