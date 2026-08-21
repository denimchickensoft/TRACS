import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useSessionStore }     from '../../../store/session.js'
import { useUnitsStore }       from '../../../store/units.js'
import { useDisplayStore }     from '../../../store/display.js'
import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { useControllersStore } from '../../../store/controllers.js'
import { useAtcStore }         from '../../../store/atc.js'
import { useFpeStore }         from '../../../store/fpe.js'
import { useAsdexPreviewStore } from '../../../store/asdexPreview.js'
import { loadAsdexPrefs } from '../../../store/asdexPrefs.js'
import { latLngToCanvas, rangeToPixelsPerNm, canvasToLatLng } from '../../../utils/projection.js'
import { resolveCallsign }     from '../../../utils/callsign.js'
import { computeMagvar }       from '../../../utils/magvar.js'
import { AsdexDcb, ASDEX_WINDOW_ID } from './AsdexDcb.jsx'
import { AsdexInputHandler }   from './AsdexInputHandler.jsx'
import { AsdexPreviewArea }    from './AsdexPreviewArea.jsx'
import { parseAsdexCommand }   from './asdexCommandParser.js'
import { drawAsdexSurface }    from './canvas/drawAsdexSurface.js'
import { drawAsdexContacts }   from './canvas/drawAsdexContacts.js'
import { FPE }                 from '../../../components/FPE/FPE.jsx'
import './AsdexScope.css'

const RANGE_MIN    = 0.1
const RANGE_MAX    = 2.0
const AGL_CEIL_M   = 61  // ≈ 200 ft — hide airborne contacts; show surface/low-approach traffic

// In popup mode facilityDcsName arrives via URL param, not the session store.
// Reading it here (module load, sync) avoids mutating the session store from the
// popup context, which would broadcast null airbases/mission to the main window
// and trigger STARS map reloads.
const _URL_FACILITY = new URLSearchParams(window.location.search).get('facilityDcsName')
const SLEW_RADIUS  = 15
const DEFAULT_PROFILES = [
  {
    name: 'Day',
    colors: { background: '#00627b', taxiway: '#4b4b4b', runway: '#221f1e', contacts: '#ffffff', datablock: '#20a634' },
  },
  {
    name: 'Night',
    colors: { background: '#070a0a', taxiway: '#1a2020', runway: '#2a3030', contacts: '#00ff88', datablock: '#00cc66' },
  },
]

