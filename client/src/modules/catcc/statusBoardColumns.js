// ── Time validation (2400-clock: 0000–2359, plus 2400) ───────────────────────
export function isValidTime(v) {
  if (!v) return true
  if (!/^\d{4}$/.test(v)) return false
  const h = parseInt(v.slice(0, 2), 10)
  const m = parseInt(v.slice(2, 4), 10)
  return (h === 24 && m === 0) || (h <= 23 && m <= 59)
}

// ── RAD: the marshal radial ──────────────────────────────────────────────────
// A radial an aircraft is given doesn't move when the carrier turns, so the
// automatic values are worked out once and stored (see setRad/setAppRad):
// the reciprocal of FB, and the emergency (FB + 150) and helicopter
// (FB + 110) radials. '' while FB is unknown.
const RADIAL_OFFSET = { RAD: 180, E: 150, H: 110 }

export function radialFromFb(fb, kind = 'RAD') {
  if (fb == null || isNaN(fb)) return ''
  return String(((Math.round(fb) + RADIAL_OFFSET[kind]) % 360) || 360).padStart(3, '0')
}

// The stored RAD, or before one is set (CASE 1, or no case yet) the live reciprocal of FB.
export function effectiveRad(rad, fb) {
  return rad || radialFromFb(fb)
}

// ── EAT: stored as HHMM Zulu, shown as its minutes only ──────────────────────
// Two typed digits are minutes past the hour, resolved to the first HHMM at
// or after the current minute: at 2055, 57 is 2057 and 01 is 2101. Four
// digits are taken as typed. Without a mission clock two digits are kept as
// typed, and show invalid until re-entered.
export function resolveEat(typed, utcSeconds) {
  if (typed.length === 1 || typed.length === 3) typed = '0' + typed
  if (typed.length !== 2 || utcSeconds == null) return typed
  const mm = parseInt(typed, 10)
  if (mm > 59) return typed
  const nowMin = Math.floor(utcSeconds / 60)
  let min = Math.floor(nowMin / 60) * 60 + mm
  if (min < nowMin) min += 60
  min %= 1440
  return `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`
}

export function formatEat(v) {
  return /^\d{4}$/.test(v) ? v.slice(2) : v
}

// Minutes from now, within +/-12 h, so EATs either side of midnight sort in
// time order rather than 0003 ahead of 2358.
export function eatSortKey(v, utcSeconds) {
  const min = (parseInt(v.slice(0, 2), 10) * 60 + parseInt(v.slice(2), 10)) % 1440
  const nowMin = Math.floor(utcSeconds / 60)
  return ((min - nowMin + 720) % 1440 + 1440) % 1440 - 720
}

// ── Fuel/state validation: 1–2 digits, decimal point, 1 digit (e.g. 1.0, 12.3) ─
export function isValidDecimal(v) {
  if (!v) return true
  return /^\d{1,2}\.\d$/.test(v)
}

// ── Aircraft table column definitions ────────────────────────────────────────
// id: unique column key | field: entry field to read/write | w: column width px
// readOnly: not editable | repeat: mirrors another field (no write)
// digitsOnly: strip non-digit input | padZero: pad to N digits with leading zeros on commit
// decimalFmt: allow digits + one decimal point | decimalValidate: validate X.X / XX.X format
export const COLUMNS = [
  { id: 'evt',    label: 'EVT',      field: 'evt',        w: 28,  maxLen: 2 },
  { id: 'side1',  label: 'SIDE',     field: 'sideNumber', w: 36,  maxLen: 3, digitsOnly: true },
  { id: 'bcn',    label: 'BCN',      field: 'bcn',        w: 58,  maxLen: 4, digitsOnly: true },
  { id: 'cs',     label: 'CALLSIGN', field: 'callsign',   w: 72,  maxLen: 10 },
  { id: 'pilot',  label: 'PILOT',    field: 'pilot',      w: 64,  maxLen: 24 },
  { id: 'type',   label: 'TYPE',     field: 'type',       w: 38,  maxLen: 4 },
  { id: 'msn',    label: 'MISSION',  field: 'msn',        w: 60,  maxLen: 6 },
  { id: 'atd',    label: 'ATD',      field: 'atd',        w: 36,  maxLen: 4, digitsOnly: true, padZero: 4, timeValidate: true },
  { id: 'radial', label: 'RAD',      field: 'radial',     w: 36,  maxLen: 3, digitsOnly: true, padZero: 3, radialFmt: true },
  { id: 'bingo',  label: 'BINGO',    field: 'bingo',      w: 44,  maxLen: 4, decimalFmt: true, decimalValidate: true },
  { id: 'side2',  label: 'SIDE',     field: 'sideNumber', w: 36,  maxLen: 3, readOnly: true },
  { id: 'appRad', label: 'RAD',      field: 'appRad',     w: 36,  maxLen: 3, padZero: 3, radialFmt: true, radialModes: true, marshalOnly: true },
  { id: 'dme',    label: 'DME',      field: 'dme',        w: 36,  maxLen: 4, stackFmt: true, marshalOnly: true },
  { id: 'angels', label: 'ANG',      field: 'angels',     w: 36,  maxLen: 3, stackFmt: true },
  { id: 'eat',    label: 'EAT',      field: 'eat',        w: 36,  maxLen: 4, digitsOnly: true, timeValidate: true, eatFmt: true },
  { id: 'btn',    label: 'BTN',      field: 'btn',        w: 28,  maxLen: 2, digitsOnly: true },
  { id: 'state',  label: 'STATE',    field: 'state',      w: 44,  maxLen: 4, decimalFmt: true, decimalValidate: true },
  { id: 'ata',    label: 'ATA',      field: 'ata',        w: 36,  maxLen: 4, digitsOnly: true, padZero: 4, timeValidate: true },
]

