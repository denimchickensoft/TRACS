import 'leaflet/dist/leaflet.css'
import './CabScope.css'
import { useEffect, useState, useCallback } from 'react'
import { MapContainer, TileLayer, Polyline, useMap } from 'react-leaflet'
import { useSessionStore }  from '../../store/session'
import { useRunwaysStore }  from '../../store/runways'
import { useUnitsStore }    from '../../store/units'
import { useDisplayStore }  from '../../store/display.js'
import { CabDcb, CAB_WINDOW_ID }  from './cab/CabDcb.jsx'
import { CabOverlay }             from './cab/CabOverlay.jsx'
import { CabPreviewArea }         from './cab/CabPreviewArea.jsx'
import { CabInputHandler }        from './cab/CabInputHandler.jsx'
import { parseCabCommand }        from './cab/cabCommandParser.js'
import { useCabPreviewStore }     from '../../store/cabPreview.js'
import { useFpeStore }            from '../../store/fpe.js'
import { FPE }                    from '../../components/FPE/FPE.jsx'

const TILE_RADIUS = 3  // must match server proxy / fetch script

// Derives a lat/lng bounding box from the center tile ± radius at a given zoom.
// This ensures the maxBounds matches exactly the tiles the proxy will serve.
function tileBbox(lat, lon, zoom, radius) {
  const n    = Math.pow(2, zoom)
  const cx   = Math.floor(((lon + 180) / 360) * n)
  const latR = (lat * Math.PI) / 180
  const cy   = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n)

  const west  = ((cx - radius) / n) * 360 - 180
  const east  = ((cx + radius + 1) / n) * 360 - 180
  const north = (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (cy - radius)) / n)) * 180) / Math.PI
  const south = (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * (cy + radius + 1)) / n)) * 180) / Math.PI

  return [[south, west], [north, east]]
}

// Keyed by DCS theatre name (lowercase). Layer configs from maps.dcsolympus.com/maps/config.json.
const THEATRES = {
  syria: {
    key:    'syria',
    layers: [
      { minNativeZoom: 14, maxNativeZoom: 15 },
      { minNativeZoom: 16, maxNativeZoom: 16 },
    ],
  },
  caucasus: {
    key:    'alt-caucasus',
    layers: [
      { minNativeZoom: 1,  maxNativeZoom: 13 },
      { minNativeZoom: 13, maxNativeZoom: 16 },
      { minNativeZoom: 16, maxNativeZoom: 18 },
    ],
  },
  persiangulf: {
    key:    'alt-persiangulf',
    layers: [
      { minNativeZoom: 1,  maxNativeZoom: 12 },
      { minNativeZoom: 13, maxNativeZoom: 14 },
      { minNativeZoom: 15, maxNativeZoom: 16 },
      { minNativeZoom: 17, maxNativeZoom: 17 },
    ],
  },
  nevada: {
    key:    'alt-nevada',
    layers: [
      { minNativeZoom: 1,  maxNativeZoom: 13 },
      { minNativeZoom: 13, maxNativeZoom: 16 },
      { minNativeZoom: 16, maxNativeZoom: 17 },
    ],
  },
  normandy: {
    key:    'alt-Normandy',
    layers: [
      { minNativeZoom: 1,  maxNativeZoom: 11 },
      { minNativeZoom: 12, maxNativeZoom: 13 },
      { minNativeZoom: 13, maxNativeZoom: 14 },
      { minNativeZoom: 14, maxNativeZoom: 15 },
      { minNativeZoom: 15, maxNativeZoom: 17 },
    ],
  },
  germanycw: {
    key:    'alt-GermanyCW',
    layers: [
      { minNativeZoom: 1,  maxNativeZoom: 11 },
      { minNativeZoom: 13, maxNativeZoom: 13 },
      { minNativeZoom: 15, maxNativeZoom: 15 },
    ],
  },
  marianaislands: {
    key:    'alt-marianaislands-modern',
    layers: [
      { minNativeZoom: 1,  maxNativeZoom: 13 },
      { minNativeZoom: 13, maxNativeZoom: 18 },
    ],
  },
}

