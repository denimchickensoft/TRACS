/**
 * STARS key → preview area token mappings.
 *
 * Each entry maps a key event (code + modifiers) to either:
 *   token  — text injected into the preview buffer
 *   action — a named side-effect that fires immediately (no buffer entry)
 *
 * Key codes match KeyboardEvent.code values.
 *
 * Source: CRC STARS documentation — STARS Keys table
 */

export const STARS_KEY_MAP = [
  // ── Operational keys ──────────────────────────────────────────────
  { code: 'F2',                ctrl: false, token: 'TR ' },   // TRK RPOS
  { code: 'F3',                ctrl: false, token: 'IC'  },   // INIT CNTL
  { code: 'F4',                ctrl: false, token: 'TC'  },   // TERM CNTL
  { code: 'F5',                ctrl: false, token: 'HO ' },   // HND OFF
  { code: 'F6',                ctrl: false, token: 'FD ' },   // FLT DATA
  { code: 'F7',                ctrl: false, token: 'MF ' },   // MULTI FUNC
  { code: 'F9',                ctrl: false, token: 'FP ' },   // VFR flight plan
  { code: 'F11',               ctrl: false, token: 'CA ' },   // CA
  { code: 'F13',               ctrl: false, token: 'F13 '},   // F13 (Shift+F3 alias handled in handler)
  { code: 'F3',                shift: true, token: 'F13 '},   // F13 (Shift+F3)
  { code: 'End',               ctrl: false, token: 'MIN' },   // MIN

  // Δ key — backtick
  { code: 'Backquote',         ctrl: false, token: 'Δ'   },

  // ── DCB / display keys — fire immediate action, no buffer entry ──
  { code: 'F1',                ctrl: true,  action: 'RECENTER'    },  // CNTR
  { code: 'F2',                ctrl: true,  action: 'OPEN_MAPS'   },  // MAPS
  { code: 'F3',                ctrl: true,  action: 'OPEN_BRITE'  },  // BRITE
  { code: 'F4',                ctrl: true,  action: 'DCB_LDR'     },  // LDR
  { code: 'F5',                ctrl: true,  action: 'OPEN_CHARSIZE'},  // CHAR SIZE
  { code: 'F7',                ctrl: true,  action: 'TOGGLE_AUX'  },  // SHIFT (aux DCB)
  { code: 'F8',                ctrl: true,  action: 'TOGGLE_DCB'  },  // DCB
  { code: 'F9',                ctrl: true,  action: 'DCB_RNG_RING' },  // RNG RING
  { code: 'F10',               ctrl: true,  action: 'DCB_RANGE'   },  // RANGE
  { code: 'Insert',            ctrl: false, action: 'DCB_PREF'    },  // PREF SET
  { code: 'KeyT',              ctrl: true,  action: 'TOGGLE_TOPDOWN' }, // Ctrl+T = top-down
]

/**
 * Given a KeyboardEvent, return the matching STARS key entry or null.
 * @param {KeyboardEvent} e
 */
export function matchStarsKey(e) {
  for (const entry of STARS_KEY_MAP) {
    if (entry.code !== e.code) continue
    if (entry.ctrl  !== undefined && entry.ctrl  !== e.ctrlKey)  continue
    if (entry.shift !== undefined && entry.shift !== e.shiftKey) continue
    return entry
  }
  return null
}

/**
 * Returns true if a KeyboardEvent should be treated as typed input
 * (appended to the preview buffer as-is).
 * @param {KeyboardEvent} e
 */
export function isTypedInput(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false
  if (e.key.length !== 1) return false
  // Allow alphanumeric + STARS-meaningful punctuation
  return /^[A-Z0-9 .+*/_Δ-]$/i.test(e.key)
}
