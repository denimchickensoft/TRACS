import { useState, useEffect, useMemo, useRef, memo, Fragment } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useStatusBoardStore }  from '../../store/statusBoard.js'
import { MissionImport } from './MissionImport.jsx'
import { useCorrelationStore }  from '../../store/correlation.js'
import { useUnitsStore }        from '../../store/units.js'
import { useSessionStore }      from '../../store/session.js'
import { getVisibleUnits }      from '../atc/visibleUnits.js'
import { resolveCallsign, parseUnitName } from '../../utils/callsign.js'
import { computeMagvar }        from '../../utils/magvar.js'
import { CARRIER_TYPES }        from '../../utils/carriers.js'
import { sunTimes }             from '../../utils/sunTimes.js'
import './StatusBoard.css'

// ── Time validation (2400-clock: 0000–2359, plus 2400) ───────────────────────
function isValidTime(v) {
  if (!v) return true
  if (!/^\d{4}$/.test(v)) return false
  const h = parseInt(v.slice(0, 2), 10)
  const m = parseInt(v.slice(2, 4), 10)
  return (h === 24 && m === 0) || (h <= 23 && m <= 59)
}

// ── Fuel/state validation: 1–2 digits, decimal point, 1 digit (e.g. 1.0, 12.3) ─
function isValidDecimal(v) {
  if (!v) return true
  return /^\d{1,2}\.\d$/.test(v)
}

// ── Aircraft table column definitions ────────────────────────────────────────
// id: unique column key | field: entry field to read/write | w: column width px
// readOnly: not editable | repeat: mirrors another field (no write)
// digitsOnly: strip non-digit input | padZero: pad to N digits with leading zeros on commit
// decimalFmt: allow digits + one decimal point | decimalValidate: validate X.X / XX.X format
const COLUMNS = [
  { id: 'evt',    label: 'EVT',      field: 'evt',        w: 28,  maxLen: 2 },
  { id: 'side1',  label: 'SIDE',     field: 'sideNumber', w: 36,  maxLen: 3, digitsOnly: true },
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
const EDITABLE_COLS    = COLUMNS.filter(c => !c.readOnly)
const EDIT_COL_IDX_MAP = Object.fromEntries(EDITABLE_COLS.map((c, i) => [c.id, i]))

// ── Inline-editable cell ──────────────────────────────────────────────────────
const EditableCell = memo(function EditableCell({
  value, onCommit, maxLen, readOnly, inputW,
  digitsOnly = false, padZero = 0, decimalFmt = false, timeValidate = false, decimalValidate = false,
  radialFmt = false,
  cellIdx, entryId, onInsertBelow,
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')

  const start = () => {
    if (readOnly) return
    setDraft(value)
    setEditing(true)
  }
  const commit = () => {
    let v = draft
    if (padZero && v.length > 0) v = v.padStart(padZero, '0')
    if (decimalFmt && v.length > 0) {
      if (!v.includes('.')) v = v + '.0'
      if (v.startsWith('.')) v = '0' + v
    }
    if (radialFmt && v === '000') v = '360'
    onCommit(v)
    setEditing(false)
  }
  const handleChange = (e) => {
    let v = e.target.value.toUpperCase()
    if (digitsOnly)  v = v.replace(/\D/g, '')
    if (decimalFmt)  v = v.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1')
    setDraft(v)
  }

  const navigateTab = (shiftKey) => {
    const idx = cellIdx
    setTimeout(() => {
      const cells = [...document.querySelectorAll('[data-sbcellidx]')]
        .sort((a, b) => +a.dataset.sbcellidx - +b.dataset.sbcellidx)
      const pos  = cells.findIndex(el => +el.dataset.sbcellidx === idx)
      if (pos === -1) return
      const next = cells[(pos + (shiftKey ? -1 : 1) + cells.length) % cells.length]
      next?.click()
    }, 0)
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="sb-cell-input"
        style={{ width: inputW }}
        value={draft}
        maxLength={maxLen}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Tab')                 { e.preventDefault(); commit(); navigateTab(e.shiftKey); return }
          if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); commit(); onInsertBelow?.(); return }
          if (e.key === 'Enter')               { commit(); return }
          if (e.key === 'Escape')              { setEditing(false) }
        }}
      />
    )
  }

  const invalid = (timeValidate && !isValidTime(value)) || (decimalValidate && !isValidDecimal(value))
  const cls = ['sb-cell', readOnly ? 'readonly' : '', !value ? 'empty' : '', invalid ? 'invalid' : ''].join(' ').trim()
  return (
    <span
      className={cls}
      data-sbcellidx={readOnly ? undefined : cellIdx}
      data-sbentryid={readOnly ? undefined : entryId}
      onClick={start}
    >
      {value || ' '}
    </span>
  )
})

