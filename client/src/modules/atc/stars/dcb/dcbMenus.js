// STARS DCB menu layout, value-spinner configuration and the pure helpers
// that read/adjust those values. Rendering and click handling live in Dcb.jsx.
import { LDR_DIR_SEQUENCE, LDR_DIR_CANVAS_ANGLES, ldrDirWraparound, clampValueDelta } from '../../../../utils/dcbSpinner.js'
import { distFromNm } from '../../../../utils/units.js'

export const WINDOW_ID = 'atc-main'

const RR_VALUES = [2, 5, 10, 20]

// ─── Menu / button definitions ────────────────────────────────────────────────
// Slot item is one of:
//   Button   { id, lines, type, ...opts }
//   HalfH    { id, slotType: 'halfH', buttons: [top, bottom] }  ← stacked (half-height each)
//   Spacer   { id, type: 'spacer' }

export const MAIN_BUTTONS = [
  // 1 — full
  { id: 'RANGE',   lines: ['RANGE'], type: 'value' },

  // 2 — halfV: PLACE CNTR / OFF CNTR
  { id: 'slot_cntr', slotType: 'halfV', buttons: [
    { id: 'PLACE_CNTR', lines: ['PLACE', 'CNTR'], type: 'action' },
    { id: 'OFF_CNTR',   lines: ['OFF',   'CNTR'], type: 'action' },
  ]},

  // 3 — full
  { id: 'RR', lines: ['RR'], type: 'value' },

  // 4 — halfV: PLACE RR / RR CNTR
  { id: 'slot_rr', slotType: 'halfV', buttons: [
    { id: 'PLACE_RR', lines: ['PLACE RR'], type: 'action' },
    { id: 'RR_CNTR',  lines: ['RR CNTR'],  type: 'action' },
  ]},

  // 5 — full
  { id: 'MAPS', lines: ['MAPS'], type: 'submenu', target: 'maps' },

  // 6-8 — halfV pairs: map slots (labels resolved at render from maps store)
  { id: 'slot_map_0', slotType: 'halfV', buttons: [
    { id: 'MAP_1', lines: [], type: 'toggle' },
    { id: 'MAP_4', lines: [], type: 'toggle' },
  ]},
  { id: 'slot_map_1', slotType: 'halfV', buttons: [
    { id: 'MAP_2', lines: [], type: 'toggle' },
    { id: 'MAP_5', lines: [], type: 'toggle' },
  ]},
  { id: 'slot_map_2', slotType: 'halfV', buttons: [
    { id: 'MAP_3', lines: [], type: 'toggle' },
    { id: 'MAP_6', lines: ['LBL'], type: 'toggle' },
  ]},

  // 9 — full
  { id: 'BRITE', lines: ['BRITE'], type: 'submenu', target: 'brite' },

  // 10 — halfV: LDR DIR / LDR LEN
  { id: 'slot_ldr', slotType: 'halfV', buttons: [
    { id: 'LDR_DIR', lines: ['LDR DIR'], type: 'value' },
    { id: 'LDR_LEN', lines: ['LDR LEN'], type: 'value' },
  ]},

  // 11 — full
  { id: 'CHAR_SIZE', lines: ['CHAR', 'SIZE'], type: 'submenu', target: 'char_size' },

  // 12 — full
  { id: 'PREF', lines: ['PREF'], type: 'submenu', target: 'pref' },

  { id: 'SHIFT', lines: ['SHIFT'], type: 'shift' },
]

function padToShift(defs) {
  return [...defs, { id: 'SHIFT', lines: ['SHIFT'], type: 'shift' }]
}

export const AUX_BUTTONS = padToShift([
  { id: 'VOL', lines: ['VOL'], type: 'value' },
  { id: 'slot_ca_wng', slotType: 'halfV', buttons: [
    { id: 'CA',  lines: ['CA'],  type: 'toggle' },
    { id: 'WNG', lines: ['WNG'], type: 'toggle' },
  ]},
  { id: 'slot_history', slotType: 'halfV', buttons: [
    { id: 'HISTORY', lines: ['HISTORY'], type: 'value' },
    { id: 'H_RATE',  lines: ['H_RATE'],  type: 'value' },
  ]},
  { id: 'slot_dcb_pos_0', slotType: 'halfV', buttons: [
    { id: 'DCB_TOP',  lines: ['DCB', 'TOP'],    type: 'action' },
    { id: 'DCB_LEFT', lines: ['DCB', 'LEFT'],   type: 'action' },
  ]},
  { id: 'slot_dcb_pos_1', slotType: 'halfV', buttons: [
    { id: 'DCB_RIGHT',  lines: ['DCB', 'RIGHT'],  type: 'action' },
    { id: 'DCB_BOTTOM', lines: ['DCB', 'BOTTOM'], type: 'action' },
  ]},
  { id: 'PTL_LNTH', lines: ['PTL', 'LNTH'], type: 'value' },
  { id: 'slot_ptl', slotType: 'halfV', buttons: [
    { id: 'PTL_OWN', lines: ['PTL', 'OWN'], type: 'action' },
    { id: 'PTL_ALL', lines: ['PTL', 'ALL'], type: 'action' },
  ]},
])


