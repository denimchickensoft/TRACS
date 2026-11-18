// Finds a flight callsign in a multiplayer unit name by its shape, wherever it
// sits and however it's written: "Colt 1-1 | Denim", "203 | COLT 1-1 | DENIM",
// "DENIM | COLT 1-1 | 203", "COLT 1-1 - DENIM", "COLT11 DENIM", "COLT1-1-DENIM"
// all give COLT11. Shape only, no list of callsign words, so nothing needs
// maintaining.
//
// The callsign is the name's first numbered part: a word of 3+ letters, then
// its number, with any spaces, hyphens or pipes between. Digits-only (modex)
// and letters-only (pilot name) parts aren't numbered parts; the 3-letter
// minimum keeps airframe names such as "F16" out. Only the first numbered
// part counts ("DENIM12 | COLT 1-1" gives DENIM12), and it must be one of:
//   - a flight and an element digit ("COLT 1-1", "COLT11"), or
//   - for a player, a flight-only callsign whose digit is the element
//     ("SCOUT 1 | Denim": flight SCOUT, element 1). Players only, since
//     AI unit names ("Akrotiri Hornet-3") end in a number too.
// The number must end the part: "SCOUT4ME DENIM23" has no callsign, and
// neither does "COLT 111".

const NUMBERED = /(?<![A-Z])[A-Z]{3,}[\s|-]*\d/i
const CALLSIGN = /([A-Z]{3,})[\s|-]*([1-9])(?:([\s|-]*)([1-9]))?(?![A-Z0-9])/iy

export function stripAcid(s) {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// The callsign in `unitName`, as { acid, flight, element, index, length },
// or null. `flightOnly` accepts a flight-only callsign (players only).
export function findShapedCallsign(unitName, { flightOnly = false } = {}) {
  if (!unitName) return null
  const first = NUMBERED.exec(unitName)
  if (!first) return null
  CALLSIGN.lastIndex = first.index
  const m = CALLSIGN.exec(unitName)
  if (!m) return null
  const word = m[1].toUpperCase()
  if (m[4]) {
    return { acid: `${word}${m[2]}${m[4]}`, flight: `${word}${m[2]}`, element: Number(m[4]), index: m.index, length: m[0].length }
  }
  if (!flightOnly) return null
  return { acid: `${word}${m[2]}`, flight: word, element: Number(m[2]), index: m.index, length: m[0].length }
}

// findShapedCallsign for a live unit: flight-only callsigns for players the
// source flags human (Olympus, the DCS exporter; Tacview flags nobody).
export function shapedCallsignOf(unit) {
  return findShapedCallsign(unit?.unitName, { flightOnly: unit?.human === true })
}

// The AID for a unit when "Use DCS Multiplayer Names" is on: the
// callsign-shaped part of its name, else its DCS callsign field, else the
// text left of the first pipe, else its unit ID.
export function callsignFromDcsName(unit) {
  const shaped = shapedCallsignOf(unit)
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
// `opts` as findShapedCallsign's.
export function parseUnitName(unitName, opts) {
  if (!unitName) return { acid: '', pilotName: null }
  const shaped = findShapedCallsign(unitName, opts)
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
