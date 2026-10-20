import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useWheelDirection } from '../../utils/wheel.js'
import { useStatusBoardStore }  from '../../store/statusBoard.js'
import { MissionImport } from './MissionImport.jsx'
import { useCorrelationStore }  from '../../store/correlation.js'
import { useUnitsStore }        from '../../store/units.js'
import { useSessionStore }      from '../../store/session.js'
import { getVisibleUnits }      from '../../utils/visibleUnits.js'
import { parseUnitName } from '../../utils/callsign.js'
import { computeMagvar } from '../../utils/magvar.js'
import { CARRIER_TYPES, computeCarrierBrcFb } from '../../utils/carriers.js'
import { sunTimes }             from '../../utils/sunTimes.js'
import { useMissionClock }      from '../../utils/useMissionClock.js'
import { toUtcDateTime, getTheatreUtcOffset } from '../../utils/theatreTime.js'
import { LAYOUTS, isMarshalCase, findStackConflicts, appRadOf, radialFromFb, btnOf, caseBtn, isValidDecimal, isValidTime, effectiveRad, resolveEat, formatEat, eatSortKey } from './statusBoardColumns.js'
import { computeCatccCorrelations } from './correlationEngine.js'
import { EditableCell } from './EditableCell.jsx'
import { useStabilityAlert } from './useStabilityAlert.js'
import { HeaderField } from './HeaderField.jsx'
import { CaseField } from './CaseField.jsx'
import './StatusBoard.css'
import { MS_TO_KT, speedFromMs } from '../../utils/units.js'
import { useUnitSystem } from '../../store/unitSystem.js'

// STATE shows red once fuel is at or below BINGO (both must be valid X.X).
function isFuelAtBingo(entry) {
  const { state, bingo } = entry
  if (!state || !bingo || !isValidDecimal(state) || !isValidDecimal(bingo)) return false
  return parseFloat(state) <= parseFloat(bingo)
}

const SB_SCALE_KEY  = 'tracs.sb.scale'
const SCALE_MIN     = 0.5
const SCALE_MAX     = 2.0
const SCALE_STEP    = 0.05

// In popup mode the carrier arrives via URL param, since the session
// BroadcastChannel doesn't carry carrierUnitId (per-scope, see
// store/session.js). It's fixed when the popup opens: picking a different
// carrier in the main window afterwards only reaches a re-popped board.
const _URL_CARRIER_UNITID = new URLSearchParams(window.location.search).get('carrierUnitId')

