import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { useWheelDirection } from '../../utils/wheel.js'
import { useControllersStore } from '../../store/controllers'
import { useSessionStore }     from '../../store/session'
import { useUnitsStore }       from '../../store/units'
import { CARRIER_TYPES }       from '../../utils/carriers'
import './ControllerList.css'

const LS_POS     = 'tracs.cl.pos'
const LS_SIZE    = 'tracs.cl.size'
const LS_OPACITY = 'tracs.cl.opacity'

const DEFAULT_SIZE = { w: 330, h: 420 }
const MIN_W = 240
const MIN_H = 160
const OPACITY_STEP = 0.05
const OPACITY_MIN  = 0.2
const OPACITY_MAX  = 1.0

function loadLS(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

// ── Haversine distance in km ──────────────────────────────────────────────────
function haversine(a, b) {
  if (!a || !b) return null
  const R    = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180
  const lt1  = a.lat * Math.PI / 180
  const lt2  = b.lat * Math.PI / 180
  const x    = Math.sin(dLat / 2) ** 2 + Math.cos(lt1) * Math.cos(lt2) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

// ── Build { facilityId → { lat, lon } } for proximity sorting ────────────────
function buildFacilityCoords(rawAirbases, icaoMap, units) {
  const coords = {}
  const dcsToIcao = {}
  for (const [key, map] of Object.entries(icaoMap)) {
    if (key === '_note' || typeof map !== 'object') continue
    for (const [dcsName, icao] of Object.entries(map)) {
      if (typeof icao === 'string') dcsToIcao[dcsName] = icao
    }
  }
  for (const ab of rawAirbases) {
    if (!ab.latitude || !ab.longitude || !ab.callsign) continue
    const icao = dcsToIcao[ab.callsign]
    if (icao) coords[icao] = { lat: ab.latitude, lon: ab.longitude }
  }
  for (const unit of Object.values(units)) {
    if (!unit?.position?.lat || !unit?.position?.lng) continue
    const ct = CARRIER_TYPES[unit.name]
    if (ct) coords[ct.facilityId] = { lat: unit.position.lat, lon: unit.position.lng }
  }
  return coords
}

// ── Resolve human-readable name for a facility ────────────────────────────────
function resolveFacilityName(facilityId, icaoMap, units) {
  for (const [key, map] of Object.entries(icaoMap)) {
    if (key === '_note' || typeof map !== 'object') continue
    for (const [dcsName, icao] of Object.entries(map)) {
      if (icao === facilityId) return dcsName
    }
  }
  for (const [, ct] of Object.entries(CARRIER_TYPES)) {
    if (ct.facilityId !== facilityId) continue
    for (const unit of Object.values(units)) {
      if (CARRIER_TYPES[unit?.name]?.facilityId === facilityId) {
        return ct.displayName
      }
    }
    return ct.displayName
  }
  return null
}

// ── Build sorted groups from registry + peers ─────────────────────────────────
function buildGroups(registry, peers, airbases, myFacilityId, units, icaoMap) {
  const rawAirbases = Object.values(airbases?.airbases ?? airbases ?? {})
  const coords      = buildFacilityCoords(rawAirbases, icaoMap, units)
  const myCoords    = coords[myFacilityId] ?? null

  const peerConnectedAt = {}
  for (const p of peers) peerConnectedAt[p.position] = p.connectedAt ?? 0

  const allEntries = Object.values(registry)
    .sort((a, b) => (peerConnectedAt[a.positionName] ?? 0) - (peerConnectedAt[b.positionName] ?? 0))

  const seen    = new Set()
  const deduped = allEntries.filter((e) => {
    const key = `${e.facility}::${e.suffix}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const facilityMap = {}
  for (const e of deduped) {
    if (!facilityMap[e.facility]) facilityMap[e.facility] = []
    facilityMap[e.facility].push(e)
  }

  // AIC entries always go in the flat AIC section, even if own facility.
  const ownGroup        = facilityMap[myFacilityId] && !facilityMap[myFacilityId].every((e) => e.suffix === 'AIC')
    ? { facilityId: myFacilityId, entries: facilityMap[myFacilityId] }
    : null
  const proximityGroups = []
  const otherEntries    = []
  const aicEntries      = []

  for (const [facId, entries] of Object.entries(facilityMap)) {
    if (entries.every((e) => e.suffix === 'AIC')) {
      aicEntries.push(...entries)
    } else if (facId === myFacilityId) {
      continue
    } else if (entries.every((e) => e.suffix === 'CTR')) {
      otherEntries.push(...entries)
    } else {
      proximityGroups.push({ facilityId: facId, entries })
    }
  }

  proximityGroups.sort((a, b) => {
    const da = haversine(myCoords, coords[a.facilityId])
    const db = haversine(myCoords, coords[b.facilityId])
    if (da === null && db === null) return a.facilityId.localeCompare(b.facilityId)
    if (da === null) return 1
    if (db === null) return -1
    return da - db
  })

  return { ownGroup, proximityGroups, aicEntries, otherEntries }
}

// ── Directional resize handler factory ────────────────────────────────────────
function makeResizer(dir, posRef, sizeRef, setPos, setSize, windowRef, rightInsetRef) {
  return (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX, sy = e.clientY
    const sp = { ...posRef.current }, ss = { ...sizeRef.current }
    const has = (d) => dir.includes(d)

    const onMove = (ev) => {
      const parent   = windowRef.current?.parentElement
      const maxRight = parent ? parent.clientWidth - rightInsetRef.current : Infinity
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      let { x, y } = sp
      let { w, h } = ss

      if (has('e')) w = Math.max(MIN_W, Math.min(ss.w + dx, maxRight - sp.x))
      if (has('s')) h = Math.max(MIN_H, ss.h + dy)
      if (has('w')) { const nw = Math.max(MIN_W, ss.w - dx); x = sp.x + (ss.w - nw); w = nw }
      if (has('n')) {
        const desiredY = sp.y + ss.h - Math.max(MIN_H, ss.h - dy)
        y = Math.max(0, desiredY)
        h = Math.max(MIN_H, sp.y + ss.h - y)
      }

      posRef.current  = { x, y }
      sizeRef.current = { w, h }
      setPos({ x, y })
      setSize({ w, h })
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }
}

// ── Controller List window ────────────────────────────────────────────────────
export function ControllerList({ visible, onClose, onUndock, onOpenDm, rightInset = 0, standalone = false, facilityId: facilityIdProp, facilityName: facilityNameProp }) {
  const wheelDir            = useWheelDirection()
  const registry            = useControllersStore((s) => s.registry)
  const peers               = useSessionStore((s) => s.peers)
  const airbases            = useSessionStore((s) => s.airbases)
  const storeFacilityId     = useSessionStore((s) => s.facilityId)
  const storeFacilityName   = useSessionStore((s) => s.facilityName)
  const units               = useUnitsStore((s) => s.units)

  // Standalone popup mode: facility identity passed as props (URL params) so the
  // popup knows which facility is "own" without relying on the BroadcastChannel
  // (which is shared across all scope windows and would cause cross-contamination).
  const myFacilityId   = facilityIdProp   ?? storeFacilityId
  const myFacilityName = facilityNameProp ?? storeFacilityName

  const [icaoMap,     setIcaoMap]     = useState({})
  const [pos,         setPos]         = useState(() => loadLS(LS_POS, { x: 24, y: 56 }))
  const [size,        setSize]        = useState(() => loadLS(LS_SIZE, DEFAULT_SIZE))
  const [opacity,     setOpacity]     = useState(() => loadLS(LS_OPACITY, 1.0))
  const [opacityHint, setOpacityHint] = useState(false)
  const [collapsed,   setCollapsed]   = useState({})

  const posRef          = useRef(pos)
  const sizeRef         = useRef(size)
  const opacityHintRef  = useRef(null)
  const windowRef       = useRef(null)
  const rightInsetRef   = useRef(rightInset)
  useEffect(() => {
    rightInsetRef.current = rightInset
    if (standalone) return
    const parent = windowRef.current?.parentElement
    if (!parent) return
    const maxX = Math.max(0, parent.clientWidth - sizeRef.current.w - rightInset)
    if (posRef.current.x > maxX) {
      const next = { ...posRef.current, x: maxX }
      posRef.current = next
      setPos(next)
    }
  }, [rightInset, standalone])

  useEffect(() => {
    fetch('/icaoMapping.json').then((r) => r.json()).then(setIcaoMap).catch(() => {})
  }, [])

  useEffect(() => { posRef.current = pos;   localStorage.setItem(LS_POS,  JSON.stringify(pos))  }, [pos])
  useEffect(() => { sizeRef.current = size; localStorage.setItem(LS_SIZE, JSON.stringify(size)) }, [size])
  useEffect(() => { localStorage.setItem(LS_OPACITY, JSON.stringify(opacity)) }, [opacity])

  // Position window in top-right on first use (no saved position)
  useLayoutEffect(() => {
    if (standalone || localStorage.getItem(LS_POS) !== null || !windowRef.current) return
    const parent = windowRef.current.parentElement
    if (!parent) return
    const x = Math.max(0, parent.offsetWidth - sizeRef.current.w - 20)
    const next = { x, y: 40 }
    posRef.current = next
    setPos(next)
  }, [standalone]) // eslint-disable-line

  // ── Drag ─────────────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((e) => {
    if (standalone || e.button !== 0) return
    e.preventDefault()
    const ox = e.clientX - posRef.current.x
    const oy = e.clientY - posRef.current.y
    const onMove = (ev) => {
      const parent = windowRef.current?.parentElement
      const maxX   = parent ? Math.max(0, parent.clientWidth  - sizeRef.current.w - rightInsetRef.current) : Infinity
      const maxY   = parent ? Math.max(0, parent.clientHeight - sizeRef.current.h) : Infinity
      const next   = {
        x: Math.max(0, Math.min(maxX, ev.clientX - ox)),
        y: Math.max(0, Math.min(maxY, ev.clientY - oy)),
      }
      posRef.current = next
      setPos(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [standalone])

  // ── Opacity (scroll wheel on title bar) ───────────────────────────────────────
  const handleOpacityWheel = useCallback((e) => {
    e.preventDefault()
    const dir = wheelDir(e)
    if (dir === null) return
    setOpacity((prev) => {
      const next = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN,
        parseFloat((prev - dir * OPACITY_STEP).toFixed(2))
      ))
      clearTimeout(opacityHintRef.current)
      setOpacityHint(true)
      opacityHintRef.current = setTimeout(() => setOpacityHint(false), 1200)
      return next
    })
  }, [wheelDir])

  // ── Resize handlers (all edges and corners) ───────────────────────────────────
  const resizers = useMemo(() => {
    if (standalone) return {}
    const make = (dir) => makeResizer(dir, posRef, sizeRef, setPos, setSize, windowRef, rightInsetRef)
    return {
      n: make('n'), s: make('s'), e: make('e'), w: make('w'),
      ne: make('ne'), nw: make('nw'), se: make('se'), sw: make('sw'),
    }
  }, [standalone])

  const groups = useMemo(
    () => buildGroups(registry, peers, airbases, myFacilityId, units, icaoMap),
    [registry, peers, airbases, myFacilityId, units, icaoMap]
  )

  if (!visible) return null

  const { ownGroup, proximityGroups, aicEntries, otherEntries } = groups

  function toggleCollapse(id) {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }))
  }

  function displayId(entry) {
    return entry.letter ? `${entry.groupNumber}${entry.letter}` : ''
  }

  function renderFacilityEntry(entry, facName) {
    const carrierType  = Object.values(CARRIER_TYPES).find((ct) => ct.facilityId === entry.facility)
    const entryFacName = carrierType?.tacticalName ?? facName
    const label = [entryFacName, entry.displayName].filter(Boolean).join(' ')
    return (
      <div
        key={entry.positionName}
        className="cl-entry"
        onDoubleClick={() => onOpenDm?.(entry.positionName)}
        title="Double-click to open DM"
      >
        <span className="cl-entry-id">{displayId(entry)}</span>
        <span className="cl-entry-name">{label}</span>
        <span className="cl-entry-freq">{entry.frequency || ''}</span>
      </div>
    )
  }

  function renderOtherEntry(entry) {
    return (
      <div
        key={entry.positionName}
        className="cl-entry"
        onDoubleClick={() => onOpenDm?.(entry.positionName)}
        title="Double-click to open DM"
      >
        <span className="cl-entry-id">{displayId(entry)}</span>
        <span className="cl-entry-name">{entry.positionName}</span>
        <span className="cl-entry-freq">{entry.frequency || ''}</span>
      </div>
    )
  }

  function renderGroup(group, nameOverride) {
    const { facilityId, entries } = group
    const facName     = nameOverride ?? resolveFacilityName(facilityId, icaoMap, units)
    const isCollapsed = collapsed[facilityId] ?? false
    const header      = (facName && facName !== facilityId) ? `${facilityId} – ${facName}` : facilityId

    return (
      <div key={facilityId} className="cl-group">
        <div className="cl-group-header" onClick={() => toggleCollapse(facilityId)}>
          <span className="cl-chevron">{isCollapsed ? '▶' : '▼'}</span>
          <span className="cl-facility-label">{header}</span>
        </div>
        {!isCollapsed && (
          <div className="cl-group-entries">
            {entries.map((e) => renderFacilityEntry(e, facName))}
          </div>
        )}
      </div>
    )
  }

  const aicCollapsed   = collapsed['__AIC__']   ?? false
  const otherCollapsed = collapsed['__OTHER__'] ?? false
  const hasAny = ownGroup || proximityGroups.length > 0 || aicEntries.length > 0 || otherEntries.length > 0

  const overlayStyle = standalone ? undefined : {
    left:    pos.x,
    top:     pos.y,
    width:   size.w,
    height:  size.h,
    opacity,
  }

  return (
    <div
      ref={windowRef}
      className={`cl-window${standalone ? ' cl-window--standalone' : ''}`}
      style={overlayStyle}
    >
      {/* Resize handles — floating mode only */}
      {!standalone && (
        <>
          <div className="cl-resize cl-resize--n"  onMouseDown={resizers.n}  />
          <div className="cl-resize cl-resize--s"  onMouseDown={resizers.s}  />
          <div className="cl-resize cl-resize--e"  onMouseDown={resizers.e}  />
          <div className="cl-resize cl-resize--w"  onMouseDown={resizers.w}  />
          <div className="cl-resize cl-resize--ne" onMouseDown={resizers.ne} />
          <div className="cl-resize cl-resize--nw" onMouseDown={resizers.nw} />
          <div className="cl-resize cl-resize--se" onMouseDown={resizers.se} />
          <div className="cl-resize cl-resize--sw" onMouseDown={resizers.sw} />
        </>
      )}

      {/* Title bar */}
      <div
        className="cl-titlebar"
        onMouseDown={handleDragStart}
        onWheel={handleOpacityWheel}
      >
        <span className="cl-title">Controllers</span>
        {opacityHint && (
          <span className="cl-opacity-hint">{Math.round(opacity * 100)}%</span>
        )}
        {!standalone && onUndock && (
          <button
            className="cl-btn"
            title="Pop out to new window"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onUndock}
          >⬡</button>
        )}
        <button
          className="cl-btn"
          title="Close (Ctrl+L)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >×</button>
      </div>

      {/* Content */}
      <div className="cl-body">
        {!hasAny && (
          <div className="cl-empty">No controllers online</div>
        )}

        {ownGroup && renderGroup(ownGroup, myFacilityName || null)}
        {proximityGroups.map((g) => renderGroup(g))}

        {aicEntries.length > 0 && (
          <div className="cl-group">
            <div className="cl-group-header" onClick={() => toggleCollapse('__AIC__')}>
              <span className="cl-chevron">{aicCollapsed ? '▶' : '▼'}</span>
              <span className="cl-facility-label">AIC</span>
            </div>
            {!aicCollapsed && (
              <div className="cl-group-entries">
                {aicEntries.map((e) => renderOtherEntry(e))}
              </div>
            )}
          </div>
        )}

        {otherEntries.length > 0 && (
          <div className="cl-group">
            <div className="cl-group-header" onClick={() => toggleCollapse('__OTHER__')}>
              <span className="cl-chevron">{otherCollapsed ? '▶' : '▼'}</span>
              <span className="cl-facility-label">Other</span>
            </div>
            {!otherCollapsed && (
              <div className="cl-group-entries">
                {otherEntries.map((e) => renderOtherEntry(e))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
