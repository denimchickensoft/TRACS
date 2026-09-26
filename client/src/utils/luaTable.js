// Minimal recursive-descent parser for the restricted Lua-table subset DCS
// mission/options/warehouse files use: nested `{ ["key"] = value, name =
// value, [n] = value, value, ... }` tables, string/number/boolean/nil
// literals, `--` line comments and `--[[ ]]` block comments. No variables,
// no function calls, no operators — DCS writes these files as pure data
// serializations, so this grammar (and not a general Lua VM) is sufficient.
//
// Every table — keyed or positional — becomes a plain JS object with
// string keys (JS has no other kind). Positional entries (`{a, b, c}`,
// e.g. a zone's `color = {0, 0.125, 1, 0.35}`) get auto-incrementing
// "1", "2", "3" keys, same as Lua's own sugar. Callers must never rely on
// object key enumeration order for numeric keys — DCS itself leaves gaps
// in `points`/`verticies` tables when a vertex is deleted in the ME, so use
// sortedValues() below rather than Object.values()/for-in.

class LuaTableParser {
  constructor(text) {
    this.text = text
    this.i = 0
    this.n = text.length
  }

  skipWs() {
    for (;;) {
      while (this.i < this.n && /\s/.test(this.text[this.i])) this.i++
      if (this.text.startsWith('--[[', this.i)) {
        const end = this.text.indexOf(']]', this.i + 4)
        this.i = end === -1 ? this.n : end + 2
        continue
      }
      if (this.text.startsWith('--', this.i)) {
        const end = this.text.indexOf('\n', this.i)
        this.i = end === -1 ? this.n : end + 1
        continue
      }
      break
    }
  }

  parseValue() {
    this.skipWs()
    const c = this.text[this.i]
    if (c === '{') return this.parseTable()
    if (c === '"' || c === "'") return this.parseString()
    if (this.text.startsWith('true', this.i)) { this.i += 4; return true }
    if (this.text.startsWith('false', this.i)) { this.i += 5; return false }
    if (this.text.startsWith('nil', this.i)) { this.i += 3; return null }
    return this.parseNumber()
  }

  parseTable() {
    this.i++ // consume '{'
    const obj = {}
    let autoIdx = 1
    for (;;) {
      this.skipWs()
      if (this.text[this.i] === '}') { this.i++; break }
      if (this.i >= this.n) throw new Error('Unterminated Lua table')

      let key
      if (this.text[this.i] === '[') {
        this.i++
        const k = this.parseValue()
        this.skipWs()
        if (this.text[this.i] !== ']') throw new Error(`Expected ']' at offset ${this.i}`)
        this.i++
        this.skipWs()
        if (this.text[this.i] !== '=') throw new Error(`Expected '=' at offset ${this.i}`)
        this.i++
        key = String(k)
      } else if (/[A-Za-z_]/.test(this.text[this.i])) {
        const start = this.i
        while (this.i < this.n && /[A-Za-z0-9_]/.test(this.text[this.i])) this.i++
        const ident = this.text.slice(start, this.i)
        this.skipWs()
        if (this.text[this.i] === '=' && this.text[this.i + 1] !== '=') {
          this.i++
          key = ident
        } else {
          // Not `ident =` after all (e.g. a bare `true`/`false` positional
          // entry) — rewind and let parseValue lex it as a value instead.
          this.i = start
          key = String(autoIdx++)
        }
      } else {
        key = String(autoIdx++)
      }

      obj[key] = this.parseValue()

      this.skipWs()
      if (this.text[this.i] === ',' || this.text[this.i] === ';') { this.i++; continue }
      this.skipWs()
      if (this.text[this.i] === '}') { this.i++; break }
      throw new Error(`Expected ',' or '}' at offset ${this.i}`)
    }
    return obj
  }

  parseString() {
    const quote = this.text[this.i]
    this.i++
    let out = ''
    while (this.i < this.n) {
      const c = this.text[this.i]
      if (c === quote) { this.i++; return out }
      if (c === '\\') {
        const next = this.text[this.i + 1]
        // Lua's own line-continuation escape: a backslash immediately
        // followed by a real newline embeds a literal '\n' in the string —
        // this is how DCS's multi-line TextBox `text` fields are encoded.
        if (next === '\r' && this.text[this.i + 2] === '\n') { out += '\n'; this.i += 3; continue }
        if (next === '\n' || next === '\r') { out += '\n'; this.i += 2; continue }
        const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '"': '"', "'": "'", '\\': '\\' }
        if (next in map) { out += map[next]; this.i += 2; continue }
        out += next ?? ''
        this.i += 2
        continue
      }
      out += c
      this.i++
    }
    throw new Error('Unterminated Lua string')
  }

  parseNumber() {
    const start = this.i
    if (this.text[this.i] === '-' || this.text[this.i] === '+') this.i++
    while (this.i < this.n && /[0-9.]/.test(this.text[this.i])) this.i++
    if (this.text[this.i] === 'e' || this.text[this.i] === 'E') {
      this.i++
      if (this.text[this.i] === '+' || this.text[this.i] === '-') this.i++
      while (this.i < this.n && /[0-9]/.test(this.text[this.i])) this.i++
    }
    const str = this.text.slice(start, this.i)
    if (!/\d/.test(str)) throw new Error(`Expected value at offset ${start}`)
    return parseFloat(str)
  }
}

/**
 * Finds `varName = { ... }` at the top level of `source` (DCS's `mission`,
 * `options`, `warehouses` files are each exactly one such assignment) and
 * returns the parsed table as a plain JS object. Returns null if no such
 * assignment is found.
 */
export function parseLuaAssignment(source, varName) {
  const re = new RegExp(`(?<![\\w])${varName}(?!\\w)\\s*=\\s*`)
  const m = re.exec(source)
  if (!m) return null
  const p = new LuaTableParser(source)
  p.i = m.index + m[0].length
  p.skipWs()
  if (p.text[p.i] !== '{') return null
  return p.parseTable()
}

/**
 * A Lua table parsed above (keyed or positional) becomes a JS object with
 * string keys — this returns its values ordered by ascending numeric key,
 * skipping any non-numeric keys. Required reading for `points`/`verticies`/
 * `zones`/`layers`/`objects` tables: DCS leaves gaps in numeric keys when a
 * vertex is deleted in the ME, so iteration order must come from sorting
 * the keys, never from object insertion/enumeration order.
 */
export function sortedValues(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.keys(obj)
    .map(k => [Number(k), obj[k]])
    .filter(([k]) => Number.isFinite(k))
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
}
