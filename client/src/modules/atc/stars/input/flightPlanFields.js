/**
 * Field parsers for the STARS flight-plan creation commands (CRC Table 23).
 *
 * Both take the whitespace-split tokens that follow the AID and return a
 * flight-plan patch, or null when any token doesn't fit — the caller turns
 * null into FORMAT.
 */

const BCN_RE      = /^[0-7]{4}$/
const ALT_RE      = /^\d{3}$/
const TYPE_RE     = /^([A-Z][A-Z0-9*]{3})(?:\/([A-Z]))?$/
const AIRPORT_RE  = /^[A-Z0-9]{3,4}$/
const RULES       = { '.V': 'VFR', '.P': 'VFR', '.E': 'IFR' }

/**
 * <FLT DATA><AID>(OPTIONAL FIELDS) — fields in any order, each at most once:
 *   ####      beacon code (octal)
 *   Δxxx      scratchpad 1 (up to 3 chars)
 *   +xxx      scratchpad 2 (up to 3 chars)
 *   TYPE[/E]  aircraft type (4 chars, letter first; pad with *) + equipment
 *   ###       requested altitude (hundreds of feet)
 *   .V .P .E  flight rules — VFR / VFR-on-top / IFR. Left unset when
 *             omitted; a newly created plan defaults to VFR, an amended one
 *             keeps its current rules.
 */
export function parseAbbreviatedFields(tokens) {
  const out = {}
  const seen = new Set()
  const once = (key) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }

  for (const tok of tokens) {
    let m
    if (BCN_RE.test(tok)) {
      if (!once('bcn')) return null
      out.bcn = tok
    } else if (ALT_RE.test(tok)) {
      if (!once('alt')) return null
      out.alt = tok
    } else if (/^Δ\S{1,3}$/.test(tok)) {
      if (!once('sp1')) return null
      out.sp1 = tok.slice(1)
    } else if (/^\+\S{1,3}$/.test(tok)) {
      if (!once('sp2')) return null
      out.sp2 = tok.slice(1)
    } else if (RULES[tok]) {
      if (!once('rules')) return null
      out.flightRules = RULES[tok]
    } else if ((m = tok.match(TYPE_RE))) {
      if (!once('typ')) return null
      out.typ = m[1].replace(/\*+$/, '')
      if (m[2]) out.eq = m[2]
    } else {
      return null
    }
  }
  return out
}

/**
 * <VFR PLAN><AID> [DEP*] DEST TYPE[/EQ] [###] — positional.
 */
export function parseVfrFields(tokens) {
  const t = [...tokens]
  const out = { flightRules: 'VFR' }

  if (t[0]?.endsWith('*')) {
    const dep = t.shift().slice(0, -1)
    if (!AIRPORT_RE.test(dep)) return null
    out.dep = dep
  }

  const dest = t.shift()
  if (!dest || !AIRPORT_RE.test(dest)) return null
  out.dest = dest

  const typeTok = t.shift()
  const m = typeTok?.match(TYPE_RE)
  if (!m) return null
  out.typ = m[1].replace(/\*+$/, '')
  if (m[2]) out.eq = m[2]

  if (t.length) {
    const alt = t.shift()
    if (!ALT_RE.test(alt)) return null
    out.alt = alt
  }

  return t.length ? null : out
}