export const SUBMENU_DEFS = {
  maps: {
    parent: 'main',
    buttons: [
      { id: 'slot_holds_msa', slotType: 'halfV', buttons: [
        { id: 'HOLDS', lines: ['HOLDS'], type: 'toggle' },
        { id: 'MSA',   lines: ['MSA'],   type: 'toggle' },
      ]},
      { id: 'slot_vj', slotType: 'halfV', buttons: [
        { id: 'AIR_V', lines: ['V'], type: 'toggle' },
        { id: 'AIR_J', lines: ['J'], type: 'toggle' },
      ]},
      { id: 'slot_b_mora', slotType: 'halfV', buttons: [
        { id: 'AIR_B', lines: ['B'],            type: 'toggle' },
        { id: 'MORA',  lines: ['GRID', 'MORA'], type: 'toggle' },
      ]},
      { id: 'DONE', lines: ['DONE'], type: 'done' },
    ],
  },
  brite: {
    parent: 'main',
    buttons: [
      { id: 'slot_br_0', slotType: 'halfV', buttons: [
        { id: 'BR_DCB', lines: ['DCB'],   type: 'value' },
        { id: 'BR_BKG', lines: ['BKG'],   type: 'value' },
      ]},
      { id: 'slot_br_1', slotType: 'halfV', buttons: [
        { id: 'BR_MAP_A', lines: ['MAP A'], type: 'value' },
        { id: 'BR_MAP_B', lines: ['MAP B'], type: 'value' },
      ]},
      { id: 'slot_br_2', slotType: 'halfV', buttons: [
        { id: 'BR_FDB', lines: ['FDB'],   type: 'value' },
        { id: 'BR_LST', lines: ['LST'],   type: 'value' },
      ]},
      { id: 'slot_br_3', slotType: 'halfV', buttons: [
        { id: 'BR_POS', lines: ['POS'],   type: 'value' },
        { id: 'BR_LDB', lines: ['LDB'],   type: 'value' },
      ]},
      { id: 'slot_br_4', slotType: 'halfV', buttons: [
        { id: 'BR_RR',  lines: ['RR'],    type: 'value' },
        { id: 'BR_CMP', lines: ['CMP'],   type: 'value' },
      ]},
      { id: 'slot_br_5', slotType: 'halfV', buttons: [
        { id: 'BR_HST', lines: ['HST'],  type: 'value' },
      ]},
      { id: 'DONE', lines: ['DONE'], type: 'done' },
    ],
  },
  char_size: {
    parent: 'main',
    buttons: [
      { id: 'CS_DATABLOCKS', lines: ['DATA', 'BLOCKS'], type: 'value' },
      { id: 'CS_LISTS',      lines: ['LISTS'],          type: 'value' },
      { id: 'CS_DCB',        lines: ['DCB'],            type: 'value' },
      { id: 'CS_TOOLS',      lines: ['TOOLS'],          type: 'value' },
      { id: 'CS_POS',        lines: ['POS'],            type: 'value' },
      { id: 'CS_MAP',        lines: ['MAP'],            type: 'value' },
      { id: 'DONE', lines: ['DONE'], type: 'done' },
    ],
  },
  pref: {
    parent: 'main',
    buttons: [
      // 12 preset slots as 6 halfV pairs — names resolved dynamically in renderBtn
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `_pref_hv_${i}`,
        slotType: 'halfV',
        buttons: [
          { id: `PRESET_${i * 2}`,     lines: [], type: 'preset-slot' },
          { id: `PRESET_${i * 2 + 1}`, lines: [], type: 'preset-slot' },
        ],
      })),
      { id: '_pref_hv_save', slotType: 'halfV', buttons: [
        { id: 'PREF_SAVE',    lines: ['SAVE'],       type: 'action' },
        { id: 'PREF_SAVE_AS', lines: ['SAVE', 'AS'], type: 'action' },
      ]},
      { id: '_pref_hv_del', slotType: 'halfV', buttons: [
        { id: 'PREF_DELETE',  lines: ['DELETE'],  type: 'action' },
        { id: 'PREF_DEFAULT', lines: ['DEFAULT'], type: 'action' },
      ]},
      { id: 'DONE', lines: ['DONE'], type: 'done' },
    ],
  },
}

