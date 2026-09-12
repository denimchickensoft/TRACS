/**
 * ABM command parser.
 *
 * Each command definition has:
 *   id       — unique identifier, passed to the action library
 *   pattern  — RegExp matched against the trimmed, lowercased command buffer
 *   captures — names for capture groups (optional)
 *
 * Order matters — more specific patterns must precede broader ones (e.g.
 * DCLEAR_ALL's literal "all" before DCLEAR_NAME's catch-all).
 *
 * Same shape as AIC's parser (modules/aic/input/commandParser.js) and, like
 * that one, deliberately has no STARS-style ENTER/SLEW `trigger` field — the
 * three click-completion mechanisms (pendingDraw, pendingClearClick,
 * pendingClearAllConfirm) and the y/n confirmation intercept stay bespoke
 * logic in AbmScope.jsx, not generalized here. See
 * resources/specs/refactor-spec.md §10.0/§10.3 for why.
 *
 * The 7 draw commands (LINE/RECT/CIRC/POLY/SECT/RACE/TEXT) only detect
 * *which* shape was typed here — they deliberately don't capture their
 * argument text via a regex group, because .text's label content needs to
 * keep the controller's original casing, and this parser only ever sees the
 * lowercased buffer. Those actions re-derive their tokens from the raw
 * buffer themselves (see actions/index.js's handleDrawCommand), the same way
 * AbmScope.jsx's original execCommand used drawCmdTokens(str, raw).
 *
 * Source: the original inline execCommand in AbmScope.jsx (ported 2026-08-22,
 * see refactor-spec.md §10.4/§10.6 phase 2). One documented, accepted
 * deviation, same category as AIC's own: FILL_SET's pattern uses `\s+`
 * instead of the original single literal space before its percentage
 * argument — a strict superset, not a behavior change for any real input.
 */