export default function AsdexScope() {
  const surfaceRef     = useRef(null)
  const contactsRef    = useRef(null)
  const interactiveRef = useRef(null)
  const canvasAreaRef  = useRef(null)
  const rafRef         = useRef(null)

  // ── Store hooks ──────────────────────────────────────────────────────────────
  const mission         = useSessionStore(s => s.mission)
  const airbases        = useSessionStore(s => s.airbases)
  const _sessionFacility = useSessionStore(s => s.facilityDcsName)
  const facilityDcsName  = _URL_FACILITY || _sessionFacility || ''
  const positionName    = useSessionStore(s => s.positionName)
  const units           = useUnitsStore(s => s.units)
  const plans           = useFlightPlansStore(s => s.plans)
  const [centerlines, setCenterlines] = useState([])
  const myControllerId  = useControllersStore(s => s.registry[positionName]?.controllerId ?? null)
  const displayStore    = useDisplayStore()
  const windowSettings  = useDisplayStore(s => s.windows[ASDEX_WINDOW_ID])

  // ── Refs that shadow live state for use in callbacks/rAF ─────────────────────
  const centerLatRef       = useRef(0)
  const centerLngRef       = useRef(0)
  const declinationRef     = useRef(0)
  const viewRef            = useRef(null)
  const unitsRef           = useRef(units)
  const plansRef           = useRef(plans)
  const historyRef         = useRef({})
  const histRateRef          = useRef(4.5)
  const myControllerIdRef    = useRef(myControllerId)
  const centerlinesRef       = useRef(centerlines)
  const centerlineVisibleRef = useRef(false)
  const colorsRef            = useRef(DEFAULT_PROFILES[0].colors)

  useEffect(() => { unitsRef.current          = units          }, [units])
  useEffect(() => { plansRef.current          = plans          }, [plans])
  useEffect(() => { myControllerIdRef.current = myControllerId }, [myControllerId])
  useEffect(() => { centerlinesRef.current    = centerlines    }, [centerlines])
  useEffect(() => { histRateRef.current       = windowSettings?.historyRate ?? 4.5 }, [windowSettings?.historyRate])

  // ── Component state ──────────────────────────────────────────────────────────
  const [view, setView]                       = useState(null)
  const [polygonData, setPolygonData]         = useState(null)    // raw GeoJSON features for theatre
  const [nameMap, setNameMap]                 = useState(null)    // { dcsName: stemName }
  const [profiles, setProfiles]               = useState(DEFAULT_PROFILES)
  const [centerlineVisible, setCenterlineVisible] = useState(false)
  const [coordsVisible, setCoordsVisible]     = useState(false)
  const coordsRef = useRef(null)

  // Pan drag state: during drag, update center refs directly for perf;
  // commit to display window only on mouseup.
  const dragRef = useRef(null)

  // ── Derived values ───────────────────────────────────────────────────────────
  const theatre  = mission?.mission?.theatre
  const colorIdx = windowSettings?.colorIdx ?? 0
  const colors   = profiles[colorIdx]?.colors ?? profiles[0]?.colors ?? DEFAULT_PROFILES[0].colors
  useEffect(() => { colorsRef.current = colors }, [colors])

  const facilityLatLng = useMemo(() => {
    if (!facilityDcsName) return null
    // Prefer midpoint of primary runway
    const cl = centerlines.find(c => c.airbase === facilityDcsName)
    if (cl?.rwyEnd1 && cl?.rwyEnd2) return {
      lat: (cl.rwyEnd1.lat + cl.rwyEnd2.lat) / 2,
      lng: (cl.rwyEnd1.lng + cl.rwyEnd2.lng) / 2,
    }
    // Fall back to DCS airbase reference point
    const raw   = airbases?.airbases ?? airbases ?? {}
    const match = Object.values(raw).find(ab => (ab.callsign || '') === facilityDcsName)
    if (match?.latitude != null) return { lat: match.latitude, lng: match.longitude }
    return null
  }, [facilityDcsName, airbases, centerlines])

  // declinationDeg (IGRF) is the only correction applied — see utils/magvar.js:
  // DCS's own heading readouts don't apply grid convergence, so this app
  // doesn't add it either.
  const missionDate    = mission?.mission?.dateAndTime?.date ?? null
  const declinationDeg = computeMagvar(
    windowSettings?.centerLat ?? facilityLatLng?.lat ?? 0,
    windowSettings?.centerLng ?? facilityLatLng?.lng ?? 0,
    missionDate
  )
  useEffect(() => { declinationRef.current = declinationDeg }, [declinationDeg])

  // Filter polygon features to facility airport via reverse name lookup
  const facilityFeatures = useMemo(() => {
    if (!polygonData || !facilityDcsName || !nameMap) return []
    const stem = nameMap[facilityDcsName]
    if (!stem) return []
    return polygonData.filter(f => f.properties.airport === stem)
  }, [polygonData, facilityDcsName, nameMap])

  // ── Window init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (windowSettings) return
    const lat = facilityLatLng?.lat ?? 0
    const lng = facilityLatLng?.lng ?? 0
    const prefs = loadAsdexPrefs()
    displayStore.initWindow(ASDEX_WINDOW_ID, {
      rangeNm: 1,
      ptlLength: prefs.ptlLength, ldrLength: prefs.ldrLength, ldrAngleDeg: prefs.ldrAngleDeg,
      historyLength: prefs.historyLength, historyRate: prefs.historyRate,
      centerLat: lat, centerLng: lng,
    })
    centerLatRef.current = lat
    centerLngRef.current = lng
  }, []) // eslint-disable-line

  // Re-center when facility changes or a better position becomes available (centerlines load).
  // Keyed on the primitive lat/lng (not the facilityLatLng object) — that memo returns a new
  // object reference every time `airbases` refreshes (Olympus polls it every 30s), which would
  // otherwise re-fire this effect and snap a manually-panned view back to the facility center.
  useEffect(() => {
    if (!facilityLatLng || !windowSettings) return
    displayStore.updateWindow(ASDEX_WINDOW_ID, {
      centerLat: facilityLatLng.lat,
      centerLng: facilityLatLng.lng,
    })
  }, [facilityLatLng?.lat, facilityLatLng?.lng]) // eslint-disable-line

  // Sync center refs from display window (after pan commits, or on init)
  useEffect(() => {
    if (!windowSettings) return
    centerLatRef.current = windowSettings.centerLat ?? 0
    centerLngRef.current = windowSettings.centerLng ?? 0
  }, [windowSettings?.centerLat, windowSettings?.centerLng]) // eslint-disable-line

  // ── Load runway centerlines (own fetch — does not touch the shared runway store) ──
  useEffect(() => {
    if (!theatre || !facilityDcsName) return
    fetch(`/runways/${encodeURIComponent(theatre)}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const cls = []
        for (const ab of data.airbases ?? []) {
          if (ab.airbase !== facilityDcsName) continue
          for (const rwy of ab.runways ?? []) {
            if (rwy.end1?.lat == null || rwy.end2?.lat == null) continue
            cls.push({
              airbase: ab.airbase,
              rwyEnd1: { lat: rwy.end1.lat, lng: rwy.end1.lon },
              rwyEnd2: { lat: rwy.end2.lat, lng: rwy.end2.lon },
            })
          }
        }
        setCenterlines(cls)
      })
      .catch(() => {})
  }, [theatre, facilityDcsName])

  // ── Fetch polygon data, name map, and colors ─────────────────────────────────
  useEffect(() => {
    if (!theatre) return
    fetch(`/api/airports/polygons/${theatre}`)
      .then(r => r.ok ? r.json() : null)
      .then(geojson => setPolygonData(geojson?.features ?? null))
      .catch(() => setPolygonData(null))
    fetch(`/api/airports/names/${theatre}`)
      .then(r => r.ok ? r.json() : null)
      .then(map => setNameMap(map))
      .catch(() => setNameMap(null))
  }, [theatre])

  useEffect(() => {
    fetch('/api/asdex/colors')
      .then(r => r.ok ? r.json() : null)
      .then(arr => { if (Array.isArray(arr) && arr.length) setProfiles(arr) })
      .catch(() => {})
  }, [])

  // ── View builder ─────────────────────────────────────────────────────────────
  const buildView = useCallback((w, h) => {
    const container = canvasAreaRef.current
    if (!container) return null
    const ws = useDisplayStore.getState().windows[ASDEX_WINDOW_ID]
    if (!ws) return null
    const rawW = w ?? container.clientWidth
    const rawH = h ?? container.clientHeight
    if (!rawW || !rawH) return null

    for (const ref of [surfaceRef, contactsRef]) {
      if (ref.current) {
        if (ref.current.width  !== rawW) ref.current.width  = rawW
        if (ref.current.height !== rawH) ref.current.height = rawH
      }
    }
    if (interactiveRef.current) {
      interactiveRef.current.style.width  = `${rawW}px`
      interactiveRef.current.style.height = `${rawH}px`
    }

    const rangeNm = ws.rangeNm ?? 1
    return {
      centerLat:   centerLatRef.current,
      centerLng:   centerLngRef.current,
      rangeNm,
      pixelsPerNm: rangeToPixelsPerNm(rangeNm, rawW, rawH),
      width: rawW, height: rawH,
      declinationDeg: declinationRef.current,
      theatre,
    }
  }, [theatre])

  // windowSettings is undefined (and the component returns null before the
  // canvas mounts) on the first render of a cold load — canvasAreaRef.current
  // is null then, so without this dep the observer would attach to nothing
  // and never re-attach once the canvas actually mounts.
  const hasWindowSettings = !!windowSettings
  useEffect(() => {
    const container = canvasAreaRef.current
    if (!container) return
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      setView(buildView(width, height))
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [hasWindowSettings]) // eslint-disable-line

  useEffect(() => { setView(buildView()) }, [windowSettings?.rangeNm, windowSettings?.centerLat, windowSettings?.centerLng, declinationDeg]) // eslint-disable-line
  useEffect(() => { viewRef.current = view }, [view])

  // ── History capture ──────────────────────────────────────────────────────────
  useEffect(() => {
    let lastCapture = 0
    const id = setInterval(() => {
      const rate = histRateRef.current
      if (rate <= 0) return
      const now = Date.now()
      if (now - lastCapture < rate * 1000) return
      lastCapture = now
      const cur = unitsRef.current
      historyRef.current = Object.fromEntries(
        Object.entries(cur).map(([uid, u]) => {
          const prev = historyRef.current[uid] || []
          const pos  = u.position
          if (!pos) return [uid, prev]
          return [uid, [{ lat: pos.lat, lng: pos.lng }, ...prev].slice(0, 10)]
        })
      )
    }, 500)
    return () => clearInterval(id)
  }, [])

  // ── Surface canvas effect ────────────────────────────────────────────────────
  useEffect(() => {
    if (!view || !surfaceRef.current) return
    const ctx = surfaceRef.current.getContext('2d')
    drawAsdexSurface(ctx, view, facilityFeatures, colors)
  }, [view, facilityFeatures, colors])

  // ── Contacts rAF loop ────────────────────────────────────────────────────────
  // Start unconditionally — contactsRef may be null on mount if windowSettings is
  // not yet created (component returns null). The draw callback guards on both refs.
  useEffect(() => {
    const draw = () => {
      const v = viewRef.current
      if (v && contactsRef.current) {
        const ctx = contactsRef.current.getContext('2d')
        const ws  = useDisplayStore.getState().windows[ASDEX_WINDOW_ID] ?? {}
        drawAsdexContacts(
          ctx, v, unitsRef.current, ws,
          plansRef.current, historyRef.current,
          centerlinesRef.current, centerlineVisibleRef.current,
          colorsRef.current,
        )
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [])

  // Keep centerline ref in sync for rAF loop
  useEffect(() => { centerlineVisibleRef.current = centerlineVisible }, [centerlineVisible])

  // ── Command handling ─────────────────────────────────────────────────────────
  const handleEnter = useCallback(() => {
    const buffer = useAsdexPreviewStore.getState().buffer
    const parsed = parseAsdexCommand(buffer, 'ENTER')
    if (!parsed) {
      useAsdexPreviewStore.getState().setResponse('INVALID INPUT')
      return
    }
    if (parsed.command.id === 'OPEN_FPE') {
      useFpeStore.getState().openFpe({ aid: parsed.captures.aid ?? null, scope: 'asdex' })
      useAsdexPreviewStore.getState().clearAfterCommand()
    }
    if (parsed.command.id === 'TOGGLE_CENTERLINE') {
      setCenterlineVisible(v => !v)
      useAsdexPreviewStore.getState().clearAfterCommand()
    }
    if (parsed.command.id === 'TOGGLE_COORDS') {
      setCoordsVisible(v => !v)
      useAsdexPreviewStore.getState().clearAfterCommand()
    }
    if (parsed.command.id === 'SET_COLORS') {
      const name = parsed.captures.name.trim()
      // profiles are from React state so read them from a ref
      const idx = profiles.findIndex(p => p.name.toUpperCase() === name.toUpperCase())
      if (idx >= 0) {
        displayStore.updateWindow(ASDEX_WINDOW_ID, { colorIdx: idx })
        useAsdexPreviewStore.getState().setResponse(`COLORS ${profiles[idx].name.toUpperCase()}`)
      } else {
        useAsdexPreviewStore.getState().setResponse('INVALID PROFILE')
      }
      useAsdexPreviewStore.getState().clearAfterCommand()
    }
  }, [profiles, displayStore])

  // ── Pan (right-click drag) ───────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 2) return
    dragRef.current = {
      startX:   e.clientX,
      startY:   e.clientY,
      startLat: centerLatRef.current,
      startLng: centerLngRef.current,
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (coordsVisible && coordsRef.current && viewRef.current) {
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (rect) {
        const ll = canvasToLatLng(e.clientX - rect.left, e.clientY - rect.top, viewRef.current)
        const latStr = `${Math.abs(ll.lat).toFixed(6)}°${ll.lat >= 0 ? 'N' : 'S'}`
        const lngStr = `${Math.abs(ll.lng).toFixed(6)}°${ll.lng >= 0 ? 'E' : 'W'}`
        coordsRef.current.textContent = `${latStr}  ${lngStr}`
      }
    }

    if (!dragRef.current || !viewRef.current) return
    const v   = viewRef.current
    const dx  = e.clientX - dragRef.current.startX
    const dy  = e.clientY - dragRef.current.startY
    const pxPerNm = v.pixelsPerNm
    const nmPerDegLng = 60 * Math.cos(dragRef.current.startLat * Math.PI / 180)
    centerLatRef.current = dragRef.current.startLat + dy / pxPerNm / 60
    centerLngRef.current = dragRef.current.startLng + dx / pxPerNm / nmPerDegLng * (-1)

    // Inline view rebuild during drag (avoids store writes on every frame)
    const container = canvasAreaRef.current
    if (!container) return
    const rawW = container.clientWidth
    const rawH = container.clientHeight
    const rangeNm = v.rangeNm
    const nextView = {
      centerLat:   centerLatRef.current,
      centerLng:   centerLngRef.current,
      rangeNm,
      pixelsPerNm: pxPerNm,
      width: rawW, height: rawH,
      declinationDeg: declinationRef.current,
      theatre: v.theatre,
    }
    viewRef.current = nextView
    setView(nextView)
  }, [coordsVisible])

  const handleMouseUp = useCallback((e) => {
    if (e.button !== 2 || !dragRef.current) return
    displayStore.updateWindow(ASDEX_WINDOW_ID, {
      centerLat: centerLatRef.current,
      centerLng: centerLngRef.current,
    })
    dragRef.current = null
  }, [displayStore])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup',   handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup',   handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  // ── Scroll zoom ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = interactiveRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const ws = useDisplayStore.getState().windows[ASDEX_WINDOW_ID]
      if (!ws) return
      const dir  = e.deltaY < 0 ? 1 : -1
      const cur  = ws.rangeNm ?? 1
      const next = Math.round(Math.max(RANGE_MIN, Math.min(RANGE_MAX, cur - dir * 0.1)) * 10) / 10
      displayStore.updateWindow(ASDEX_WINDOW_ID, { rangeNm: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [!!windowSettings, displayStore]) // eslint-disable-line

  // ── Click: FPE (Ctrl+click) and slew commands ────────────────────────────────
  const handleClick = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect || !viewRef.current) return
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top

    const findNearest = () => {
      let nearest = null, nearestDist = SLEW_RADIUS
      for (const [id, unit] of Object.entries(unitsRef.current)) {
        const pos = unit.position
        if (!pos) continue
        const { x, y } = latLngToCanvas(pos.lat, pos.lng, viewRef.current)
        const dist = Math.hypot(x - cx, y - cy)
        if (dist < nearestDist) { nearestDist = dist; nearest = { id, unit } }
      }
      return nearest
    }

    if (e.ctrlKey) {
      const nearest = findNearest()
      if (!nearest) return
      const aid      = resolveCallsign(nearest.unit).toUpperCase()
      const owner    = useAtcStore.getState().ownership[String(nearest.id)]
      const readOnly = !!(owner && owner !== myControllerIdRef.current)
      useFpeStore.getState().openFpe({ aid, unitId: Number(nearest.id), readOnly, scope: 'asdex' })
      return
    }

    const buffer = useAsdexPreviewStore.getState().buffer
    const parsed = parseAsdexCommand(buffer, 'SLEW')
    if (!parsed) return
    const nearest = findNearest()
    if (!nearest) return
    if (parsed.command.id === 'SET_LEADER_SHORT') {
      const dir     = parsed.captures.dir
      const current = useDisplayStore.getState().windows[ASDEX_WINDOW_ID]?.leaderDirs ?? {}
      const next    = { ...current }
      if (dir === '5') delete next[String(nearest.id)]
      else next[String(nearest.id)] = dir
      useDisplayStore.getState().updateWindow(ASDEX_WINDOW_ID, { leaderDirs: next })
      useAsdexPreviewStore.getState().clearAfterCommand()
    }
  }, [])

  // ── Filter units to surface traffic (≤200 ft AGL) ───────────────────────────
  const airUnits = useMemo(() =>
    Object.fromEntries(
      Object.entries(units).filter(([, u]) =>
        (u.category === 'Aircraft' || u.category === 'Helicopter') &&
        u.position?.lat != null &&
        (u.agl === undefined || u.agl <= AGL_CEIL_M)
      )
    ),
  [units])

  useEffect(() => { unitsRef.current = airUnits }, [airUnits])

  if (!windowSettings) return null

  return (
    <div className="asdex-scope" style={{ background: colors.background }}>
      <AsdexInputHandler onEnter={handleEnter} />
      <AsdexDcb />

      <div ref={canvasAreaRef} className="asdex-canvas-area">
        <FPE scope="asdex" />
        <AsdexPreviewArea />
        <canvas ref={surfaceRef}  className="asdex-layer" />
        <canvas ref={contactsRef} className="asdex-layer" />
        <div
          ref={interactiveRef}
          className="asdex-layer asdex-interactive"
          onMouseDown={handleMouseDown}
          onClick={handleClick}
          onContextMenu={e => e.preventDefault()}
        />

        {facilityFeatures.length === 0 && view && (
          <div className="asdex-no-data">
            {nameMap && facilityDcsName && !nameMap[facilityDcsName]
              ? 'NO SURFACE DATA FOR THIS FACILITY'
              : polygonData === null
              ? 'SURFACE DATA UNAVAILABLE'
              : 'NO POSITION DATA'}
          </div>
        )}

        {coordsVisible && <div ref={coordsRef} className="asdex-coords" />}
      </div>
    </div>
  )
}
