import { useState, useCallback, useMemo, useRef } from 'react'
import { useWheelDirection } from '../../../../utils/wheel.js'
import { useDisplayStore }  from '../../../../store/display.js'
import { usePresetsStore }  from '../../../../store/presets.js'
import { usePreviewStore }  from '../../../../store/preview.js'
import { useMapsStore }     from '../../../../store/maps.js'
import { useRunwaysStore }  from '../../../../store/runways.js'
import { useHoldingsStore } from '../../../../store/holdings.js'
import { useAirwaysStore }  from '../../../../store/airways.js'
import { useMsaStore }      from '../../../../store/msa.js'
import { useMoraStore }       from '../../../../store/mora.js'
import { useReliefStore }     from '../../../../store/relief.js'
import { useMvaStore }        from '../../../../store/mva.js'
import { useGeoStore }        from '../../../../store/geo.js'
import { useFixesStore }      from '../../../../store/fixes.js'
import { useProceduresStore } from '../../../../store/procedures.js'
import { saveStarsPrefs }     from '../../../../store/starsPrefs.js'
import { LDR_DIR_SEQUENCE, LDR_DIR_CANVAS_ANGLES, ldrDirWraparound, clampValueDelta } from '../../../../utils/dcbSpinner.js'
import { useNonPassiveWheel } from '../../../../utils/useNonPassiveWheel.js'
import '../../dcb.css'

const WINDOW_ID = 'atc-main'

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

