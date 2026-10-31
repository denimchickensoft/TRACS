// Reads a dropped mission file -- a .miz, a bare `mission` file, or a Mission
// Editor static template (.stm) -- into its parsed Lua table. Shared by the
// ATO/FRAG and flight-plan importers.

import { unzipSync } from 'fflate'
import { parseLua, isStaticTemplateText } from './parseMission.js'

/** @returns {Promise<{ kind: 'miz' | 'stm' | 'mission', mission: object }>} */
export async function readMissionFile(file) {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.miz')) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()))
    if (!files['mission']) throw new Error('No "mission" file found inside .miz')
    return { kind: 'miz', mission: parseLua(new TextDecoder().decode(files['mission'])) }
  }
  const text = await file.text()
  const kind = lower.endsWith('.stm') || isStaticTemplateText(text) ? 'stm' : 'mission'
  return { kind, mission: parseLua(text) }
}