// ── Stability alert hook ──────────────────────────────────────────────────────
// Fires when cumulative deviation from the last stable baseline exceeds `threshold`.
// Stays true until `stabilityMs` of no movement, at which point baseline advances.
function useStabilityAlert(value, { threshold = 5, stabilityMs = 20000, circular = false } = {}) {
  const baseRef    = useRef(value)  // last confirmed stable value; only updated by timer
  const prevRef    = useRef(value)  // previous poll value
  const currentRef = useRef(value)  // always latest; safe to read from timer callbacks
  const timerRef   = useRef(null)
  const alertedRef = useRef(false)
  const [alerted, setAlerted] = useState(false)

  useEffect(() => {
    currentRef.current = value

    const cumDelta = circular
      ? Math.abs(((value - baseRef.current + 540) % 360) - 180)
      : Math.abs(value - baseRef.current)

    const pollDelta = circular
      ? Math.abs(((value - prevRef.current + 540) % 360) - 180)
      : Math.abs(value - prevRef.current)
    prevRef.current = value

    // Trigger alert once cumulative drift from baseline exceeds threshold
    if (cumDelta > threshold && !alertedRef.current) {
      alertedRef.current = true
      setAlerted(true)
    }

    // Any movement resets the stability window; baseline advances only when timer fires
    if (pollDelta > 0) {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        baseRef.current = currentRef.current
        if (alertedRef.current) {
          alertedRef.current = false
          setAlerted(false)
        }
      }, stabilityMs)
    }
  }, [value])

  useEffect(() => () => clearTimeout(timerRef.current), [])

  return alerted
}

// ── Inline-editable header field ──────────────────────────────────────────────
function HeaderField({ label, value, onChange, inputW = 40, readOnly = false, maxLen, digitsOnly = false, padZero = 0, timeValidate = false, flash = false, hdrIdx }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')

  const start = () => {
    if (readOnly) return
    setDraft(value)
    setEditing(true)
  }
  const commit = () => {
    let v = draft
    if (padZero && v.length > 0) v = v.padStart(padZero, '0')
    onChange(v)
    setEditing(false)
  }

  const handleChange = (e) => {
    let v = e.target.value.toUpperCase()
    if (digitsOnly) v = v.replace(/\D/g, '')
    setDraft(v)
  }

  const navigateHdrTab = (shiftKey) => {
    const idx = hdrIdx
    setTimeout(() => {
      const fields = [...document.querySelectorAll('[data-sbhdridx]')]
        .sort((a, b) => +a.dataset.sbhdridx - +b.dataset.sbhdridx)
      const pos = fields.findIndex(el => +el.dataset.sbhdridx === idx)
      if (pos === -1) return
      fields[(pos + (shiftKey ? -1 : 1) + fields.length) % fields.length]?.click()
    }, 0)
  }

  return (
    <div className={['sb-field', flash ? 'sb-field--alert' : ''].filter(Boolean).join(' ')}>
      <span className="sb-label">{label}</span>
      {editing ? (
        <input
          autoFocus
          className="sb-input"
          style={{ '--input-w': `${inputW}px` }}
          value={draft}
          maxLength={maxLen}
          onChange={handleChange}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Tab')    { e.preventDefault(); commit(); navigateHdrTab(e.shiftKey); return }
            if (e.key === 'Enter')  { commit(); return }
            if (e.key === 'Escape') { setEditing(false) }
          }}
        />
      ) : (
        <span
          className={['sb-value', readOnly ? 'readonly' : '', !value ? 'empty' : '', (timeValidate && !isValidTime(value)) ? 'invalid' : '', flash ? 'alert' : ''].join(' ').trim()}
          data-sbhdridx={readOnly ? undefined : hdrIdx}
          onClick={start}
        >
          {value || '——'}
        </span>
      )}
    </div>
  )
}

