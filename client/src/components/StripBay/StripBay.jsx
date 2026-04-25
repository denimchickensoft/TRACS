import { useState, useRef, useCallback } from 'react'
import { useStripsStore, STRIP_HIGHLIGHT, CONFLICT_RESOLUTION } from '../../store/strips.js'
import { useFlightPlansStore } from '../../store/flightPlans.js'
import { useSessionStore }     from '../../store/session.js'
import './StripBay.css'

const SORT_OPTIONS = [
  { value: 'time',   label: 'Time'   },
  { value: 'aid',    label: 'AID'    },
  { value: 'dep',    label: 'DEP'    },
  { value: 'dest',   label: 'DEST'   },
  { value: 'manual', label: 'Manual' },
]

// ── Sort comparators ──────────────────────────────────────────────────────────
function sortStrips(strips, plans, sortBy) {
  if (sortBy === 'manual') return strips  // preserve stripIds order
  return [...strips].sort((a, b) => {
    switch (sortBy) {
      case 'aid':  return a.aid.localeCompare(b.aid)
      case 'dep':  return (plans[a.aid]?.dep ?? '').localeCompare(plans[b.aid]?.dep ?? '')
      case 'dest': return (plans[a.aid]?.dest ?? '').localeCompare(plans[b.aid]?.dest ?? '')
      default:     return a.createdAt - b.createdAt  // 'time'
    }
  })
}

// ── Single annotation cell ────────────────────────────────────────────────────
function AnnCell({ stripId, cellIndex, value }) {
  const setAnnotation = useStripsStore((s) => s.setAnnotation)
  const [local, setLocal] = useState(value)

  function handleChange(e) {
    const v = e.target.value.toUpperCase().slice(0, 3)
    setLocal(v)
  }

  function handleBlur() {
    setAnnotation(stripId, cellIndex, local)
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') e.target.blur()
    if (e.key === 'Escape') { setLocal(''); e.target.blur() }
  }

  // Sync when external value changes (e.g. strip pass)
  if (local !== value && document.activeElement?.dataset?.cellId !== `${stripId}-${cellIndex}`) {
    setLocal(value)
  }

  return (
    <div className="sb-ann-cell">
      <input
        className="sb-ann-input"
        value={local}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        maxLength={3}
        data-cell-id={`${stripId}-${cellIndex}`}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}

// ── Single strip ──────────────────────────────────────────────────────────────
function Strip({ strip, plan, dragOver, onDragStart, onDragOver, onDragEnd, onDrop }) {
  const acknowledgeStrip = useStripsStore((s) => s.acknowledgeStrip)
  const deleteStrip      = useStripsStore((s) => s.deleteStrip)

  const highlightClass = strip.highlight ? `highlight-${strip.highlight}` : ''
  const dragOverClass  = dragOver ? ' sb-strip--drag-over' : ''

  const rte  = plan?.rte  ?? ''
  const rte1 = rte.slice(0, 20)
  const rte2 = rte.slice(20, 40)

  function handleClick() {
    if (strip.highlight) acknowledgeStrip(strip.id)
  }

  function handleContextMenu(e) {
    e.preventDefault()
    deleteStrip(strip.id)
  }

  const anns = strip.annotations

  return (
    <div
      className={`sb-strip ${highlightClass}${dragOverClass}`}
      draggable
      onDragStart={(e) => onDragStart(e, strip.id)}
      onDragOver={(e)  => onDragOver(e, strip.id)}
      onDragEnd={onDragEnd}
      onDrop={(e)      => onDrop(e, strip.id)}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Col 1: AID / TYP/EQ / CID */}
      <div className="sb-col">
        <div className="sb-cell sb-aid">{strip.aid}</div>
        <div className="sb-cell sb-dim">
          {plan?.typ ?? ''}{plan?.eq ? `/${plan.eq}` : ''}
        </div>
        <div className="sb-cell sb-dim">{plan?.cid ?? ''}</div>
      </div>

      {/* Col 2: BCN / — / ALT */}
      <div className="sb-col">
        <div className="sb-cell sb-bcn">{plan?.bcn ?? '----'}</div>
        <div className="sb-cell sb-dim"></div>
        <div className="sb-cell sb-dim">{plan?.alt ?? ''}</div>
      </div>

      {/* Col 3: DEP / DEST / — */}
      <div className="sb-col">
        <div className="sb-cell sb-dep">{plan?.dep ?? ''}</div>
        <div className="sb-cell sb-dest">{plan?.dest ?? ''}</div>
        <div className="sb-cell sb-dim"></div>
      </div>

      {/* Col 4: route rows */}
      <div className="sb-col">
        <div className="sb-cell sb-rte">{rte1}</div>
        <div className="sb-cell sb-rte">{rte2}</div>
        <div className="sb-cell sb-rte">{plan?.rmk ?? ''}</div>
      </div>

      {/* Annotation col 0 — cells 0, 3, 6 */}
      <div className="sb-col">
        <AnnCell stripId={strip.id} cellIndex={0} value={anns[0]} />
        <AnnCell stripId={strip.id} cellIndex={3} value={anns[3]} />
        <AnnCell stripId={strip.id} cellIndex={6} value={anns[6]} />
      </div>

      {/* Annotation col 1 — cells 1, 4, 7 */}
      <div className="sb-col">
        <AnnCell stripId={strip.id} cellIndex={1} value={anns[1]} />
        <AnnCell stripId={strip.id} cellIndex={4} value={anns[4]} />
        <AnnCell stripId={strip.id} cellIndex={7} value={anns[7]} />
      </div>

      {/* Annotation col 2 — cells 2, 5, 8 */}
      <div className="sb-col">
        <AnnCell stripId={strip.id} cellIndex={2} value={anns[2]} />
        <AnnCell stripId={strip.id} cellIndex={5} value={anns[5]} />
        <AnnCell stripId={strip.id} cellIndex={8} value={anns[8]} />
      </div>
    </div>
  )
}

