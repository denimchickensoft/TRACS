// ── Time validation (2400-clock: 0000–2359, plus 2400) ───────────────────────
export function isValidTime(v) {
  if (!v) return true
  if (!/^\d{4}$/.test(v)) return false
  const h = parseInt(v.slice(0, 2), 10)
  const m = parseInt(v.slice(2, 4), 10)
  return (h === 24 && m === 0) || (h <= 23 && m <= 59)
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
  { id: 'radial', label: 'RADIAL',   field: 'radial',     w: 42,  maxLen: 3, digitsOnly: true, padZero: 3, radialFmt: true },
  { id: 'bingo',  label: 'BINGO',    field: 'bingo',      w: 44,  maxLen: 4, decimalFmt: true, decimalValidate: true },
  { id: 'side2',  label: 'SIDE',     field: 'sideNumber', w: 36,  maxLen: 3, readOnly: true },
  { id: 'eat',    label: 'EAT',      field: 'eat',        w: 36,  maxLen: 4, digitsOnly: true, padZero: 4, timeValidate: true },
  { id: 'angels', label: 'ANGELS',   field: 'angels',     w: 42,  maxLen: 2, digitsOnly: true },
  { id: 'state',  label: 'STATE',    field: 'state',      w: 44,  maxLen: 4, decimalFmt: true, decimalValidate: true },
  { id: 'ata',    label: 'ATA',      field: 'ata',        w: 36,  maxLen: 4, digitsOnly: true, padZero: 4, timeValidate: true },
]

// Natural docked width: sum of all column tracks + move (28) + delete (20) columns
export const SB_NATURAL_WIDTH = COLUMNS.reduce((s, c) => s + c.w, 0) + 28 + 20

// Pre-computed: editable columns in tab order, and index map by column id
export const EDITABLE_COLS    = COLUMNS.filter(c => !c.readOnly)
export const EDIT_COL_IDX_MAP = Object.fromEntries(EDITABLE_COLS.map((c, i) => [c.id, i]))