// ── Main component ────────────────────────────────────────────────────────────
export function StatusBoard({ docked = true, width, onResize, onUndock, onDock, onHide, onScaleChange }) {
  const wheelDir = useWheelDirection()
  const {
    event, launch, recovery, clg, vis, qnh,
    caseLaunch, caseRecovery, cvApp, marBtn, app, twrBtn, depBtn, rad, radAuto,
    entries, setHeader, addEntry, insertEntryAfter, updateEntry, removeEntry, moveEntry,
    clearMissionData, clearAll, recycleBcn, assignNextMarshal, setStackValue, toggleFocus, setRad, setAppRad, clearApproach, removeEntries,
  } = useStatusBoardStore()

  const [importOpen,       setImportOpen]       = useState(false)
  const [confirmingClear,  setConfirmingClear]  = useState(false)
  // Right-click menu on a SIDE: { kind, entryId, x, y, confirming }. kind 'clear'
  // (green, approach side) clears the approach fields; 'delete' (departure side) removes rows.
  const [rowMenu,          setRowMenu]          = useState(null)

  const hasMissionData = clg || vis || qnh || entries.some(e => e.fromMission)

  const [sortField,  setSortField]  = useState(null)
  const [sortDir,    setSortDir]    = useState('asc')
  const [scale,      setScale]      = useState(() => {
    const saved = parseFloat(localStorage.getItem(SB_SCALE_KEY))
    return isNaN(saved) ? 1.0 : Math.min(SCALE_MAX, Math.max(SCALE_MIN, saved))
  })
  const [scaleHint,  setScaleHint]  = useState(false)
  const scaleHintRef = useRef(null)

  useEffect(() => { onScaleChange?.(scale) }, [scale]) // eslint-disable-line

  const handleTitleWheel = (e) => {
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

  const unitSystem  = useUnitSystem('catcc')
  const units       = useUnitsStore((s) => s.units)
  const coalition   = useSessionStore((s) => s.coalition)
  const mission     = useSessionStore((s) => s.mission)
  const sessionCarrierId = useSessionStore((s) => s.carrierUnitId)
  const carrierUnitId = _URL_CARRIER_UNITID ? Number(_URL_CARRIER_UNITID) : sessionCarrierId

  // No AGL floor: aircraft parked on deck or on short final below 100 ft
  // still need their side number for the DECK tab and PAR.
  const visibleUnits = useMemo(() => getVisibleUnits(units, coalition, true), [units, coalition])

  // ── Carrier-derived values ─────────────────────────────────────────
  const carrier      = carrierUnitId != null ? units[carrierUnitId] : null
  const theatre      = mission?.mission?.theatre
  const missionDate  = mission?.mission?.dateAndTime?.date ?? null
  const missionTod   = mission?.mission?.dateAndTime?.time ?? null
  const utcDate      = (missionDate && missionTod)
    ? toUtcDateTime(missionDate, missionTod, theatre).date
    : missionDate
  const magvar     = computeMagvar(carrier?.position?.lat ?? 0, carrier?.position?.lng ?? 0, utcDate)
  const hdgDeg     = (carrier?.heading ?? 0) * 180 / Math.PI
  const deckOffset = CARRIER_TYPES[carrier?.name]?.deckOffset ?? 9
  const { brc: brcF, fb: fbF } = computeCarrierBrcFb(hdgDeg, magvar, deckOffset)
  const brcRaw     = Math.round(brcF)
  const brc        = brcRaw === 0 ? 360 : brcRaw
  const fbRaw      = Math.round(fbF)
  const fb         = fbRaw === 0 ? 360 : fbRaw
  // Alert compares knots whatever the display unit, so its threshold holds.
  const spdKt      = Math.round((carrier?.speed ?? 0) * MS_TO_KT)
  const spd        = Math.round(speedFromMs(carrier?.speed ?? 0, unitSystem))

  const carrierPos   = carrier?.position
  const tzOffset      = theatre ? getTheatreUtcOffset(theatre) : null
  const autoTzStr     = tzOffset == null ? ''
                      : tzOffset === 0   ? 'Z'
                      : tzOffset > 0     ? `+${tzOffset}`
                      :                    String(tzOffset)

  const brcAlert = useStabilityAlert(brc, { threshold: 5, stabilityMs: 20000, circular: true })
  const fbAlert  = useStabilityAlert(fb,  { threshold: 5, stabilityMs: 20000, circular: true })
  const spdAlert = useStabilityAlert(spdKt, { threshold: 5, stabilityMs: 20000 })

  const { sunrise: sunriseZ, sunset: sunsetZ } = useMemo(() => {
    if (!utcDate || !carrierPos) return { sunrise: null, sunset: null }
    const { Day, Month, Year } = utcDate
    return sunTimes(carrierPos.lat, carrierPos.lng, Year, Month, Day)
  }, [utcDate, carrierPos])

  // ── Mission clock ──────────────────────────────────────────────────
  const { timeStr, dateStr, localTimeStr, localDateStr, utcSeconds } = useMissionClock()
  const [showLocalTime, setShowLocalTime] = useState(false)
  const missionTime     = showLocalTime ? localTimeStr : timeStr
  const missionDateStr  = showLocalTime ? localDateStr : dateStr

  const magvarStr = magvar >= 0
    ? `+${magvar.toFixed(1)}`
    : `${magvar.toFixed(1)}`

  // ── Sorted view of entries (does not mutate store order) ──────────
  const marshal = isMarshalCase(caseRecovery)
  const layout  = marshal ? LAYOUTS.marshal : LAYOUTS.base
  // A blank approach RAD follows the header RAD (itself automatic from FB)
  const boardRad = effectiveRad(rad, fb)
  const boardBtn = caseBtn(caseRecovery, twrBtn, app)
  const dups    = useMemo(() => (marshal ? findStackConflicts(entries, boardRad) : null), [marshal, entries, boardRad])

  const nowMin = utcSeconds == null ? null : Math.floor(utcSeconds / 60)
  const sortedEntries = useMemo(() => {
    if (!sortField) return entries
    const sortNum = (v) => (sortField === 'eat' && nowMin != null && /^\d{4}$/.test(v) && isValidTime(v))
      ? eatSortKey(v, nowMin * 60)
      : parseFloat(v)
    return [...entries].sort((a, b) => {
      const av = a[sortField] ?? ''
      const bv = b[sortField] ?? ''
      const an = sortNum(av)
      const bn = sortNum(bv)
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv)
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [entries, sortField, sortDir, nowMin])

  // ── Correlation sync — see correlationEngine.js's computeCatccCorrelations ──
  // Rebuild correlationStore from entries whenever entries or visible units change.
  useEffect(() => {
    const { correlations, pendingCodes } = computeCatccCorrelations({ entries, visibleUnits })
    useCorrelationStore.getState().setAll(correlations)
    useCorrelationStore.getState().setPendingCodes(pendingCodes)
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
          const { acid } = parseUnitName(unit.unitName, unit.callsign)
          if (acid === entry.callsign) { uid = id; break }
        }
      }
      if (!uid) continue
      const { pilotName } = parseUnitName(units[uid]?.unitName, units[uid]?.callsign)
      if (pilotName) useStatusBoardStore.getState().updateEntry(entry.id, 'pilot', pilotName)
    }
  }, [entries, units])

  useEffect(() => {
    if (!rowMenu) return
    const close = (e) => { if (!e.target.closest?.('.sb-ctx-menu')) setRowMenu(null) }
    const onKey = (e) => { if (e.key === 'Escape') setRowMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [rowMenu])

  // The menu renders outside the CSS-zoomed board, fixed at the click point
  const openRowMenu = (kind, entryId) => (e) => {
    e.preventDefault()
    setRowMenu({ kind, entryId, x: e.clientX, y: e.clientY, confirming: null })
  }
  // Keep the menu inside the window near the right/bottom edges
  const fitRowMenu = (el) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.right > window.innerWidth)   el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`
    if (r.bottom > window.innerHeight) el.style.top  = `${Math.max(0, window.innerHeight - r.height - 4)}px`
  }

  // "Above"/"below" follow the rows as displayed (any column sort included),
  // and leave the clicked row as it is.
  const runRowClear = (which) => {
    const idx = sortedEntries.findIndex((e) => e.id === rowMenu.entryId)
    const rows = which === 'below' ? sortedEntries.slice(idx + 1)
               : which === 'above' ? sortedEntries.slice(0, Math.max(idx, 0))
               : sortedEntries
    const ids = rows.map((e) => e.id)
    if (rowMenu.kind === 'delete') removeEntries(ids)
    else clearApproach(ids)
    setRowMenu(null)
  }

  const style = { zoom: scale, ...(docked && width ? { width, minWidth: width } : { flex: 1, minWidth: 0 }) }

  return (
    <div className="sb" style={style}>
      {docked && <div className="sb-resize-handle" onMouseDown={onResize} />}
      <div className="sb-title" onWheel={handleTitleWheel}>
        <span
          className="sb-title-time"
          onClick={() => setShowLocalTime((v) => !v)}
          title="Click to toggle Zulu / Local time"
        >
          {missionTime ?? (showLocalTime ? '----L' : '----Z')}
        </span>
        <span className="sb-title-text">CATCC Status Board</span>
        {scaleHint && (
          <span className="sb-title-scale-hint">{Math.round(scale * 100)}%</span>
        )}
        <span className="sb-title-right">
          <span className="sb-title-date">{missionDateStr ?? ''}</span>
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
          <HeaderField label="SUNRISE"  value={sunriseZ ? `${sunriseZ}Z` : '——'} onChange={() => {}} readOnly inputW={40} />
          <HeaderField label="SUNSET"   value={sunsetZ  ? `${sunsetZ}Z`  : '——'} onChange={() => {}} readOnly inputW={40} />
          <HeaderField label="MAGVAR"   value={magvarStr} onChange={() => {}} readOnly inputW={36} />
          <HeaderField label="TZ"       value={autoTzStr || '——'} onChange={() => {}} readOnly inputW={24} />
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
          <CaseField suffix="RECOVERY" value={caseRecovery} onChange={(v) => {
            setHeader('caseRecovery', v)
            // The marshal radial is fixed when a stack recovery starts, not followed as the carrier turns
            if (isMarshalCase(v) && !useStatusBoardStore.getState().rad) setRad(radialFromFb(fb), true)
          }} hdrIdx={8} />
          {isMarshalCase(caseRecovery) && (
            <CaseField label="CV" suffix="APP" value={cvApp} onChange={(v) => setHeader('cvApp', v)} hdrIdx={8.5} />
          )}
        </div>
        <div className="sb-group">
          <HeaderField label="MAR BTN" value={marBtn}       onChange={(v) => setHeader('marBtn',       v)} inputW={22} maxLen={2} digitsOnly hdrIdx={9} />
          <HeaderField label="APP BTN" value={app}          onChange={(v) => setHeader('app',          v)} inputW={22} maxLen={2} digitsOnly hdrIdx={10} />
          <HeaderField label="TWR BTN" value={twrBtn}       onChange={(v) => setHeader('twrBtn',       v)} inputW={22} maxLen={2} digitsOnly hdrIdx={11} />
          <HeaderField label="DEP BTN" value={depBtn}       onChange={(v) => setHeader('depBtn',       v)} inputW={22} maxLen={2} digitsOnly hdrIdx={12} />
        </div>
        <div className="sb-group">
          <HeaderField label="RAD"     value={effectiveRad(rad, fb)} auto={!rad || radAuto}
            // Clearing RAD works it out again from the current FB (CASE 2/3), or leaves it live
            onChange={(v) => (v ? setRad(v) : setRad(isMarshalCase(caseRecovery) ? radialFromFb(fb) : '', true))} inputW={28} maxLen={3} digitsOnly padZero={3} hdrIdx={13} />
          <HeaderField label="BRC"     value={String(brc).padStart(3, '0')} onChange={() => {}} readOnly inputW={28} flash={brcAlert} />
          <HeaderField label="FB"      value={String(fb).padStart(3, '0')}  onChange={() => {}} readOnly inputW={28} flash={fbAlert} />
          <HeaderField label="SPD"     value={String(spd)}                  onChange={() => {}} readOnly inputW={24} flash={spdAlert} />
        </div>
      </div>

      {/* ── Section 3: Aircraft table ─────────────────────────────── */}
      <div className="sb-table-wrap">
        <div
          className="sb-table"
          style={{ gridTemplateColumns: [...layout.cols.map(c => `${c.w}px`), '28px', '20px'].join(' ') }}
        >
          {/* Header */}
          {layout.cols.map((col) => (
            <div
              key={col.id}
              className="sb-th sb-th-sort"
              onClick={() => {
                if (sortField === col.field) setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
                else { setSortField(col.field); setSortDir('asc') }
              }}
              title={`Sort by ${col.label}`}
            >
              {col.label}{sortField === col.field ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
            </div>
          ))}
          <div className="sb-th" />
          <div className="sb-th" />

          {/* Rows */}
          {sortedEntries.map((entry, rowIdx) => (
            <Fragment key={entry.id}>
              {layout.cols.map((col) => (
                <div key={col.id} className={col.id === 'bcn' ? 'sb-td sb-td-bcn' : 'sb-td'}>
                  <EditableCell
                    value={col.id === 'appRad' ? appRadOf(entry, boardRad) : col.id === 'btn' ? btnOf(entry, boardBtn) : entry[col.field] ?? ''}
                    readOnly={col.readOnly}
                    maxLen={col.maxLen}
                    inputW={col.id === 'bcn' ? col.w - 24 : col.w - 6}
                    digitsOnly={col.digitsOnly}
                    radialModes={col.radialModes}
                    padZero={col.padZero}
                    decimalFmt={col.decimalFmt}
                    timeValidate={col.timeValidate}
                    decimalValidate={col.decimalValidate}
                    radialFmt={col.radialFmt}
                    stackFmt={col.stackFmt}
                    format={col.eatFmt ? formatEat : undefined}
                    // An emergency radial (E) turns the aircraft's whole row red
                    alert={entry.radMode === 'E' || (col.id === 'state' && isFuelAtBingo(entry)) || !!dups?.[col.field]?.has(entry.id)}
                    auto={col.stackFmt ? !entry.unlinked : col.id === 'appRad' ? (!entry.appRad || entry.radMode === 'H' || !!entry.auto?.appRad) : col.id === 'btn' ? !entry.btn : !!entry.auto?.[col.field]}
                    onContextMenu={col.id === 'side2' ? openRowMenu('clear', entry.id) : col.id === 'side1' ? openRowMenu('delete', entry.id) : undefined}
                    onDoubleClick={col.id === 'side2' ? () => { assignNextMarshal(entry.id, boardRad); toggleFocus(entry.id) } : undefined}
                    cellIdx={col.readOnly ? undefined : rowIdx * layout.editable.length + layout.idxMap[col.id]}
                    entryId={col.readOnly ? undefined : entry.id}
                    rowStride={col.readOnly ? undefined : layout.editable.length}
                    colIdx={col.readOnly ? undefined : layout.idxMap[col.id]}
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
                      if (col.readOnly) return
                      if (col.stackFmt) setStackValue(entry.id, col.field, v)
                      // E/H give the emergency/helicopter radial from FB as it is now
                      else if (col.id === 'appRad') setAppRad(entry.id, v === 'E' || v === 'H' ? radialFromFb(fb, v) : v, v === 'E' || v === 'H' ? v : '')
                      else updateEntry(entry.id, col.field, col.eatFmt ? resolveEat(v, utcSeconds) : v)
                    }}
                  />
                  {col.id === 'bcn' && (
                    <button
                      type="button"
                      className="sb-recycle-btn"
                      onClick={() => recycleBcn(entry.id)}
                      title="Recycle BCN"
                    >↻</button>
                  )}
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

      {rowMenu && createPortal(
        <div ref={fitRowMenu} className="sb-ctx-menu" style={{ left: rowMenu.x, top: rowMenu.y }}>
          {(rowMenu.kind === 'delete'
            ? [['below', 'Delete rows below'], ['above', 'Delete rows above'], ['all', 'Delete all rows']]
            : [['below', 'Clear below this row'], ['above', 'Clear above this row'], ['all', 'Clear all']]
          ).map(([which, label]) => (
            <button
              key={which}
              type="button"
              className={rowMenu.confirming === which ? 'sb-ctx-item confirming' : 'sb-ctx-item'}
              onClick={() => (rowMenu.confirming === which ? runRowClear(which) : setRowMenu({ ...rowMenu, confirming: which }))}
            >
              {rowMenu.confirming === which ? 'Confirm?' : label}
            </button>
          ))}
        </div>,
        document.body,
      )}

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div className="sb-footer">
        {confirmingClear ? (
          <>
            <span className="sb-confirm-label">Clear all fields?</span>
            <button
              className="sb-add-btn sb-confirm-btn"
              onClick={() => {
                clearAll()
                setConfirmingClear(false)
              }}
            >Confirm</button>
            <button
              className="sb-add-btn"
              onClick={() => setConfirmingClear(false)}
            >Cancel</button>
          </>
        ) : (
          <>
            <button className="sb-add-btn" onClick={() => addEntry()}>+ Add</button>
            <button className="sb-add-btn" onClick={() => setImportOpen(true)}>⬆ Load Mission</button>
            {hasMissionData && (
              <button className="sb-add-btn sb-clear-mission-btn" onClick={clearMissionData}>✕ Clear Mission</button>
            )}
            <button className="sb-add-btn sb-clear-all-btn" onClick={() => setConfirmingClear(true)}>✕ Clear ALL</button>
          </>
        )}
      </div>
    </div>
  )
}
