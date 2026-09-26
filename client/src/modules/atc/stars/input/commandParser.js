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
  // SSA — ATIS code (one letter) / GI text. Aux lines and * (delete)
  // variants precede the plain set patterns, which would otherwise read
  // "S1" or "SA*" as an ATIS code.
  { id: 'SET_GI_AUX',           pattern: /^MF S([1-9]) (.+)$/,    trigger: 'ENTER', captures: ['line', 'text'] },
  { id: 'CLEAR_GI_AUX',         pattern: /^MF S([1-9])$/,         trigger: 'ENTER', captures: ['line'] },
  { id: 'CLEAR_ATIS',           pattern: /^MF S\*$/,              trigger: 'ENTER' },
  { id: 'CLEAR_ATIS_SET_GI',    pattern: /^MF S\* ?(.+)$/,        trigger: 'ENTER', captures: ['giText'] },
  { id: 'SET_ATIS_CLEAR_GI',    pattern: /^MF S([A-Z])\*$/,       trigger: 'ENTER', captures: ['atis'] },
  { id: 'SET_ATIS_GI',          pattern: /^MF S([A-Z]) (.+)$/,    trigger: 'ENTER', captures: ['atis', 'giText'] },
  { id: 'SET_ATIS',             pattern: /^MF S([A-Z])$/,         trigger: 'ENTER', captures: ['atis'] },
  { id: 'CLEAR_ATIS_GI',        pattern: /^MF S$/,                trigger: 'ENTER' },
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
  { id: 'RECENTER',             pattern: /^\.CENTER$/,            trigger: 'ENTER' },
  { id: 'RELOCATE_PREVIEW',     pattern: /^MF P$/,                trigger: 'SLEW'  },
  { id: 'TOGGLE_PTL',           pattern: /^MF R$/,                trigger: 'SLEW'  },
  // MF M family (Tables 23/24/31) — FLID directly after M for the ENTER
  // forms. Δ### (temp altitude) must precede Δ(scratchpad); all of these
  // precede the bare MF M (Mode C toggle).
  { id: 'MF_M_TEMP_ALT',        pattern: /^MF MΔ(\d{3})$/,              trigger: 'SLEW',  captures: ['alt'] },
  { id: 'MF_M_SP1',             pattern: /^MF MΔ(\S{1,3})$/,            trigger: 'SLEW',  captures: ['sp'] },
  { id: 'MF_M_SP2',             pattern: /^MF M\+(\S{1,3})$/,           trigger: 'SLEW',  captures: ['sp'] },
  { id: 'SET_BEACON',           pattern: /^MF M([0-7]{4})$/,            trigger: 'SLEW',  captures: ['bcn'] },
  { id: 'MF_M_REQ_ALT',         pattern: /^MF M(\d{3})$/,               trigger: 'SLEW',  captures: ['alt'] },
  { id: 'MF_M_TEMP_ALT',        pattern: /^MF M(\S+) Δ(\d{3})$/,        trigger: 'ENTER', captures: ['flid', 'alt'] },
  { id: 'MF_M_SP1',             pattern: /^MF M(\S+) Δ(\S{1,3})$/,      trigger: 'ENTER', captures: ['flid', 'sp'] },
  { id: 'MF_M_SP2',             pattern: /^MF M(\S+) \+(\S{1,3})$/,     trigger: 'ENTER', captures: ['flid', 'sp'] },
  { id: 'SET_BEACON',           pattern: /^MF M(\S+) ([0-7]{4})$/,      trigger: 'ENTER', captures: ['flid', 'bcn'] },
  { id: 'MF_M_REQ_ALT',         pattern: /^MF M(\S+) (\d{3})$/,         trigger: 'ENTER', captures: ['flid', 'alt'] },
  { id: 'TOGGLE_MODE_C',        pattern: /^MF M$/,                trigger: 'SLEW'  },
  // MF D — flight plan readout in the preview area (D* / D+ left free)
  { id: 'SHOW_FP',              pattern: /^MF D$/,                trigger: 'SLEW'  },
  { id: 'SHOW_FP',              pattern: /^MF D([A-Z0-9]+)$/,     trigger: 'ENTER', captures: ['flid'] },
  { id: 'TOGGLE_BEACON',        pattern: /^MF B$/,                trigger: 'SLEW'  },
  { id: 'TOGGLE_FDB_OVERFLIGHT',pattern: /^MF E$/,                trigger: 'ENTER' },

  // ── Altitude filters (Table 29) ───────────────────────────────────
  // MF F<ENTER>            — show current filters in preview area
  // MF FC(loA)(hiA)        — set associated-only filter (must precede the bare-F pattern)
  // MF F(loU)(hiU) (loA)(hiA) — set both filters, each value 3 digits (hundreds of feet)
  { id: 'SHOW_ALT_FILTER',      pattern: /^MF F$/,                trigger: 'ENTER' },
  { id: 'SET_ALT_FILTER_ASSOC', pattern: /^MF FC(\d{3})(\d{3})$/, trigger: 'ENTER', captures: ['loA', 'hiA'] },
  { id: 'SET_ALT_FILTER',       pattern: /^MF F(\d{3})(\d{3}) (\d{3})(\d{3})$/, trigger: 'ENTER',
    captures: ['loU', 'hiU', 'loA', 'hiA'] },
  { id: 'SET_RANGE',            pattern: /^RG (\d+)$/,            trigger: 'ENTER', captures: ['range'] },
  { id: 'SET_RNG_RING',         pattern: /^RR (2|5|10|20)$/,      trigger: 'ENTER', captures: ['spacing'] },

  // ── Leader lines ────────────────────────────────────────────────
  // Global (direction entered twice): MF L33
  { id: 'SET_LEADER_GLOBAL',    pattern: /^MF L([1-9])\1$/,       trigger: 'SLEW',  captures: ['dir'] },
  // Single track: MF L3 or shorthand 3
  { id: 'SET_LEADER_MF',        pattern: /^MF L([1-9])$/,         trigger: 'SLEW',  captures: ['dir'] },
  { id: 'SET_LEADER_SHORT',     pattern: /^([1-9])$/,             trigger: 'SLEW',  captures: ['dir'], contextFree: true },
  // Leader length via DCB LDR key: LD 0-7
  { id: 'SET_LEADER_LEN',       pattern: /^LD ([0-7])$/,          trigger: 'ENTER', captures: ['len'] },

  // ── Display settings ─────────────────────────────────────────────
  { id: 'SET_ALTIM',            pattern: /^\.(?:ALTIM|QNH) (\d+(?:\.\d+)?)$/, trigger: 'ENTER', captures: ['value'] },
  { id: 'SET_ASP_COLORS',       pattern: /^\.ASPCOLORS (.+)$/,    trigger: 'ENTER', captures: ['name'] },
  { id: 'REFRESH_ASP_COLORS',  pattern: /^\.REFRESH$/,           trigger: 'ENTER' },
  { id: 'TOGGLE_DBCA',          pattern: /^\.DBCA$/,              trigger: 'ENTER' },
  { id: 'TOGGLE_LABELS',        pattern: /^\.(?:LABELS|LBL|LABEL)$/, trigger: 'ENTER' },
  { id: 'TOGGLE_FIXES',         pattern: /^\.FIXES$/,             trigger: 'ENTER' },
  { id: 'SET_FILL',             pattern: /^\.FILL (\d{1,3})$/,    trigger: 'ENTER', captures: ['pct'] },
  { id: 'TOGGLE_FILL',          pattern: /^\.FILL$/,              trigger: 'ENTER' },
  // .LABELSIZE [0-5] — alias for the CHAR SIZE > MAP DCB spinner (csMap)
  { id: 'SET_LABELSIZE',        pattern: /^\.LABELSIZE ([0-5])$/, trigger: 'ENTER', captures: ['n'] },
  { id: 'SHOW_LABELSIZE',       pattern: /^\.LABELSIZE$/,         trigger: 'ENTER' },
  // Conflict alert (STCA) processing on/off, facility-wide.
  { id: 'TOGGLE_STCA',          pattern: /^\.CA$/,                trigger: 'ENTER' },
  // Simulated squawk-standby wingmen — only the DCS-group flight lead gets
  // a real datablock, the rest render as primary-only contacts. Bare ENTER
  // toggles the feature on/off; SLEW (typed then click) starts a manual
  // lead+wingman pairing for aircraft that don't share a DCS group.
  { id: 'TOGGLE_WINGMEN',       pattern: /^\.WNG$/,               trigger: 'ENTER' },
  { id: 'WNG_PAIR_INIT',        pattern: /^\.WNG$/,               trigger: 'SLEW'  },

  // ── Airspace category bulk toggles — same verbs/categories as CATCC/ABM's
  // .asp/.tma/.ctr/.../.classa-.classg, retargeted at STARS' MAPS DCB slots.
  { id: 'TOGGLE_ASP',           pattern: /^\.ASP$/,               trigger: 'ENTER' },
  { id: 'TOGGLE_AIRSPACE_CAT',  pattern: /^\.(TMA|CTR|CTA|FIR|UIR|SUA|MIL|TRSA|CLASSA|CLASSB|CLASSC|CLASSD|CLASSE|CLASSF|CLASSG)$/,
    trigger: 'ENTER', captures: ['cat'] },

  // ── MAPS submenu single-store toggles ─────────────────────────────
  { id: 'TOGGLE_MSA',           pattern: /^\.MSA$/,               trigger: 'ENTER' },
  { id: 'TOGGLE_HOLDS',         pattern: /^\.HOLDS$/,             trigger: 'ENTER' },
  { id: 'TOGGLE_RELIEF',        pattern: /^\.RELIEF$/,            trigger: 'ENTER' },
  { id: 'TOGGLE_MVA',           pattern: /^\.MVA$/,               trigger: 'ENTER' },
  { id: 'TOGGLE_SAT',           pattern: /^\.SAT (\w+)$/,         trigger: 'ENTER', captures: ['label'] },

  // ── Debug ────────────────────────────────────────────────────────
  { id: 'TOGGLE_COORDS',        pattern: /^\.COORDS$/,            trigger: 'ENTER' },

  // ── Find fix/navaid/airport ──────────────────────────────────────
  { id: 'FIND_FIX',             pattern: /^\.FIND (.+)$/,         trigger: 'ENTER', captures: ['query'] },
  // .FIX <name...> — force-show one or more fixes regardless of the FIXES
  // DCB toggle; each name toggles independently (repeat to un-pin).
  { id: 'TOGGLE_FIX',           pattern: /^\.FIX (.+)$/,          trigger: 'ENTER', captures: ['names'] },
  // .FIX with no argument clears all pinned fixes for this theatre.
  { id: 'CLEAR_FIX',            pattern: /^\.FIX$/,               trigger: 'ENTER' },

  // ── Procedure display ────────────────────────────────────────────
  { id: 'SHOW_PROC',            pattern: /^\.PROC (.+)$/,         trigger: 'ENTER', captures: ['name'] },
  { id: 'CLEAR_PROCS',          pattern: /^\.PROC$/,              trigger: 'ENTER' },

  // ── Filed-route display ──────────────────────────────────────────
  // .RCLEAR — clears every route currently shown (Ctrl+right-click toggle),
  // same convention as ABM's own .rclear.
  { id: 'RCLEAR',               pattern: /^\.RCLEAR$/,            trigger: 'ENTER' },

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
  { id: 'TERM_CNTL_ALL',        pattern: /^\.DROPALL$/,           trigger: 'ENTER' },
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
  { id: 'HND_OFF_SHORT',        pattern: /^([1-9][A-Z0-9])$/,     trigger: 'SLEW',  captures: ['tcp'], contextFree: true },

  // ── Point outs ──────────────────────────────────────────────────
  // Send point out: (TCP)* + SLEW
  { id: 'POINT_OUT',            pattern: /^([^ *]+)\*$/,          trigger: 'SLEW',  captures: ['tcp'], contextFree: true },
  // Convert incoming point out to handoff + accept: ** + SLEW
  { id: 'CONVERT_POINT_OUT',    pattern: /^\*\*$/,                trigger: 'SLEW',  contextFree: true },
  // Reject incoming point out: UN + SLEW
  { id: 'REJECT_POINT_OUT',     pattern: /^UN$/,                  trigger: 'SLEW'  },
  // Force quicklook: ** + (TCP) + SLEW
  { id: 'QUICK_LOOK_TCP',       pattern: /^\*\*([A-Z0-9]+)$/,     trigger: 'SLEW',  captures: ['tcp'], contextFree: true },
  { id: 'QUICK_LOOK_ALL',       pattern: /^\*\*ALL$/,             trigger: 'SLEW',  contextFree: true },

  // ── Conflict alert (Table 27) ───────────────────────────────────
  // CA K — toggle CA warnings for one track
  { id: 'CA_INHIBIT',           pattern: /^CA ?K$/,               trigger: 'SLEW'  },
  { id: 'CA_INHIBIT',           pattern: /^CA ?K (.+)$/,          trigger: 'ENTER', captures: ['flid'] },

  // ── Flight plan creation (Table 23) ─────────────────────────────
  // FLT DATA (F6): abbreviated plan, optional fields in any order.
  // VFR PLAN (F9): [DEP*] DEST TYPE[/EQ] [###]. Implied (no key) form is
  // at the end of the ENTER patterns.
  { id: 'CREATE_FP_ABBREV',     pattern: /^DA ([A-Z][A-Z0-9]{1,12})(?: (.+))?$/, trigger: 'ENTER', captures: ['aid', 'rest'] },
  { id: 'CREATE_VFR_FP',        pattern: /^VP ([A-Z][A-Z0-9]{1,12}) (.+)$/,      trigger: 'ENTER', captures: ['aid', 'rest'] },

  // ── Minimum separation ──────────────────────────────────────────
  // Must precede SET_SP1 — "MIN" matches the 3-char scratchpad pattern
  { id: 'MIN_INIT',             pattern: /^MIN$/,                trigger: 'SLEW'  },
  { id: 'MIN_CLEAR',            pattern: /^MIN$/,                trigger: 'ENTER' },

  // ── Scratchpads ─────────────────────────────────────────────────
  // SP1 via MF Y (SP2 has no MF form - only the + shorthand below)
  { id: 'SET_SP1_MF',           pattern: /^MF Y(.+)$/,            trigger: 'SLEW',  captures: ['sp'] },
  { id: 'CLEAR_SP1_MF',         pattern: /^MF Y$/,                trigger: 'SLEW'  },
  // SP1 via Δ key: Δ(text) + SLEW
  { id: 'SET_SP1',              pattern: /^Δ(\S{1,3})$/,          trigger: 'SLEW',  captures: ['sp'] },
  // SP1 shorthand: (text) + SLEW — a bare 3-digit entry lands here too
  { id: 'SET_SP1',              pattern: /^([A-Z0-9/]{3,4})$/,    trigger: 'SLEW',  captures: ['sp'], contextFree: true },
  // Temporary assigned altitude: +(###) + SLEW (+000 clears) — must
  // precede SET_SP2, whose pattern also matches +###
  { id: 'SET_ALT_ASSIGNED',     pattern: /^\+(\d{3})$/,           trigger: 'SLEW',  captures: ['alt'], contextFree: true },
  // Amend requested (filed) altitude: ++(###) + SLEW
  { id: 'SET_ALT_REQUESTED',    pattern: /^\+\+(\d{3})$/,         trigger: 'SLEW',  captures: ['alt'], contextFree: true },
  // SP2 shorthand: +(text) + SLEW
  { id: 'SET_SP2',              pattern: /^\+([A-Z0-9/]{1,4})$/,  trigger: 'SLEW',  captures: ['sp'], contextFree: true },
  // Clear SP1: . + SLEW
  { id: 'CLEAR_SP1',            pattern: /^\.$/,                  trigger: 'SLEW',  contextFree: true },
  // Clear SP2: + + SLEW
  { id: 'CLEAR_SP2',            pattern: /^\+$/,                  trigger: 'SLEW',  contextFree: true },

  // ── Range bearing line ──────────────────────────────────────────
  // *T + ENTER → clear all RBLs; *Tn + ENTER → clear RBL #n
  // *T + SLEW  → initiate RBL (P0 = slew target or click position)
  { id: 'RBL_CLEAR_ALL',        pattern: /^\*T$/,                 trigger: 'ENTER' },
  { id: 'RBL_CLEAR_N',          pattern: /^\*T(\d+)$/,            trigger: 'ENTER', captures: ['n'] },
  { id: 'RBL_INIT_FIX',         pattern: /^\*T (.+)$/,            trigger: 'ENTER', captures: ['query'] },
  { id: 'RBL_INIT',             pattern: /^\*T$/,                 trigger: 'SLEW'  },

  // ── Implied flight plan: <AID>(fields)<ENTER> — MUST be the last
  // ENTER pattern. The handler rejects known command verbs as AIDs and
  // tries the FLT DATA fields before the VFR PLAN fields.
  { id: 'CREATE_FP_IMPLIED',    pattern: /^([A-Z][A-Z0-9]{1,12})(?: (.+))?$/,    trigger: 'ENTER', captures: ['aid', 'rest'], contextFree: true },

  // ── Context-sensitive bare slew — MUST be last ──────────────────
  { id: 'BARE_SLEW',            pattern: /^$/,                    trigger: 'SLEW'  },
]

