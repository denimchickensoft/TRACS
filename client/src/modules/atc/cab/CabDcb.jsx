import { useState, useCallback, useRef, useEffect } from 'react'
import { useWheelDirection } from '../../../utils/wheel.js'
import { useDisplayStore }   from '../../../store/display.js'
import '../dcb/Dcb.css'

export const CAB_WINDOW_ID = 'cab-main'

const LDR_DIR_SEQUENCE      = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const LDR_DIR_CANVAS_ANGLES = [-90,  -45,   0,   45,  90,  135,  180, -135]

const VALUE_CONFIG = {
  RANGE:    { min: 14,  max: 16,  step: 0.25, dir: -1, fmt: v => v != null ? String(v) : '--' },
  LDR_DIR:  { min: 0,   max: 7,   step: 1,   dir: -1, fmt: v => LDR_DIR_SEQUENCE[v] ?? 'NE' },
  LDR_LEN:  { min: 0,   max: 7,   step: 1,   dir: -1, fmt: v => String(v)                   },
  PTL_LNTH: { min: 0,   max: 5,   step: 0.5, dir: -1, fmt: v => v.toFixed(1)                },
  HISTORY:  { min: 0,   max: 10,  step: 1,   dir: -1, fmt: v => String(v)                   },
  H_RATE:   { min: 0,   max: 4.5, step: 0.5, dir: -1, fmt: v => v.toFixed(1)                },
}

const BUTTONS = [
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
]

const COLORS = {
  background:             '#3a3a3a',
  buttonBackground:       '#3a3a3a',
  buttonBorder:           '#666666',
  buttonText:             '#ffffff',
  buttonActiveBackground: '#606060',
  buttonActiveBorder:     '#aaaaaa',
  buttonActiveText:       '#ffffff',
  valueColor:             '#ffffff',
}

// ── Read current value from display window ───────────────────────────────────

function getValue(id, win) {
  switch (id) {
    case 'RANGE':   return win?.rangeNmDisplay ?? null
    case 'LDR_DIR': {
      const idx = LDR_DIR_CANVAS_ANGLES.indexOf(win?.ldrAngleDeg ?? -45)
      return idx >= 0 ? idx : 1
    }
    case 'LDR_LEN':  return win?.ldrLength    ?? 2
    case 'PTL_LNTH': return win?.ptlLength    ?? 0.5
    case 'HISTORY':  return win?.historyLength ?? 5
    case 'H_RATE':   return win?.historyRate   ?? 4.5
    default:         return null
  }
}

// ── Apply a scroll delta to a value ─────────────────────────────────────────

function applyDelta(id, delta, win, updateWindow) {
  if (id === 'RANGE') {
    const cur  = win?.rangeNm ?? 15
    const next = parseFloat(Math.max(14, Math.min(16, cur - delta * 0.25)).toFixed(3))
    updateWindow(CAB_WINDOW_ID, { rangeNm: next })
    return
  }
  if (id === 'LDR_DIR') {
    const cur  = getValue('LDR_DIR', win)
    const next = ((cur - delta) % 8 + 8) % 8
    updateWindow(CAB_WINDOW_ID, { ldrAngleDeg: LDR_DIR_CANVAS_ANGLES[next] })
    return
  }
  const cfg = VALUE_CONFIG[id]
  if (!cfg) return
  const cur  = getValue(id, win)
  const next = Math.max(cfg.min, Math.min(cfg.max,
    parseFloat((cur + delta * cfg.step * (cfg.dir ?? -1)).toFixed(3))
  ))
  switch (id) {
    case 'LDR_LEN':  updateWindow(CAB_WINDOW_ID, { ldrLength: next });     break
    case 'PTL_LNTH': updateWindow(CAB_WINDOW_ID, { ptlLength: next });     break
    case 'HISTORY':  updateWindow(CAB_WINDOW_ID, { historyLength: next }); break
    case 'H_RATE':   updateWindow(CAB_WINDOW_ID, { historyRate: next });   break
  }
}

// ── Single button ─────────────────────────────────────────────────────────────

function CabDcbButton({ btn, isActive, valStr, half, onClick }) {
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

// ── DCB bar ───────────────────────────────────────────────────────────────────

export function CabDcb() {
  const wheelDir          = useWheelDirection()
  const barRef            = useRef(null)
  const { updateWindow }  = useDisplayStore()
  const win               = useDisplayStore((s) => s.windows[CAB_WINDOW_ID])
  const activeSpinner     = win?.dcbActiveSpinner ?? null

  const handleClick = useCallback((btn) => {
    const cur = win?.dcbActiveSpinner ?? null
    updateWindow(CAB_WINDOW_ID, { dcbActiveSpinner: cur === btn.id ? null : btn.id })
  }, [win, updateWindow])

  const handleWheel = useCallback((e) => {
    if (!activeSpinner) return
    e.preventDefault()
    e.stopPropagation()
    const dir = wheelDir(e)
    if (dir === null) return
    applyDelta(activeSpinner, dir, win, updateWindow)
  }, [activeSpinner, win, updateWindow, wheelDir])

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  function renderBtn(btn, half = false) {
    const isActive = activeSpinner === btn.id
    const raw      = btn.type === 'value' ? getValue(btn.id, win) : null
    const valStr   = raw != null ? VALUE_CONFIG[btn.id]?.fmt(raw) : null
    return (
      <CabDcbButton
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
      className="dcb-bar"
      data-pos="top"
      style={{ background: COLORS.background, borderBottomColor: COLORS.buttonBorder }}
    >
      {BUTTONS.map((slot) => {
        if (slot.slotType === 'halfV') {
          return (
            <div key={slot.id} className="dcb-halfV">
              {slot.buttons.map((btn) => renderBtn(btn, true))}
            </div>
          )
        }
        return renderBtn(slot)
      })}
    </div>
  )
}
