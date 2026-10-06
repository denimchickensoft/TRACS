import { useCallback, useRef } from 'react'
import { useWheelDirection } from '../../../utils/wheel.js'
import { useDisplayStore }   from '../../../store/display.js'
import { saveAsdexPrefs }   from '../../../store/asdexPrefs.js'
import { useUnitSystem }    from '../../../store/unitSystem.js'
import { distFromNm, distUnit } from '../../../utils/units.js'
import { LDR_DIR_SEQUENCE, LDR_DIR_CANVAS_ANGLES, ldrDirWraparound, clampValueDelta } from '../../../utils/dcbSpinner.js'
import { useNonPassiveWheel } from '../../../utils/useNonPassiveWheel.js'
import { setAllDatablocks } from './asdexDatablockToggle.js'
import '../dcb.css'

export const ASDEX_WINDOW_ID = 'asdex-main'

const RANGE_MIN = 0.1
const RANGE_MAX = 2.0

const VALUE_CONFIG = {
  LDR_DIR:  { min: 0,   max: 7,   step: 1,   dir: -1, fmt: v => LDR_DIR_SEQUENCE[v] ?? 'NE' },
  LDR_LEN:  { min: 0,   max: 7,   step: 1,   dir: -1, fmt: v => String(v)                   },
  PTL_LNTH: { min: 0,   max: 5,   step: 0.5, dir: -1, fmt: v => v.toFixed(1)                },
  HISTORY:  { min: 0,   max: 10,  step: 1,   dir: -1, fmt: v => String(v)                   },
  H_RATE:   { min: 0,   max: 4.5, step: 0.5, dir: -1, fmt: v => v.toFixed(1)                },
}

const ON_OFF    = [['ON', true], ['OFF', false]]
const FULL_PART = [['FULL', true], ['PART', false]]

const MAIN_BUTTONS = [
  { id: 'RANGE',        lines: ['RANGE'],           type: 'value' },
  { id: 'slot_ldr',     slotType: 'halfV', buttons: [
    { id: 'LDR_DIR',    lines: ['LDR DIR'], type: 'value' },
    { id: 'LDR_LEN',    lines: ['LDR LEN'], type: 'value' },
  ]},
  { id: 'PTL_LNTH',     lines: ['PTL', 'LNTH'],     type: 'value' },
  { id: 'slot_history', slotType: 'halfV', buttons: [
    { id: 'HISTORY',    lines: ['HISTORY'],  type: 'value' },
    { id: 'H_RATE',     lines: ['H_RATE'],   type: 'value' },
  ]},
  { id: 'slot_db',      slotType: 'halfV', buttons: [
    { id: 'DB_ON',      lines: ['DB'],       type: 'select', key: 'dbOn', options: ON_OFF },
    { id: 'DB_EDIT',    lines: ['DB EDIT'],  type: 'submenu', target: 'dbEdit' },
  ]},
]

// CRC ASDE-X Data Block Edit submenu — only the fields TRACS implements
// (A/B/C are always on; E/G deliberately omitted).
const DB_EDIT_BUTTONS = [
  { id: 'DB_FULL',      lines: [],                 type: 'select', key: 'dbFull', options: FULL_PART },
  { id: 'slot_alt_type', slotType: 'halfV', buttons: [
    { id: 'DB_ALT',     lines: ['ALTITUDE'],    type: 'select', key: 'dbAltitude', options: ON_OFF },
    { id: 'DB_TYPE',    lines: ['TYPE'],        type: 'select', key: 'dbType',     options: ON_OFF },
  ]},
  { id: 'slot_fix_vel', slotType: 'halfV', buttons: [
    { id: 'DB_FIX',     lines: ['FIX'],         type: 'select', key: 'dbFix',      options: ON_OFF },
    { id: 'DB_VEL',     lines: ['VELOCITY'],    type: 'select', key: 'dbVelocity', options: ON_OFF },
  ]},
  { id: 'DB_SCRATCH',   lines: ['SCRATCH', 'PAD'],  type: 'select', key: 'dbScratch',  options: ON_OFF },
  { id: 'DONE',         lines: ['DONE'],             type: 'done' },
]