// ── Known command verbs ──────────────────────────────────────────────────
// Used to distinguish an unrecognized entry (INVALID INPUT) from a recognized
// command with bad arguments/format — wrong digit count, missing space, bad
// value (FORMAT) — when nothing in COMMANDS matches on ENTER. Derived from
// the literal keyword each command family starts with; context-free shorthand
// (bare digits, TCP shorthand, scratchpad shorthand, altitude shorthand) has
// no fixed verb and is excluded, so those fall back to INVALID INPUT.
export const WORD_VERBS = ['MF', 'RG', 'RR', 'LD', 'IC', 'TC', 'HO', 'MIN', 'UN', 'DA', 'VP', 'CA', 'RP']
const DOT_VERBS = [
  'ALTIM', 'QNH', 'ASPCOLORS', 'REFRESH', 'DBCA', 'LABELS', 'LBL', 'LABEL', 'FIXES', 'FILL',
  'CA', 'WNG', 'ASP', 'TMA', 'CTR', 'CTA', 'FIR', 'UIR', 'SUA', 'MIL', 'TRSA',
  'CLASSA', 'CLASSB', 'CLASSC', 'CLASSD', 'CLASSE', 'CLASSF', 'CLASSG',
  'MSA', 'HOLDS', 'RELIEF', 'MVA', 'SAT', 'COORDS', 'FIND', 'FIX', 'PROC',
  'FP', 'RENAME', 'LABELSIZE', 'DROPALL', 'CENTER',
]