const ZOOM_MIN  = 14
const ZOOM_MAX  = 16
const ZOOM_STEP = 0.25

// Replaces Leaflet's scroll zoom with a fixed 0.25-step handler.
// Leaflet's built-in scroll handler ignores zoomDelta and uses its own accumulator.
function ScrollZoomOverride() {
  const map = useMap()
  useEffect(() => {
    map.scrollWheelZoom.disable()
    const onWheel = (e) => {
      e.preventDefault()
      const dir  = e.deltaY < 0 ? 1 : -1
      const next = parseFloat(
        Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, map.getZoom() + dir * ZOOM_STEP)).toFixed(3)
      )
      map.setZoom(next)
    }
    map.getContainer().addEventListener('wheel', onWheel, { passive: false })
    return () => {
      map.getContainer().removeEventListener('wheel', onWheel)
      map.scrollWheelZoom.enable()
    }
  }, [map])
  return null
}

// One-way: integer zoom level stored as rangeNm → map zoom.
// DCB or scroll changes rangeNm → this applies it to the map.
function ZoomController({ zoom }) {
  const map = useMap()
  useEffect(() => {
    if (Math.abs(map.getZoom() - zoom) > 0.01) map.setZoom(zoom)
  }, [zoom, map])
  return null
}

// One-way: map zoom → store. Computes live nm from zoom + container + lat,
// writes rangeNmDisplay (formatted string) and rangeNm (integer zoom level).
function ZoomListener() {
  const map          = useMap()
  const updateWindow = useDisplayStore((s) => s.updateWindow)

  const computeAndStore = useCallback(() => {
    const zoom     = map.getZoom()
    const size     = map.getSize()
    const shortDim = Math.min(size.x, size.y)
    if (!shortDim) return
    const cosLat = Math.cos(map.getCenter().lat * Math.PI / 180)
    const nm     = 156543.03392 * cosLat * shortDim / (2 * 1852 * Math.pow(2, zoom))
    updateWindow(CAB_WINDOW_ID, { rangeNm: zoom, rangeNmDisplay: nm.toFixed(1) })
  }, [map, updateWindow])

  useEffect(() => {
    computeAndStore()
    map.on('zoomend resize', computeAndStore)
    return () => map.off('zoomend resize', computeAndStore)
  }, [map, computeAndStore])

  return null
}