const MENUS = { main: MAIN_BUTTONS, dbEdit: DB_EDIT_BUTTONS }

function applySelect(key, value, updateWindow) {
  if (key === 'dbOn') { setAllDatablocks(value); return }
  updateWindow(ASDEX_WINDOW_ID, { [key]: value })
  saveAsdexPrefs({ [key]: value })
}

const COLORS = {
  background:             '#3a3a3a',
  buttonBackground:       '#3a3a3a',
  buttonBorder:           '#666666',
  buttonText:             '#ffffff',
  buttonActiveBackground: '#606060',
  buttonActiveBorder:     '#aaaaaa',
  buttonActiveText:       '#ffffff',
  valueColor:             '#ffffff',
  selectedColor:          '#FFB300',
}

function getValue(id, win) {
  switch (id) {
    case 'RANGE':   return win?.rangeNm ?? 1
    case 'LDR_DIR': {
      const idx = LDR_DIR_CANVAS_ANGLES.indexOf(win?.ldrAngleDeg ?? -45)
      return idx >= 0 ? idx : 1
    }
    case 'LDR_LEN':  return win?.ldrLength    ?? 2
    case 'PTL_LNTH': return win?.ptlLength    ?? 0.0
    case 'HISTORY':  return win?.historyLength ?? 5
    case 'H_RATE':   return win?.historyRate   ?? 4.5
    default:         return null
  }
}

function applyDelta(id, delta, win, updateWindow) {
  if (id === 'RANGE') {
    const cur  = win?.rangeNm ?? 1
    const next = Math.round(Math.max(RANGE_MIN, Math.min(RANGE_MAX, cur - delta * 0.1)) * 10) / 10
    updateWindow(ASDEX_WINDOW_ID, { rangeNm: next })
    return
  }
  if (id === 'LDR_DIR') {
    const cur  = getValue('LDR_DIR', win)
    const next = ldrDirWraparound(cur, delta)
    const ldrAngleDeg = LDR_DIR_CANVAS_ANGLES[next]
    updateWindow(ASDEX_WINDOW_ID, { ldrAngleDeg })
    saveAsdexPrefs({ ldrAngleDeg })
    return
  }
  const cfg = VALUE_CONFIG[id]
  if (!cfg) return
  const cur  = getValue(id, win)
  const next = clampValueDelta(cur, delta, cfg)
  switch (id) {
    case 'LDR_LEN':  updateWindow(ASDEX_WINDOW_ID, { ldrLength: next });     saveAsdexPrefs({ ldrLength: next });     break
    case 'PTL_LNTH': updateWindow(ASDEX_WINDOW_ID, { ptlLength: next });     saveAsdexPrefs({ ptlLength: next });     break
    case 'HISTORY':  updateWindow(ASDEX_WINDOW_ID, { historyLength: next }); saveAsdexPrefs({ historyLength: next }); break
    case 'H_RATE':   updateWindow(ASDEX_WINDOW_ID, { historyRate: next });   saveAsdexPrefs({ historyRate: next });   break
  }
}

function AsdexDcbButton({ btn, isActive, valStr, half, onClick }) {
  const lit = isActive
  const style = {
    background:  lit ? COLORS.buttonActiveBackground : COLORS.buttonBackground,
    borderColor: lit ? COLORS.buttonActiveBorder     : COLORS.buttonBorder,
    color:       lit ? COLORS.buttonActiveText        : COLORS.buttonText,
  }
  return (
    <button
      className={`dcb-btn${lit ? ' dcb-btn--lit' : ''}${half ? ' dcb-btn--half' : ''}`}
      style={style}
      onClick={onClick}
      tabIndex={-1}
    >
      <span className="dcb-btn-label">
        {btn.lines.map((line, i) => <span key={i} className="dcb-btn-line">{line}</span>)}
      </span>
      {valStr != null && (
        <span className="dcb-btn-value" style={{ color: COLORS.valueColor }}>
          {valStr}
        </span>
      )}
    </button>
  )
}

