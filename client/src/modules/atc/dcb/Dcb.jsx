import { useState, useCallback, useMemo } from 'react'
import { useDisplayStore }  from '../../../store/display.js'
import { usePresetsStore }  from '../../../store/presets.js'
import { usePreviewStore }  from '../../../store/preview.js'
import { useMapsStore }     from '../../../store/maps.js'
import { useRunwaysStore }  from '../../../store/runways.js'
import './Dcb.css'

const WINDOW_ID = 'atc-main'

// ─── LDR direction spinner — clockwise from N ────────────────────────────────
// Index corresponds to bearing (N=0°, E=90°, etc.); canvas angles differ because
// canvas 0° is right (+x) and y increases downward.
const LDR_DIR_SEQUENCE     = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const LDR_DIR_CANVAS_ANGLES = [-90,  -45,   0,   45,  90,  135,  180, -135]
const RR_VALUES = [2, 5, 10, 20]

// ─── Menu / button definitions ────────────────────────────────────────────────
// Slot item is one of:
//   Button   { id, lines, type, ...opts }
//   HalfH    { id, slotType: 'halfH', buttons: [top, bottom] }  ← stacked (half-height each)
//   Spacer   { id, type: 'spacer' }

const MAIN_BUTTONS = [
  // 1 — full
  { id: 'RANGE',   lines: ['RANGE'], type: 'value' },

  // 2 — halfV: PLACE CNTR / OFF CNTR
  { id: 'slot_cntr', slotType: 'halfV', buttons: [
    { id: 'PLACE_CNTR', lines: ['PLACE', 'CNTR'], type: 'stub'   },
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

  // 6-8 — halfV pairs: map slots OWN/SUA, SCT/FIR, ADJ/LBL
  { id: 'slot_map_0', slotType: 'halfV', buttons: [
    { id: 'MAP_1', lines: ['OWN'], type: 'toggle' },
    { id: 'MAP_4', lines: ['SUA'], type: 'toggle' },
  ]},
  { id: 'slot_map_1', slotType: 'halfV', buttons: [
    { id: 'MAP_2', lines: ['SCT'], type: 'toggle' },
    { id: 'MAP_5', lines: ['FIR'], type: 'toggle' },
  ]},
  { id: 'slot_map_2', slotType: 'halfV', buttons: [
    { id: 'MAP_3', lines: ['ADJ'], type: 'toggle' },
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

const AUX_BUTTONS = padToShift([
  { id: 'VOL', lines: ['VOL'], type: 'value' },
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


const SUBMENU_DEFS = {
  maps: {
    parent: 'main',
    buttons: [
      { id: 'slot_map_3', slotType: 'halfV', buttons: [
        { id: 'MAP_7',  lines: ['7'],  type: 'toggle' },
        { id: 'MAP_10', lines: ['10'], type: 'toggle' },
      ]},
      { id: 'slot_map_4', slotType: 'halfV', buttons: [
        { id: 'MAP_8',  lines: ['8'],  type: 'toggle' },
        { id: 'MAP_11', lines: ['11'], type: 'toggle' },
      ]},
      { id: 'slot_map_5', slotType: 'halfV', buttons: [
        { id: 'MAP_9',  lines: ['9'],  type: 'toggle' },
        { id: 'MAP_12', lines: ['12'], type: 'toggle' },
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
const VALUE_CONFIG = {
  VOL:           { min: 1,   max: 10,  step: 1,   dir: -1, fmt: v => String(v)                  },
  RANGE:         { min: 6,   max: 256, step: 1,   dir:  1, fmt: v => String(v)                  },
  RR:            { min: 0,   max: 3,   step: 1,   dir: -1, fmt: v => String(RR_VALUES[v] ?? 10) },
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

function getWindowValue(id, win) {
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
    case 'BR_MAP_A':      return win?.briteMapA  ?? 80
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

function applyValueDelta(id, delta, win, updateWindow) {
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
    const next = ((cur - delta) % 8 + 8) % 8  // dir:-1 → scroll-up increments index (clockwise)
    updateWindow(WINDOW_ID, { ldrAngleDeg: LDR_DIR_CANVAS_ANGLES[next] })
    return
  }

  const cfg = VALUE_CONFIG[id]
  if (!cfg) return
  const cur  = getWindowValue(id, win)
  const next = Math.max(cfg.min, Math.min(cfg.max,
    parseFloat((cur + delta * cfg.step * (cfg.dir ?? -1)).toFixed(3))
  ))
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

const DEFAULT_DCB = {
  background:             '#0C2E0C',
  buttonBackground:       '#0C2E0C',
  buttonBorder:           '#1E661E',
  buttonText:             '#FFFFFF',
  buttonActiveBackground: '#165016',
  buttonActiveBorder:     '#2A7A2A',
  buttonActiveText:       '#FFFFFF',
  valueColor:             '#FFFFFF',
}

// MAP_1–5 → maps array index; MAP_6 → 'lbl'; MAP_7–12 → submenu indices 5–10
const MAP_SLOT_KEYS = {
  MAP_1: 0, MAP_2: 1, MAP_3:  2,
  MAP_4: 3, MAP_5: 4, MAP_6:  'lbl',
  MAP_7: 5, MAP_8: 6, MAP_9:  7,
  MAP_10: 8, MAP_11: 9, MAP_12: 10,
}

// ─── DcbButton ────────────────────────────────────────────────────────────────

function DcbButton({ btn, isActive, isToggled, valStr, colors, half, onClick }) {
  if (btn.type === 'spacer') {
    return <div className={`dcb-spacer${half ? ' dcb-spacer--half' : ''}`} />
  }

  const lit = isActive || isToggled

  const style = {
    background:  lit ? colors.buttonActiveBackground : colors.buttonBackground,
    borderColor: lit ? colors.buttonActiveBorder     : colors.buttonBorder,
    color:       lit ? colors.buttonActiveText        : colors.buttonText,
  }

  return (
    <button
      className={`dcb-btn${lit ? ' dcb-btn--lit' : ''}${half ? ' dcb-btn--half' : ''}`}
      style={style}
      onClick={onClick}
      tabIndex={-1}
    >
      <span className="dcb-btn-label">
        {btn.lines.map((line, i) => (
          <span key={i} className="dcb-btn-line">{line}</span>
        ))}
      </span>
      {valStr != null && (
        <span className="dcb-btn-value" style={{ color: lit ? colors.buttonActiveText : colors.valueColor }}>
          {valStr}
        </span>
      )}
    </button>
  )
}

// ─── Dcb ─────────────────────────────────────────────────────────────────────

export function Dcb({ profile, briteDcb, csDcb }) {
  const [menuKey, setMenuKey] = useState('main')
  const [toggles, setToggles] = useState(() => new Set())

  const { updateWindow } = useDisplayStore()
  const windowSettings   = useDisplayStore((s) => s.windows[WINDOW_ID])

  const presetSlots    = usePresetsStore((s) => s.slots)
  const activePreset   = usePresetsStore((s) => s.activeSlot)
  const defaultPreset  = usePresetsStore((s) => s.defaultSlot)
  const presetPending  = usePresetsStore((s) => s.pendingMode)

  // activeButton lives in the store so AtcScope can inhibit zoom while a spinner is selected
  const activeButton = windowSettings?.dcbActiveSpinner ?? null
  const mapsVisible   = useMapsStore((s) => s.visible)
  const maps          = useMapsStore((s) => s.maps)
  const centerlines   = useRunwaysStore((s) => s.centerlines)
  const cltrVisible   = useRunwaysStore((s) => s.cltrVisible)
  const obstructions  = useRunwaysStore((s) => s.obstructions)
  const obstVisible   = useRunwaysStore((s) => s.obstVisible)

  const colors = profile?.dcb ?? DEFAULT_DCB

  // ── Resolve current slot list ──────────────────────────────────────
  const slots = useMemo(() => {
    if (menuKey === 'main') return MAIN_BUTTONS
    if (menuKey === 'aux')  return AUX_BUTTONS
    if (menuKey === 'maps') {
      // Static geo slots (MAP_7–MAP_12, 3 halfV pairs = 6 button slots) +
      // optional OBST slot + dynamic CLTR_* entries, cap at 24 total
      const staticSlots = SUBMENU_DEFS.maps.buttons.filter((b) => b.id !== 'DONE')
      const obstSlots   = obstructions.length > 0 ? [{ id: 'OBST', lines: ['OBST'], type: 'toggle' }] : []
      const maxDynamic  = 24 - 6 - obstSlots.length
      const cltrSlice   = centerlines.slice(0, maxDynamic)

      const cltrPairs = []
      for (let i = 0; i < cltrSlice.length; i += 2) {
        const top = { id: `CLTR_${i}`,     lines: [cltrSlice[i].label],     type: 'toggle' }
        const bot = cltrSlice[i + 1]
          ? { id: `CLTR_${i + 1}`, lines: [cltrSlice[i + 1].label], type: 'toggle' }
          : null
        cltrPairs.push({
          id:       `slot_cltr_${i}`,
          slotType: 'halfV',
          buttons:  bot ? [top, bot] : [top],
        })
      }
      return [...staticSlots, ...obstSlots, ...cltrPairs, { id: 'DONE', lines: ['DONE'], type: 'done' }]
    }
    return SUBMENU_DEFS[menuKey]?.buttons ?? MAIN_BUTTONS
  }, [menuKey, centerlines, obstructions])

  // ── Button click ───────────────────────────────────────────────────
  const handleButtonClick = useCallback((btn) => {
    switch (btn.type) {
      case 'spacer': return

      case 'shift':
        setMenuKey(k => k === 'aux' ? 'main' : 'aux')
        updateWindow(WINDOW_ID, { dcbActiveSpinner: null })
        return

      case 'done': {
        const parent = SUBMENU_DEFS[menuKey]?.parent ?? 'main'
        setMenuKey(parent)
        updateWindow(WINDOW_ID, { dcbActiveSpinner: null })
        usePresetsStore.getState().setPendingMode(null)
        usePreviewStore.getState().clearResponse()
        return
      }

      case 'submenu':
        setMenuKey(btn.target)
        updateWindow(WINDOW_ID, { dcbActiveSpinner: null })
        return

      case 'toggle':
        if (btn.id in MAP_SLOT_KEYS) {
          useMapsStore.getState().toggleMap(MAP_SLOT_KEYS[btn.id])
        } else if (btn.id === 'OBST') {
          useRunwaysStore.getState().toggleObst()
        } else if (btn.id.startsWith('CLTR_')) {
          const idx = parseInt(btn.id.slice(5), 10)
          const cl  = centerlines[idx]
          if (cl) useRunwaysStore.getState().toggleCenterline(cl.id)
        } else {
          setToggles(prev => {
            const next = new Set(prev)
            if (next.has(btn.id)) next.delete(btn.id)
            else next.add(btn.id)
            return next
          })
        }
        return

      case 'preset-slot': {
        const idx     = parseInt(btn.id.replace('PRESET_', ''), 10)
        const pending = usePresetsStore.getState().pendingMode
        if (pending?.type === 'pick') {
          usePresetsStore.getState().setPendingMode({ type: 'name', slotIndex: idx })
          usePreviewStore.getState().clear()
          usePreviewStore.getState().setResponse('ENTER NAME:')
        } else if (pending?.type === 'delete') {
          usePresetsStore.getState().deleteSlot(idx)
          usePreviewStore.getState().clearResponse()
        } else {
          // Load the preset
          const slot = usePresetsStore.getState().slots[idx]
          if (slot) {
            updateWindow(WINDOW_ID, {
              ...slot.settings,
              offCntr:         false,
              rrCenterLat:     null,
              rrCenterLng:     null,
              rrOffCenter:     false,
              pendingAction:   null,
              dcbActiveSpinner: null,
            })
            if (slot.settings.mapsVisible)
              useMapsStore.getState().setVisible(slot.settings.mapsVisible)
            if (slot.settings.previewPosition !== undefined)
              usePreviewStore.getState().setPosition(slot.settings.previewPosition)
            usePresetsStore.getState().setActiveSlot(idx)
          }
        }
        return
      }

      case 'action':
        if (btn.id === 'OFF_CNTR' && windowSettings?.offCntr) {
          updateWindow(WINDOW_ID, {
            centerLat: windowSettings.homeCenterLat ?? 0,
            centerLng: windowSettings.homeCenterLng ?? 0,
            offCntr:   false,
          })
        } else if (btn.id === 'PLACE_RR') {
          const already = windowSettings?.pendingAction === 'PLACE_RR'
          updateWindow(WINDOW_ID, { pendingAction: already ? null : 'PLACE_RR' })
        } else if (btn.id === 'PTL_OWN') {
          const cur = useDisplayStore.getState().windows[WINDOW_ID]?.ptlMode
          updateWindow(WINDOW_ID, { ptlMode: cur === 'OWN' ? null : 'OWN' })
        } else if (btn.id === 'PTL_ALL') {
          const cur = useDisplayStore.getState().windows[WINDOW_ID]?.ptlMode
          updateWindow(WINDOW_ID, { ptlMode: cur === 'ALL' ? null : 'ALL' })
        } else if (btn.id === 'DCB_TOP') {
          updateWindow(WINDOW_ID, { dcbPosition: 'top' })
        } else if (btn.id === 'DCB_BOTTOM') {
          updateWindow(WINDOW_ID, { dcbPosition: 'bottom' })
        } else if (btn.id === 'DCB_LEFT') {
          updateWindow(WINDOW_ID, { dcbPosition: 'left' })
        } else if (btn.id === 'DCB_RIGHT') {
          updateWindow(WINDOW_ID, { dcbPosition: 'right' })
        } else if (btn.id === 'PREF_SAVE') {
          const win      = useDisplayStore.getState().windows[WINDOW_ID]
          const enriched = {
            ...win,
            mapsVisible:     useMapsStore.getState().visible,
            previewPosition: usePreviewStore.getState().position,
          }
          const saved = usePresetsStore.getState().saveActive(enriched)
          usePreviewStore.getState().setResponse(saved ? 'PREF SAVED' : 'NO PRESET LOADED')
        } else if (btn.id === 'PREF_SAVE_AS') {
          usePresetsStore.getState().setPendingMode({ type: 'pick' })
          usePreviewStore.getState().setResponse('SELECT SLOT')
        } else if (btn.id === 'PREF_DELETE') {
          usePresetsStore.getState().setPendingMode({ type: 'delete' })
          usePreviewStore.getState().setResponse('SELECT SLOT TO DELETE')
        } else if (btn.id === 'PREF_DEFAULT') {
          const { activeSlot } = usePresetsStore.getState()
          if (activeSlot === null) {
            usePreviewStore.getState().setResponse('NO PRESET LOADED')
          } else {
            usePresetsStore.getState().setDefaultSlot(activeSlot)
          }
        } else if (btn.id === 'RR_CNTR' && windowSettings?.rrOffCenter) {
          updateWindow(WINDOW_ID, {
            rrCenterLat:   null,
            rrCenterLng:   null,
            rrOffCenter:   false,
            pendingAction: null,
          })
        }
        return

      default: {
        const cur = windowSettings?.dcbActiveSpinner ?? null
        updateWindow(WINDOW_ID, { dcbActiveSpinner: cur === btn.id ? null : btn.id })
        return
      }
    }
  }, [menuKey, updateWindow, windowSettings])

  // ── Wheel — adjust active value button ────────────────────────────
  const handleWheel = useCallback((e) => {
    if (!activeButton) return
    e.preventDefault()
    e.stopPropagation()
    const delta = e.deltaY > 0 ? 1 : -1
    applyValueDelta(activeButton, delta, windowSettings, updateWindow)
  }, [activeButton, windowSettings, updateWindow])

  // ── Render a single button def ────────────────────────────────────
  function renderBtn(btn, half = false) {
    // Resolve preset-slot display before anything else
    let displayBtn = btn

    if (btn.id in MAP_SLOT_KEYS) {
      const key   = MAP_SLOT_KEYS[btn.id]
      const label = typeof key === 'number' ? (maps[key]?.name ?? '') : 'LBL'
      displayBtn = { ...btn, lines: [label] }
    }

    if (btn.type === 'preset-slot') {
      const idx  = parseInt(btn.id.replace('PRESET_', ''), 10)
      const slot = presetSlots[idx]
      displayBtn = { ...btn, lines: slot ? [slot.name] : [`P${idx + 1}`] }
    }

    const isActive  = activeButton === displayBtn.id
    let   isToggled = btn.id in MAP_SLOT_KEYS
      ? (mapsVisible[MAP_SLOT_KEYS[btn.id]] ?? false)
      : btn.id === 'OBST'
        ? obstVisible
        : btn.id.startsWith('CLTR_')
        ? (() => { const cl = centerlines[parseInt(btn.id.slice(5), 10)]; return cl ? (cltrVisible[cl.id] ?? false) : false })()
        : toggles.has(btn.id)

    if (btn.id === 'OFF_CNTR') {
      isToggled = windowSettings?.offCntr ?? false
    }
    if (btn.id === 'PLACE_RR') {
      isToggled = windowSettings?.pendingAction === 'PLACE_RR'
    }
    if (btn.id === 'RR_CNTR') {
      isToggled = windowSettings?.rrOffCenter ?? false
    }
    if (['DCB_TOP', 'DCB_BOTTOM', 'DCB_LEFT', 'DCB_RIGHT'].includes(btn.id)) {
      const posMap = { DCB_TOP: 'top', DCB_BOTTOM: 'bottom', DCB_LEFT: 'left', DCB_RIGHT: 'right' }
      isToggled = (windowSettings?.dcbPosition ?? 'top') === posMap[btn.id]
    }
    if (btn.id === 'PTL_OWN') {
      isToggled = windowSettings?.ptlMode === 'OWN'
    }
    if (btn.id === 'PTL_ALL') {
      isToggled = windowSettings?.ptlMode === 'ALL'
    }
    if (btn.type === 'preset-slot') {
      const idx = parseInt(btn.id.replace('PRESET_', ''), 10)
      isToggled = activePreset === idx
    }
    if (btn.id === 'PREF_SAVE_AS') {
      isToggled = presetPending?.type === 'pick' || presetPending?.type === 'name'
    }
    if (btn.id === 'PREF_DELETE') {
      isToggled = presetPending?.type === 'delete'
    }
    if (btn.id === 'PREF_DEFAULT') {
      isToggled = activePreset !== null && activePreset === defaultPreset
    }

    const rawVal = (displayBtn.type === 'value') ? getWindowValue(displayBtn.id, windowSettings) : null
    const valStr = rawVal != null ? VALUE_CONFIG[displayBtn.id]?.fmt(rawVal) : null

    return (
      <DcbButton
        key={btn.id}
        btn={displayBtn}
        isActive={isActive}
        isToggled={isToggled}
        valStr={valStr}
        colors={colors}
        half={half}
        onClick={() => handleButtonClick(btn)}
      />
    )
  }

  return (
    <div
      className="dcb-bar"
      data-pos={windowSettings?.dcbPosition ?? 'top'}
      style={{
        background: colors.background,
        borderBottomColor: colors.buttonBorder,
        opacity: briteDcb ?? 1,
        fontSize: `${10 + (csDcb ?? 3) * 2}px`,
      }}
      onWheel={handleWheel}
    >
      {slots.map((slot) => {
        if (slot.slotType === 'halfV') {
          return (
            <div key={slot.id} className="dcb-halfV">
              {slot.buttons.map(btn => renderBtn(btn, true))}
            </div>
          )
        }
        return renderBtn(slot)
      })}
    </div>
  )
}