export default function CabScope() {
  const mission         = useSessionStore((s) => s.mission)
  const airbases        = useSessionStore((s) => s.airbases)
  const facilityDcsName = useSessionStore((s) => s.facilityDcsName)
  const positionSuffix  = useSessionStore((s) => s.positionSuffix)
  const centerlines     = useRunwaysStore((s) => s.centerlines)
  const facilityAirbase = useRunwaysStore((s) => s.facilityAirbase)
  const units           = useUnitsStore((s) => s.units)

  const displayStore   = useDisplayStore()
  const windowSettings = useDisplayStore((s) => s.windows[CAB_WINDOW_ID])

  // Init display window with CAB defaults
  useEffect(() => {
    if (!windowSettings) {
      displayStore.initWindow(CAB_WINDOW_ID, { rangeNm: 15, ptlLength: 0.5, ldrLength: 2 })
    }
  }, []) // eslint-disable-line

  const [magvarOverride, setMagvarOverride] = useState(() => window.__magvarOverride ?? null)
  useEffect(() => {
    const id = setInterval(() => {
      const cur = window.__magvarOverride ?? null
      setMagvarOverride((prev) => (prev === cur ? prev : cur))
    }, 500)
    return () => clearInterval(id)
  }, [])

  const handleEnter = useCallback(() => {
    const buffer = useCabPreviewStore.getState().buffer
    const parsed = parseCabCommand(buffer, 'ENTER')
    if (!parsed) {
      useCabPreviewStore.getState().setResponse('INVALID INPUT')
      return
    }
    if (parsed.command.id === 'OPEN_FPE') {
      useFpeStore.getState().openFpe({ aid: parsed.captures.aid ?? null, scope: 'cab' })
      useCabPreviewStore.getState().clearAfterCommand()
    }
  }, [])

  const theatreRaw = (mission?.mission?.theatre ?? 'Syria').toLowerCase()
  const theatreCfg = THEATRES[theatreRaw] ?? THEATRES.syria
  const tileUrl    = `/api/tiles/${theatreCfg.key}/{z}/{x}/{y}`

  // Ensure runway data is loaded even when AtcScope is not mounted
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre || !facilityDcsName) return
    const raw    = airbases?.airbases ?? airbases ?? {}
    const match  = Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName)
    useRunwaysStore.getState().loadForTheatre(
      theatre, positionSuffix, match?.latitude ?? null, match?.longitude ?? null, facilityDcsName, null
    )
  }, [mission?.mission?.theatre, facilityDcsName, positionSuffix, airbases, magvarOverride])

  // Center from runways store (populated async), falling back to session airbases (immediate)
  const facilityCl = centerlines.find((c) => c.airbase === facilityAirbase)
  let center = facilityCl
    ? [(facilityCl.rwyEnd1.lat + facilityCl.rwyEnd2.lat) / 2, (facilityCl.rwyEnd1.lng + facilityCl.rwyEnd2.lng) / 2]
    : null

  if (!center && facilityDcsName) {
    const raw   = airbases?.airbases ?? airbases ?? {}
    const match = Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName)
    if (match?.latitude != null) center = [match.latitude, match.longitude]
  }

  const rangeNm = windowSettings?.rangeNm ?? 15
  const maxBounds  = center ? tileBbox(center[0], center[1], 14, TILE_RADIUS) : null

  // Filter to airborne contacts only
  const airUnits = Object.fromEntries(
    Object.entries(units).filter(([, u]) =>
      (u.category === 'Aircraft' || u.category === 'Helicopter') && u.position?.lat != null
    )
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden', userSelect: 'none', background: '#0a0a0a' }}>
      <CabInputHandler onEnter={handleEnter} />
      <CabDcb />

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <FPE scope="cab" />
        <CabPreviewArea />
        {!center ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#444', fontFamily: 'inherit', letterSpacing: '0.1em' }}>
            NO POSITION DATA
          </div>
        ) : (
          <MapContainer
            key={facilityAirbase}
            center={center}
            zoom={15}
            minZoom={14}
            maxZoom={16}
            zoomSnap={0.25}
            doubleClickZoom={false}
            maxBounds={maxBounds}
            maxBoundsViscosity={1.0}
            className="cab-map"
            style={{ width: '100%', height: '100%', background: '#0a0a0a' }}
            zoomControl={false}
            attributionControl={false}
          >
            <ZoomController zoom={rangeNm} />
            <ZoomListener />
            <ScrollZoomOverride />

            {theatreCfg.layers.map((l, i) => (
              <TileLayer
                key={i}
                url={tileUrl}
                minNativeZoom={l.minNativeZoom}
                maxNativeZoom={l.maxNativeZoom}
                minZoom={l.minNativeZoom}
                maxZoom={20}
              />
            ))}

            {centerlines.map((cl) => (
              <Polyline
                key={cl.id}
                positions={[[cl.rwyEnd1.lat, cl.rwyEnd1.lng], [cl.rwyEnd2.lat, cl.rwyEnd2.lng]]}
                pathOptions={{ color: '#ff0', weight: 2, opacity: 0.8 }}
              />
            ))}

            <CabOverlay units={airUnits} />
          </MapContainer>
        )}
      </div>
    </div>
  )
}