/**
 * Whether the trimmed/uppercased buffer starts with a recognized command
 * verb, even though it didn't match any full pattern in COMMANDS.
 *
 * @param {string} trimmed  trimmed, uppercased buffer
 */
export function looksLikeKnownCommand(trimmed) {
  if (trimmed.startsWith('*T')) return true
  if (trimmed.startsWith('.')) {
    const m = trimmed.match(/^\.([A-Z]+)/)
    return !!m && DOT_VERBS.includes(m[1])
  }
  const m = trimmed.match(/^([A-Z]+)(?: |$)/)
  return !!m && WORD_VERBS.includes(m[1])
}

/**
 * Match the current buffer against the command table.
 *
 * @param {string}  buffer    current preview buffer (trimmed)
 * @param {'SLEW'|'ENTER'} trigger   what event fired
 * @param {boolean} hasToken  true if a function-key token entered the buffer
 *   since it was last cleared — disables the context-free shorthand patterns,
 *   which are only valid for buffers built purely from typed characters.
 * @returns {{ command, captures } | null}
 */
export function parseCommand(buffer, trigger, hasToken = false) {
  const trimmed = buffer.trim().toUpperCase()

  for (const cmd of COMMANDS) {
    if (cmd.trigger !== trigger && cmd.trigger !== 'EITHER') continue
    if (cmd.contextFree && hasToken) continue
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
