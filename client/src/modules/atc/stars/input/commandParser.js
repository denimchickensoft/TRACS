/**
 * STARS command parser.
 *
 * Each command definition has:
 *   id       — unique identifier, passed to action library
 *   pattern  — RegExp matched against the trimmed preview buffer
 *   trigger  — 'SLEW' | 'ENTER' | 'EITHER'
 *   captures — names for capture groups (optional)
 *
 * Order matters — more specific patterns must come before broader ones.
 *
 * Source: CRC STARS documentation — Command Reference
 */

const COMMANDS = [
  // ── List management ─────────────────────────────────────────────
  // SSA — relocate only (always visible)
  { id: 'RELOCATE_SSA',         pattern: /^MF S$/,                trigger: 'SLEW'  },
  // Sign-On List
  { id: 'TOGGLE_SIGNON',        pattern: /^MF TS$/,               trigger: 'ENTER' },
  { id: 'RELOCATE_SIGNON',      pattern: /^MF TS$/,               trigger: 'SLEW'  },
  // Flight Plan (TAB) List — resize before toggle so "MF T5" doesn't match "MF T"
  { id: 'RESIZE_TAB',           pattern: /^MF T(\d+)$/,           trigger: 'ENTER', captures: ['lines'] },
  { id: 'TOGGLE_TAB',           pattern: /^MF T$/,                trigger: 'ENTER' },
  { id: 'RELOCATE_TAB',         pattern: /^MF T$/,                trigger: 'SLEW'  },
  // Tower Lists (1–3)
  { id: 'RESIZE_TOWER',         pattern: /^MF P([1-3]) (\d+)$/,   trigger: 'ENTER', captures: ['idx', 'lines'] },
  { id: 'TOGGLE_TOWER',         pattern: /^MF P([1-3])$/,         trigger: 'ENTER', captures: ['idx'] },
  { id: 'RELOCATE_TOWER',       pattern: /^MF P([1-3])$/,         trigger: 'SLEW',  captures: ['idx'] },
  // Coast/Suspend List
  { id: 'RESIZE_COAST',         pattern: /^MF TC(\d+)$/,          trigger: 'ENTER', captures: ['lines'] },
  { id: 'TOGGLE_COAST',         pattern: /^MF TC$/,               trigger: 'ENTER' },
  { id: 'RELOCATE_COAST',       pattern: /^MF TC$/,               trigger: 'SLEW'  },
  // Alert (CA/MCI/LA) List
  { id: 'TOGGLE_ALERT',         pattern: /^MF TM$/,               trigger: 'ENTER' },
  { id: 'RELOCATE_ALERT',       pattern: /^MF TM$/,               trigger: 'SLEW'  },
  // VFR List
  { id: 'RESIZE_VFR',           pattern: /^MF TV(\d+)$/,          trigger: 'ENTER', captures: ['lines'] },
  { id: 'TOGGLE_VFR',           pattern: /^MF TV$/,               trigger: 'ENTER' },
  { id: 'RELOCATE_VFR',         pattern: /^MF TV$/,               trigger: 'SLEW'  },

  // ── Display manipulation ────────────────────────────────────────
  { id: 'RELOCATE_PREVIEW',     pattern: /^MF P$/,                trigger: 'SLEW'  },
  { id: 'TOGGLE_PTL',           pattern: /^MF R$/,                trigger: 'SLEW'  },
  { id: 'TOGGLE_MODE_C',        pattern: /^MF M$/,                trigger: 'SLEW'  },
  { id: 'TOGGLE_BEACON',        pattern: /^MF B$/,                trigger: 'SLEW'  },
  { id: 'TOGGLE_FDB_OVERFLIGHT',pattern: /^MF E$/,                trigger: 'ENTER' },
  { id: 'SET_RANGE',            pattern: /^RG (\d+)$/,            trigger: 'ENTER', captures: ['range'] },
  { id: 'SET_RNG_RING',         pattern: /^RR (2|5|10|20)$/,      trigger: 'ENTER', captures: ['spacing'] },

  // ── Leader lines ────────────────────────────────────────────────
  // Global (direction entered twice): MF L33
  { id: 'SET_LEADER_GLOBAL',    pattern: /^MF L([1-9])\1$/,       trigger: 'SLEW',  captures: ['dir'] },
  // Single track: MF L3 or shorthand 3
  { id: 'SET_LEADER_MF',        pattern: /^MF L([1-9])$/,         trigger: 'SLEW',  captures: ['dir'] },
  { id: 'SET_LEADER_SHORT',     pattern: /^([1-9])$/,             trigger: 'SLEW',  captures: ['dir'] },
  // Leader length via DCB LDR key: LD 0-7
  { id: 'SET_LEADER_LEN',       pattern: /^LD ([0-7])$/,          trigger: 'ENTER', captures: ['len'] },

  // ── Display settings ─────────────────────────────────────────────
  { id: 'SET_ALTIM',            pattern: /^\.(?:ALTIM|QNH) (\d+(?:\.\d+)?)$/, trigger: 'ENTER', captures: ['value'] },
  { id: 'SET_ASP_COLORS',       pattern: /^\.ASPCOLORS (.+)$/,    trigger: 'ENTER', captures: ['name'] },
  { id: 'REFRESH_ASP_COLORS',  pattern: /^\.REFRESH$/,           trigger: 'ENTER' },
  { id: 'TOGGLE_DBCA',          pattern: /^\.DBCA$/,              trigger: 'ENTER' },

  // ── Debug ────────────────────────────────────────────────────────
  { id: 'TOGGLE_COORDS',        pattern: /^\.COORDS$/,            trigger: 'ENTER' },

  // ── Find fix/navaid/airport ──────────────────────────────────────
  { id: 'FIND_FIX',             pattern: /^\.FIND (.+)$/,         trigger: 'ENTER', captures: ['query'] },

  // ── Procedure display ────────────────────────────────────────────
  { id: 'SHOW_PROC',            pattern: /^\.PROC (.+)$/,         trigger: 'ENTER', captures: ['name'] },
  { id: 'CLEAR_PROCS',          pattern: /^\.PROC$/,              trigger: 'ENTER' },

  // ── Flight plan editor ──────────────────────────────────────────
  { id: 'OPEN_FPE',             pattern: /^\.FP (.+)$/,           trigger: 'ENTER', captures: ['aid'] },
  { id: 'OPEN_FPE',             pattern: /^\.FP$/,                trigger: 'ENTER' },

  // ── Callsign rename ──────────────────────────────────────────────
  { id: 'RENAME_CALLSIGN',      pattern: /^\.RENAME (.+)$/,       trigger: 'SLEW',  captures: ['newCallsign'] },
  { id: 'RESET_CALLSIGN',       pattern: /^\.RENAME$/,            trigger: 'SLEW'  },

  // ── Track control ───────────────────────────────────────────────
  { id: 'INIT_CNTL',            pattern: /^IC$/,                  trigger: 'SLEW'  },
  { id: 'INIT_CNTL_BY_ID',      pattern: /^IC (.+)$/,             trigger: 'ENTER', captures: ['flid'] },
  { id: 'TERM_CNTL_ALL',        pattern: /^TC ALL$/,              trigger: 'ENTER' },
  { id: 'TERM_CNTL_BY_ID',      pattern: /^TC (.+)$/,             trigger: 'ENTER', captures: ['flid'] },
  { id: 'TERM_CNTL',            pattern: /^TC$/,                  trigger: 'SLEW'  },

  // ── Handoffs ────────────────────────────────────────────────────
  // Accept nearest incoming handoff: HO + ENTER
  { id: 'HND_OFF_ACCEPT_NEAR',  pattern: /^HO$/,                  trigger: 'ENTER' },
  // Recall/cancel outgoing handoff: HO + SLEW (on owned track with pending HO)
  // Initiate handoff: HO (TCP) + SLEW
  { id: 'HND_OFF',              pattern: /^HO ([^ ]+)$/,          trigger: 'SLEW',  captures: ['tcp'] },
  // Initiate by flight ID: HO (TCP) (FLID) + ENTER
  { id: 'HND_OFF_BY_ID',        pattern: /^HO ([^ ]+) (.+)$/,     trigger: 'ENTER', captures: ['tcp', 'flid'] },
  // Bare HO + slew = context-dependent (recall if outgoing, accept if incoming)
  { id: 'HND_OFF_BARE',         pattern: /^HO$/,                  trigger: 'SLEW'  },
  // Shorthand: TCP + SLEW (e.g. "1D" slew = handoff to 1D)
  { id: 'HND_OFF_SHORT',        pattern: /^([1-9][A-Z0-9])$/,     trigger: 'SLEW',  captures: ['tcp'] },

  // ── Point outs ──────────────────────────────────────────────────
  // Send point out: (TCP)* + SLEW
  { id: 'POINT_OUT',            pattern: /^([^ *]+)\*$/,          trigger: 'SLEW',  captures: ['tcp'] },
  // Convert incoming point out to handoff + accept: ** + SLEW
  { id: 'CONVERT_POINT_OUT',    pattern: /^\*\*$/,                trigger: 'SLEW'  },
  // Reject incoming point out: UN + SLEW
  { id: 'REJECT_POINT_OUT',     pattern: /^UN$/,                  trigger: 'SLEW'  },
  // Force quicklook: ** + (TCP) + SLEW
  { id: 'QUICK_LOOK_TCP',       pattern: /^\*\*([A-Z0-9]+)$/,     trigger: 'SLEW',  captures: ['tcp'] },
  { id: 'QUICK_LOOK_ALL',       pattern: /^\*\*ALL$/,             trigger: 'SLEW'  },

  // ── Minimum separation ──────────────────────────────────────────
  // Must precede SET_SP1 — "MIN" matches the 3-char scratchpad pattern
  { id: 'MIN_INIT',             pattern: /^MIN$/,                trigger: 'SLEW'  },
  { id: 'MIN_CLEAR',            pattern: /^MIN$/,                trigger: 'ENTER' },

  // ── Scratchpads ─────────────────────────────────────────────────
  // SP1 via MF Y
  { id: 'SET_SP1_MF',           pattern: /^MF Y(.+)$/,            trigger: 'SLEW',  captures: ['sp'] },
  { id: 'CLEAR_SP1_MF',         pattern: /^MF Y$/,                trigger: 'SLEW'  },
  // SP2 via MF Y+
  { id: 'SET_SP2_MF',           pattern: /^MF Y\+(.+)$/,          trigger: 'SLEW',  captures: ['sp'] },
  { id: 'CLEAR_SP2_MF',         pattern: /^MF Y\+$/,              trigger: 'SLEW'  },
  // SP1 shorthand: (text) + SLEW
  { id: 'SET_SP1',              pattern: /^([A-Z0-9/]{3,4})$/,    trigger: 'SLEW',  captures: ['sp'] },
  // SP2 shorthand: +(text) + SLEW
  { id: 'SET_SP2',              pattern: /^\+([A-Z0-9/]{1,4})$/,  trigger: 'SLEW',  captures: ['sp'] },
  // Clear SP1: . + SLEW
  { id: 'CLEAR_SP1',            pattern: /^\.$/,                  trigger: 'SLEW'  },
  // Clear SP2: + + SLEW
  { id: 'CLEAR_SP2',            pattern: /^\+$/,                  trigger: 'SLEW'  },

  // ── Altitude ────────────────────────────────────────────────────
  // Pilot-reported altitude: (###) + SLEW
  { id: 'SET_ALT_REPORTED',     pattern: /^(\d{3})$/,             trigger: 'SLEW',  captures: ['alt'] },
  // Assigned altitude: +(###) + SLEW
  { id: 'SET_ALT_ASSIGNED',     pattern: /^\+(\d{3})$/,           trigger: 'SLEW',  captures: ['alt'] },

  // ── Range bearing line ──────────────────────────────────────────
  // *T + ENTER → clear all RBLs; *Tn + ENTER → clear RBL #n
  // *T + SLEW  → initiate RBL (P0 = slew target or click position)
  { id: 'RBL_CLEAR_ALL',        pattern: /^\*T$/,                 trigger: 'ENTER' },
  { id: 'RBL_CLEAR_N',          pattern: /^\*T(\d+)$/,            trigger: 'ENTER', captures: ['n'] },
  { id: 'RBL_INIT_FIX',         pattern: /^\*T (.+)$/,            trigger: 'ENTER', captures: ['query'] },
  { id: 'RBL_INIT',             pattern: /^\*T$/,                 trigger: 'SLEW'  },

  // ── Context-sensitive bare slew — MUST be last ──────────────────
  { id: 'BARE_SLEW',            pattern: /^$/,                    trigger: 'SLEW'  },
]

/**
 * Match the current buffer against the command table.
 *
 * @param {string}  buffer   current preview buffer (trimmed)
 * @param {'SLEW'|'ENTER'} trigger  what event fired
 * @returns {{ command, captures } | null}
 */
export function parseCommand(buffer, trigger) {
  const trimmed = buffer.trim().toUpperCase()

  for (const cmd of COMMANDS) {
    if (cmd.trigger !== trigger && cmd.trigger !== 'EITHER') continue
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