const COMMANDS = [
  { id: 'RR_TOGGLE',        pattern: /^\.rr$/ },
  { id: 'RR_SET',           pattern: /^\.rr\s+(\d+(?:\.\d+)?)$/, captures: ['nm'] },
  { id: 'RR_SET_ANCHOR',    pattern: /^\.rr\s+(\d+(?:\.\d+)?)\s+(\S+)$/, captures: ['nm', 'anchor'] },
  { id: 'BE_RESET',         pattern: /^\.be$/ },
  { id: 'BE_LATLNG',        pattern: /^\.be\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/, captures: ['lat', 'lng'] },
  { id: 'BE_FIX',           pattern: /^\.be\s+(\S+)$/, captures: ['fix'] },
  { id: 'TIME_TOGGLE',      pattern: /^\.time$/ },
  { id: 'UNITRO_TOGGLE',    pattern: /^\.unitro$/ },
  { id: 'GEO_TOGGLE',       pattern: /^\.geo$/ },
  { id: 'RELIEF_TOGGLE',    pattern: /^\.relief$/ },
  { id: 'HOLDS_TOGGLE',     pattern: /^\.holds$/ },
  { id: 'MORA_TOGGLE',      pattern: /^\.mora$/ },
  { id: 'AIRWAYS_TOGGLE',   pattern: /^\.airways$/ },
  { id: 'AIRWAYS_TYPE',     pattern: /^\.airways\s+([vjb])$/, captures: ['type'] },
  { id: 'ASP_TOGGLE',       pattern: /^\.asp$/ },
  { id: 'ASP_CATEGORY',     pattern: /^\.(tma|ctr|cta|fir|uir|sua|mil|trsa|class[a-g])$/, captures: ['cat'] },
  { id: 'ASPCOLORS',        pattern: /^\.aspcolors\s+(.+)$/, captures: ['name'] },
  { id: 'REFRESH',          pattern: /^\.refresh$/ },
  { id: 'LABELS_TOGGLE',    pattern: /^\.(?:labels|lbl|label)$/ },
  { id: 'FILL_TOGGLE',      pattern: /^\.fill$/ },
  { id: 'FILL_SET',         pattern: /^\.fill\s+(\d{1,3})$/, captures: ['pct'] },
  { id: 'CUSTOM_TOGGLE',    pattern: /^\.(?:custom|cust)$/ },
  { id: 'CUSTOM_NAME',      pattern: /^\.(?:custom|cust)\s+(.+)$/, captures: ['name'] },
  { id: 'LINE',             pattern: /^\.line(?:\s.*)?$/ },
  { id: 'RECT',             pattern: /^\.rect(?:\s.*)?$/ },
  { id: 'CIRC',             pattern: /^\.circ(?:\s.*)?$/ },
  { id: 'POLY',             pattern: /^\.poly(?:\s.*)?$/ },
  { id: 'SECT',             pattern: /^\.sect(?:\s.*)?$/ },
  { id: 'RACE',             pattern: /^\.race(?:\s.*)?$/ },
  { id: 'TEXT',             pattern: /^\.text(?:\s.*)?$/ },
  { id: 'DCLEAR_BARE',      pattern: /^\.dclear$/ },
  { id: 'DCLEAR_ALL',       pattern: /^\.dclear\s+all$/ },
  { id: 'DCLEAR_NAME',      pattern: /^\.dclear\s+(.+)$/, captures: ['name'] },
  { id: 'FIXES_TOGGLE',     pattern: /^\.fixes$/ },
  { id: 'NAVAIDS_TOGGLE',   pattern: /^\.navaids$/ },
  { id: 'FIX_CLEAR',        pattern: /^\.fix$/ },
  { id: 'FIX_PIN',          pattern: /^\.fix\s+(.+)$/, captures: ['names'] },
  { id: 'FIND',             pattern: /^\.find\s+(.+)$/, captures: ['fix'] },
  { id: 'DEFINE',           pattern: /^\.define\s+(.+)$/, captures: ['term'] },
  { id: 'DEFINE',           pattern: /^\.def\s+(.+)$/, captures: ['term'] },
  { id: 'WHERE',            pattern: /^\.where\s+(.+)$/, captures: ['callsign'] },
  // Digits-only form must precede the single-token callsign form, or bare
  // `.focus 50` (set the default range) would be misread as a callsign.
  { id: 'FOCUS_DEFAULT_RANGE', pattern: /^\.focus\s+(\d+(?:\.\d+)?)$/, captures: ['nm'] },
  { id: 'FOCUS_OPEN_RANGE',    pattern: /^\.focus\s+(\S+)\s+(\d+(?:\.\d+)?)$/, captures: ['callsign', 'nm'] },
  { id: 'FOCUS_OPEN',          pattern: /^\.focus\s+(\S+)$/, captures: ['callsign'] },
  { id: 'FRAG_FIND',        pattern: /^\.frag\s+(.+)$/, captures: ['callsign'] },
  { id: 'ROUTE_FIND',       pattern: /^\.route\s+(.+)$/, captures: ['callsign'] },
  { id: 'RCLEAR',           pattern: /^\.rclear$/ },
  { id: 'RUNWAYS_TOGGLE',   pattern: /^\.runways$/ },
  { id: 'POLYGONS_TOGGLE',  pattern: /^\.polygons$/ },
  { id: 'MGRS_TOGGLE',      pattern: /^\.mgrs$/ },
  { id: 'TOWNS_TOGGLE',     pattern: /^\.towns$/ },
  { id: 'BASE_TOGGLE',      pattern: /^\.base$/ },
  { id: 'TERRAIN_TOGGLE',   pattern: /^\.terrain$/ },
  { id: 'MAP_TOGGLE',       pattern: /^\.map$/ },
  { id: 'WATER_TOGGLE',     pattern: /^\.water$/ },
  { id: 'ROADS_TOGGLE',     pattern: /^\.roads$/ },
  { id: 'COORDS_TOGGLE',    pattern: /^\.coords$/ },
  { id: 'BEC_TOGGLE',       pattern: /^\.bec$/ },
  { id: 'DDM',              pattern: /^\.ddm$/ },
  { id: 'DMS',              pattern: /^\.dms$/ },
  { id: 'METERS',           pattern: /^\.meters$/ },
  { id: 'FEET',             pattern: /^\.feet$/ },
  { id: 'PTL',              pattern: /^\.ptl\s+(\d+(?:\.\d+)?)$/, captures: ['mins'] },
  { id: 'FADED',            pattern: /^\.faded\s+(\d+)$/, captures: ['s'] },
  { id: 'HISTORY_TOGGLE',   pattern: /^\.history$/ },
  { id: 'HISTORY_LEN_RATE', pattern: /^\.history\s+(\d+)\s+(\d+(?:\.\d+)?)$/, captures: ['len', 'rate'] },
  { id: 'HISTORY_LEN',      pattern: /^\.history\s+(\d+)$/, captures: ['len'] },
  { id: 'DB_TOGGLE',        pattern: /^\.db$/ },
  { id: 'DBRESET',          pattern: /^\.dbreset$/ },
  { id: 'DBCA_TOGGLE',      pattern: /^\.dbca$/ },
  { id: 'DBS_TOGGLE',       pattern: /^\.dbs$/ },
  { id: 'LDR',              pattern: /^\.ldr\s+([0-7])\s+([1-9])$/, captures: ['length', 'dir'] },
  { id: 'THREAT_CLEAR',     pattern: /^\.threat$/ },
  { id: 'THREAT_RADIUS',    pattern: /^\.threat\s+(\d+(?:\.\d+)?)$/, captures: ['nm'] },
  { id: 'TCLEAR',           pattern: /^\.tclear$/ },
  { id: 'CLASS_RESET',      pattern: /^\.class$/ },
  { id: 'CLASS_RECLASSIFY', pattern: /^\.class\s+([fnbh])\s+([fnbh])$/, captures: ['oldLetter', 'newLetter'] },
  { id: 'AUTOCLASS',        pattern: /^\.autoclass$/ },
  { id: 'AUTOTHREAT',       pattern: /^\.autothreat$/ },
  { id: 'ROE_TOGGLE',       pattern: /^\.roe$/ },
  { id: 'ROE',              pattern: /^\.roe\s+(free|tight|hold)$/, captures: ['state'] },
  { id: 'ACQ_CLASS',        pattern: /^\.acq\s+([fnbh])$/, captures: ['letter'] },
  { id: 'ACQ_TOGGLE',       pattern: /^\.acq$/ },
  { id: 'ENG_CLASS',        pattern: /^\.eng\s+([fnbh])$/, captures: ['letter'] },
  { id: 'ENG_TOGGLE',       pattern: /^\.eng$/ },
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