const AUX_BUTTONS = padToShift([
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


const SUBMENU_DEFS = {
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

// MAP_1–5 → maps array index; MAP_6 → 'lbl'
const MAP_SLOT_KEYS = {
  MAP_1: 0, MAP_2: 1, MAP_3: 2,
  MAP_4: 3, MAP_5: 4, MAP_6: 'lbl',
}

// A map-toggle button's store key — an explicit `mapKey` (used for buttons placed
// dynamically, e.g. the SUA↔MVA swap) takes precedence over the static slot table.
function mapKeyOf(btn) {
  return btn.mapKey ?? MAP_SLOT_KEYS[btn.id]
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
  const wheelDir = useWheelDirection()
  const barRef   = useRef(null)
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
  const mvaSlot       = useMapsStore((s) => s.mvaSlot)

  const holdsVisible   = useHoldingsStore((s) => s.visible)
  const airwaysVisible = useAirwaysStore((s) => s.visible)
  const msaVisible     = useMsaStore((s) => s.visible)
  const moraVisible    = useMoraStore((s) => s.visible)
  const reliefVisible  = useReliefStore((s) => s.visible)
  const mvaVisible     = useMvaStore((s) => s.visible)
  const geoVisible     = useGeoStore((s) => s.visible)
  const fixesVisible   = useFixesStore((s) => s.visible)

  const procSidGroups   = useProceduresStore((s) => s.sidGroups)
  const procStarGroups  = useProceduresStore((s) => s.starGroups)
  const procAppchGroups = useProceduresStore((s) => s.appchGroups)
  const procVisible     = useProceduresStore((s) => s.visible)

  const centerlines     = useRunwaysStore((s) => s.centerlines)
  const cltrVisible     = useRunwaysStore((s) => s.cltrVisible)
  const satBuckets      = useRunwaysStore((s) => s.satBuckets)
  const obstructions    = useRunwaysStore((s) => s.obstructions)
  const obstVisible     = useRunwaysStore((s) => s.obstVisible)
  const facilityAirbase = useRunwaysStore((s) => s.facilityAirbase)

  const facilityCenterlines = useMemo(
    () => facilityAirbase ? centerlines.filter((c) => c.airbase === facilityAirbase) : [],
    [centerlines, facilityAirbase],
  )

  const colors = profile?.dcb ?? DEFAULT_DCB

  // ── Resolve current slot list ──────────────────────────────────────
  const slots = useMemo(() => {
    if (menuKey === 'main') {
      if (mvaSlot == null) return MAIN_BUTTONS
      // Pin MVA to its fixed slot index from the store (derived from ICAO_PRESETS).
      return MAIN_BUTTONS.map((slot) => {
        if (slot.slotType !== 'halfV') return slot
        return { ...slot, buttons: slot.buttons.map((b) =>
          MAP_SLOT_KEYS[b.id] === mvaSlot ? { id: 'MVA', lines: ['MVA'], type: 'toggle' } : b) }
      })
    }
    if (menuKey === 'aux')  return AUX_BUTTONS
    if (menuKey === 'maps') {
      const staticSlots = SUBMENU_DEFS.maps.buttons
        .filter((b) => b.id !== 'DONE')

      // Pool RELIEF + GEO with overflow map categories and pair them sequentially
      const halfPool = [
        { id: 'RELIEF', lines: ['RELIEF'], type: 'toggle' },
        { id: 'GEO',    lines: ['GEO'],    type: 'toggle' },
        { id: 'FIXES',  lines: ['FIXES'],  type: 'toggle' },
      ]
      for (let i = 5; i < maps.length; i++) {
        if (maps[i] != null) halfPool.push({ id: `MAP_OVF_${i}`, mapKey: i, lines: [], type: 'toggle' })
      }
      const overflowSlots = []
      for (let i = 0; i < halfPool.length; i += 2) {
        const top = halfPool[i]
        const bot = halfPool[i + 1] ?? null
        overflowSlots.push({ id: `slot_ovf_${i}`, slotType: 'halfV', buttons: bot ? [top, bot] : [top] })
      }

      const obstSlots   = obstructions.length > 0 ? [{ id: 'OBST', lines: ['OBST'], type: 'toggle' }] : []

      // Individual halfV buttons for facility centerlines only
      const cltrPairs = []
      for (let i = 0; i < facilityCenterlines.length; i += 2) {
        const cl0 = facilityCenterlines[i]
        const cl1 = facilityCenterlines[i + 1]
        const top = { id: `CLTR_${cl0.id}`, lines: [cl0.label], type: 'toggle' }
        const bot = cl1 ? { id: `CLTR_${cl1.id}`, lines: [cl1.label], type: 'toggle' } : null
        cltrPairs.push({ id: `slot_cltr_${i}`, slotType: 'halfV', buttons: bot ? [top, bot] : [top] })
      }

      // One halfV slot for satellite flow buckets (SAT NW / SAT SE)
      const satSlots = []
      if (satBuckets.length > 0) {
        const satBtns = satBuckets.map((b) => ({ id: `SAT_${b.label}`, lines: [`SAT ${b.label}`], type: 'toggle' }))
        satSlots.push({ id: 'slot_sat', slotType: 'halfV', buttons: satBtns })
      }

      // Procedure buttons — SIDs, STARs, then approaches, paired into halfV slots
      const procBtns = []
      for (const groupKey of Object.keys(procSidGroups).sort()) {
        const lastSpace = groupKey.lastIndexOf(' ')
        const lines = lastSpace >= 0 ? [groupKey.slice(0, lastSpace), groupKey.slice(lastSpace + 1)] : [groupKey]
        procBtns.push({ id: `PROC_SID_${groupKey}`, lines, type: 'toggle' })
      }
      for (const groupKey of Object.keys(procStarGroups).sort()) {
        const lastSpace = groupKey.lastIndexOf(' ')
        const lines = lastSpace >= 0 ? [groupKey.slice(0, lastSpace), groupKey.slice(lastSpace + 1)] : [groupKey]
        procBtns.push({ id: `PROC_STAR_${groupKey}`, lines, type: 'toggle' })
      }
      for (const groupKey of Object.keys(procAppchGroups).sort()) {
        const lastSpace = groupKey.lastIndexOf(' ')
        const lines = lastSpace >= 0 ? [groupKey.slice(0, lastSpace), groupKey.slice(lastSpace + 1)] : [groupKey]
        procBtns.push({ id: `PROC_APPCH_${groupKey}`, lines, type: 'toggle' })
      }
      const procSlots = []
      for (let i = 0; i < procBtns.length; i += 2) {
        const top = procBtns[i]
        const bot = procBtns[i + 1] ?? null
        procSlots.push({ id: `_proc_hv_${i}`, slotType: 'halfV', buttons: bot ? [top, bot] : [top] })
      }

      return [...staticSlots, ...overflowSlots, ...obstSlots, ...cltrPairs, ...satSlots, ...procSlots, { id: 'DONE', lines: ['DONE'], type: 'done' }]
    }
    return SUBMENU_DEFS[menuKey]?.buttons ?? MAIN_BUTTONS
  }, [menuKey, maps, facilityCenterlines, satBuckets, obstructions, procSidGroups, procStarGroups, procAppchGroups, mvaSlot])

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

      case 'toggle': {
        const mapKey = mapKeyOf(btn)
        if (mapKey != null) {
          useMapsStore.getState().toggleMap(mapKey)
        } else if (btn.id === 'HOLDS') {
          useHoldingsStore.getState().toggleVisible()
        } else if (btn.id === 'MSA') {
          useMsaStore.getState().toggleVisible()
        } else if (btn.id === 'MORA') {
          useMoraStore.getState().toggleVisible()
        } else if (btn.id === 'RELIEF') {
          useReliefStore.getState().toggleVisible()
        } else if (btn.id === 'GEO') {
          useGeoStore.getState().toggleVisible()
        } else if (btn.id === 'FIXES') {
          useFixesStore.getState().toggleVisible()
        } else if (btn.id === 'MVA') {
          useMvaStore.getState().toggleVisible()
        } else if (btn.id === 'AIR_V') {
          useAirwaysStore.getState().toggleVisible('V')
        } else if (btn.id === 'AIR_J') {
          useAirwaysStore.getState().toggleVisible('J')
        } else if (btn.id === 'AIR_B') {
          useAirwaysStore.getState().toggleVisible('B')
        } else if (btn.id === 'OBST') {
          useRunwaysStore.getState().toggleObst()
        } else if (btn.id.startsWith('CLTR_')) {
          useRunwaysStore.getState().toggleCenterline(btn.id.slice(5))
        } else if (btn.id.startsWith('SAT_')) {
          useRunwaysStore.getState().toggleSatBucket(btn.id.slice(4))
        } else if (btn.id.startsWith('PROC_SID_')) {
          useProceduresStore.getState().toggleVisible(`SID:${btn.id.slice(9)}`)
        } else if (btn.id.startsWith('PROC_STAR_')) {
          useProceduresStore.getState().toggleVisible(`STAR:${btn.id.slice(10)}`)
        } else if (btn.id.startsWith('PROC_APPCH_')) {
          useProceduresStore.getState().toggleVisible(`APPCH:${btn.id.slice(11)}`)
        } else if (btn.id === 'CA') {
          const next = !(windowSettings?.stcaEnabled ?? false)
          updateWindow(WINDOW_ID, { stcaEnabled: next })
          saveStarsPrefs({ stcaEnabled: next })
        } else if (btn.id === 'WNG') {
          const next = !(windowSettings?.simWingmenStandby ?? false)
          updateWindow(WINDOW_ID, { simWingmenStandby: next })
          saveStarsPrefs({ simWingmenStandby: next })
        } else {
          setToggles(prev => {
            const next = new Set(prev)
            if (next.has(btn.id)) next.delete(btn.id)
            else next.add(btn.id)
            return next
          })
        }
        return
      }

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
            const s = slot.settings
            if (s.mapsVisible)              useMapsStore.getState().setVisible(s.mapsVisible)
            if (s.reliefVisible  != null)   useReliefStore.getState().setVisible(s.reliefVisible)
            if (s.geoVisible     != null)   useGeoStore.getState().setVisible(s.geoVisible)
            if (s.fixesVisible   != null)   useFixesStore.getState().setVisible(s.fixesVisible)
            if (s.mvaVisible     != null)   useMvaStore.getState().setVisible(s.mvaVisible)
            if (s.msaVisible     != null)   useMsaStore.getState().setVisible(s.msaVisible)
            if (s.moraVisible    != null)   useMoraStore.getState().setVisible(s.moraVisible)
            if (s.holdsVisible   != null)   useHoldingsStore.getState().setVisible(s.holdsVisible)
            if (s.airwaysVisible != null)   useAirwaysStore.getState().setVisible(s.airwaysVisible)
            if (s.procVisible    != null)   useProceduresStore.getState().setVisible(s.procVisible)
            if (s.previewPosition !== undefined)
              usePreviewStore.getState().setPosition(s.previewPosition)
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
            reliefVisible:   useReliefStore.getState().visible,
            geoVisible:      useGeoStore.getState().visible,
            fixesVisible:    useFixesStore.getState().visible,
            mvaVisible:      useMvaStore.getState().visible,
            msaVisible:      useMsaStore.getState().visible,
            moraVisible:     useMoraStore.getState().visible,
            holdsVisible:    useHoldingsStore.getState().visible,
            airwaysVisible:  useAirwaysStore.getState().visible,
            procVisible:     [...useProceduresStore.getState().visible],
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

  // ── Wheel — adjust active value button, or scroll DCB if overflowing ────
  const handleWheel = useCallback((e) => {
    if (activeButton) {
      e.preventDefault()
      e.stopPropagation()
      const dir = wheelDir(e)
      if (dir === null) return
      applyValueDelta(activeButton, dir, windowSettings, updateWindow)
      return
    }
    const pos = windowSettings?.dcbPosition ?? 'top'
    if ((pos === 'top' || pos === 'bottom') && barRef.current) {
      const bar = barRef.current
      if (bar.scrollWidth > bar.clientWidth) {
        e.preventDefault()
        bar.scrollLeft += e.deltaY
      }
    }
  }, [activeButton, windowSettings, updateWindow, wheelDir])

  useNonPassiveWheel(barRef, handleWheel)

  // ── Render a single button def ────────────────────────────────────
  function renderBtn(btn, half = false) {
    // Resolve preset-slot display before anything else
    let displayBtn = btn

    const mapKey = mapKeyOf(btn)
    if (mapKey != null) {
      const label = typeof mapKey === 'number' ? (maps[mapKey]?.name ?? '') : 'LBL'
      const lines = label.startsWith('ADJ ') ? ['ADJ', label.slice(4)] : [label]
      displayBtn = { ...btn, lines }
    }

    if (btn.type === 'preset-slot') {
      const idx  = parseInt(btn.id.replace('PRESET_', ''), 10)
      const slot = presetSlots[idx]
      displayBtn = { ...btn, lines: slot ? [slot.name] : [`P${idx + 1}`] }
    }

    const isActive  = activeButton === displayBtn.id
    let   isToggled = mapKey != null
      ? (mapsVisible[mapKey] ?? false)
      : btn.id === 'HOLDS'
        ? holdsVisible
        : btn.id === 'MSA'
          ? msaVisible
          : btn.id === 'MORA'
            ? moraVisible
            : btn.id === 'RELIEF'
              ? reliefVisible
            : btn.id === 'GEO'
              ? geoVisible
            : btn.id === 'FIXES'
              ? fixesVisible
            : btn.id === 'MVA'
              ? mvaVisible
            : btn.id === 'AIR_V'
              ? airwaysVisible.V
              : btn.id === 'AIR_J'
                ? airwaysVisible.J
                : btn.id === 'AIR_B'
                  ? airwaysVisible.B
                  : btn.id === 'OBST'
        ? obstVisible
        : btn.id.startsWith('CLTR_')
          ? (cltrVisible[btn.id.slice(5)] ?? false)
          : btn.id.startsWith('SAT_')
            ? (() => {
                const label  = btn.id.slice(4)
                const bucket = satBuckets.find((b) => b.label === label)
                return bucket ? bucket.ids.some((id) => cltrVisible[id]) : false
              })()
            : btn.id.startsWith('PROC_SID_')
              ? procVisible.has(`SID:${btn.id.slice(9)}`)
              : btn.id.startsWith('PROC_STAR_')
                ? procVisible.has(`STAR:${btn.id.slice(10)}`)
                : btn.id.startsWith('PROC_APPCH_')
                  ? procVisible.has(`APPCH:${btn.id.slice(11)}`)
                  : btn.id === 'CA'
                    ? (windowSettings?.stcaEnabled ?? false)
                    : btn.id === 'WNG'
                      ? (windowSettings?.simWingmenStandby ?? false)
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
      ref={barRef}
      className="dcb-bar"
      data-pos={windowSettings?.dcbPosition ?? 'top'}
      style={{
        background: colors.background,
        borderBottomColor: colors.buttonBorder,
        opacity: briteDcb ?? 1,
        fontSize: `${10 + (csDcb ?? 3) * 2}px`,
      }}
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