// ── Airport tag list ──────────────────────────────────────────────────────────
function AirportList({ airports, onAdd, onRemove, implicit = null, disabled }) {
  const [input, setInput] = useState('')

  function handleAdd(e) {
    e.preventDefault()
    const val = input.trim().toUpperCase()
    if (!val) return
    onAdd(val)
    setInput('')
  }

  const hasAny = implicit || airports.length > 0

  return (
    <div className="sb-airport-list">
      <div className="sb-airport-tags">
        {!hasAny && <span className="sb-airport-empty">none</span>}
        {implicit && (
          <span className="sb-airport-tag sb-airport-tag--implicit" title="Your facility — automatically included">
            {implicit}
          </span>
        )}
        {airports.map((ap) => (
          <span key={ap} className="sb-airport-tag">
            {ap}
            {!disabled && (
              <button
                type="button"
                className="sb-airport-remove"
                onClick={() => onRemove(ap)}
              >×</button>
            )}
          </span>
        ))}
      </div>
      {!disabled && (
        <form className="sb-airport-form" onSubmit={handleAdd}>
          <input
            className="sb-airport-input"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            placeholder="ICAO"
            maxLength={4}
          />
          <button type="submit" className="sb-airport-add-btn" disabled={!input.trim()}>+</button>
        </form>
      )}
    </div>
  )
}