// Two-word selector (ON/OFF, FULL/PART): title line(s), then "ON/OFF" on the
// last line — each word independently clickable, the selected word amber.
function AsdexDcbSelect({ btn, value, half, onSelect }) {
  const style = {
    background:  COLORS.buttonBackground,
    borderColor: COLORS.buttonBorder,
    color:       COLORS.buttonText,
  }
  return (
    <div
      className={`dcb-btn dcb-btn--select${half ? ' dcb-btn--half' : ''}`}
      style={style}
    >
      <span className="dcb-btn-label">
        {btn.lines.map((line, i) => <span key={i} className="dcb-btn-line">{line}</span>)}
      </span>
      <span className="dcb-btn-value dcb-select-opts">
        {btn.options.map(([label, v], i) => (
          <span key={label}>
            {i > 0 && '/'}
            <span
              className="dcb-select-opt"
              style={{ color: value === v ? COLORS.selectedColor : COLORS.valueColor }}
              onClick={() => onSelect(v)}
            >
              {label}
            </span>
          </span>
        ))}
      </span>
    </div>
  )
}

export function AsdexDcb() {
  const wheelDir         = useWheelDirection()
  const barRef           = useRef(null)
  const updateWindow = useDisplayStore((s) => s.updateWindow)
  const win              = useDisplayStore(s => s.windows[ASDEX_WINDOW_ID])
  const unitSystem       = useUnitSystem('atc')
  const activeSpinner    = win?.dcbActiveSpinner ?? null
  const menu             = win?.dcbMenu ?? 'main'

  const handleClick = useCallback((btn) => {
    if (btn.type === 'submenu') {
      updateWindow(ASDEX_WINDOW_ID, { dcbMenu: btn.target, dcbActiveSpinner: null })
      return
    }
    if (btn.type === 'done') {
      updateWindow(ASDEX_WINDOW_ID, { dcbMenu: 'main', dcbActiveSpinner: null })
      return
    }
    const cur = win?.dcbActiveSpinner ?? null
    updateWindow(ASDEX_WINDOW_ID, { dcbActiveSpinner: cur === btn.id ? null : btn.id })
  }, [win, updateWindow])

  const handleWheel = useCallback((e) => {
    if (!activeSpinner) return
    e.preventDefault()
    e.stopPropagation()
    const dir = wheelDir(e)
    if (dir === null) return
    applyDelta(activeSpinner, dir, win, updateWindow)
  }, [activeSpinner, win, updateWindow, wheelDir])

  useNonPassiveWheel(barRef, handleWheel)

  function renderBtn(btn, half = false) {
    if (btn.type === 'select') {
      return (
        <AsdexDcbSelect
          key={btn.id}
          btn={btn}
          value={win?.[btn.key] ?? true}
          half={half}
          onSelect={(v) => applySelect(btn.key, v, updateWindow)}
        />
      )
    }
    const isActive = activeSpinner === btn.id
    const raw      = btn.type === 'value' ? getValue(btn.id, win) : null
    let   valStr   = null
    if (raw != null) {
      valStr = btn.id === 'RANGE'
        ? `${Number(distFromNm(raw, unitSystem).toFixed(1))}${distUnit(unitSystem)}`
        : VALUE_CONFIG[btn.id]?.fmt(raw) ?? null
    }
    return (
      <AsdexDcbButton
        key={btn.id}
        btn={btn}
        isActive={isActive}
        valStr={valStr}
        half={half}
        onClick={() => handleClick(btn)}
      />
    )
  }

  return (
    <div
      ref={barRef}
      className="dcb-bar dcb-bar--asdex"
      data-pos="top"
      style={{ background: COLORS.background, borderBottomColor: COLORS.buttonBorder }}
    >
      {(MENUS[menu] ?? MAIN_BUTTONS).map(slot => {
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