// Natural docked width: sum of all column tracks + move (28) + delete (20) columns
export const SB_NATURAL_WIDTH = COLUMNS.reduce((s, c) => s + c.w, 0) + 28 + 20

// CASE 2/3 recoveries use the marshal stack, which adds the DME column.
export function isMarshalCase(caseRecovery) {
  return parseInt(caseRecovery, 10) >= 2
}

// Pre-computed per layout: the visible columns, the editable ones in tab
// order, and the editable index by column id.
function buildLayout(cols) {
  const editable = cols.filter(c => !c.readOnly)
  return { cols, editable, idxMap: Object.fromEntries(editable.map((c, i) => [c.id, i])) }
}
export const LAYOUTS = {
  marshal: buildLayout(COLUMNS),
  base:    buildLayout(COLUMNS.filter(c => !c.marshalOnly)),
}

// ── DME / ANGELS: one linked pair in the marshal stack, DME = ANGELS + 15 ───
// Typing either one sets the other, from the lowest usable pair (DME 21 /
// ANGELS 6) up to ANGELS 99. A value prefixed with X, or one outside that
// range, unlinks the pair so a controller can run a nonstandard stack.
export const DME_OFFSET = 15
export const STACK_MIN = { dme: 21, angels: 6 }
const STACK_MAX = { dme: 99 + DME_OFFSET, angels: 99 }

// The row fields after typing `typed` into DME or ANGELS. '' clears the
// linked pair, or just that field once the pair is unlinked.
export function stackFieldsFor(entry, field, typed) {
  const other = field === 'dme' ? 'angels' : 'dme'
  if (!typed) return entry.unlinked ? { [field]: '' } : { dme: '', angels: '', unlinked: false }
  const forced = typed.startsWith('X')
  const value  = forced ? typed.slice(1) : typed
  if (!value) return {}
  const n = parseInt(value, 10)
  if (forced || n < STACK_MIN[field] || n > STACK_MAX[field]) return { [field]: value, unlinked: true }
  return {
    [field]: value,
    [other]: String(field === 'dme' ? n - DME_OFFSET : n + DME_OFFSET),
    unlinked: false,
  }
}

// ── Marshal stack order ──────────────────────────────────────────────────────
// The stack is the rows still holding (no ATA). It must climb with time: a
// later EAT always holds a higher altitude, or two aircraft cross.
const stackRows = (entries) => entries.filter((e) => !e.ata)
const eatMin = (e) => (/^\d{4}$/.test(e.eat ?? '') && isValidTime(e.eat)
  ? (parseInt(e.eat.slice(0, 2), 10) * 60 + parseInt(e.eat.slice(2), 10)) % 1440
  : null)
const angelsOf = (e) => (/^\d+$/.test(e.angels ?? '') ? parseInt(e.angels, 10) : null)
const dmeOf    = (e) => (/^\d+$/.test(e.dme ?? '') ? parseInt(e.dme, 10) : null)
// The approach radial a row marshals on: its own, or the board's header RAD
// when left blank. Altitudes only conflict between aircraft on one radial.
// e.radMode records an E or H radial: the stored number is kept, and E turns
// the row red.
export const appRadOf = (e, defaultRad) => e.appRad || defaultRad || ''