// ─── Value configuration ─────────────────────────────────────────────────────

// dir: 1 = scroll-down increases (matches scope zoom convention used for RANGE)
//      -1 = scroll-up increases (standard for everything else)
// fmt(value, unitSystem): RANGE/RR spin in NM steps and show the value in
// the ATC display unit (NM or km).
export const VALUE_CONFIG = {
  VOL:           { min: 1,   max: 10,  step: 1,   dir: -1, fmt: v => String(v)                  },
  RANGE:         { min: 6,   max: 256, step: 1,   dir:  1, fmt: (v, sys) => String(Math.round(distFromNm(v, sys))) },
  RR:            { min: 0,   max: 3,   step: 1,   dir: -1, fmt: (v, sys) => String(Math.round(distFromNm(RR_VALUES[v] ?? 10, sys))) },
  LDR_DIR:       { min: 0,   max: 7,   step: 1,   dir: -1, fmt: v => LDR_DIR_SEQUENCE[v] ?? 'NE' },
  LDR_LEN:       { min: 0,   max: 7,   step: 1,   dir: -1, fmt: v => String(v)                  },
  PTL_LNTH:      { min: 0,   max: 5,   step: 0.5, dir: -1, fmt: v => v.toFixed(1)               },
  HISTORY:       { min: 0,   max: 10,  step: 1,   dir: -1, fmt: v => String(v)                  },
  H_RATE:        { min: 0,   max: 4.5, step: 0.5, dir: -1, fmt: v => v.toFixed(1)               },
  BR_DCB:        { min: 25, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_BKG:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_MAP_A:      { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_MAP_B:      { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_FDB:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_LST:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_POS:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_LDB:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_RR:         { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_CMP:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  BR_HST:        { min: 0, max: 100, step: 5, dir: -1, fmt: v => String(v) },
  CS_DATABLOCKS: { min: 0,   max: 5,   step: 1,   dir: -1, fmt: v => String(v)                  },
  CS_LISTS:      { min: 0,   max: 5,   step: 1,   dir: -1, fmt: v => String(v)                  },
  CS_DCB:        { min: 0,   max: 5,   step: 1,   dir: -1, fmt: v => String(v)                  },
  CS_TOOLS:      { min: 0,   max: 5,   step: 1,   dir: -1, fmt: v => String(v)                  },
  CS_POS:        { min: 0,   max: 5,   step: 1,   dir: -1, fmt: v => String(v)                  },
  CS_MAP:        { min: 0,   max: 5,   step: 1,   dir: -1, fmt: v => String(v)                  },
}

export function getWindowValue(id, win) {
  switch (id) {
    case 'VOL':           return win?.vol            ?? 10
    case 'RANGE':         return win?.rangeNm       ?? 60
    case 'RR': {
      const nm = win?.ringSpacingNm ?? 10
      const idx = RR_VALUES.indexOf(nm)
      return idx >= 0 ? idx : 2  // fallback to 10nm (index 2)
    }
    case 'LDR_DIR': {
      const angle = win?.ldrAngleDeg ?? -45  // default NE
      const idx = LDR_DIR_CANVAS_ANGLES.indexOf(angle)
      return idx >= 0 ? idx : 1  // fallback to NE (index 1)
    }
    case 'LDR_LEN':       return win?.ldrLength     ?? 4   // 4 = 40px at 10px/unit
    case 'PTL_LNTH':      return win?.ptlLength     ?? 2
    case 'HISTORY':       return win?.historyLength ?? 5
    case 'H_RATE':        return win?.historyRate   ?? 4.5
    case 'BR_DCB':        return win?.briteDcb   ?? 80
    case 'BR_BKG':        return win?.briteBkg   ?? 0
    case 'BR_MAP_A':      return win?.briteMapA  ?? 50
    case 'BR_MAP_B':      return win?.briteMapB  ?? 50
    case 'BR_FDB':        return win?.briteFdb   ?? 80
    case 'BR_LST':        return win?.briteLst   ?? 80
    case 'BR_POS':        return win?.britePos   ?? 80
    case 'BR_LDB':        return win?.briteLdb   ?? 70
    case 'BR_RR':         return win?.briteRr    ?? 70
    case 'BR_CMP':        return win?.briteCmp   ?? 70
    case 'BR_HST':        return win?.briteHst   ?? 80
    case 'CS_DATABLOCKS': return win?.csDatablocks  ?? 3
    case 'CS_LISTS':      return win?.csLists       ?? 3
    case 'CS_DCB':        return win?.csDcb         ?? 3
    case 'CS_TOOLS':      return win?.csTools       ?? 3
    case 'CS_POS':        return win?.csPos         ?? 3
    case 'CS_MAP':        return win?.csMap         ?? 2
    default:              return null
  }
}

export function applyValueDelta(id, delta, win, updateWindow) {
  // RR uses discrete values [2,5,10,20] stored as nm, spinner uses index
  if (id === 'RR') {
    const cur  = getWindowValue('RR', win)
    const next = Math.max(0, Math.min(3, cur - delta))  // dir:-1 → scroll-up increases
    updateWindow(WINDOW_ID, { ringSpacingNm: RR_VALUES[next] })
    return
  }

  // LDR_DIR wraps around (circular), so handle before the generic clamping path
  if (id === 'LDR_DIR') {
    const cur = getWindowValue('LDR_DIR', win)
    const next = ldrDirWraparound(cur, delta)  // dir:-1 → scroll-up increments index (clockwise)
    updateWindow(WINDOW_ID, { ldrAngleDeg: LDR_DIR_CANVAS_ANGLES[next] })
    return
  }

  const cfg = VALUE_CONFIG[id]
  if (!cfg) return
  const cur  = getWindowValue(id, win)
  const next = clampValueDelta(cur, delta, cfg)
  switch (id) {
    case 'VOL':           updateWindow(WINDOW_ID, { vol: next });            break
    case 'RANGE':         updateWindow(WINDOW_ID, { rangeNm: next });       break
    case 'RR':            updateWindow(WINDOW_ID, { ringSpacingNm: next }); break
    case 'LDR_LEN':       updateWindow(WINDOW_ID, { ldrLength: next });     break
    case 'PTL_LNTH':      updateWindow(WINDOW_ID, { ptlLength: next });     break
    case 'HISTORY':       updateWindow(WINDOW_ID, { historyLength: next }); break
    case 'H_RATE':        updateWindow(WINDOW_ID, { historyRate: next });   break
    case 'BR_DCB':        updateWindow(WINDOW_ID, { briteDcb:  next }); break
    case 'BR_BKG':        updateWindow(WINDOW_ID, { briteBkg:  next }); break
    case 'BR_MAP_A':      updateWindow(WINDOW_ID, { briteMapA: next }); break
    case 'BR_MAP_B':      updateWindow(WINDOW_ID, { briteMapB: next }); break
    case 'BR_FDB':        updateWindow(WINDOW_ID, { briteFdb:  next }); break
    case 'BR_LST':        updateWindow(WINDOW_ID, { briteLst:  next }); break
    case 'BR_POS':        updateWindow(WINDOW_ID, { britePos:  next }); break
    case 'BR_LDB':        updateWindow(WINDOW_ID, { briteLdb:  next }); break
    case 'BR_RR':         updateWindow(WINDOW_ID, { briteRr:   next }); break
    case 'BR_CMP':        updateWindow(WINDOW_ID, { briteCmp:  next }); break
    case 'BR_HST':        updateWindow(WINDOW_ID, { briteHst:  next }); break
    case 'CS_DATABLOCKS': updateWindow(WINDOW_ID, { csDatablocks: next });  break
    case 'CS_LISTS':      updateWindow(WINDOW_ID, { csLists: next });       break
    case 'CS_DCB':        updateWindow(WINDOW_ID, { csDcb: next });         break
    case 'CS_TOOLS':      updateWindow(WINDOW_ID, { csTools: next });       break
    case 'CS_POS':        updateWindow(WINDOW_ID, { csPos: next });         break
    case 'CS_MAP':        updateWindow(WINDOW_ID, { csMap: next });         break
  }
}

// ─── Default colours ─────────────────────────────────────────────────────────

export const DEFAULT_DCB = {
  background:             '#0C2E0C',
  buttonBackground:       '#0C2E0C',
  buttonBorder:           '#1E661E',
  buttonText:             '#FFFFFF',
  buttonActiveBackground: '#165016',
  buttonActiveBorder:     '#2A7A2A',
  buttonActiveText:       '#FFFFFF',
  valueColor:             '#FFFFFF',
}

// MAP_1–5 → maps array index; MAP_6 → 'lbl'
export const MAP_SLOT_KEYS = {
  MAP_1: 0, MAP_2: 1, MAP_3: 2,
  MAP_4: 3, MAP_5: 4, MAP_6: 'lbl',
}

// A map-toggle button's store key — an explicit `mapKey` (used for buttons placed
// dynamically, e.g. the SUA↔MVA swap) takes precedence over the static slot table.
export function mapKeyOf(btn) {
  return btn.mapKey ?? MAP_SLOT_KEYS[btn.id]
}

// ─── DcbButton ────────────────────────────────────────────────────────────────