// ── CASE L / CASE R field: renders "CASE [1-char] LAUNCH/RECOVERY" ────────────
function CaseField({ suffix, value, onChange, hdrIdx }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')

  const start = () => { setDraft(value); setEditing(true) }
  const commit = () => { onChange(draft); setEditing(false) }

  const navigateHdrTab = (shiftKey) => {
    const idx = hdrIdx
    setTimeout(() => {
      const fields = [...document.querySelectorAll('[data-sbhdridx]')]
        .sort((a, b) => +a.dataset.sbhdridx - +b.dataset.sbhdridx)
      const pos = fields.findIndex(el => +el.dataset.sbhdridx === idx)
      if (pos === -1) return
      fields[(pos + (shiftKey ? -1 : 1) + fields.length) % fields.length]?.click()
    }, 0)
  }

  return (
    <div className="sb-field">
      <span className="sb-label">CASE</span>
      {editing ? (
        <input
          autoFocus
          className="sb-case-input"
          value={draft}
          maxLength={1}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Tab')    { e.preventDefault(); commit(); navigateHdrTab(e.shiftKey); return }
            if (e.key === 'Enter')  { commit(); return }
            if (e.key === 'Escape') { setEditing(false) }
          }}
        />
      ) : (
        <span
          className={['sb-case-value', !value ? 'empty' : ''].join(' ').trim()}
          data-sbhdridx={hdrIdx}
          onClick={start}
        >
          {value || '_'}
        </span>
      )}
      <span className="sb-case-suffix">{suffix}</span>
    </div>
  )
}

const SB_SCALE_KEY  = 'tracs.sb.scale'
const SCALE_MIN     = 0.5
const SCALE_MAX     = 2.0
const SCALE_STEP    = 0.05

