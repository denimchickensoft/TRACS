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
 * deliberately not generalized here — see resources/specs/refactor-spec.md
 * §9.3 for why. This parser only covers commands that resolve entirely from
 * their typed text.
 *
 * Source: the original inline execCommand in AicScope.jsx (ported 2026-08-21,
 * see refactor-spec.md §9.4/§9.5 phase 2). A handful of malformed/incomplete-
 * input edge cases resolve slightly differently than the original inline
 * if/else chain did (e.g. `.center <2 non-numeric words>` now falls through
 * to a failed fix lookup instead of an "INVALID: .CENTER <BRG> <RNG>"
 * message) — all in the same category: an unmatched or malformed command
 * still fails safely, just with a different feedback string. None of the
 * documented, intentional command forms are affected.
 */

const COMMANDS = [
  { id: 'CENTER_BULLSEYE',  pattern: /^\.center$/ },
  { id: 'CENTER_BRG_RNG',   pattern: /^\.center\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/, captures: ['brg', 'rng'] },
  { id: 'CENTER_FIX',       pattern: /^\.center\s+(.+)$/, captures: ['fix'] },
  { id: 'FIND',             pattern: /^\.find\s+(.+)$/, captures: ['fix'] },
  { id: 'RR_TOGGLE',        pattern: /^\.rr$/ },
  { id: 'RR_SET',           pattern: /^\.rr\s+(\d+(?:\.\d+)?)$/, captures: ['nm'] },
  { id: 'PTL',              pattern: /^\.ptl\s+(\d+)$/, captures: ['s'] },
  { id: 'SYM',              pattern: /^\.sym\s+(\d+)$/, captures: ['n'] },
  { id: 'FADED',            pattern: /^\.faded\s+(\d+)$/, captures: ['s'] },
  { id: 'THREAT_CLEAR',     pattern: /^\.threat$/ },
  { id: 'THREAT_RADIUS',    pattern: /^\.threat\s+(\d+(?:\.\d+)?)$/, captures: ['nm'] },
  { id: 'CLEAR_ALL',        pattern: /^\.clear$/ },
  { id: 'CLASS_RESET',      pattern: /^\.class$/ },
  { id: 'CLASS_RECLASSIFY', pattern: /^\.class\s+([fnbh])\s+([fnbh])$/, captures: ['oldLetter', 'newLetter'] },
  { id: 'AUTOCLASS',        pattern: /^\.autoclass$/ },
  { id: 'AUTOTHREAT',       pattern: /^\.autothreat$/ },
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