// The radio button an aircraft is sent to: its own, or when left blank the
// header's TWR button (CASE 1/2) or APP button (CASE 3).
export function caseBtn(caseRecovery, twrBtn, appBtn) {
  const c = parseInt(caseRecovery, 10)
  return c === 3 ? (appBtn || '') : (c === 1 || c === 2) ? (twrBtn || '') : ''
}
export const btnOf = (e, defaultBtn) => e.btn || defaultBtn || ''
const toHhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`

// EATs can wrap past 2359. The stack is a short run of minutes with the rest
// of the day empty, so it starts just after the largest gap around the clock.
// Returns the start minute, or null with no EATs.
function stackStart(mins) {
  const sorted = [...new Set(mins)].sort((x, y) => x - y)
  if (!sorted.length) return null
  let start = sorted[0]
  let gap = sorted[0] + 1440 - sorted[sorted.length - 1]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) { gap = sorted[i] - sorted[i - 1]; start = sorted[i] }
  }
  return start
}
const orderKey = (min, start) => (min - start + 1440) % 1440

// The minute after the latest EAT in the stack, as HHMM. Null with no EATs.
export function nextStackEat(entries, id) {
  const mins = stackRows(entries).filter((e) => e.id !== id).map(eatMin).filter((m) => m != null)
  const start = stackStart(mins)
  if (start == null) return null
  const latest = mins.reduce((l, m) => (orderKey(m, start) > orderKey(l, start) ? m : l))
  return toHhmm((latest + 1) % 1440)
}

// The lowest free ANGELS (from 6 up) that keeps the stack climbing for a row
// at EAT `eat`: above every earlier aircraft on its approach radial, below
// every later one. Null when no altitude fits.
export function fitStackAngels(entries, id, eat, defaultRad) {
  const target = eatMin({ eat })
  if (target == null) return null
  const self   = entries.find((e) => e.id === id)
  const radial = self ? appRadOf(self, defaultRad) : (defaultRad || '')
  const others = stackRows(entries).filter((e) => e.id !== id && appRadOf(e, defaultRad) === radial)
  const start  = stackStart([target, ...others.map(eatMin).filter((m) => m != null)])
  const key    = orderKey(target, start)
  let lower = STACK_MIN.angels - 1
  let upper = 100
  const held = new Set()
  for (const e of others) {
    const alt = angelsOf(e)
    if (alt == null) continue
    held.add(alt)
    const m = eatMin(e)
    if (m == null) continue
    const k = orderKey(m, start)
    if (k < key) lower = Math.max(lower, alt)
    if (k > key) upper = Math.min(upper, alt)
  }
  for (let alt = lower + 1; alt < upper; alt++) if (!held.has(alt)) return alt
  return null
}

// Marshal-stack conflicts among rows still holding (no ATA). Returns { eat, dme, angels }, each a
// Set of the row ids to show red:
// - two aircraft sharing an EAT (any radial), or a DME or ANGELS on one approach radial
// - a crossing on one approach radial: an earlier EAT holding a higher DME or
//   ANGELS than a later one (EAT, DME and ANGELS all red on both rows)
// - an EAT with no altitude yet where none fits between its neighbours
export function findStackConflicts(entries, defaultRad) {
  const rows = stackRows(entries)
  const out = { eat: new Set(), dme: new Set(), angels: new Set() }
  const onRadial = (key) => (e) => { const k = key(e); return k == null ? null : `${appRadOf(e, defaultRad)}|${k}` }

  const keys = { eat: eatMin, dme: onRadial(dmeOf), angels: onRadial(angelsOf) }
  for (const [field, key] of Object.entries(keys)) {
    const byValue = new Map()
    for (const e of rows) {
      const k = key(e)
      if (k == null) continue
      byValue.set(k, [...(byValue.get(k) ?? []), e.id])
    }
    for (const ids of byValue.values()) if (ids.length > 1) ids.forEach((id) => out[field].add(id))
  }

  const timed = rows.filter((e) => eatMin(e) != null)
  const start = stackStart(timed.map(eatMin))
  const crossed = (a, b, alt) => {
    const [x, y] = [alt(a), alt(b)]
    if (x == null || y == null) return false
    const [ka, kb] = [orderKey(eatMin(a), start), orderKey(eatMin(b), start)]
    return (ka < kb && x > y) || (kb < ka && y > x)
  }
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const [a, b] = [timed[i], timed[j]]
      if (appRadOf(a, defaultRad) !== appRadOf(b, defaultRad)) continue
      if (!crossed(a, b, angelsOf) && !crossed(a, b, dmeOf)) continue
      for (const f of ['eat', 'dme', 'angels']) { out[f].add(a.id); out[f].add(b.id) }
    }
  }

  for (const e of timed) {
    if (angelsOf(e) == null && dmeOf(e) == null && fitStackAngels(entries, e.id, e.eat, defaultRad) == null) out.eat.add(e.id)
  }
  return out
}