// ── Main component ────────────────────────────────────────────────────────────
export function StatusBoard({ docked = true, width, onResize, onUndock, onDock, onHide }) {
  const wheelDir = useWheelDirection()
  const {
    event, launch, recovery, tz, clg, vis, qnh,
    caseLaunch, caseRecovery, marBtn, app, twrBtn, depBtn, rad,
    entries, setHeader, addEntry, insertEntryAfter, updateEntry, removeEntry, moveEntry,
    clearMissionData,
  } = useStatusBoardStore()

  const [importOpen, setImportOpen] = useState(false)

  const hasMissionData = clg || vis || qnh || entries.some(e => e.fromMission)

  const [sortField,  setSortField]  = useState(null)
  const [sortDir,    setSortDir]    = useState('asc')
  const [scale,      setScale]      = useState(() => {
    const saved = parseFloat(localStorage.getItem(SB_SCALE_KEY))
    return isNaN(saved) ? 1.0 : Math.min(SCALE_MAX, Math.max(SCALE_MIN, saved))
  })
  const [scaleHint,  setScaleHint]  = useState(false)
  const scaleHintRef = useRef(null)

  const handleTitleWheel = (e) => {
    e.preventDefault()
    const dir = wheelDir(e)
    if (dir === null) return
    setScale((prev) => {
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN,
        parseFloat((prev - dir * SCALE_STEP).toFixed(2))
      ))
      localStorage.setItem(SB_SCALE_KEY, String(next))
      clearTimeout(scaleHintRef.current)
      setScaleHint(true)
      scaleHintRef.current = setTimeout(() => setScaleHint(false), 1200)
      return next
    })
  }

  const units       = useUnitsStore((s) => s.units)
  const coalition   = useSessionStore((s) => s.coalition)
  const mission     = useSessionStore((s) => s.mission)
  const carrierUnitId = useSessionStore((s) => s.carrierUnitId)

  const visibleUnits = useMemo(() => getVisibleUnits(units, coalition), [units, coalition])

  // ── Carrier-derived values ─────────────────────────────────────────
  const theatre    = mission?.mission?.theatre
  const carrier    = carrierUnitId != null ? units[carrierUnitId] : null
  const missionDate = mission?.mission?.dateAndTime?.date ?? null
  const magvar     = computeMagvar(carrier?.position?.lat ?? 0, carrier?.position?.lng ?? 0, missionDate)
  const hdgDeg     = (carrier?.heading ?? 0) * 180 / Math.PI
  const brcRaw     = Math.round(((hdgDeg - magvar) % 360 + 360) % 360)
  const brc        = brcRaw === 0 ? 360 : brcRaw
  const deckOffset = CARRIER_TYPES[carrier?.name]?.deckOffset ?? 9
  const fbRaw      = Math.round(((brc - deckOffset) % 360 + 360) % 360)
  const fb         = fbRaw === 0 ? 360 : fbRaw
  const spd        = Math.round((carrier?.speed ?? 0) * 1.94384)

  const carrierPos   = carrier?.position
  const tzOffset     = carrierPos ? Math.round(carrierPos.lng / 15) : null
  const autoTzStr    = tzOffset == null ? ''
                     : tzOffset === 0   ? 'Z'
                     : tzOffset > 0     ? `+${tzOffset}`
                     :                    String(tzOffset)

  const brcAlert = useStabilityAlert(brc, { threshold: 5, stabilityMs: 20000, circular: true })
  const fbAlert  = useStabilityAlert(fb,  { threshold: 5, stabilityMs: 20000, circular: true })
  const spdAlert = useStabilityAlert(spd, { threshold: 5, stabilityMs: 20000 })

  const { sunrise: sunriseZ, sunset: sunsetZ } = useMemo(() => {
    if (!missionDate || !carrierPos) return { sunrise: null, sunset: null }
    const { Day, Month, Year } = missionDate
    return sunTimes(carrierPos.lat, carrierPos.lng, Year, Month, Day)
  }, [missionDate, carrierPos])

  // ── Mission clock ──────────────────────────────────────────────────
  const syncRef = useRef(null)
  const [missionTime, setMissionTime] = useState('----Z')

  useEffect(() => {
    const t = mission?.mission?.dateAndTime?.time
    if (!t) return
    syncRef.current = {
      missionSeconds: (t.h ?? 0) * 3600 + (t.m ?? 0) * 60 + (t.s ?? 0),
      wallMs: Date.now(),
    }
  }, [mission])

  useEffect(() => {
    function tick() {
      if (!syncRef.current) { setMissionTime('----Z'); return }
      const elapsed = (Date.now() - syncRef.current.wallMs) / 1000
      const total = Math.floor(syncRef.current.missionSeconds + elapsed) % 86400
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      setMissionTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
  const missionDateStr = missionDate
    ? `${String(missionDate.Day).padStart(2, '0')} ${MONTHS[missionDate.Month - 1]} ${missionDate.Year}`
    : ''

  const magvarStr = magvar >= 0
    ? `+${magvar.toFixed(1)}`
    : `${magvar.toFixed(1)}`

  // ── Sorted view of entries (does not mutate store order) ──────────
  const sortedEntries = useMemo(() => {
    if (!sortField) return entries
    return [...entries].sort((a, b) => {
      const av = a[sortField] ?? ''
      const bv = b[sortField] ?? ''
      const an = parseFloat(av)
      const bn = parseFloat(bv)
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [entries, sortField, sortDir])

  // ── Correlation sync ───────────────────────────────────────────────
  // Rebuild correlationStore from entries whenever entries or visible units change.
  useEffect(() => {
    const newCorrelations = {}
    for (const entry of entries) {
      let uid = entry.unitId
      if (uid && !visibleUnits[uid]) uid = null  // stale — unit was deleted and recreated
      if (!uid && entry.callsign) {
        for (const [id, unit] of Object.entries(visibleUnits)) {
          if (resolveCallsign(unit) === entry.callsign) { uid = id; break }
        }
      }
      if (uid && entry.sideNumber) {
        newCorrelations[String(uid)] = entry.sideNumber
      }
    }
    useCorrelationStore.getState().setAll(newCorrelations)
  }, [entries, visibleUnits])

  // ── Pilot auto-populate ────────────────────────────────────────────
  // Use all units (not AGL-filtered visibleUnits) — parked/low aircraft
  // still appear on the status board and need pilot name resolution.
  useEffect(() => {
    for (const entry of entries) {
      if (entry.pilot) continue
      if (!entry.callsign) continue
      let uid = entry.unitId ?? null
      if (!uid) {
        for (const [id, unit] of Object.entries(units)) {
          const { acid } = parseUnitName(unit.unitName)
          if (acid === entry.callsign) { uid = id; break }
        }
      }
      if (!uid) continue
      const { pilotName } = parseUnitName(units[uid]?.unitName)
      if (pilotName) useStatusBoardStore.getState().updateEntry(entry.id, 'pilot', pilotName)
    }
  }, [entries, units])

  const style = { zoom: scale, ...(docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }) }

  return (
    <div className="sb" style={style}>
      {docked && <div className="sb-resize-handle" onMouseDown={onResize} />}
      <div className="sb-title" onWheel={handleTitleWheel}>
        <span className="sb-title-time">{missionTime}</span>
        <span className="sb-title-text">CATCC Status Board</span>
        {scaleHint && (
          <span className="sb-title-scale-hint">{Math.round(scale * 100)}%</span>
        )}
        <span className="sb-title-right">
          <span className="sb-title-date">{missionDateStr}</span>
          {docked  && onUndock && <button className="sb-dock-btn" onClick={onUndock} title="Undock">⬡</button>}
          {!docked && onDock   && <button className="sb-dock-btn" onClick={onDock}   title="Dock">⬡</button>}
          {docked  && onHide   && <button className="sb-dock-btn" onClick={onHide}   title="Hide">›</button>}
        </span>
      </div>

      {/* ── Section 1: Event header ───────────────────────────────── */}
      <div className="sb-section">
        <div className="sb-group">
          <HeaderField label="EVENT"    value={event}    onChange={(v) => setHeader('event',    v)} inputW={18}  maxLen={2}  hdrIdx={0} />
          <HeaderField label="LAUNCH"   value={launch}   onChange={(v) => setHeader('launch',   v)} inputW={32}  maxLen={4}  digitsOnly timeValidate hdrIdx={1} />
          <HeaderField label="RECOVERY" value={recovery} onChange={(v) => setHeader('recovery', v)} inputW={32}  maxLen={4}  digitsOnly timeValidate hdrIdx={2} />
        </div>
        <div className="sb-group">
          <HeaderField label="SUNRISE"  value={sunriseZ ?? '——'} onChange={() => {}} readOnly inputW={32} />
          <HeaderField label="SUNSET"   value={sunsetZ  ?? '——'} onChange={() => {}} readOnly inputW={32} />
          <HeaderField label="MAGVAR"   value={magvarStr} onChange={() => {}} readOnly inputW={36} />
          <HeaderField label="TZ"       value={tz || autoTzStr} onChange={(v) => setHeader('tz', v)} inputW={24} maxLen={3}  hdrIdx={3} />
        </div>
        <div className="sb-group">
          <HeaderField label="CLG"      value={clg}             onChange={(v) => setHeader('clg', v)} inputW={24} maxLen={3}  digitsOnly padZero={3} hdrIdx={4} />
          <HeaderField label="VIS"      value={vis}             onChange={(v) => setHeader('vis', v)} inputW={18} maxLen={2}  digitsOnly hdrIdx={5} />
          <HeaderField label="QNH"      value={qnh}             onChange={(v) => setHeader('qnh', v)} inputW={32} maxLen={4}  digitsOnly hdrIdx={6} />
        </div>
      </div>

      {/* ── Section 2: Recovery status ────────────────────────────── */}
      <div className="sb-section">
        <div className="sb-group">
          <CaseField suffix="LAUNCH"   value={caseLaunch}   onChange={(v) => setHeader('caseLaunch',   v)} hdrIdx={7} />
          <CaseField suffix="RECOVERY" value={caseRecovery} onChange={(v) => setHeader('caseRecovery', v)} hdrIdx={8} />
        </div>
        <div className="sb-group">
          <HeaderField label="MAR BTN" value={marBtn}       onChange={(v) => setHeader('marBtn',       v)} inputW={22} maxLen={2} digitsOnly hdrIdx={9} />
          <HeaderField label="APP BTN" value={app}          onChange={(v) => setHeader('app',          v)} inputW={22} maxLen={2} digitsOnly hdrIdx={10} />
          <HeaderField label="TWR BTN" value={twrBtn}       onChange={(v) => setHeader('twrBtn',       v)} inputW={22} maxLen={2} digitsOnly hdrIdx={11} />
          <HeaderField label="DEP BTN" value={depBtn}       onChange={(v) => setHeader('depBtn',       v)} inputW={22} maxLen={2} digitsOnly hdrIdx={12} />
        </div>
        <div className="sb-group">
          <HeaderField label="RAD"     value={rad || String((((fb + 180) % 360) || 360)).padStart(3, '0')}  onChange={(v) => setHeader('rad', v)} inputW={28} maxLen={3} digitsOnly padZero={3} hdrIdx={13} />
          <HeaderField label="BRC"     value={String(brc).padStart(3, '0')} onChange={() => {}} readOnly inputW={28} flash={brcAlert} />
          <HeaderField label="FB"      value={String(fb).padStart(3, '0')}  onChange={() => {}} readOnly inputW={28} flash={fbAlert} />
          <HeaderField label="SPD"     value={String(spd)}                  onChange={() => {}} readOnly inputW={24} flash={spdAlert} />
        </div>
      </div>

      {/* ── Section 3: Aircraft table ─────────────────────────────── */}
      <div className="sb-table-wrap">
        <div
          className="sb-table"
          style={{ gridTemplateColumns: [...COLUMNS.map(c => `${c.w}px`), '28px', '20px'].join(' ') }}
        >
          {/* Header */}
          {COLUMNS.map((col) => (
            <div key={col.id} className="sb-th">{col.label}</div>
          ))}
          <div className="sb-th" />
          <div className="sb-th" />

          {/* Rows */}
          {sortedEntries.map((entry, rowIdx) => (
            <Fragment key={entry.id}>
              {COLUMNS.map((col) => (
                <div key={col.id} className="sb-td">
                  <EditableCell
                    value={entry[col.field] ?? ''}
                    readOnly={col.readOnly}
                    maxLen={col.maxLen}
                    inputW={col.w - 6}
                    digitsOnly={col.digitsOnly}
                    padZero={col.padZero}
                    decimalFmt={col.decimalFmt}
                    timeValidate={col.timeValidate}
                    decimalValidate={col.decimalValidate}
                    radialFmt={col.radialFmt}
                    cellIdx={col.readOnly ? undefined : rowIdx * EDITABLE_COLS.length + EDIT_COL_IDX_MAP[col.id]}
                    entryId={col.readOnly ? undefined : entry.id}
                    onInsertBelow={col.readOnly ? undefined : () => {
                      const newId = useStatusBoardStore.getState().nextId
                      insertEntryAfter(entry.id)
                      setTimeout(() => {
                        const cells = [...document.querySelectorAll(`[data-sbentryid="${newId}"][data-sbcellidx]`)]
                          .sort((a, b) => +a.dataset.sbcellidx - +b.dataset.sbcellidx)
                        cells[0]?.click()
                      }, 0)
                    }}
                    onCommit={(v) => {
                      if (!col.readOnly) updateEntry(entry.id, col.field, v)
                    }}
                  />
                </div>
              ))}
              <div className="sb-td sb-td-move">
                <button className="sb-move-btn" onClick={() => moveEntry(entry.id, -1)} title="Move up">▲</button>
                <button className="sb-move-btn" onClick={() => moveEntry(entry.id,  1)} title="Move down">▼</button>
              </div>
              <div className="sb-td">
                <button
                  className="sb-del-btn"
                  onClick={() => removeEntry(entry.id)}
                  title="Remove"
                >×</button>
              </div>
            </Fragment>
          ))}
        </div>
      </div>

      {importOpen && (
        <MissionImport
          activeCarrierType={carrier?.name}
          onClose={() => setImportOpen(false)}
        />
      )}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className="sb-footer">
        <button className="sb-add-btn" onClick={() => addEntry()}>+ Add</button>
        <button className="sb-add-btn" onClick={() => setImportOpen(true)}>⬆ Load Mission</button>
        {hasMissionData && (
          <button className="sb-add-btn sb-clear-mission-btn" onClick={clearMissionData}>✕ Clear Mission</button>
        )}
        <select
          className="sb-sort-select"
          value={sortField ?? ''}
          onChange={(e) => setSortField(e.target.value || null)}
        >
          <option value="">Sort...</option>
          {COLUMNS.filter((c, i, arr) => !c.readOnly && arr.findIndex(x => x.field === c.field) === i)
            .map((c) => (
              <option key={c.id} value={c.field}>{c.label}</option>
            ))}
        </select>
        {sortField && (
          <button
            className="sb-sort-dir-btn"
            onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
            title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
          >
            {sortDir === 'asc' ? '▲' : '▼'}
          </button>
        )}
      </div>
    </div>
  )
}
