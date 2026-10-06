/**
 * AIC command parser.
 *
 * Each command definition has:
 *   id       — unique identifier, passed to the action library
 *   pattern  — RegExp matched against the trimmed, lowercased command buffer
 *   captures — names for capture groups (optional)
 *
 * Order matters — more specific patterns must precede broader ones (e.g.
 * CENTER_BRG_RNG's two-number pattern before CENTER_FIX's catch-all).
 *
 * Unlike STARS' parser (atc/stars/input/commandParser.js), there's no ENTER/
 * SLEW trigger field — AIC has no generic mechanism for "type a command,
 * then click to complete it." That interaction (bare `.sector`/`.be` awaiting
 * a map click) stays bespoke logic in AicScope.jsx (pendingSector/pendingBe),
 * deliberately not generalized here, since only those two commands need a
 * click to complete. This parser only covers commands that resolve entirely from
 * their typed text.
 */

const COMMANDS = [
  { id: 'CENTER_BULLSEYE',  pattern: /^\.center$/ },
  { id: 'CENTER_BRG_RNG',   pattern: /^\.center\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/, captures: ['brg', 'rng'] },
  { id: 'CENTER_FIX',       pattern: /^\.center\s+(.+)$/, captures: ['fix'] },
  { id: 'FIND',             pattern: /^\.find\s+(.+)$/, captures: ['fix'] },
  { id: 'RR_TOGGLE',        pattern: /^\.rr$/ },
  { id: 'RR_SET',           pattern: /^\.rr\s+(\d+(?:\.\d+)?)$/, captures: ['dist'] },
  { id: 'PTL',              pattern: /^\.ptl\s+(\d+)$/, captures: ['s'] },
  { id: 'SYM',              pattern: /^\.sym\s+(\d+)$/, captures: ['n'] },
  { id: 'FADED',            pattern: /^\.faded\s+(\d+)$/, captures: ['s'] },
  { id: 'THREAT_CLEAR',     pattern: /^\.threat$/ },
  { id: 'THREAT_RADIUS',    pattern: /^\.threat\s+(\d+(?:\.\d+)?)$/, captures: ['dist'] },
  { id: 'CLEAR_ALL',        pattern: /^\.clear$/ },
  { id: 'DECLARATION_RESET',    pattern: /^\.dec$/ },
  { id: 'DECLARATION_SET_BULK', pattern: /^\.dec\s+([fnbh])\s+([fnbh])$/, captures: ['oldLetter', 'newLetter'] },
  { id: 'AUTO_DECLARE_IFF',     pattern: /^\.autodec\s+iff$/ },
  { id: 'AUTO_DECLARE',         pattern: /^\.autodec$/ },
  { id: 'AUTOTHREAT',       pattern: /^\.autothreat$/ },
  { id: 'ROE_TOGGLE',       pattern: /^\.roe$/ },
  { id: 'ROE',              pattern: /^\.roe\s+(free|tight|hold)$/, captures: ['state'] },
  { id: 'ASPCOLORS',        pattern: /^\.aspcolors\s+(.+)$/, captures: ['name'] },
  { id: 'GEO_TOGGLE',       pattern: /^\.geo$/ },
  { id: 'RELIEF_TOGGLE',    pattern: /^\.relief$/ },
  { id: 'CENTROID_TOGGLE',  pattern: /^\.centroid$/ },
  { id: 'AXIS_TOGGLE',      pattern: /^\.axis$/ },
  { id: 'PICTURE_TOGGLE',   pattern: /^\.picture$/ },
  { id: 'BEC_TOGGLE',       pattern: /^\.bec$/ },
  { id: 'SECTOR_ON',        pattern: /^\.sector$/ },
  { id: 'SECTOR_CLEAR',     pattern: /^\.sector\s+(?:clear|off)$/ },
  { id: 'SECTOR_SET',       pattern: /^\.sector\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/, captures: ['fromMag', 'toMag', 'rng'] },
  { id: 'BE_RESET',         pattern: /^\.be$/ },
  { id: 'BE_LATLNG',        pattern: /^\.be\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/, captures: ['lat', 'lng'] },
  { id: 'BE_FIX',           pattern: /^\.be\s+(\S+)$/, captures: ['fix'] },
  { id: 'METRIC_UNITS',     pattern: /^\.metric$/ },
  { id: 'IMPERIAL_UNITS',   pattern: /^\.imperial$/ },
  { id: 'DEFINE',           pattern: /^\.define\s+(.+)$/, captures: ['term'] },
  { id: 'DEFINE',           pattern: /^\.def\s+(.+)$/, captures: ['term'] },
]

/**
 * Match a command buffer against the command table.
 *
 * @param {string} buffer  raw command text (not yet trimmed/lowercased)
 * @returns {{ command, captures } | null}
 */
export function parseCommand(buffer) {
  const trimmed = buffer.trim().toLowerCase()

  for (const cmd of COMMANDS) {
    const match = trimmed.match(cmd.pattern)
    if (!match) continue

    const captures = {}
    if (cmd.captures) {
      cmd.captures.forEach((name, i) => {
        captures[name] = match[i + 1]
      })
    }
    return { command: cmd, captures }
  }

  return null
}