// ── Settings panel ────────────────────────────────────────────────────────────
function SettingsPanel() {
  const s          = useStripsStore()
  const facilityId = useSessionStore((st) => st.facilityId)

  return (
    <div className="sb-settings">

      <div className="sb-settings-section">
        <div className="sb-settings-heading">Auto-Add Triggers</div>

        <label className="sb-setting-row">
          <input
            type="checkbox"
            checked={s.autoAddOnTrack}
            onChange={(e) => s.setSetting('autoAddOnTrack', e.target.checked)}
          />
          On track initiation
        </label>

        <label className="sb-setting-row">
          <input
            type="checkbox"
            checked={s.autoAddOnHandoff}
            onChange={(e) => s.setSetting('autoAddOnHandoff', e.target.checked)}
          />
          On handoff acceptance
        </label>

        <label className="sb-setting-row">
          <input
            type="checkbox"
            checked={s.autoAddOnStripPass}
            onChange={(e) => s.setSetting('autoAddOnStripPass', e.target.checked)}
          />
          On strip pass acceptance
        </label>

        <label className="sb-setting-row">
          <input
            type="checkbox"
            checked={s.autoAddOnDepMatch}
            onChange={(e) => s.setSetting('autoAddOnDepMatch', e.target.checked)}
          />
          On DEP airport match
        </label>
        {s.autoAddOnDepMatch && (
          <AirportList
            airports={s.depAirports}
            onAdd={s.addDepAirport}
            onRemove={s.removeDepAirport}
            implicit={facilityId || null}
          />
        )}

        <label className="sb-setting-row">
          <input
            type="checkbox"
            checked={s.autoAddOnDestMatch}
            onChange={(e) => s.setSetting('autoAddOnDestMatch', e.target.checked)}
          />
          On DEST airport match
        </label>
        {s.autoAddOnDestMatch && (
          <AirportList
            airports={s.destAirports}
            onAdd={s.addDestAirport}
            onRemove={s.removeDestAirport}
            implicit={facilityId || null}
          />
        )}
      </div>

      <div className="sb-settings-section">
        <div className="sb-settings-heading">Annotation Conflict</div>
        {[
          { value: CONFLICT_RESOLUTION.OVERWRITE, label: 'Overwrite — incoming replaces existing' },
          { value: CONFLICT_RESOLUTION.MERGE,     label: 'Merge — incoming fills blank cells only' },
          { value: CONFLICT_RESOLUTION.IGNORE,    label: 'Ignore — existing always kept' },
        ].map(({ value, label }) => (
          <label key={value} className="sb-setting-row">
            <input
              type="radio"
              name="conflictResolution"
              value={value}
              checked={s.conflictResolution === value}
              onChange={() => s.setConflictResolution(value)}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="sb-settings-section">
        <div className="sb-settings-heading">Strip Lifecycle</div>
        <label className="sb-setting-row">
          <input
            type="checkbox"
            checked={s.deleteOnDropTrack}
            onChange={(e) => s.setSetting('deleteOnDropTrack', e.target.checked)}
          />
          Delete strip on drop track
        </label>
      </div>

    </div>
  )
}

// ── Strip Bay panel ───────────────────────────────────────────────────────────
export function StripBay({ onClose, standalone = false }) {
  const strips      = useStripsStore((s) => s.strips)
  const bays        = useStripsStore((s) => s.bays)
  const setSortBy   = useStripsStore((s) => s.setSortBy)
  const reorderBay  = useStripsStore((s) => s.reorderBay)
  const addStrip    = useStripsStore((s) => s.addStrip)
  const plans       = useFlightPlansStore((s) => s.plans)

  const bay = bays[0] ?? { id: 'default', name: 'Bay 1', sortBy: 'time', stripIds: [] }

  const [addAid,       setAddAid]       = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [dragId,       setDragId]       = useState(null)
  const [dragOverId,   setDragOverId]   = useState(null)
  const addInputRef = useRef(null)

  const bayStrips = bay.stripIds.map((id) => strips[id]).filter(Boolean)
  const sorted    = sortStrips(bayStrips, plans, bay.sortBy)

  const handleAddStrip = useCallback((e) => {
    e.preventDefault()
    const aid = addAid.trim().toUpperCase()
    if (!aid) return
    addStrip(aid)
    setAddAid('')
    addInputRef.current?.focus()
  }, [addAid, addStrip])

  function handleDragStart(e, stripId) {
    setDragId(stripId)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e, stripId) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (stripId !== dragOverId) setDragOverId(stripId)
  }

  function handleDrop(e, targetId) {
    e.preventDefault()
    if (!dragId || dragId === targetId) { setDragId(null); setDragOverId(null); return }
    // Switch to manual sort so reorder persists
    if (bay.sortBy !== 'manual') setSortBy(bay.id, 'manual')
    const order   = [...bay.stripIds]
    const fromIdx = order.indexOf(dragId)
    const toIdx   = order.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return
    order.splice(fromIdx, 1)
    order.splice(toIdx, 0, dragId)
    reorderBay(bay.id, order)
    setDragId(null)
    setDragOverId(null)
  }

  function handleDragEnd() {
    setDragId(null)
    setDragOverId(null)
  }

  return (
    <div className={`sb-panel${standalone ? ' sb-panel--standalone' : ''}`}>

      {/* Header */}
      <div className="sb-header">
        <span className="sb-title">Strip Bay</span>

        <select
          className="sb-sort-select"
          value={bay.sortBy}
          onChange={(e) => setSortBy(bay.id, e.target.value)}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <button
          className={`sb-btn-settings${showSettings ? ' active' : ''}`}
          onClick={() => setShowSettings((v) => !v)}
          title="Settings"
        >⚙</button>

        <button className="sb-btn-close" onClick={onClose}>×</button>
      </div>

      {/* Settings panel (collapsible) */}
      {showSettings && <SettingsPanel />}

      {/* Strip list */}
      <div className="sb-list">
        {sorted.length === 0 && (
          <div className="sb-empty">No strips</div>
        )}
        {sorted.map((strip) => (
          <Strip
            key={strip.id}
            strip={strip}
            plan={plans[strip.aid] ?? null}
            dragOver={dragOverId === strip.id}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
          />
        ))}
      </div>

      {/* Add strip footer */}
      <div className="sb-footer">
        <form style={{ display: 'flex', gap: 6, flex: 1 }} onSubmit={handleAddStrip}>
          <input
            ref={addInputRef}
            className="sb-add-input"
            value={addAid}
            onChange={(e) => setAddAid(e.target.value.toUpperCase())}
            placeholder="Callsign"
            maxLength={10}
          />
          <button type="submit" className="sb-btn-add" disabled={!addAid.trim()}>
            Add Strip
          </button>
        </form>
      </div>

    </div>
  )
}
