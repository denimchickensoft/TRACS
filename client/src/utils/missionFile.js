// Reads a dropped mission file -- a .miz, a DCS track (.trk), a bare `mission`
// file, or a Mission Editor static template (.stm) -- into its parsed Lua
// table. Shared by the ATO/FRAG and flight-plan importers.

import { unzipSync } from 'fflate'
import { parseLua, isStaticTemplateText } from './parseMission.js'
import { canonicalTheatre } from './theatreName.js'

// The file's `theatre` is DCS's name for the map, translated to TRACS's.
function withCanonicalTheatre(mission) {
  if (mission && typeof mission.theatre === 'string') mission.theatre = canonicalTheatre(mission.theatre)
  return mission
}

/** @returns {Promise<{ kind: 'miz' | 'stm' | 'mission', mission: object }>} */
export async function readMissionFile(file) {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.miz') || lower.endsWith('.trk')) {
    // A .trk is a .miz plus the recorded track data, which can run to
    // hundreds of MB - only the `mission` entry is ever unpacked.
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => f.name === 'mission' })
    if (!files['mission']) throw new Error(`No "mission" file found inside ${file.name}`)
    return { kind: 'miz', mission: withCanonicalTheatre(parseLua(new TextDecoder().decode(files['mission']))) }
  }
  const text = await file.text()
  const kind = lower.endsWith('.stm') || isStaticTemplateText(text) ? 'stm' : 'mission'
  return { kind, mission: withCanonicalTheatre(parseLua(text)) }
}

// A mission's `mission` text (as the relay serves the running mission) into
// its parsed Lua table, theatre translated as for a dropped file.
export function parseMissionText(text) {
  return withCanonicalTheatre(parseLua(text))
}
