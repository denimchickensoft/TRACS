import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useSessionStore }  from '../../store/session'
import { useDisplayStore }  from '../../store/display.js'
import { useUnitsStore }    from '../../store/units.js'
import { useAbmStore, DECLARATION } from '../../store/abm.js'
import { nmBetween, findNearestBogey } from '../../utils/findNearestBogey.js'
import { useBlink } from '../../utils/useBlink.js'
import { applyCallsignChange }  from '../../utils/callsignRename.js'
import { resolveCallsign } from '../../utils/callsign.js'
import { sendWebrtcSessionEvent } from '../../webrtc/client.js'
import { useNavdataStore }  from '../../store/navdata.js'
import { useRunwaysStore }  from '../../store/runways.js'
import { useGeoStore }      from '../../store/geo.js'
import { useReliefStore }   from '../../store/relief.js'
import { useHoldingsStore } from '../../store/holdings.js'
import { useMoraStore }     from '../../store/mora.js'
import { useAirwaysStore }  from '../../store/airways.js'
import { useAbmAirspaceStore } from '../../store/abmAirspace.js'
import { useAbmDrawingsStore } from '../../store/abmDrawings.js'
import { loadAbmPrefs, saveAbmPrefs } from '../../store/abmPrefs.js'
import { rangeToPixelsPerNm, canvasToLatLng, latLngToCanvas } from '../../utils/projection.js'
import { resolveSlew }      from '../atc/stars/input/slewResolver.js'
import { formatDMS, formatDDM, formatMGRS, formatElevation } from '../../utils/coords.js'
import { DIR_TO_ANGLE }     from '../atc/stars/constants.js'
import { computeMagvar } from '../../utils/magvar.js'
import { gridBearingRangeNm, toMagneticFromTrue } from '../../utils/bearing.js'
import { drawCompassRose }  from '../atc/stars/canvas/drawCompassRose.js'
import { drawGeo }          from '../atc/stars/canvas/drawGeo.js'
import { drawRelief }       from '../atc/stars/canvas/drawRelief.js'
import { drawHoldings }     from '../atc/stars/canvas/drawHoldings.js'
import { drawMora }         from '../atc/stars/canvas/drawMora.js'
import { drawAirways }      from '../atc/stars/canvas/drawAirways.js'
import { drawRunways }      from '../atc/stars/canvas/drawRunways.js'
import { drawAbmLayers }    from './canvas/drawAbmLayers.js'
import { drawAbmFixSymbols } from './canvas/drawAbmFixSymbols.js'
import { drawAbmAirportPolygons } from './canvas/drawAbmAirportPolygons.js'
import { drawAbmContacts, typeAbbrev, computeSuppressedIds } from './canvas/drawAbmContacts.js'
import { drawAbmGroundContacts } from './canvas/drawAbmGroundContacts.js'
import { drawAbmFragRoute } from './canvas/drawAbmFragRoute.js'
import { useAbmMissionStore } from '../../store/abmMission.js'
import { useBrevityStore } from '../../store/brevity.js'
import { preloadAirdromes } from '../../utils/airdromes.js'
import { drawBraaOverlays, drawThreatRings } from './canvas/drawAbmBraa.js'
import { drawRbl }         from './canvas/drawAbmRbl.js'
import { drawMgrsGrid }    from './canvas/drawMgrsGrid.js'
import { drawAbmTowns }    from './canvas/drawAbmTowns.js'
import { useMissionClock } from '../../utils/useMissionClock.js'
import { drawAbmRaster }   from './canvas/drawAbmRaster.js'
import { drawAbmAirspace } from './canvas/drawAbmAirspace.js'
import { drawAbmCustomDrawings } from './canvas/drawAbmCustomDrawings.js'
import { drawPendingDraw } from './canvas/drawPendingDraw.js'
import { hitTestDrawingLayer } from './canvas/hitTestDrawing.js'
import {
  parseDrawCommand, advancePendingDraw, rotatePendingDraw, supportsRotation, POLY_CLOSE_RADIUS_PX,
} from './draw/drawCommands.js'
import './AbmScope.css'

const WINDOW_ID  = 'abm-main'
const RANGE_MIN  = 1
const RANGE_MAX  = 600
const COALITION_NUM = { blue: 2, red: 1, gm: 2, admin: 2 }
const AGL_FLOOR_M = 30  // ≈ 100 ft — suppress ground contacts, same floor AIC uses
const MAX_HISTORY   = 10  // absolute cap on captured points; display capped by historyLength setting
const ALT_TOGGLE_MS   = 2000  // datablock line-2 speed/type alternation rate
const READOUT_RADIUS_PX = 10    // cursor-proximity radius for the unit readout box
const READOUT_CYCLE_MS  = 3000  // per-object fade in/out phase when >1 unit is under the cursor
// Must match SEA_COLOR in server/scripts/buildAbmBasemap.js — the .base
// (basemap) raster's own opaque background fill; .terrain's own raster is
// transparent beyond its relief data (2026-08-11) and has no fill of its
// own, so the letterbox backdrop is keyed off basemap OR terrain being on,
// whichever is visible, so the scope's own background reads as a
// continuation of whichever raster is showing instead of a mismatched or
// black border around it.
const BASEMAP_SEA_COLOR = 'rgb(26, 38, 48)'

const F_KEY_DECL = {
  F1: DECLARATION.HOSTILE,
  F2: DECLARATION.BOGEY,
  F3: DECLARATION.NEUTRAL,
  F4: DECLARATION.FRIENDLY,
}

// .acq/.eng classification letters — same f/n/b/h convention as the F-key
// declarations above (b for BOGEY, MTTP brevity — not "u" for unknown),
// lowercase for command-line entry (2026-07-07).
const CLASS_LETTER = {
  f: DECLARATION.FRIENDLY,
  n: DECLARATION.NEUTRAL,
  b: DECLARATION.BOGEY,
  h: DECLARATION.HOSTILE,
}
const ALL_DECLARATIONS = [DECLARATION.HOSTILE, DECLARATION.BOGEY, DECLARATION.NEUTRAL, DECLARATION.FRIENDLY]

// .autoclass (2026-07-08) — same TRUE-classification rule as AIC's
// (client/src/modules/aic/AicScope.jsx trueDeclaration): own coalition is
// FRIENDLY, coalition 0 (DCS's neutral) is NEUTRAL, anything else is HOSTILE.
function trueDeclaration(unit, myCoalitionNum) {
  if (unit.coalition === myCoalitionNum) return DECLARATION.FRIENDLY
  if (unit.coalition === 0) return DECLARATION.NEUTRAL
  return DECLARATION.HOSTILE
}

// Draw-command arg tokens (.line/.rect/.circ/.poly/.sect/.race/.text) must
// come from the ORIGINAL-case command text, not the lowercased `str`
// execCommand matches against — .text's label content needs to keep
// whatever case the controller typed. `str`/`raw.trim()` share the same
// length and whitespace positions (lowercasing doesn't change either), so
// the split point found in `str` is reused to slice the original-case raw.
function drawCmdTokens(str, raw) {
  const trimmedRaw = raw.trim()
  const spaceIdx = str.indexOf(' ')
  return spaceIdx === -1 ? [] : trimmedRaw.slice(spaceIdx + 1).trim().split(/\s+/).filter(Boolean)
}

// Per-category airspace toggles (2026-07-08) — replaces the old single
// .airspace bulk toggle. Categories mirror the displayCategory values in
// server/navdata/config/airspace_colors.json, excluding procedures (no
// PROC_SID/STAR/APPCH commands) and the non-airspace layers that already
// have their own commands (HOLDS/.holds, AIRWAYS_*/.airways, MORA/.mora,
// RELIEF/.relief, MVA, ROUTE, GEO_*).
const AIRSPACE_CATEGORIES = [
  'TMA', 'CTR', 'CTA', 'FIR', 'UIR', 'SUA', 'MIL', 'TRSA',
  'CLASS A', 'CLASS B', 'CLASS C', 'CLASS D', 'CLASS E', 'CLASS F', 'CLASS G',
]
const AIRSPACE_CMD_CATEGORY = {
  tma: 'TMA', ctr: 'CTR', cta: 'CTA', fir: 'FIR', uir: 'UIR', sua: 'SUA', mil: 'MIL', trsa: 'TRSA',
  classa: 'CLASS A', classb: 'CLASS B', classc: 'CLASS C', classd: 'CLASS D',
  classe: 'CLASS E', classf: 'CLASS F', classg: 'CLASS G',
}

// Same fog-of-war model as AIC (client/src/modules/aic/AicScope.jsx
// getAicVisibleUnits) — kept as a local copy rather than a shared import
// since it's a small, stable filter and AIC doesn't export it.
function getAbmVisibleUnits(units, myCoalitionNum, rwrEverDetected) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if ((c.detectionMethod & 4) || (c.detectionMethod & 32)) detectedIds.add(String(c.ID))
      if (c.detectionMethod & 16) rwrEverDetected?.add(String(c.ID))
    }
  }

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    if (unit.alive === false) continue
    if (unit.category !== 'Aircraft' && unit.category !== 'Helicopter') continue
    if (unit.agl !== undefined && unit.agl < AGL_FLOOR_M) continue
    const c = unit.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = unit
  }

  return result
}

// Same fog-of-war rule as air (§7.2) — friendly ground/naval always shown,
// enemy only if in a friendly's contacts[] — but no AGL floor (ground units
// sit at/near 0 AGL by definition, so that filter doesn't apply here).
// Unlike air (RADAR/DLINK only), ground/naval detection counts any method —
// VISUAL(1)/OPTIC(2)/RADAR(4)/IRST(8)/RWR(16)/DLINK(32) — since a ground unit
// spotted visually or optically is just as "detected" as one painted by radar.
const GROUND_DETECTION_MASK = 1 | 2 | 4 | 8 | 16 | 32

function getAbmVisibleGroundUnits(units, myCoalitionNum) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.contacts) continue
    for (const c of unit.contacts) {
      if (c.detectionMethod & GROUND_DETECTION_MASK) detectedIds.add(String(c.ID))
    }
  }

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    if (unit.alive === false) continue
    if (unit.category !== 'GroundUnit' && unit.category !== 'NavyUnit') continue
    const c = unit.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = unit
  }

  return result
}

// Bogey dope helper — ported from AIC's AicScope.jsx findNearestBogey as-is.
// Air contacts only, BOGEY/HOSTILE only (excludes FRIENDLY/NEUTRAL and,
// per 2026-07-07 direction, ground/naval contacts — "bogey" means air).
// Classification-only multi-select (2026-07-08) — local to ABM, not shared
// with resolveSlew (used everywhere else: BRAA, threat rings, bogey dope,
// leader-dir override) which always picks the single nearest hit. Dense
// ground/naval clusters can bury a unit behind closer neighbors so that
// "nearest wins" makes it unreachable no matter where in the cluster you
// click; F1-F4 + click instead classifies every contact within the same
// click radius at once.
const CLASSIFY_CLICK_RADIUS_PX = 10

function resolveClassifyTargets(canvasPos, units, view) {
  const hits = []
  for (const [id, unit] of Object.entries(units)) {
    const pos = unit.position
    if (!pos) continue
    const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
    if (Math.hypot(canvasPos.x - x, canvasPos.y - y) < CLASSIFY_CLICK_RADIUS_PX) {
      hits.push({ unitId: id, unit })
    }
  }
  return hits
}

const METERS_PER_NM = 1852
function formatNmRange(meters, suffix) {
  return `${Math.round(meters / METERS_PER_NM)} NM ${suffix}`
}

// Cursor-proximity readout field list — pulled from the ground/navy unit
// databases (client/public/units/{ground,navy}unitdatabase.json), same
// dbEntry shape drawAbmGroundContacts.js keys off of (unit.name lookup).
// Empty string/null/0 fields are dropped per spec — a 0 acq/eng range means
// "no ring drawn" (see drawAbmGroundContacts.js), not "range is zero". No
// labels on the lines themselves — the acq/eng lines carry their own
// "acquisition"/"engagement" suffix instead (2026-07-09 direction).
function buildReadoutFields(dbEntry) {
  if (!dbEntry) return []
  const fields = [
    dbEntry.label,
    dbEntry.type,
    dbEntry.acquisitionRange > 0 ? formatNmRange(dbEntry.acquisitionRange, 'acquisition') : null,
    dbEntry.engagementRange  > 0 ? formatNmRange(dbEntry.engagementRange,  'engagement')  : null,
    dbEntry.description,
  ]
  return fields.filter(v => v !== undefined && v !== null && v !== '')
}

// Friendly air-unit readout — true coalition (unit.coalition === myCoalitionNum),
// not the possibly F-key-overridden declaration, same "actual side" gate
// drawAbmContacts.js uses for its own friendly/non-friendly datablock split
// (2026-08-02 direction: classification overrides shouldn't unlock this).
// One line per ammo entry, no cap — a loaded-out jet just gets a long list.
function buildFriendlyAirFields(unit) {
  const fields = [
    resolveCallsign(unit).toUpperCase(),
    typeAbbrev(unit),
    unit.fuel != null ? `${Math.round(unit.fuel)}% FUEL` : null,
    ...(unit.ammo ?? [])
      .filter(a => a.quantity > 0)
      .map(a => `${a.name} x ${a.quantity}`),
  ]
  return fields.filter(v => v !== undefined && v !== null && v !== '')
}

// Perpendicular distance from (px,py) to the segment (x1,y1)-(x2,y2), clamped
// to the segment itself (not the infinite line) — used to hit-test the
// cursor against runway centerlines for the airport readout below.
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// Average of every runway-strip endpoint at the named airbase — a good
// enough center point for a FRAG BASE .find-style marker, and reuses the
// same per-airbase strip tables airportStrips (below) already builds from
// runwayCenterlines rather than a separate lookup.
function airbaseCenterFromStrips(strips, airbaseName) {
  const airport = strips.find(a => a.airbase === airbaseName)
  if (!airport) return null
  let latSum = 0, lngSum = 0, count = 0
  for (const s of airport.strips) {
    latSum += s.rwyEnd1.lat + s.rwyEnd2.lat
    lngSum += s.rwyEnd1.lng + s.rwyEnd2.lng
    count += 2
  }
  return count ? { lat: latSum / count, lng: lngSum / count } : null
}

// Standard aviation padding: single-digit runway numbers get a leading zero
// (e.g. "4" → "04"), the L/C/R parallel suffix (already resolved by
// useRunwaysStore) passes through unchanged.
function padRunwayName(name) {
  const m = String(name).match(/^(\d+)([A-Za-z]?)$/)
  if (!m) return String(name)
  return `${m[1].padStart(2, '0')}${m[2].toUpperCase()}`
}

// Airport readout field list — DCS airbase name (line 1, every airport has
// one), ICAO (line 2, dropped if this airbase has no icaoMapping.json
// entry — not every airbase does), and every runway designator at the
// airport (line 3, physical strips comma-separated, each strip's reciprocal
// pair slash-joined — e.g. "04/22, 09L/27R").
function buildAirportFields(airport) {
  const fields = [airport.airbase, airport.icao, airport.designators.join(', ')]
  return fields.filter(v => v !== undefined && v !== null && v !== '')
}

// Phase 2 — real canvas + rAF PPI: pan (right-click drag), zoom (scroll),
// range rings (toggle + anchor via .rr command), bullseye marker, command
// preview area. Phase 3 adds the §4 navdata layers (geo/relief/holdings/
// mora/airways/airspace reused directly from STARS's stores+draw functions;
// fixes/navaids/runways/airports_polygons reused/ported; airports still
// blocked). Phase 4 adds air contacts with ABM's own symbology (§3, revised
// 2026-07-05): declaration colors match AIC, but plain-square symbols,
// persistent leader-lined datablocks, and history trails — a distinct system
// from both AIC's HAFU shapes and ATC's STARS symbology. Declarations are
// ABM's own (store/abm.js), independent from AIC's (deferred cross-module
// sharing decision — see abm-spec.md §1.2). No STARS/CATCC-style track
// ownership/initiation — declare-and-display only. Magnetic-north-up
// projection (real WMM declination) and a compass rose (CATCC's smaller
// fontScale, not STARS's) added 2026-07-05.
export default function AbmScope() {
  const canvasAreaRef  = useRef(null)
  const mapRef         = useRef(null)
  const layersRef      = useRef(null)
  const compassRef     = useRef(null)
  const contactsRef    = useRef(null)
  const interactiveRef = useRef(null)

  // Loaded once on first mount — feeds initial state below (window-init
  // defaults + local useState initializers). Not re-read after that; all
  // updates go through saveAbmPrefs at the point of each command.
  const abmPrefsRef = useRef(null)
  if (abmPrefsRef.current === null) {
    abmPrefsRef.current = loadAbmPrefs()
    // paletteIdx lives in useAbmAirspaceStore (not local state) so
    // Drawings.jsx can reactively read the active CUSTOM palette color —
    // hydrated here, synchronously, so the selector below never sees the
    // store's default 0 before this mount's saved value applies.
    useAbmAirspaceStore.setState({ paletteIdx: abmPrefsRef.current.aspColorIdx })
  }
  const abmPrefs = abmPrefsRef.current

  const coalition = useSessionStore(s => s.coalition)
  const bullseyes = useSessionStore(s => s.bullseyes)
  const mission   = useSessionStore(s => s.mission)
  const theatre   = mission?.mission?.theatre
  const missionDate = mission?.mission?.dateAndTime?.date ?? null
  const myCoalitionNum = COALITION_NUM[coalition] ?? 2

  // ── Mission clock — click to toggle Zulu/Local, .time to toggle visibility ─────
  const { timeStr, localTimeStr } = useMissionClock()
  const [showLocalTime, setShowLocalTime] = useState(false)
  const [clockVisible,  setClockVisible]  = useState(abmPrefs.timeVisible)
  const clockTime = showLocalTime ? localTimeStr : timeStr

  const displayStore   = useDisplayStore()
  const windowSettings = useDisplayStore(s => s.windows[WINDOW_ID])

  // ── Air picture (§3 / Phase 4) — ABM's own declarations, own symbology ──────
  const units        = useUnitsStore(s => s.units)
  const declarations = useAbmStore(s => s.declarations)
  const autoClassify = useAbmStore(s => s.autoClassify)
  const getEffectiveDeclaration = useAbmStore(s => s.getEffectiveDeclaration)
  const declarationsRef = useRef(declarations)
  useEffect(() => { declarationsRef.current = declarations }, [declarations])

  // ── ATO/FRAG flight selection (Ctrl+Shift+Click) ─────────────────────────────
  const atoFlights       = useAbmMissionStore(s => s.flights)
  const selectedGroupId = useAbmMissionStore(s => s.selectedGroupId)
  const selectAtoGroup  = useAbmMissionStore(s => s.selectGroup)
  const routeVisible    = useAbmMissionStore(s => s.routeVisible)
  const selectedRoute = useMemo(
    () => (routeVisible ? atoFlights.find(f => f.groupId === selectedGroupId)?.route ?? null : null),
    [atoFlights, selectedGroupId, routeVisible]
  )

  // FRAG BASE/waypoint click (requestFind) and roster click (toggleBlink) —
  // store/abmMission.js. AbmScope is the only place holding theatre navdata/
  // runway/live-unit data, so it resolves these refs; see the findRequest
  // effect and blink wiring below.
  const findRequest = useAbmMissionStore(s => s.findRequest)
  const findNonce    = useAbmMissionStore(s => s.findNonce)
  const blinkIds     = useAbmMissionStore(s => s.blinkIds)
  const blinkIdSet   = useMemo(() => new Set(blinkIds ?? []), [blinkIds])

  // BRAA line / bogey dope — ported from AIC, same keypresses/commands
  // (§11-adjacent — not in the original spec draft, added 2026-07-07).
  const braaList          = useAbmStore(s => s.braaList)
  const pendingBraaFighter = useAbmStore(s => s.pendingBraaFighter)
  const {
    addBraaPair, removeBraaPairsForUnit,
    setPendingBraaFighter, clearPendingBraa,
  } = useAbmStore()
  const [threatRings, setThreatRings] = useState(new Set())
  const toggleThreatRing = (unitId) =>
    setThreatRings(s => { const n = new Set(s); n.has(unitId) ? n.delete(unitId) : n.add(unitId); return n })
  const threatRadius = windowSettings?.threatRadius ?? 45

  // .db + click (2026-07-29) — per-contact datablock override, same
  // session-local Set-toggle pattern as threatRings above (not persisted —
  // bare `.db` in execCommand toggles the global dbVisible window setting
  // instead, that one *is* persisted via abmPrefs). Checked in addition to
  // dbVisible/formation suppression in drawAbmContacts, never in place of them.
  const [dbHiddenIds, setDbHiddenIds] = useState(new Set())
  const toggleDbHidden = (unitId) =>
    setDbHiddenIds(s => { const n = new Set(s); n.has(unitId) ? n.delete(unitId) : n.add(unitId); return n })

  // Middle-click highlight (STARS/AbmScope shared behaviour) — session-local,
  // not persisted; toggles a contact's symbol/datablock to HIGHLIGHT_TEAL
  // (atc/stars/constants.js). Works across air + ground/naval (allVisibleUnits).
  const [highlightedIds, setHighlightedIds] = useState(new Set())
  const toggleHighlight = (unitId) =>
    setHighlightedIds(s => { const n = new Set(s); n.has(unitId) ? n.delete(unitId) : n.add(unitId); return n })

  // .autothreat (2026-07-10) — local UI toggle (not shared with other
  // controllers), persisted via abmPrefs like the rest of ABM's local display
  // settings. While on, rings light automatically on every friendly aircraft
  // within threatRadius of a HOSTILE/BOGEY aircraft; auto-lit rings are
  // tracked separately from threatRings (manual Ctrl+Alt+click/.threat+click)
  // and just union at draw time, so auto fully owns a contact's ring for as
  // long as the breach lasts.
  const [autoThreat, setAutoThreatState] = useState(abmPrefs.autoThreat)
  const setAutoThreat = (enabled) => {
    setAutoThreatState(enabled)
    saveAbmPrefs({ autoThreat: enabled })
  }
  const [autoThreatRingIds, setAutoThreatRingIds] = useState(new Set())

  // Ground/naval acq/eng range-ring visibility (§7) — per-classification
  // hide sets (.acq/.eng commands). Empty set = everything shown; bare
  // `.acq`/`.eng` toggles all four classes at once, `.acq h` etc. toggles
  // just that classification (2026-07-07).
  const [acqHidden, setAcqHidden] = useState(new Set(abmPrefs.acqHidden))
  const [engHidden, setEngHidden] = useState(new Set(abmPrefs.engHidden))

  // IDs ever seen with the RWR detection bit (16) set — same "sticky" reveal
  // rule as AIC (AicScope.jsx rwrEverDetectedRef): once a non-friendly air
  // contact is RWR-detected, its type stays revealed in the air-unit readout
  // below even if RWR drops out again.
  const rwrEverDetectedRef = useRef(new Set())
  const visibleUnits = useMemo(
    () => getAbmVisibleUnits(units, myCoalitionNum, rwrEverDetectedRef.current),
    [units, myCoalitionNum]
  )
  const visibleUnitsRef = useRef(visibleUnits)
  useEffect(() => { visibleUnitsRef.current = visibleUnits }, [visibleUnits])

  useEffect(() => {
    if (!autoThreat) { setAutoThreatRingIds(new Set()); return }
    const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
    const friendlies = []
    const hostiles   = []
    for (const [id, unit] of Object.entries(visibleUnits)) {
      if (!unit.position) continue
      const decl = getDecl(id, unit)
      if (decl === DECLARATION.FRIENDLY) friendlies.push([id, unit])
      else if (decl === DECLARATION.HOSTILE || decl === DECLARATION.BOGEY) hostiles.push(unit)
    }
    const breached = new Set()
    for (const [id, unit] of friendlies) {
      if (hostiles.some(h => nmBetween(unit.position, h.position) <= threatRadius)) breached.add(id)
    }
    setAutoThreatRingIds(breached)
  }, [visibleUnits, autoThreat, myCoalitionNum, threatRadius]) // eslint-disable-line

  // ── Ground/naval picture (§7 / Phase 5) — same declaration store/symbology
  // rules as air (classification works the same way), distinct rendering
  // (drawAbmGroundContacts.js): solid circles, half the air symbol's size,
  // no datablock/leader/PTL. Range rings sourced from the static unit
  // databases (client/public/units/{ground,navy}unitdatabase.json), keyed by
  // the Olympus unit.name type identifier. No moving/stationary distinction
  // in v1 (2026-07-07 direction) — every ground/naval unit renders the same.
  const visibleGroundUnits = useMemo(
    () => getAbmVisibleGroundUnits(units, myCoalitionNum),
    [units, myCoalitionNum]
  )

  // Middle-click "pin" (2026-07-29) — a highlighted ground/naval unit stays
  // drawn at its last known position even after it drops out of the
  // fog-of-war visible set (e.g. the contact that was detecting it goes
  // stale) — ground/naval otherwise has no fade/coast mechanism (unlike
  // air's fadedRef below), so without this a highlight would just vanish
  // the instant detection lapses. Deliberately indefinite for as long as
  // the underlying unit is still alive — un-highlighting (a second
  // middle-click) or the unit actually being destroyed both drop the pin.
  const pinnedGroundRef = useRef({})
  useEffect(() => {
    for (const id of highlightedIds) {
      if (visibleGroundUnits[id]) pinnedGroundRef.current[id] = visibleGroundUnits[id]
    }
    for (const id of Object.keys(pinnedGroundRef.current)) {
      if (!highlightedIds.has(id) || !units[id] || units[id].alive === false) {
        delete pinnedGroundRef.current[id]
      }
    }
  }, [visibleGroundUnits, highlightedIds, units])

  const pinnedGroundUnits = useMemo(() => {
    let merged = visibleGroundUnits
    for (const id of highlightedIds) {
      if (!merged[id] && pinnedGroundRef.current[id]) {
        if (merged === visibleGroundUnits) merged = { ...visibleGroundUnits }
        merged[id] = pinnedGroundRef.current[id]
      }
    }
    return merged
  }, [visibleGroundUnits, highlightedIds])

  const visibleGroundUnitsRef = useRef(pinnedGroundUnits)
  useEffect(() => { visibleGroundUnitsRef.current = pinnedGroundUnits }, [pinnedGroundUnits])

  // Merged air+ground/naval pool — BRAA pairing, bogey dope, and threat
  // rings all operate across both (a fighter can be BRAA'd to a SAM site,
  // a tanker's threat ring can trip on a ground threat, etc.), unlike AIC
  // where only air contacts exist. Uses pinnedGroundUnits (not the raw
  // fog-of-war set) so a pinned unit stays clickable — e.g. to un-highlight
  // it again — the same as any other visible contact.
  const allVisibleUnits = useMemo(
    () => ({ ...visibleUnits, ...pinnedGroundUnits }),
    [visibleUnits, pinnedGroundUnits]
  )
  const allVisibleUnitsRef = useRef(allVisibleUnits)
  useEffect(() => { allVisibleUnitsRef.current = allVisibleUnits }, [allVisibleUnits])

  // .autoclass (2026-07-08) — same pattern as AIC's (AicScope.jsx): while on,
  // any air/ground/naval unit that becomes visible with no explicit
  // declaration yet gets one set to its TRUE classification. Only touches
  // undeclared units so it never stomps a manual override (or its own prior
  // auto-declaration). The bulk reclassify-everything-visible-now pass runs
  // once, in execCommand, at the moment .autoclass is switched on.
  useEffect(() => {
    if (!autoClassify) return
    for (const [id, unit] of Object.entries(allVisibleUnits)) {
      if (declarationsRef.current[id] === undefined) {
        useAbmStore.getState().setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
      }
    }
  }, [allVisibleUnits, autoClassify, myCoalitionNum])

  const [groundUnitDb, setGroundUnitDb] = useState({})
  useEffect(() => {
    Promise.all([
      fetch('/units/groundunitdatabase.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/units/navyunitdatabase.json').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]).then(([ground, navy]) => setGroundUnitDb({ ...ground, ...navy }))
  }, [])

  // Real ICAO codes only (client/public/icaoMapping.json) — fetched
  // separately from useRunwaysStore's internal copy so the airport readout
  // (below) can tell a genuine ICAO apart from that store's fallback
  // abbreviation (computeAirbaseLabels in store/runways.js) baked into its
  // centerline .label strings, and drop line 1 when there's no real mapping.
  const [icaoMap, setIcaoMap] = useState({})
  useEffect(() => {
    fetch('/icaoMapping.json').then(r => r.ok ? r.json() : {}).catch(() => ({})).then(setIcaoMap)
  }, [])

  useEffect(() => { useBrevityStore.getState().load() }, [])

  const [pendingDeclaration, setPendingDeclaration] = useState(null)

  // Faded/coasting contacts — same tracking pattern as AIC
  // (client/src/modules/aic/AicScope.jsx): a unit that drops out of
  // visibleUnits gets dead-reckoned from its last known state for
  // fadedSeconds before being dropped entirely.
  const fadedRef       = useRef({})
  const prevVisibleRef = useRef({})
  const [fadedTick, setFadedTick] = useState(0)

  useEffect(() => {
    const now  = Date.now()
    const prev = prevVisibleRef.current
    const curr = visibleUnits
    for (const [id, unit] of Object.entries(prev)) {
      if (!curr[id] && !fadedRef.current[id]) {
        fadedRef.current[id] = { unit: { ...unit }, disappearedAt: now }
      }
    }
    for (const id of Object.keys(fadedRef.current)) {
      if (curr[id]) delete fadedRef.current[id]
    }
    prevVisibleRef.current = curr
  }, [visibleUnits])

  useEffect(() => {
    const id = setInterval(() => {
      const now          = Date.now()
      const fadedSeconds = useDisplayStore.getState().windows[WINDOW_ID]?.fadedSeconds ?? 30
      for (const unitId of Object.keys(fadedRef.current)) {
        if (now - fadedRef.current[unitId].disappearedAt > fadedSeconds * 1000)
          delete fadedRef.current[unitId]
      }
      setFadedTick(t => t + 1)
    }, 500)
    return () => clearInterval(id)
  }, [])

  // History trail capture — same rate-gated-setInterval pattern STARS uses
  // (client/src/modules/atc/stars/StarsScope.jsx), not AIC (which has none).
  // Rate driven by windowSettings.historyRate (seconds), via a ref so the
  // interval doesn't need to be torn down/rebuilt when the rate changes.
  const historyRef = useRef({})
  const historyRateRef = useRef(4.5)
  useEffect(() => {
    historyRateRef.current = windowSettings?.historyRate ?? 4.5
  }, [windowSettings?.historyRate])
  useEffect(() => {
    let lastCaptureWall = 0
    let lastCaptureUpdateTime = 0
    const id = setInterval(() => {
      const { lastUpdateTime } = useUnitsStore.getState()
      if (!lastUpdateTime || lastUpdateTime === lastCaptureUpdateTime) return
      const now = Date.now()
      if (now - lastCaptureWall < historyRateRef.current * 1000) return
      lastCaptureWall = now
      lastCaptureUpdateTime = lastUpdateTime

      const current = visibleUnitsRef.current
      historyRef.current = Object.fromEntries(
        Object.entries(current).map(([uid, u]) => {
          const prev = historyRef.current[uid] || []
          const pos  = u.position
          if (!pos) return [uid, prev]
          return [uid, [{ lat: pos.lat, lng: pos.lng }, ...prev].slice(0, MAX_HISTORY)]
        })
      )
    }, 200)
    return () => clearInterval(id)
  }, [])

  // Datablock line-2 speed/type alternation (friendlies only) — same idea as
  // STARS' blink timers, just a plain toggle rather than a visibility blink.
  const [altToggle, setAltToggle] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setAltToggle(v => !v), ALT_TOGGLE_MS)
    return () => clearInterval(id)
  }, [])

  // FRAG roster "blink datablock" cue — same 200ms redraw tick / 500ms
  // on-off period StarsScope.jsx uses for handoff/point-out blink.
  const { blinkTick, blinkOn } = useBlink()

  // ── Navdata layers (§4) — reused directly from STARS's stores/draw functions ─
  const geoBoundaries   = useGeoStore(s => s.boundaries)
  const geoCoastlines   = useGeoStore(s => s.coastlines)
  const geoVisible      = useGeoStore(s => s.visible)
  const relief          = useReliefStore(s => s.relief)
  const reliefVisible   = useReliefStore(s => s.visible)
  const holdings        = useHoldingsStore(s => s.holdings)
  const holdingsVisible = useHoldingsStore(s => s.visible)
  const mora            = useMoraStore(s => s.mora)
  const moraVisible     = useMoraStore(s => s.visible)
  const airways         = useAirwaysStore(s => s.airways)
  const airwaysVisible  = useAirwaysStore(s => s.visible)
  const airspaceFeatures = useAbmAirspaceStore(s => s.features)
  const airspacePalettes = useAbmAirspaceStore(s => s.palettes)
  const aspColorIdx   = useAbmAirspaceStore(s => s.paletteIdx)
  const setPaletteIdx = useAbmAirspaceStore(s => s.setPaletteIdx)
  const [asVisible, setAsVisible] = useState(abmPrefs.asVisible)
  const [labelsVisible, setLabelsVisible] = useState(abmPrefs.labelsVisible)
  const [fillVisible, setFillVisible] = useState(abmPrefs.fillVisible)
  const [fillPct, setFillPct] = useState(abmPrefs.fillPct)
  const drawingLayers = useAbmDrawingsStore(s => (theatre ? s.byTheatre[theatre] ?? [] : []))
  const toggleAllDrawings = useAbmDrawingsStore(s => s.toggleAll)
  const addDrawnShape = useAbmDrawingsStore(s => s.addDrawnShape)
  const removeDrawingLayer = useAbmDrawingsStore(s => s.removeLayer)
  const removeDrawingsByName = useAbmDrawingsStore(s => s.removeLayersByName)
  const toggleDrawingsByName = useAbmDrawingsStore(s => s.toggleLayersByName)
  const clearAllDrawings = useAbmDrawingsStore(s => s.clearTheatre)
  const airspaceColors = airspacePalettes[aspColorIdx]?.colors ?? airspacePalettes[0]?.colors ?? null
  const fixes   = useNavdataStore(s => s.fixes)
  const navaids = useNavdataStore(s => s.navaids)
  const [fixesVisible,   setFixesVisible]   = useState(abmPrefs.fixesVisible)
  const [navaidsVisible, setNavaidsVisible] = useState(abmPrefs.navaidsVisible)
  // .fix <name...> — per-theatre pinned fixes, always shown regardless of
  // fixesVisible (see .fix handler below and drawAbmFixSymbols call).
  const [pinnedFixes, setPinnedFixes] = useState(abmPrefs.pinnedFixes ?? {})
  // Same useRunwaysStore.loadForTheatre(theatre) call as below (no facility
  // args) already yields theatre-wide unfiltered centerlines — see §4.3.
  const runwayCenterlines = useRunwaysStore(s => s.centerlines)
  const [runwaysVisible, setRunwaysVisible] = useState(abmPrefs.runwaysVisible)
  // Local fetch mirroring ASDE-X's pattern — no shared store exists for this,
  // and unlike ASDE-X we want every airport in the theatre, not one facility.
  const [polygonFeatures, setPolygonFeatures] = useState([])
  const [polygonsVisible, setPolygonsVisible] = useState(abmPrefs.polygonsVisible)
  // Real UTM/MGRS grid (see drawMgrsGrid.js) — matches DCS's own F10 map.
  // No shared store needed (ABM-only, like the toggles above), so plain
  // local state.
  const [mgrsVisible, setMgrsVisible] = useState(abmPrefs.mgrsVisible)
  // Town/city name labels (.towns) — local fetch straight from the public
  // static file, same as polygonFeatures below but no server API needed
  // since towns are pre-baked per-theatre JSON, not derived from mission data.
  const [towns, setTowns] = useState([])
  const [townsVisible, setTownsVisible] = useState(abmPrefs.townsVisible)
  // Baked raster layers (.map/.terrain/.water/.roads/.base) — see server's
  // buildAbmBasemap.js + drawAbmRaster.js. Draw order (furthest-back first):
  // basemap (land/sea silhouette, wide/coarse), terrain (relief wash only,
  // tight/detailed — no longer bakes coastline/boundary strokes as of
  // 2026-08-11, see .geo below), water, roads, then the live vector
  // relief/geo/etc layers. Each carries the loaded <img> alongside
  // the placement metadata (origin/scale) fetched alongside it. basemap and
  // terrain were named "landfill"/"basemap" respectively until 2026-08-11 —
  // renamed once basemap (the former landfill) graduated from a theatre-by-
  // theatre preview to the layer actually responsible for land/sea color
  // everywhere, and terrain (the former basemap) stopped being that source.
  const [basemap, setBasemap] = useState(null)
  const [basemapVisible, setBasemapVisible] = useState(abmPrefs.basemapVisible)
  const [terrain, setTerrain] = useState(null)
  const [terrainVisible, setTerrainVisible] = useState(abmPrefs.terrainVisible)
  const [water, setWater] = useState(null)
  const [waterVisible, setWaterVisible] = useState(abmPrefs.waterVisible)
  const [roads, setRoads] = useState(null)
  const [roadsVisible, setRoadsVisible] = useState(abmPrefs.roadsVisible)

  // Cursor position readout (.coords) — DMS/DDS + real MGRS + terrain
  // elevation at the cursor. Position updates read straight off a ref
  // (cheap, no fetch), gated to a short interval so the box doesn't
  // re-render on every raw mousemove; elevation is fetched from the new
  // /api/elevation endpoint (server/src/elevation.js, previously only used
  // internally for per-unit AGL) and throttled to once per ~100m cell.
  const [coordsVisible, setCoordsVisible] = useState(abmPrefs.coordsVisible)
  const [coordFormat,   setCoordFormat]   = useState(abmPrefs.coordFormat) // 'dms' | 'ddm'
  const [elevUnit,      setElevUnit]      = useState(abmPrefs.elevUnit) // 'feet' | 'meters'
  const [coordsReadout, setCoordsReadout] = useState(null)
  const cursorLatLngRef  = useRef({ lat: null, lng: null })
  const elevRef          = useRef(null)
  const lastElevFetchRef = useRef(null)

  // Raw canvas-pixel cursor position — tracked unconditionally (unlike
  // cursorLatLngRef above, which only updates when .coords is on) since the
  // hover readout below needs it regardless of whether .coords is toggled.
  const cursorCanvasPosRef = useRef({ x: null, y: null })

  // Bullseye-on-cursor readout (.bec) — small bearing/range label that
  // tracks the mouse pixel-for-pixel, unlike .coords' box above which is
  // pinned to a corner and throttled. Recomputed straight off setState on
  // every mousemove instead of the 150ms interval .coords uses, since this
  // is plain trig (no fetch to throttle) and needs to feel like it's
  // actually attached to the cursor.
  const [becVisible, setBecVisible] = useState(abmPrefs.becVisible)
  const [becReadout, setBecReadout] = useState(null)

  const handleCursorMove = useCallback((e) => {
    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    cursorCanvasPosRef.current = { x, y }
    if (coordsVisible && viewRef.current) {
      cursorLatLngRef.current = canvasToLatLng(x, y, viewRef.current)
    }
    if (becVisible && viewRef.current) {
      const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
      const { hasBullseye, lat: bsLat, lng: bsLng } = bullseyeRef.current
      if (hasBullseye) {
        const { gridBearingDeg, rangeNm } = gridBearingRangeNm(bsLat, bsLng, lat, lng, theatreRef.current)
        const magBrg = toMagneticFromTrue(gridBearingDeg, declinationRef.current)
        setBecReadout({ x, y, bearing: Math.round(magBrg) || 360, range: Math.round(rangeNm) })
      } else {
        setBecReadout(null)
      }
    }
  }, [coordsVisible, becVisible])

  useEffect(() => { if (!becVisible) setBecReadout(null) }, [becVisible])

  useEffect(() => {
    if (!coordsVisible) { setCoordsReadout(null); return }
    const id = setInterval(() => {
      const { lat, lng } = cursorLatLngRef.current
      if (lat === null) return

      let bullseye = null
      const { hasBullseye, lat: bsLat, lng: bsLng } = bullseyeRef.current
      if (hasBullseye) {
        const { gridBearingDeg, rangeNm } = gridBearingRangeNm(bsLat, bsLng, lat, lng, theatreRef.current)
        const magBrg = toMagneticFromTrue(gridBearingDeg, declinationRef.current)
        bullseye = { bearing: Math.round(magBrg) || 360, range: Math.round(rangeNm) }
      }

      setCoordsReadout({ lat, lng, elevationM: elevRef.current, bullseye })

      const key = `${lat.toFixed(3)},${lng.toFixed(3)}`
      if (key !== lastElevFetchRef.current) {
        lastElevFetchRef.current = key
        fetch(`/api/elevation?lat=${lat}&lng=${lng}`)
          .then(r => r.ok ? r.json() : null)
          .then(data => { elevRef.current = data?.elevationM ?? null })
          .catch(() => {})
      }
    }, 150)
    return () => clearInterval(id)
  }, [coordsVisible])

  // ── Cursor-proximity unit readout (top-left) ────────────────────────────────
  // Lists every ground unit within READOUT_RADIUS_PX of the cursor, cross-
  // referenced against groundUnitDb. Reuses visibleGroundUnitsRef — the same
  // fog-of-war set drawAbmGroundContacts renders — so a unit only shows up
  // here if it's actually visible on the scope. On by default (.unitro
  // toggles it, 2026-08-02) — gates only the ground/air unit hit-gathering
  // below, not the airport readout, which is a separate concern that
  // happens to share the same box/interval. Gated on the same 150ms
  // interval so it doesn't re-render on every raw mousemove.
  const [unitReadoutVisible, setUnitReadoutVisible] = useState(abmPrefs.unitReadoutVisible)
  //
  // Airports/runways (2026-07-09) piggyback on the same interval and radius:
  // useRunwaysStore.centerlines emits two direction-entries per physical
  // strip (same rwyEnd1/rwyEnd2, opposite rwyName/reciprocal) — collapsed
  // below (airportStrips) back into one strip per physical runway, then
  // grouped by airbase so a hit anywhere on any of an airport's strips
  // surfaces every runway at that airport, not just the one under the
  // cursor. Gated on runwaysVisible||polygonsVisible (either toggle means
  // the airport is actually rendered on the scope) rather than on the
  // centerline draw specifically — at ABM's zoom levels a runway's physical
  // width is sub-pixel, so "near the centerline" already means "on the
  // pavement" whichever layer is the one actually visible.
  const airportStrips = useMemo(() => {
    const theatreIcao = (theatre && icaoMap[theatre.toLowerCase()]) || {}
    const stripMap = new Map()
    for (const c of runwayCenterlines) {
      if (!c.rwyEnd1 || !c.rwyEnd2) continue
      // centerlines' public shape (store/runways.js) doesn't carry rwyName
      // directly — only rawCenterlines (an internal intermediate) does — but
      // id is `${airbase}__${rwyName}`, so pull it back out from there.
      const rwyName = c.id.slice(c.airbase.length + 2)
      const key = `${c.airbase}|${c.rwyEnd1.lat.toFixed(6)},${c.rwyEnd1.lng.toFixed(6)}|${c.rwyEnd2.lat.toFixed(6)},${c.rwyEnd2.lng.toFixed(6)}`
      const existing = stripMap.get(key)
      if (existing) existing.names.push(rwyName)
      else stripMap.set(key, { airbase: c.airbase, rwyEnd1: c.rwyEnd1, rwyEnd2: c.rwyEnd2, names: [rwyName] })
    }
    const byAirbase = new Map()
    for (const strip of stripMap.values()) {
      const designator = strip.names.map(padRunwayName).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).join('/')
      if (!byAirbase.has(strip.airbase)) {
        byAirbase.set(strip.airbase, {
          airbase: strip.airbase, icao: theatreIcao[strip.airbase] ?? null, strips: [], designators: [],
        })
      }
      const entry = byAirbase.get(strip.airbase)
      entry.strips.push({ rwyEnd1: strip.rwyEnd1, rwyEnd2: strip.rwyEnd2 })
      entry.designators.push(designator)
    }
    return [...byAirbase.values()]
  }, [runwayCenterlines, icaoMap, theatre])
  const airportStripsRef = useRef(airportStrips)
  useEffect(() => { airportStripsRef.current = airportStrips }, [airportStrips])

  const [readoutHits, setReadoutHits] = useState([])
  useEffect(() => {
    const id = setInterval(() => {
      const v = viewRef.current
      const { x, y } = cursorCanvasPosRef.current
      if (!v || x === null) {
        setReadoutHits(prev => prev.length ? [] : prev)
        return
      }
      const hits = []
      if (unitReadoutVisible) {
        for (const [unitId, unit] of Object.entries(visibleGroundUnitsRef.current)) {
          if (!unit.position) continue
          const p = latLngToCanvas(unit.position.lat, unit.position.lng, v)
          if (Math.hypot(x - p.x, y - p.y) <= READOUT_RADIUS_PX) hits.push({ kind: 'ground', unitId, unit })
        }
        for (const [unitId, unit] of Object.entries(visibleUnitsRef.current)) {
          if (!unit.position) continue
          const p = latLngToCanvas(unit.position.lat, unit.position.lng, v)
          if (Math.hypot(x - p.x, y - p.y) <= READOUT_RADIUS_PX) hits.push({ kind: 'air', unitId, unit })
        }
      }

      if (runwaysVisible || polygonsVisible) {
        for (const airport of airportStripsRef.current) {
          const isHit = airport.strips.some((strip) => {
            const p1 = latLngToCanvas(strip.rwyEnd1.lat, strip.rwyEnd1.lng, v)
            const p2 = latLngToCanvas(strip.rwyEnd2.lat, strip.rwyEnd2.lng, v)
            return distToSegment(x, y, p1.x, p1.y, p2.x, p2.y) <= READOUT_RADIUS_PX
          })
          if (isHit) hits.push({ kind: 'airport', unitId: `airport-${airport.airbase}`, airport })
        }
      }

      setReadoutHits(hits)
    }, 150)
    return () => clearInterval(id)
  }, [runwaysVisible, polygonsVisible, unitReadoutVisible])

  // Collapse same-type ground hits (matched on unit.name, the groundUnitDb
  // key — e.g. three LAV-25s under the cursor) into one entry carrying a
  // count, so the readout/index line reflects the pre-collapse total while
  // the cycle itself only steps through distinct types. Airport hits are
  // already one-per-airbase (deduped in the hit test above) — distinct
  // airports are never "duplicates" of each other, so no count/xN applies.
  //
  // Air hits (2026-08-02) split by true coalition: friendly aircraft each
  // carry their own callsign/fuel/ammo, so they're never collapsed together
  // (one entry per unitId, count always 1). Non-friendly aircraft only ever
  // show a type-or-"UNKNOWN" line, so they collapse the same way ground
  // units do — grouped by whatever label will actually be displayed
  // (revealed type, or the shared "unknown" bucket) so two undetected
  // contacts of different real types still merge into one "UNKNOWN x2"
  // rather than leaking their (undisplayed) distinctness via separate lines.
  const groupedReadout = useMemo(() => {
    const groups = new Map()
    for (const hit of readoutHits) {
      if (hit.kind === 'airport') {
        groups.set(hit.unitId, { kind: 'airport', unitId: hit.unitId, airport: hit.airport, count: 1 })
        continue
      }
      if (hit.kind === 'air') {
        const isFriendly = hit.unit.coalition === myCoalitionNum
        if (isFriendly) {
          groups.set(`air:${hit.unitId}`, {
            kind: 'air', unitId: hit.unitId, unit: hit.unit, isFriendly: true, count: 1,
          })
          continue
        }
        const revealed  = rwrEverDetectedRef.current.has(String(hit.unitId))
        const typeLabel = revealed ? typeAbbrev(hit.unit) : null
        const key       = `air-unknown:${typeLabel ?? 'UNKNOWN'}`
        const existing  = groups.get(key)
        if (existing) existing.count++
        else groups.set(key, {
          kind: 'air', unitId: hit.unitId, unit: hit.unit, isFriendly: false, revealed, typeLabel, count: 1,
        })
        continue
      }
      const key = `ground:${hit.unit.name}`
      const existing = groups.get(key)
      if (existing) existing.count++
      else groups.set(key, { kind: 'ground', unitId: hit.unitId, unit: hit.unit, count: 1 })
    }
    // Airfields always lead the list — Array#sort is stable, so this only
    // reorders across kinds and leaves same-kind relative order untouched.
    return [...groups.values()].sort((a, b) => (a.kind === 'airport' ? 0 : 1) - (b.kind === 'airport' ? 0 : 1))
  }, [readoutHits, myCoalitionNum])

  // Readout is one object at a time: with only one (post-collapse) hit it's
  // shown steadily, with 2+ it cycles through them, one per READOUT_CYCLE_MS,
  // each fading in and back out over that whole phase (abm-readout-fade in
  // the CSS, timed to match).
  const [readoutIdx, setReadoutIdx] = useState(0)
  useEffect(() => {
    if (groupedReadout.length <= 1) { setReadoutIdx(0); return }
    const id = setInterval(() => {
      setReadoutIdx(i => (i + 1) % groupedReadout.length)
    }, READOUT_CYCLE_MS)
    return () => clearInterval(id)
  }, [groupedReadout.length])

  useEffect(() => {
    if (!theatre) return
    fetch(`/api/airports/polygons/${encodeURIComponent(theatre)}`)
      .then(r => r.ok ? r.json() : null)
      .then(geojson => setPolygonFeatures(geojson?.features ?? []))
      .catch(() => setPolygonFeatures([]))
  }, [theatre])

  useEffect(() => {
    if (!theatre) return
    fetch(`/towns/${encodeURIComponent(theatre)}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setTowns(data?.towns ?? []))
      .catch(() => setTowns([]))
  }, [theatre])

  useEffect(() => {
    if (!theatre) { setBasemap(null); setTerrain(null); setWater(null); setRoads(null); return }
    let cancelled = false
    const setters = { basemap: setBasemap, terrain: setTerrain, water: setWater, roads: setRoads }
    for (const [layer, setLayer] of Object.entries(setters)) {
      setLayer(null)
      fetch(`/api/abm/raster/${encodeURIComponent(theatre)}/${layer}`)
        .then(r => r.ok ? r.json() : null)
        .then(meta => {
          if (!meta || cancelled) return
          const img = new Image()
          img.onload = () => { if (!cancelled) setLayer({ ...meta, img }) }
          img.src = `/api/abm/raster/${encodeURIComponent(theatre)}/${layer}/image.png`
        })
        .catch(() => { if (!cancelled) setLayer(null) })
    }
    return () => { cancelled = true }
  }, [theatre])

  // Unlike STARS/AIC, ABM has no per-window persistence for this toggle, so
  // force geo on whenever the scope mounts rather than inheriting whatever
  // another module last left the shared store at.
  useEffect(() => { useGeoStore.getState().setVisible(true) }, [])

  useEffect(() => {
    if (!theatre) return
    useNavdataStore.getState().loadForTheatre(theatre)
    if (useRunwaysStore.getState().theatre !== theatre) useRunwaysStore.getState().loadForTheatre(theatre)
    useGeoStore.getState().loadForTheatre(theatre)
    useReliefStore.getState().loadForTheatre(theatre)
    useHoldingsStore.getState().loadForTheatre(theatre)
    useMoraStore.getState().loadForTheatre(theatre)
    useAirwaysStore.getState().loadForTheatre(theatre)
    // Flat, unbucketed load — see store/abmAirspace.js header for why ABM
    // doesn't reuse useMapsStore's STARS-only bucketing pipeline.
    useAbmAirspaceStore.getState().loadForTheatre(theatre)
  }, [theatre])

  const bullseyeEntry = useMemo(() => {
    if (!bullseyes?.bullseyes) return null
    const coalStr = coalition === 'red' ? 'red' : 'blue'
    return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
        ?? Object.values(bullseyes.bullseyes)[0]
        ?? null
  }, [bullseyes, coalition])

  // .be override — lets the operator relocate bullseye off the mission's
  // real one (fix, explicit lat/lon, or a map click). Not persisted: like
  // ringAnchor*, it's a mission-specific placement, not a saved preference.
  const [bullseyeOverride, setBullseyeOverride] = useState(null) // { lat, lng } | null

  const bullseyeLat = bullseyeOverride?.lat ?? bullseyeEntry?.latitude  ?? 0
  const bullseyeLng = bullseyeOverride?.lng ?? bullseyeEntry?.longitude ?? 0

  // Ref mirror for the .coords readout effect above, which is declared
  // earlier in the component (before bullseyeEntry/Lat/Lng exist) and would
  // hit a temporal-dead-zone error referencing them directly in its deps.
  const bullseyeRef = useRef({ hasBullseye: false, lat: 0, lng: 0 })
  useEffect(() => {
    bullseyeRef.current = { hasBullseye: !!(bullseyeOverride || bullseyeEntry), lat: bullseyeLat, lng: bullseyeLng }
  }, [bullseyeOverride, bullseyeEntry, bullseyeLat, bullseyeLng])

  // ── Window init — default center follows bullseye until the user pans.
  // Range rings default OFF; when enabled default to 20nm spacing anchored
  // on the bullseye (ringAnchor* null == bullseye). Datablocks default ON,
  // PTL defaults 1 minute, leader defaults length 2 / NE (dir 9, matching
  // ASDE-X's default -45° angle) — mirrors §"contacts" decisions 2026-07-05.
  useEffect(() => {
    if (windowSettings) return
    displayStore.initWindow(WINDOW_ID, {
      rangeNm: 150,
      ringsVisible: abmPrefs.ringsVisible, ringSpacingNm: abmPrefs.ringSpacingNm,
      ringAnchorLat: null, ringAnchorLng: null, ringAnchorId: null,
      centerLat: bullseyeLat, centerLng: bullseyeLng, centerOverridden: false,
      ptlMinutes: abmPrefs.ptlMinutes, dbVisible: abmPrefs.dbVisible, dbSuppress: abmPrefs.dbSuppress,
      ldrLength: abmPrefs.ldrLength, ldrAngleDeg: abmPrefs.ldrAngleDeg, leaderDirs: {},
      fadedSeconds: abmPrefs.fadedSeconds, threatRadius: abmPrefs.threatRadius,
      historyVisible: abmPrefs.historyVisible, historyLength: abmPrefs.historyLength,
      historyRate: abmPrefs.historyRate,
      dbca: abmPrefs.dbca,
    })
  }, []) // eslint-disable-line

  const centerOverridden = windowSettings?.centerOverridden ?? false
  const centerLat = centerOverridden ? (windowSettings?.centerLat ?? bullseyeLat) : bullseyeLat
  const centerLng = centerOverridden ? (windowSettings?.centerLng ?? bullseyeLng) : bullseyeLng

  const centerLatRef = useRef(centerLat)
  const centerLngRef = useRef(centerLng)
  useEffect(() => { centerLatRef.current = centerLat }, [centerLat])
  useEffect(() => { centerLngRef.current = centerLng }, [centerLng])

  // Magnetic-north-up projection — same computation AIC/STARS/CATCC use.
  // Was a hardcoded 0 through Phase 4; that was an accepted gap, not a
  // permanent design choice — see 2026-07-05.
  // Anchored to the bullseye rather than centerLat/centerLng: the latter
  // shifts on every pan, which recomputed declination per-frame and made the
  // whole picture visibly re-rotate while dragging — a fixed chart shouldn't
  // change orientation just because you scrolled it. The bullseye is a
  // stable, mission-defined point independent of pan/zoom (2026-07-07).
  // declinationDeg (IGRF) is the only correction applied — see utils/magvar.js:
  // DCS's own heading readouts don't apply grid convergence, so this app
  // doesn't add it either.
  const declinationDeg = computeMagvar(bullseyeLat, bullseyeLng, missionDate)
  const declinationRef = useRef(declinationDeg)
  useEffect(() => { declinationRef.current = declinationDeg }, [declinationDeg])

  // Grid-frame bearing math (gridBearingRangeNm) needs the theatre for its TM
  // lookup — same ref pattern as declinationRef, for the same reason (read
  // inside a useCallback/setInterval that would otherwise close over a stale
  // value).
  const theatreRef = useRef(theatre)
  useEffect(() => { theatreRef.current = theatre }, [theatre])

  const [view, setView] = useState(null)
  const viewRef = useRef(null)
  useEffect(() => { viewRef.current = view }, [view])

  const dragRef = useRef(null)

  // ── RBL (range/bearing line) — ported from AIC, left-click-drag (2026-07-07).
  // ABM's right-click is already taken by pan (unlike AIC, which has no pan
  // and uses right-click for nothing), so RBL uses AIC's actual mechanism —
  // left-button drag past a 5px threshold — same as AIC, not a new binding.
  const [rbl, setRbl] = useState(null)
  const leftDragStartRef  = useRef(null)
  const rblDragActiveRef  = useRef(false)

  // .find <fix> — ported from AIC (AicScope.jsx), same green-square marker.
  const [findMarker, setFindMarker] = useState(null)

  // FRAG BASE/waypoint click → requestFind (store/abmMission.js) — resolves
  // the ref into a lat/lon and drops it into the same findMarker the local
  // .find command above already draws. Keyed on findNonce (not findRequest
  // itself) so re-clicking the same row re-fires even though FRAG hands us
  // a fresh-but-equivalent ref object each time. A null ref is FRAG clicking
  // its own already-active row again (toggle-off — Frag.jsx passes
  // requestFind(null, null) in that case) and clears the marker; this only
  // ever fires on a real nonce bump, so it never stomps a marker set by the
  // local .find command below (that path calls the no-nonce-bump clearFind()
  // instead, purely to desync FRAG's row highlight).
  useEffect(() => {
    const ref = findRequest
    if (!ref) { setFindMarker(null); return }

    if (ref.type === 'point') {
      if (ref.lat != null && ref.lng != null) setFindMarker({ lat: ref.lat, lon: ref.lng, id: ref.id })
      return
    }
    if (ref.type === 'carrier') {
      const unit = Object.values(useUnitsStore.getState().units).find(u => u.unitID === ref.carrierUnitId)
      if (unit?.position) setFindMarker({ lat: unit.position.lat, lon: unit.position.lng, id: ref.carrierName })
      return
    }
    if (ref.type === 'airbase') {
      preloadAirdromes(ref.theatre).then((names) => {
        const name = names?.[String(ref.airdromeId)] ?? null
        const pos  = name ? airbaseCenterFromStrips(airportStripsRef.current, name) : null
        if (pos) setFindMarker({ lat: pos.lat, lon: pos.lng, id: name })
      })
    }
  }, [findNonce]) // eslint-disable-line

  const buildView = useCallback((w, h) => {
    const container = canvasAreaRef.current
    if (!container) return null
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    if (!ws) return null
    const rawW = w ?? container.clientWidth
    const rawH = h ?? container.clientHeight
    if (!rawW || !rawH) return null

    for (const ref of [mapRef, layersRef, compassRef, contactsRef]) {
      if (ref.current) {
        if (ref.current.width  !== rawW) ref.current.width  = rawW
        if (ref.current.height !== rawH) ref.current.height = rawH
      }
    }
    if (interactiveRef.current) {
      interactiveRef.current.style.width  = `${rawW}px`
      interactiveRef.current.style.height = `${rawH}px`
    }

    const rangeNm = ws.rangeNm ?? 150
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
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setView(buildView(width, height))
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [hasWindowSettings]) // eslint-disable-line

  useEffect(() => { setView(buildView()) }, [centerLat, centerLng, windowSettings?.rangeNm, declinationDeg]) // eslint-disable-line

  // ── Navdata layers draw (geo/relief/airspace/airways/mora/holdings) ─────────
  // Bottom canvas, under the rings/bullseye layer — same stacking AIC uses
  // (its mapCanvasRef sits under layersRef).
  useEffect(() => {
    if (!view || !mapRef.current) return
    const ctx = mapRef.current.getContext('2d')
    ctx.clearRect(0, 0, view.width, view.height)
    drawAbmRaster(ctx, view, basemap, basemapVisible)
    drawAbmRaster(ctx, view, terrain, terrainVisible)
    drawAbmRaster(ctx, view, water, waterVisible)
    drawAbmRaster(ctx, view, roads, roadsVisible)
    drawRelief(ctx, view, relief, reliefVisible, 40, airspaceColors)
    drawGeo(ctx, view, geoBoundaries, geoCoastlines, geoVisible, 50)
    drawAbmAirportPolygons(ctx, view, polygonFeatures, polygonsVisible)
    // Per-feature stroke, no edge de-dup — adjacent regions each draw their
    // own shared border. If dense theatres make that read as double/uneven
    // lines, pass `true` as a 6th arg here to de-dup (see drawAbmAirspace.js).
    drawAbmAirspace(ctx, view, airspaceFeatures, asVisible, 80, false, airspaceColors, labelsVisible,
      fillVisible ? fillPct : 0)
    drawAbmCustomDrawings(ctx, view, drawingLayers, airspaceColors?.CUSTOM ?? null, labelsVisible,
      fillVisible ? fillPct : 0)
    drawAirways(ctx, view, airways, airwaysVisible, 50)
    drawMora(ctx, view, mora, moraVisible, 50)
    drawHoldings(ctx, view, holdings, holdingsVisible, 50, 0)
    drawAbmFixSymbols(ctx, view, navaids, navaidsVisible, '#FFCC44', 60, labelsVisible)
    const pinnedFixIds = new Set(pinnedFixes[theatre] ?? [])
    const fixesToDraw  = fixesVisible ? fixes : fixes.filter(f => pinnedFixIds.has(f.id.toUpperCase()))
    drawAbmFixSymbols(ctx, view, fixesToDraw, fixesToDraw.length > 0, '#66CCFF', 60, labelsVisible)
    if (runwaysVisible && runwayCenterlines.length) {
      // drawRunways expects { id, end1, end2 }; the store's centerlines carry
      // the same points under rwyEnd1/rwyEnd2 (built for STARS's own draw path).
      const runwayMaps = runwayCenterlines.map(c => ({ id: c.id, end1: c.rwyEnd1, end2: c.rwyEnd2 }))
      const rwyVisible  = Object.fromEntries(runwayMaps.map(r => [r.id, true]))
      drawRunways(ctx, view, runwayMaps, rwyVisible, 80)
    }
    drawMgrsGrid(ctx, view, mgrsVisible, 60)
    drawAbmTowns(ctx, view, towns, townsVisible)
  }, [view, relief, reliefVisible, geoBoundaries, geoCoastlines, geoVisible,
      polygonFeatures, polygonsVisible,
      asVisible, airspaceFeatures, airspaceColors, labelsVisible, fillVisible, fillPct, drawingLayers, airways, airwaysVisible, mora, moraVisible,
      holdings, holdingsVisible, navaids, navaidsVisible, fixes, fixesVisible, pinnedFixes, theatre,
      runwaysVisible, runwayCenterlines, mgrsVisible, towns, townsVisible,
      basemap, basemapVisible, terrain, terrainVisible, water, waterVisible, roads, roadsVisible])

  // ── Range rings + bullseye marker ───────────────────────────────────────────
  const ringAnchorLat = windowSettings?.ringAnchorLat ?? bullseyeLat
  const ringAnchorLng = windowSettings?.ringAnchorLng ?? bullseyeLng
  const ringAnchorId  = windowSettings?.ringAnchorId  ?? null

  useEffect(() => {
    if (!view || !layersRef.current) return
    const ctx = layersRef.current.getContext('2d')
    drawAbmLayers(
      ctx, view,
      windowSettings?.ringsVisible ? (windowSettings?.ringSpacingNm ?? 20) : 0,
      ringAnchorLat, ringAnchorLng, ringAnchorId,
      bullseyeLat, bullseyeLng,
    )
  }, [view, windowSettings?.ringsVisible, windowSettings?.ringSpacingNm, ringAnchorLat, ringAnchorLng, ringAnchorId, bullseyeLat, bullseyeLng])

  // ── Compass rose — CATCC's fontScale (0.625), not STARS's default (1) ──────
  // ABM's view is the densest of any scope (contacts+sectors+flights all at
  // once), so the smaller CATCC variant reads better than STARS's larger one.
  // Shared draw function (client/src/modules/atc/stars/canvas/drawCompassRose.js)
  // — no ABM-specific copy needed, just CATCC's parameter choice.
  useEffect(() => {
    if (!view || !compassRef.current) return
    drawCompassRose(compassRef.current.getContext('2d'), view, 70, 3, 0.625)
  }, [view])

  // .line/.rect/.circ/.poly/.sect/.race/.text click-driven drawing —
  // pendingDraw is null when no draw command is armed; see
  // modules/abm/draw/drawCommands.js for the per-shape state shape/arity.
  // drawCursor tracks the live mouse position (map lat/lng) only while a
  // draw command is pending, driving the preview redraw the same way RBL's
  // `rbl.end` already does. Declared here (ahead of the contactsRef draw
  // effect below, which reads both) rather than down by cmdBuffer/
  // cmdFeedback where the rest of the command-line state lives, since a
  // useEffect's dependency array is evaluated during this render pass and a
  // `const` referenced before its own declaration line throws (TDZ), even
  // though the effect body itself only runs after render.
  const [pendingDraw, setPendingDraw] = useState(null)
  const [drawCursor,  setDrawCursor]  = useState(null)

  // .clear — bare/click form arms pendingClearClick (one-shot: the next
  // click hit-tests via hitTestDrawingLayer and removes whatever it finds,
  // then disarms regardless of a hit). .clear all arms
  // pendingClearAllConfirm instead, which execCommand intercepts at the top
  // on the NEXT submitted line as a bare yes/no answer (not a new command).
  const [pendingClearClick, setPendingClearClick] = useState(false)
  const [pendingClearAllConfirm, setPendingClearAllConfirm] = useState(false)

  useEffect(() => {
    if (!pendingDraw) { setDrawCursor(null); return }
    const onMove = (e) => {
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setDrawCursor(canvasToLatLng(x, y, viewRef.current))
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [pendingDraw])

  // ── Air contacts (top canvas) ────────────────────────────────────────────────
  // Draw order (bottom to top, matching AIC's drawAicContacts): threat rings,
  // then BRAA overlay lines, then air contacts, then ground/naval contacts.
  useEffect(() => {
    if (!view || !contactsRef.current) return
    const ctx = contactsRef.current.getContext('2d')
    const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
    ctx.clearRect(0, 0, view.width, view.height)

    const mergedThreatRings = autoThreatRingIds.size
      ? new Set([...threatRings, ...autoThreatRingIds])
      : threatRings
    drawThreatRings(ctx, view, allVisibleUnits, mergedThreatRings, threatRadius, getDecl)
    drawBraaOverlays(ctx, view, braaList, allVisibleUnits, view.declinationDeg)

    drawAbmContacts(
      ctx, view, visibleUnits, getDecl,
      windowSettings?.ptlMinutes ?? 1,
      windowSettings?.dbVisible ?? true,
      altToggle,
      windowSettings?.ldrLength ?? 2,
      windowSettings?.ldrAngleDeg ?? -45,
      windowSettings?.leaderDirs ?? {},
      historyRef.current,
      (windowSettings?.historyVisible ?? true) ? Math.min(MAX_HISTORY, windowSettings?.historyLength ?? 4) : 0,
      fadedRef.current, Date.now(),
      windowSettings?.dbSuppress ?? true,
      myCoalitionNum,
      rwrEverDetectedRef.current,
      windowSettings?.dbca ?? false,
      dbHiddenIds,
      highlightedIds,
      blinkIdSet,
      blinkOn,
    )
    drawAbmGroundContacts(ctx, view, pinnedGroundUnits, getDecl, groundUnitDb, acqHidden, engHidden, highlightedIds)

    // Selected FRAG flight's route, if any.
    drawAbmFragRoute(ctx, view, selectedRoute)

    // RBL on top of everything — same layering AIC uses.
    drawRbl(ctx, view, rbl, view.declinationDeg)

    // .find marker — small green square, same symbol AIC uses (drawAicContacts.js).
    if (findMarker) {
      const { x, y } = latLngToCanvas(findMarker.lat, findMarker.lon, view)
      ctx.fillStyle = '#00e000'
      ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8)
    }

    // In-progress .line/.rect/.circ/.poly/.sect/.race/.text preview — on top
    // of everything, same as RBL.
    drawPendingDraw(ctx, view, pendingDraw, drawCursor)
  }, [view, visibleUnits, pinnedGroundUnits, allVisibleUnits, groundUnitDb, declarations, myCoalitionNum, getEffectiveDeclaration, altToggle,
      windowSettings?.ptlMinutes, windowSettings?.dbVisible, windowSettings?.dbSuppress,
      windowSettings?.ldrLength, windowSettings?.ldrAngleDeg, windowSettings?.leaderDirs, fadedTick,
      windowSettings?.historyVisible, windowSettings?.historyLength, windowSettings?.dbca,
      threatRings, autoThreatRingIds, threatRadius, braaList, rbl, acqHidden, engHidden, findMarker, dbHiddenIds, highlightedIds, selectedRoute,
      blinkIdSet, blinkOn, blinkTick, pendingDraw, drawCursor])

  // ── Pan (right-click drag) / RBL start (left-click drag) ────────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button === 2) {
      dragRef.current = {
        startX: e.clientX, startY: e.clientY,
        startLat: centerLatRef.current, startLng: centerLngRef.current,
      }
      return
    }
    // Middle mouse — suppress the browser's autoscroll/paste behaviour so
    // mouseup's highlight toggle (below) is the only effect.
    if (e.button === 1) e.preventDefault()
    if (e.button === 0) {
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
      leftDragStartRef.current = { clientX: e.clientX, clientY: e.clientY, lat, lng }
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (!dragRef.current || !viewRef.current) return
    const v  = viewRef.current
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    const pxPerNm = v.pixelsPerNm
    const nmPerDegLng = 60 * Math.cos(dragRef.current.startLat * Math.PI / 180)
    centerLatRef.current = dragRef.current.startLat + dy / pxPerNm / 60
    centerLngRef.current = dragRef.current.startLng - dx / pxPerNm / nmPerDegLng

    const container = canvasAreaRef.current
    if (!container) return
    const nextView = {
      centerLat:   centerLatRef.current,
      centerLng:   centerLngRef.current,
      rangeNm:     v.rangeNm,
      pixelsPerNm: pxPerNm,
      width: container.clientWidth, height: container.clientHeight,
      declinationDeg: v.declinationDeg ?? 0,
      theatre: v.theatre,
    }
    viewRef.current = nextView
    setView(nextView)
  }, [])

  const handlePanMouseUp = useCallback((e) => {
    if (e.button !== 2 || !dragRef.current) return
    displayStore.updateWindow(WINDOW_ID, {
      centerLat: centerLatRef.current,
      centerLng: centerLngRef.current,
      centerOverridden: true,
    })
    dragRef.current = null
  }, [displayStore])

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup',   handlePanMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup',   handlePanMouseUp)
    }
  }, [handleMouseMove, handlePanMouseUp])

  // ── RBL drag — ported from AIC exactly: arms only once movement clears a
  // 5px threshold (so plain left-clicks used for declare/BRAA/dope/threat
  // don't touch the RBL), tracks the cursor while dragging, fixes the line
  // on mouseup. The element-level mouseup dispatch (below) checks
  // rblDragActiveRef *before* this window listener resets it — same bubble
  // ordering AIC relies on (target listeners fire before window listeners).
  useEffect(() => {
    const onMove = (e) => {
      const start = leftDragStartRef.current
      if (!start) return
      if (!rblDragActiveRef.current) {
        const dist = Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY)
        if (dist <= 5) return
        rblDragActiveRef.current = true
        setRbl({ anchor: { lat: start.lat, lng: start.lng }, end: null, fixed: false })
      }
      const rect = interactiveRef.current?.getBoundingClientRect()
      if (!rect || !viewRef.current) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const { lat, lng } = canvasToLatLng(x, y, viewRef.current)
      setRbl(prev => prev ? { ...prev, end: { lat, lng } } : null)
    }
    const onUp = (e) => {
      if (e.button !== 0) return
      const wasActive = rblDragActiveRef.current
      leftDragStartRef.current = null
      rblDragActiveRef.current = false
      if (!wasActive) return
      setRbl(prev => prev?.end ? { ...prev, fixed: true } : null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

  // ── Scroll zoom ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = interactiveRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      // While a .rect/.poly/.race/.text draw command is pending, the scroll
      // wheel rotates the shape (whole-degree steps, locked to the MAGNETIC
      // heading lattice — see ROTATION_STEP_DEG) instead of zooming.
      if (pendingDraw && supportsRotation(pendingDraw.type)) {
        const declinationDeg = viewRef.current?.declinationDeg ?? 0
        setPendingDraw(pd => pd && rotatePendingDraw(pd, e.deltaY < 0 ? 1 : -1, declinationDeg))
        return
      }
      const ws = useDisplayStore.getState().windows[WINDOW_ID]
      if (!ws) return
      const dir     = e.deltaY < 0 ? 1 : -1
      const current = ws.rangeNm ?? 150
      // Fine 1NM steps once inside 10NM — the normal 10/25NM steps are too
      // coarse to be useful down at the RANGE_MIN=1 end of the range.
      const step    = current <= 10 ? 1 : (e.ctrlKey ? 25 : 10)
      const next    = Math.max(RANGE_MIN, Math.min(RANGE_MAX, current - dir * step))
      displayStore.updateWindow(WINDOW_ID, { rangeNm: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [!!windowSettings, displayStore, pendingDraw]) // eslint-disable-line

  // ── Command preview area (bottom-left, same pattern as AIC) ─────────────────
  const [cmdBuffer,   setCmdBuffer]   = useState('')
  const [cmdFeedback, setCmdFeedback] = useState('')
  // .define readout — kept separate from cmdFeedback (see AbmScope.css) since
  // cmdFeedback gets overwritten by every incidental click/command ack and a
  // brevity definition is meant to be read, not flashed. Dismissed only by
  // Escape, another .define, or clicking the readout itself.
  const [defineEntry, setDefineEntry] = useState(null) // { term, text }
  const [cmdHistory,  setCmdHistory]  = useState([])
  const cmdHistoryRef = useRef([])

  useEffect(() => { cmdHistoryRef.current = cmdHistory }, [cmdHistory])
  const [cmdHistoryIdx, setCmdHistoryIdx] = useState(-1)
  const cmdHistoryIdxRef = useRef(-1)
  useEffect(() => { cmdHistoryIdxRef.current = cmdHistoryIdx }, [cmdHistoryIdx])
  const cmdDraftRef = useRef('')

  // .be + click — armed live (before Enter) the moment cmdBuffer is exactly
  // ".be", same live-parse pattern AIC uses for .sector. Ref mirror so
  // handleMouseUp (a stable useCallback) can read it without re-binding.
  const pendingBe = cmdBuffer.trim().toLowerCase() === '.be'
  const pendingBeRef = useRef(false)
  useEffect(() => { pendingBeRef.current = pendingBe }, [pendingBe])

  function clearCmd() { setCmdBuffer(''); setCmdFeedback('') }

  async function execCommand(raw) {
    const str = raw.trim().toLowerCase()

    // .clear all's confirmation — intercepts the very next submitted line
    // as a bare yes/no answer, not a new command, however it's routed.
    if (pendingClearAllConfirm) {
      setPendingClearAllConfirm(false)
      if (str === 'y') {
        clearAllDrawings(theatre)
        setCmdFeedback('ALL DRAWINGS CLEARED')
      } else {
        setCmdFeedback('CLEAR ALL CANCELLED')
      }
      return
    }

    if (str === '.rr') {
      const on = !(windowSettings?.ringsVisible ?? false)
      displayStore.updateWindow(WINDOW_ID, { ringsVisible: on })
      saveAbmPrefs({ ringsVisible: on })
      setCmdFeedback(on ? `RANGE RINGS ${windowSettings?.ringSpacingNm ?? 20}NM` : 'RANGE RINGS OFF')
      return
    }

    const spacingOnly = str.match(/^\.rr\s+(\d+(?:\.\d+)?)$/)
    if (spacingOnly) {
      const nm = parseFloat(spacingOnly[1])
      if (nm <= 0) {
        displayStore.updateWindow(WINDOW_ID, { ringsVisible: false })
        saveAbmPrefs({ ringsVisible: false })
        setCmdFeedback('RANGE RINGS OFF')
      } else {
        displayStore.updateWindow(WINDOW_ID, { ringsVisible: true, ringSpacingNm: nm })
        saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
        setCmdFeedback(`RANGE RINGS ${nm}NM`)
      }
      return
    }

    const spacingAndAnchor = str.match(/^\.rr\s+(\d+(?:\.\d+)?)\s+(\S+)$/)
    if (spacingAndAnchor) {
      const nm     = parseFloat(spacingAndAnchor[1])
      const anchor = spacingAndAnchor[2]
      if (nm <= 0) {
        displayStore.updateWindow(WINDOW_ID, { ringsVisible: false })
        saveAbmPrefs({ ringsVisible: false })
        setCmdFeedback('RANGE RINGS OFF')
        return
      }
      if (anchor === 'bullseye' || anchor === 'bs') {
        displayStore.updateWindow(WINDOW_ID, {
          ringsVisible: true, ringSpacingNm: nm,
          ringAnchorLat: null, ringAnchorLng: null, ringAnchorId: null,
        })
        saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
        setCmdFeedback(`RANGE RINGS ${nm}NM @ BULLSEYE`)
        return
      }
      const result = useNavdataStore.getState().lookupFix(anchor)
      if (result) {
        displayStore.updateWindow(WINDOW_ID, {
          ringsVisible: true, ringSpacingNm: nm,
          ringAnchorLat: result.lat, ringAnchorLng: result.lon, ringAnchorId: result.id,
        })
        // Anchor lat/lng/id intentionally excluded — mission-specific fix,
        // not a persisted preference (see store/abmPrefs.js header).
        saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
        setCmdFeedback(`RANGE RINGS ${nm}NM @ ${result.id}`)
      } else {
        setCmdFeedback('FIX NOT FOUND')
      }
      return
    }

    // .be — bullseye override. Bare form (Enter, no click) clears the
    // override and reverts to the mission bullseye; typed bare and then
    // clicked instead (see pendingBe/handleMouseUp), it places the override
    // at the clicked point. `.be <fix>` looks up a theatre fix/navaid/runway
    // by name; `.be <lat> <lon>` takes explicit decimal-degree coordinates.
    if (str === '.be') {
      setBullseyeOverride(null)
      setCmdFeedback('BULLSEYE RESET')
      return
    }

    const beCoords = str.match(/^\.be\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)$/)
    if (beCoords) {
      const lat = parseFloat(beCoords[1])
      const lng = parseFloat(beCoords[2])
      setBullseyeOverride({ lat, lng })
      setCmdFeedback(`BULLSEYE SET ${lat.toFixed(2)}/${lng.toFixed(2)}`)
      return
    }

    const beFix = str.match(/^\.be\s+(\S+)$/)
    if (beFix) {
      const result = useNavdataStore.getState().lookupFix(beFix[1])
      if (result) {
        setBullseyeOverride({ lat: result.lat, lng: result.lon })
        setCmdFeedback(`BULLSEYE SET @ ${result.id}`)
      } else {
        setCmdFeedback('FIX NOT FOUND')
      }
      return
    }

    // ── Navdata layer toggles (§4.2) ──────────────────────────────────────────
    if (str === '.time') {
      const next = !clockVisible
      setClockVisible(next)
      saveAbmPrefs({ timeVisible: next })
      setCmdFeedback(next ? 'TIME ON' : 'TIME OFF')
      return
    }

    if (str === '.unitro') {
      const next = !unitReadoutVisible
      setUnitReadoutVisible(next)
      saveAbmPrefs({ unitReadoutVisible: next })
      setCmdFeedback(next ? 'UNIT READOUT ON' : 'UNIT READOUT OFF')
      return
    }

    if (str === '.geo') {
      useGeoStore.getState().toggleVisible()
      setCmdFeedback(useGeoStore.getState().visible ? 'GEO ON' : 'GEO OFF')
      return
    }

    if (str === '.relief') {
      useReliefStore.getState().toggleVisible()
      setCmdFeedback(useReliefStore.getState().visible ? 'RELIEF ON' : 'RELIEF OFF')
      return
    }

    if (str === '.holds') {
      useHoldingsStore.getState().toggleVisible()
      setCmdFeedback(useHoldingsStore.getState().visible ? 'HOLDS ON' : 'HOLDS OFF')
      return
    }

    if (str === '.mora') {
      useMoraStore.getState().toggleVisible()
      setCmdFeedback(useMoraStore.getState().visible ? 'MORA ON' : 'MORA OFF')
      return
    }

    if (str === '.airways') {
      const v = useAirwaysStore.getState().visible
      const anyOn = v.V || v.J || v.B
      useAirwaysStore.getState().setVisible({ V: !anyOn, J: !anyOn, B: !anyOn })
      setCmdFeedback(anyOn ? 'AIRWAYS OFF' : 'AIRWAYS ON')
      return
    }

    const airwayType = str.match(/^\.airways\s+([vjb])$/)
    if (airwayType) {
      const type = airwayType[1].toUpperCase()
      useAirwaysStore.getState().toggleVisible(type)
      setCmdFeedback(`AIRWAYS ${type} ${useAirwaysStore.getState().visible[type] ? 'ON' : 'OFF'}`)
      return
    }

    // .asp — bulk toggle (was .airspace, 2026-07-08): on if any category is
    // currently visible, off otherwise, same anyOn pattern as .airways.
    if (str === '.asp') {
      const anyOn = AIRSPACE_CATEGORIES.some(c => asVisible[c])
      const next  = anyOn ? {} : Object.fromEntries(AIRSPACE_CATEGORIES.map(c => [c, true]))
      setAsVisible(next)
      saveAbmPrefs({ asVisible: next })
      setCmdFeedback(anyOn ? 'AIRSPACE OFF' : 'AIRSPACE ON')
      return
    }

    // Per-category airspace toggles (2026-07-08) — .tma/.ctr/.cta/.fir/.uir/
    // .sua/.mil/.trsa/.classa-.classg. No procedure commands (SID/STAR/APPCH
    // stay display-only, per direction).
    const airspaceCatMatch = str.match(/^\.(tma|ctr|cta|fir|uir|sua|mil|trsa|class[a-g])$/)
    if (airspaceCatMatch) {
      const cat  = AIRSPACE_CMD_CATEGORY[airspaceCatMatch[1]]
      const next = !asVisible[cat]
      setAsVisible(s => {
        const merged = { ...s, [cat]: next }
        saveAbmPrefs({ asVisible: merged })
        return merged
      })
      setCmdFeedback(`${cat} ${next ? 'ON' : 'OFF'}`)
      return
    }

    // .aspcolors <name> / .refresh — same commands STARS uses for airspace
    // palettes (input/commandParser.js SET_ASP_COLORS/REFRESH_ASP_COLORS),
    // reimplemented against useAbmAirspaceStore's own palette state rather
    // than useMapsStore's, which is STARS-only (see store/abmAirspace.js).
    if (str.startsWith('.aspcolors ')) {
      const name = str.slice('.aspcolors '.length).trim().toUpperCase()
      await useAbmAirspaceStore.getState().refreshPalettes()
      const palettes = useAbmAirspaceStore.getState().palettes
      const idx = palettes.findIndex(p => p.name.toUpperCase() === name)
      if (idx < 0) { setCmdFeedback('INVALID PALETTE'); return }
      setPaletteIdx(idx)
      saveAbmPrefs({ aspColorIdx: idx })
      setCmdFeedback(`ASP COLORS: ${palettes[idx].name.toUpperCase()}`)
      return
    }

    if (str === '.refresh') {
      const success = await useAbmAirspaceStore.getState().refreshPalettes()
      setCmdFeedback(success ? 'PALETTES REFRESHED' : 'REFRESH FAILED')
      return
    }

    // .labels/.lbl/.label — name-label toggle for both airspace and
    // custom-drawing layers. Airspace labels are drawn only for categories
    // currently on via asVisible (.tma/.classc/etc); custom-drawing labels
    // only for features that have one (parseGeojson's title/name
    // convention). Either way this is purely a "show text too" layer on top
    // of the geometry.
    if (str === '.labels' || str === '.lbl' || str === '.label') {
      const next = !labelsVisible
      setLabelsVisible(next)
      saveAbmPrefs({ labelsVisible: next })
      setCmdFeedback(next ? 'LABELS ON' : 'LABELS OFF')
      return
    }

    // .fill — toggle airspace polygon fill, remembering the last percentage
    // used. .fill <1-100> — set percentage and always turn it on.
    if (str === '.fill') {
      const next = !fillVisible
      setFillVisible(next)
      saveAbmPrefs({ fillVisible: next })
      setCmdFeedback(next ? 'FILL ON' : 'FILL OFF')
      return
    }

    const fillPctMatch = str.match(/^\.fill (\d{1,3})$/)
    if (fillPctMatch) {
      const pct = parseInt(fillPctMatch[1], 10)
      if (pct < 1 || pct > 100) { setCmdFeedback('ILL VAL'); return }
      setFillVisible(true)
      setFillPct(pct)
      saveAbmPrefs({ fillVisible: true, fillPct: pct })
      setCmdFeedback(`FILL ${pct}%`)
      return
    }

    // .custom/.cust — interchangeable: bare form is a bulk toggle for
    // user-imported GeoJSON drawings (store/abmDrawings.js), same any-on
    // pattern as .asp. `.custom <name>`/`.cust <name>` instead toggles just
    // the drawing(s) matching that name (case-insensitive, could be more
    // than one after manual renames — all matched layers toggle together,
    // same any-on pattern). Individual drawings can otherwise be toggled
    // from the Drawings panel's per-row checkbox.
    if (str === '.custom' || str === '.cust') {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const anyOn = drawingLayers.some(l => l.visible)
      toggleAllDrawings(theatre)
      setCmdFeedback(anyOn ? 'CUSTOM OFF' : 'CUSTOM ON')
      return
    }
    if (str.startsWith('.custom ') || str.startsWith('.cust ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const arg = drawCmdTokens(str, raw).join(' ').trim()
      const matches = drawingLayers.filter(l => l.name.toUpperCase() === arg.toUpperCase())
      if (!matches.length) { setCmdFeedback('NOT FOUND'); return }
      const anyOn = matches.some(l => l.visible)
      toggleDrawingsByName(theatre, arg)
      setCmdFeedback(`${arg.toUpperCase()} ${anyOn ? 'OFF' : 'ON'}`)
      return
    }

    // ── Draw commands ─────────────────────────────────────────────────────
    // .line/.rect/.circ/.poly/.sect/.race/.text — fully-typed args commit
    // immediately (addDrawnShape, store/abmDrawings.js); anything left
    // unresolved arms pendingDraw and waits for click(s). See
    // modules/abm/draw/drawCommands.js for the per-shape grammar/arity.
    if (str === '.line' || str.startsWith('.line ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('line', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      if (result.immediate) {
        addDrawnShape(theatre, 'line', result.immediate)
        setCmdFeedback('LINE DRAWN')
      } else {
        setPendingDraw(result.pending)
        setCmdFeedback('LINE: CLICK TO PLACE')
      }
      return
    }

    if (str === '.rect' || str.startsWith('.rect ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('rect', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      setPendingDraw(result.pending)
      setCmdFeedback('RECT: CLICK TO PLACE')
      return
    }

    if (str === '.circ' || str.startsWith('.circ ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('circ', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      if (result.immediate) {
        addDrawnShape(theatre, 'circ', result.immediate)
        setCmdFeedback('CIRCLE DRAWN')
      } else {
        setPendingDraw(result.pending)
        setCmdFeedback('CIRC: CLICK TO PLACE')
      }
      return
    }

    if (str === '.poly' || str.startsWith('.poly ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('poly', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      if (result.immediate) {
        addDrawnShape(theatre, 'poly', result.immediate)
        setCmdFeedback('POLY DRAWN')
      } else {
        setPendingDraw(result.pending)
        setCmdFeedback('POLY: CLICK VERTICES, CLICK NEAR START TO CLOSE')
      }
      return
    }

    if (str === '.sect' || str.startsWith('.sect ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('sect', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      if (result.immediate) {
        // .sect <id> <brg1> <brg2>...<brgN> <radius> draws N-1 adjoining
        // sectors sharing that radius — result.immediate is an array here
        // (every other command's `immediate` is a single params object).
        for (const sector of result.immediate) addDrawnShape(theatre, 'sect', sector)
        setCmdFeedback(result.immediate.length > 1 ? `${result.immediate.length} SECTORS DRAWN` : 'SECTOR DRAWN')
      } else {
        setPendingDraw(result.pending)
        setCmdFeedback('SECT: CLICK TO PLACE')
      }
      return
    }

    if (str === '.race' || str.startsWith('.race ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('race', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      if (result.immediate) {
        addDrawnShape(theatre, 'race', result.immediate)
        setCmdFeedback('RACETRACK DRAWN')
      } else {
        setPendingDraw(result.pending)
        setCmdFeedback('RACE: CLICK TO PLACE')
      }
      return
    }

    if (str === '.text' || str.startsWith('.text ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const result = parseDrawCommand('text', drawCmdTokens(str, raw), useNavdataStore.getState().lookupFix, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.error) { setCmdFeedback(result.error); return }
      setPendingDraw(result.pending)
      setCmdFeedback('TEXT: CLICK TO PLACE')
      return
    }

    // .clear — bare/click removes whatever's hit-tested at the click point
    // (handleMouseUp); .clear <name> removes every same-named drawing
    // (case-insensitive, could be more than one after manual renames);
    // .clear all confirms via the pendingClearAllConfirm intercept above.
    if (str === '.clear' || str.startsWith('.clear ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const arg = drawCmdTokens(str, raw).join(' ').trim()
      if (!arg) {
        setPendingDraw(null)
        setPendingClearClick(true)
        setCmdFeedback('CLEAR: CLICK A DRAWING')
        return
      }
      if (arg.toLowerCase() === 'all') {
        if (!drawingLayers.length) { setCmdFeedback('NOTHING TO CLEAR'); return }
        setPendingClearAllConfirm(true)
        setCmdFeedback(`CLEAR ALL ${drawingLayers.length} DRAWINGS? Y TO CONFIRM`)
        return
      }
      const matches = drawingLayers.filter(l => l.name.toUpperCase() === arg.toUpperCase())
      if (!matches.length) { setCmdFeedback('NOT FOUND'); return }
      removeDrawingsByName(theatre, arg)
      setCmdFeedback(matches.length > 1 ? `CLEARED ${matches.length} ${arg.toUpperCase()}` : `CLEARED ${matches[0].name}`)
      return
    }

    if (str === '.fixes') {
      const next = !fixesVisible
      setFixesVisible(next)
      saveAbmPrefs({ fixesVisible: next })
      setCmdFeedback(next ? 'FIXES ON' : 'FIXES OFF')
      return
    }

    if (str === '.navaids') {
      const next = !navaidsVisible
      setNavaidsVisible(next)
      saveAbmPrefs({ navaidsVisible: next })
      setCmdFeedback(next ? 'NAVAIDS ON' : 'NAVAIDS OFF')
      return
    }

    // .fix — with no argument, clears all pinned fixes for this theatre.
    if (str === '.fix') {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const merged = { ...pinnedFixes, [theatre]: [] }
      setPinnedFixes(merged)
      saveAbmPrefs({ pinnedFixes: merged })
      setCmdFeedback('FIX CLEARED')
      return
    }

    // .fix <name...> — force-show one or more fixes regardless of .fixes
    // visibility. Each name toggles independently (repeat to un-pin);
    // persisted per-theatre so pins survive a reload.
    if (str.startsWith('.fix ')) {
      if (!theatre) { setCmdFeedback('NO THEATRE'); return }
      const names = drawCmdTokens(str, raw).map(n => n.toUpperCase()).filter(Boolean)
      if (!names.length) { setCmdFeedback('ILL VAL'); return }
      // Pinning only affects rendering of the `fixes` layer (see the
      // drawAbmFixSymbols call below), so validate against that list rather
      // than lookupFix's broader fix/navaid/runway/airport search — a name
      // that resolves elsewhere would never actually draw as pinned.
      const knownIds = new Set(fixes.map(f => f.id.toUpperCase()))
      const notFound = names.filter(n => !knownIds.has(n))
      if (notFound.length) { setCmdFeedback(`${notFound.join(' ')} NOT FOUND`); return }
      const current = new Set(pinnedFixes[theatre] ?? [])
      for (const name of names) {
        if (current.has(name)) current.delete(name)
        else current.add(name)
      }
      const merged = { ...pinnedFixes, [theatre]: [...current] }
      setPinnedFixes(merged)
      saveAbmPrefs({ pinnedFixes: merged })
      setCmdFeedback(`FIX ${names.join(' ')}`)
      return
    }

    // .find <fix> — ported from AIC (AicScope.jsx): drops a green square
    // marker at the looked-up fix/navaid, cleared by Escape or another .find.
    if (str.startsWith('.find ')) {
      const result = useNavdataStore.getState().lookupFix(str.slice(6).trim())
      if (result) {
        setFindMarker(result)
        useAbmMissionStore.getState().clearFind() // this find isn't tied to a FRAG row
        setCmdFeedback(`FIND ${result.id}`)
      } else {
        setCmdFeedback('NOT FOUND')
      }
      return
    }

    // .define <term> — tactical brevity glossary lookup (ATP 1-02.1, see
    // store/brevity.js). Shown in its own readout, not cmdFeedback, so it
    // doesn't disappear the instant the next incidental click fires.
    if (str.startsWith('.define ')) {
      const result = useBrevityStore.getState().lookup(str.slice(8).trim())
      if (result) { setDefineEntry(result); setCmdFeedback('') }
      else { setDefineEntry(null); setCmdFeedback('NOT FOUND') }
      return
    }

    if (str === '.runways') {
      const next = !runwaysVisible
      setRunwaysVisible(next)
      saveAbmPrefs({ runwaysVisible: next })
      setCmdFeedback(next ? 'RUNWAYS ON' : 'RUNWAYS OFF')
      return
    }

    if (str === '.polygons') {
      const next = !polygonsVisible
      setPolygonsVisible(next)
      saveAbmPrefs({ polygonsVisible: next })
      setCmdFeedback(next ? 'POLYGONS ON' : 'POLYGONS OFF')
      return
    }

    if (str === '.mgrs') {
      const next = !mgrsVisible
      setMgrsVisible(next)
      saveAbmPrefs({ mgrsVisible: next })
      setCmdFeedback(next ? 'MGRS GRID ON' : 'MGRS GRID OFF')
      return
    }

    if (str === '.towns') {
      const next = !townsVisible
      setTownsVisible(next)
      saveAbmPrefs({ townsVisible: next })
      setCmdFeedback(next ? 'TOWNS ON' : 'TOWNS OFF')
      return
    }

    if (str === '.base') {
      const next = !basemapVisible
      setBasemapVisible(next)
      saveAbmPrefs({ basemapVisible: next })
      setCmdFeedback(next ? 'BASE ON' : 'BASE OFF')
      return
    }

    if (str === '.terrain') {
      const next = !terrainVisible
      setTerrainVisible(next)
      saveAbmPrefs({ terrainVisible: next })
      setCmdFeedback(next ? 'TERRAIN ON' : 'TERRAIN OFF')
      return
    }

    // .map — bulk toggle for all four raster layers (base/terrain/water/
    // roads) plus .geo's live coastline/boundary layer, same any-on pattern
    // as .asp: on if any is currently visible, off otherwise. .geo is
    // included because terrain.png no longer bakes coastlines/boundaries
    // into the raster (2026-08-11) — .geo is now the only source of that
    // linework in ABM, so a bulk "hide the map" should hide it too.
    if (str === '.map') {
      const anyOn = basemapVisible || terrainVisible || waterVisible || roadsVisible || geoVisible
      const next  = !anyOn
      setBasemapVisible(next)
      setTerrainVisible(next)
      setWaterVisible(next)
      setRoadsVisible(next)
      useGeoStore.getState().setVisible(next)
      saveAbmPrefs({ basemapVisible: next, terrainVisible: next, waterVisible: next, roadsVisible: next })
      setCmdFeedback(next ? 'MAP ON' : 'MAP OFF')
      return
    }

    if (str === '.water') {
      const next = !waterVisible
      setWaterVisible(next)
      saveAbmPrefs({ waterVisible: next })
      setCmdFeedback(next ? 'WATER ON' : 'WATER OFF')
      return
    }

    if (str === '.roads') {
      const next = !roadsVisible
      setRoadsVisible(next)
      saveAbmPrefs({ roadsVisible: next })
      setCmdFeedback(next ? 'ROADS ON' : 'ROADS OFF')
      return
    }

    // ── Cursor position readout (.coords) ─────────────────────────────────────
    if (str === '.coords') {
      const next = !coordsVisible
      setCoordsVisible(next)
      saveAbmPrefs({ coordsVisible: next })
      setCmdFeedback(next ? 'COORDS ON' : 'COORDS OFF')
      return
    }

    if (str === '.bec') {
      const next = !becVisible
      setBecVisible(next)
      saveAbmPrefs({ becVisible: next })
      setCmdFeedback(next ? 'BULLSEYE-ON-CURSOR ON' : 'BULLSEYE-ON-CURSOR OFF')
      return
    }

    if (str === '.ddm') {
      setCoordFormat('ddm')
      saveAbmPrefs({ coordFormat: 'ddm' })
      setCmdFeedback('DDM — DEGREES DECIMAL MINUTES')
      return
    }

    if (str === '.dms') {
      setCoordFormat('dms')
      saveAbmPrefs({ coordFormat: 'dms' })
      setCmdFeedback('DMS — DEGREES MINUTES SECONDS')
      return
    }

    if (str === '.meters') {
      setElevUnit('meters')
      saveAbmPrefs({ elevUnit: 'meters' })
      setCmdFeedback('ELEV METERS')
      return
    }

    if (str === '.feet') {
      setElevUnit('feet')
      saveAbmPrefs({ elevUnit: 'feet' })
      setCmdFeedback('ELEV FEET')
      return
    }

    // ── Contact display commands (§3, 2026-07-05) ─────────────────────────────
    const ptlMatch = str.match(/^\.ptl\s+(\d+(?:\.\d+)?)$/)
    if (ptlMatch) {
      const mins = parseFloat(ptlMatch[1])
      if (mins < 0 || mins > 5) { setCmdFeedback('INVALID: .PTL 0-5'); return }
      displayStore.updateWindow(WINDOW_ID, { ptlMinutes: mins })
      saveAbmPrefs({ ptlMinutes: mins })
      setCmdFeedback(mins === 0 ? 'PTL OFF' : `PTL ${mins}MIN`)
      return
    }

    const fadedMatch = str.match(/^\.faded\s+(\d+)$/)
    if (fadedMatch) {
      const s = parseInt(fadedMatch[1], 10)
      displayStore.updateWindow(WINDOW_ID, { fadedSeconds: s })
      saveAbmPrefs({ fadedSeconds: s })
      setCmdFeedback(`FADED ${s}S`)
      return
    }

    // .history — toggleable position-history trail, mirroring STARS'
    // HISTORY/H_RATE DCB knobs but as a command and with ABM's own defaults
    // (4 points / 4.5s) and colors (each contact's own classification color,
    // not a separate gradient — see drawAbmContacts.js). Bare `.history`
    // toggles visibility; `.history <len>` sets trail length (0 = off);
    // `.history <len> <rate>` also sets capture rate (seconds).
    if (str === '.history') {
      const next = !(windowSettings?.historyVisible ?? true)
      displayStore.updateWindow(WINDOW_ID, { historyVisible: next })
      saveAbmPrefs({ historyVisible: next })
      setCmdFeedback(next ? `HISTORY ${windowSettings?.historyLength ?? 4}/${windowSettings?.historyRate ?? 4.5}` : 'HISTORY OFF')
      return
    }

    const historyLenRateMatch = str.match(/^\.history\s+(\d+)\s+(\d+(?:\.\d+)?)$/)
    if (historyLenRateMatch) {
      const len  = Math.min(MAX_HISTORY, parseInt(historyLenRateMatch[1], 10))
      const rate = parseFloat(historyLenRateMatch[2])
      if (len <= 0) {
        displayStore.updateWindow(WINDOW_ID, { historyVisible: false })
        saveAbmPrefs({ historyVisible: false })
        setCmdFeedback('HISTORY OFF')
        return
      }
      displayStore.updateWindow(WINDOW_ID, { historyVisible: true, historyLength: len, historyRate: rate })
      saveAbmPrefs({ historyVisible: true, historyLength: len, historyRate: rate })
      setCmdFeedback(`HISTORY ${len}/${rate}`)
      return
    }

    const historyLenMatch = str.match(/^\.history\s+(\d+)$/)
    if (historyLenMatch) {
      const len = Math.min(MAX_HISTORY, parseInt(historyLenMatch[1], 10))
      if (len <= 0) {
        displayStore.updateWindow(WINDOW_ID, { historyVisible: false })
        saveAbmPrefs({ historyVisible: false })
        setCmdFeedback('HISTORY OFF')
        return
      }
      displayStore.updateWindow(WINDOW_ID, { historyVisible: true, historyLength: len })
      saveAbmPrefs({ historyVisible: true, historyLength: len })
      setCmdFeedback(`HISTORY ${len}/${windowSettings?.historyRate ?? 4.5}`)
      return
    }

    if (str === '.db') {
      const next = !(windowSettings?.dbVisible ?? true)
      displayStore.updateWindow(WINDOW_ID, { dbVisible: next })
      saveAbmPrefs({ dbVisible: next })
      setCmdFeedback(next ? 'DATABLOCKS ON' : 'DATABLOCKS OFF')
      return
    }

    // .dbreset — clears every .db + click per-contact override (dbHiddenIds),
    // returning all contacts to the global dbVisible/formation-suppression
    // behavior. Enter-only, no click — same shape as .threat clearing threatRings.
    if (str === '.dbreset') {
      setDbHiddenIds(new Set())
      setCmdFeedback('DATABLOCKS RESET')
      return
    }

    // .dbca — datablock collision avoidance (shared algorithm w/ CATCC, see
    // utils/datablockPlacement.js). Off by default for ABM.
    if (str === '.dbca') {
      const next = !(windowSettings?.dbca ?? false)
      displayStore.updateWindow(WINDOW_ID, { dbca: next })
      saveAbmPrefs({ dbca: next })
      setCmdFeedback(next ? 'DBCA ON' : 'DBCA OFF')
      return
    }

    // .dbs — formation datablock suppression (§3, 2026-07-08): when two or
    // more same-flight aircraft are within a 3NM box of the flight's lead
    // (see drawAbmContacts.js), only the lead's datablock shows. On by default.
    if (str === '.dbs') {
      const next = !(windowSettings?.dbSuppress ?? true)
      displayStore.updateWindow(WINDOW_ID, { dbSuppress: next })
      saveAbmPrefs({ dbSuppress: next })
      setCmdFeedback(next ? 'DB SUPPRESSION ON' : 'DB SUPPRESSION OFF')
      return
    }

    const ldrMatch = str.match(/^\.ldr\s+([0-7])\s+([1-9])$/)
    if (ldrMatch) {
      const length = parseInt(ldrMatch[1], 10)
      const dir    = ldrMatch[2]
      displayStore.updateWindow(WINDOW_ID, { ldrLength: length, ldrAngleDeg: DIR_TO_ANGLE[dir] })
      saveAbmPrefs({ ldrLength: length, ldrAngleDeg: DIR_TO_ANGLE[dir] })
      setCmdFeedback(`LDR ${length} ${dir}`)
      return
    }

    // ── BRAA line / bogey dope / threat rings — ported from AIC, same
    // commands (2026-07-07). Ctrl+click/Alt+click/Ctrl+Alt+click/Shift+click
    // and .dope + click are handled in handleMouseUp; these two are the
    // Enter-only (no click) forms, matching AIC's execCommand exactly.
    if (str === '.threat') {
      setThreatRings(new Set())
      setCmdFeedback('THREAT RINGS CLEARED')
      return
    }

    const threatRadiusMatch = str.match(/^\.threat\s+(\d+(?:\.\d+)?)$/)
    if (threatRadiusMatch) {
      const nm = parseFloat(threatRadiusMatch[1])
      displayStore.updateWindow(WINDOW_ID, { threatRadius: nm })
      saveAbmPrefs({ threatRadius: nm })
      setCmdFeedback(`THREAT RING ${nm}NM`)
      return
    }

    // .clear — clears RBL, BRAA/bogey-dope pairs, and threat rings (2026-07-07).
    if (str === '.clear') {
      setRbl(null)
      setThreatRings(new Set())
      useAbmStore.getState().braaList.forEach(p => useAbmStore.getState().removeBraaPair(p.id))
      setCmdFeedback('ALL CLEARED')
      return
    }

    // ── Bulk reclassification (2026-07-07) ────────────────────────────────────
    // `.class` alone returns every explicit declaration to its fog-of-war
    // default; `.class <old> <new>` (letters f/n/b/h) reclassifies every
    // currently-visible contact whose *effective* declaration is <old> to
    // <new> — e.g. `.class b h` turns every bogey into a hostile. Applies
    // across air + ground/naval (allVisibleUnits).
    if (str === '.class') {
      useAbmStore.getState().resetDeclarations()
      setCmdFeedback('CLASS RESET')
      return
    }

    const classMatch = str.match(/^\.class\s+([fnbh])\s+([fnbh])$/)
    if (classMatch) {
      const oldDecl = CLASS_LETTER[classMatch[1]]
      const newDecl = CLASS_LETTER[classMatch[2]]
      for (const [id, unit] of Object.entries(allVisibleUnitsRef.current)) {
        if (getEffectiveDeclaration(id, unit, myCoalitionNum) === oldDecl) {
          useAbmStore.getState().setDeclaration(id, newDecl)
        }
      }
      setCmdFeedback(`CLASS ${oldDecl} → ${newDecl}`)
      return
    }

    // .autoclass — toggles autoclassification (2026-07-08), same behavior as
    // AIC's: ON sets every currently-visible air/ground/naval contact to its
    // TRUE (coalition-based) classification right away, and the useEffect
    // above keeps auto-declaring newly-visible units from then on. OFF does
    // not revert anything already classified, it just stops future
    // auto-declaration. `.class` (no args) overrides this and turns it off.
    if (str === '.autoclass') {
      const next = !autoClassify
      useAbmStore.getState().setAutoClassify(next)
      if (next) {
        for (const [id, unit] of Object.entries(allVisibleUnitsRef.current)) {
          useAbmStore.getState().setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
        }
        setCmdFeedback('AUTOCLASS ON')
      } else {
        setCmdFeedback('AUTOCLASS OFF')
      }
      return
    }

    // .autothreat — toggles automatic threat rings (2026-07-10): while on,
    // every friendly aircraft within threatRadius of a HOSTILE/BOGEY aircraft
    // gets its ring lit until the breach clears — see the useEffect above.
    if (str === '.autothreat') {
      const next = !autoThreat
      setAutoThreat(next)
      setCmdFeedback(next ? 'AUTOTHREAT ON' : 'AUTOTHREAT OFF')
      return
    }

    // ── Ground/naval acq/eng range-ring visibility (§7, 2026-07-07) ───────────
    // `.acq`/`.eng` toggle all four classifications' rings at once; `.acq h`/
    // `.eng b` etc. toggle just that classification (f/n/b/h — matches the
    // F-key declaration letters, b for BOGEY).
    const acqClassMatch = str.match(/^\.acq\s+([fnbh])$/)
    if (acqClassMatch) {
      const decl = CLASS_LETTER[acqClassMatch[1]]
      const wasHidden = acqHidden.has(decl)
      const next = new Set(acqHidden)
      wasHidden ? next.delete(decl) : next.add(decl)
      setAcqHidden(next)
      saveAbmPrefs({ acqHidden: [...next] })
      setCmdFeedback(`ACQ ${decl} ${wasHidden ? 'ON' : 'OFF'}`)
      return
    }

    if (str === '.acq') {
      const next = acqHidden.size ? new Set() : new Set(ALL_DECLARATIONS)
      setAcqHidden(next)
      saveAbmPrefs({ acqHidden: [...next] })
      setCmdFeedback(next.size ? 'ACQ OFF' : 'ACQ ON')
      return
    }

    const engClassMatch = str.match(/^\.eng\s+([fnbh])$/)
    if (engClassMatch) {
      const decl = CLASS_LETTER[engClassMatch[1]]
      const wasHidden = engHidden.has(decl)
      const next = new Set(engHidden)
      wasHidden ? next.delete(decl) : next.add(decl)
      setEngHidden(next)
      saveAbmPrefs({ engHidden: [...next] })
      setCmdFeedback(`ENG ${decl} ${wasHidden ? 'ON' : 'OFF'}`)
      return
    }

    if (str === '.eng') {
      const next = engHidden.size ? new Set() : new Set(ALL_DECLARATIONS)
      setEngHidden(next)
      saveAbmPrefs({ engHidden: [...next] })
      setCmdFeedback(next.size ? 'ENG OFF' : 'ENG ON')
      return
    }

    setCmdFeedback('UNKNOWN COMMAND')
  }

  // Ctrl+V into the command line — interactiveRef is a plain div (not a
  // text input), so pasting only works if something actually listens for
  // the native paste event and appends the clipboard text to cmdBuffer
  // itself; without this the browser has nowhere to put it. Collapses any
  // newlines in the pasted text to spaces — cmdBuffer is a single line.
  const handlePaste = useCallback((e) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    if (!text) return
    setCmdFeedback('')
    setCmdBuffer(b => b + text.replace(/[\r\n]+/g, ' '))
  }, [])

  const handleKeyDown = useCallback((e) => {
    const fDecl = F_KEY_DECL[e.key]
    if (fDecl) {
      e.preventDefault()
      setPendingDeclaration(d => d === fDecl ? null : fDecl)
      clearPendingBraa()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (pendingClearClick) { setPendingClearClick(false); return }
      if (pendingClearAllConfirm) { setPendingClearAllConfirm(false); setCmdFeedback('CLEAR ALL CANCELLED'); return }
      if (pendingDraw) { setPendingDraw(null); return }
      if (findMarker) { setFindMarker(null); useAbmMissionStore.getState().clearFind(); return }
      if (routeVisible) { useAbmMissionStore.getState().clearRouteVisible(); return }
      if (pendingDeclaration) { setPendingDeclaration(null); return }
      if (pendingBraaFighter) { clearPendingBraa(); return }
      if (rbl) { setRbl(null); return }
      if (defineEntry) { setDefineEntry(null); return }
      clearCmd()
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = cmdBuffer.trim()
      if (trimmed) {
        execCommand(trimmed)
        setCmdHistory(h => [trimmed, ...h.filter(c => c !== trimmed)].slice(0, 50))
      }
      setCmdBuffer('')
      setCmdHistoryIdx(-1)
      cmdHistoryIdxRef.current = -1
      cmdDraftRef.current = ''
      return
    }

    // While a .define readout is up, ArrowUp/ArrowDown browse the glossary
    // alphabetically instead of the command history, until Escape.
    if (defineEntry && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const result = useBrevityStore.getState().neighbor(defineEntry.term, e.key === 'ArrowUp' ? -1 : 1)
      if (result) setDefineEntry(result)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const hist = cmdHistoryRef.current
      if (!hist.length) return
      if (cmdHistoryIdxRef.current === -1) cmdDraftRef.current = cmdBuffer
      const next = Math.min(cmdHistoryIdxRef.current + 1, hist.length - 1)
      setCmdHistoryIdx(next)
      cmdHistoryIdxRef.current = next
      setCmdBuffer(hist[next])
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (cmdHistoryIdxRef.current === -1) return
      const next = cmdHistoryIdxRef.current - 1
      setCmdHistoryIdx(next)
      cmdHistoryIdxRef.current = next
      setCmdBuffer(next === -1 ? cmdDraftRef.current : cmdHistoryRef.current[next])
      return
    }

    if (e.key === 'Backspace') {
      e.preventDefault()
      setCmdBuffer(b => b.slice(0, -1))
      return
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      setCmdFeedback('')
      setCmdBuffer(b => b + e.key)
    }
  // execCommand is a large per-render-redefined function only called from this handler; wrapping
  // it in its own useCallback is a larger refactor than this cleanup pass, tracked separately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmdBuffer, pendingDeclaration, pendingBraaFighter, clearPendingBraa, rbl, findMarker, pendingDraw,
      pendingClearClick, pendingClearAllConfirm, defineEntry, routeVisible])

  // ── Click dispatch — ported from AIC's handleMouseUp, same modifier/command
  // precedence (2026-07-07): Shift+click removes BRAA pairs for the target;
  // Ctrl+Alt+click toggles its threat ring; Ctrl+click (twice) pairs two
  // contacts into a BRAA line (target can be air or ground/naval); Alt+click
  // (or `.dope` + click) auto-pairs the target with its nearest BOGEY/
  // HOSTILE *air* contact only ("bogey dope" — not friendly, not ground);
  // `.threat`/`.threat
  // <nm>` + click toggles a ring (optionally setting the default radius
  // first). Falls through to ABM's own bare-digit leader-direction override
  // ("# + slew", no AIC equivalent) and pending F-key declaration apply.
  // Bound to onMouseUp (not onClick) so the rblDragActiveRef guard below can
  // suppress all of this when the mouseup is actually finishing an RBL drag
  // — same reason AIC uses mouseup instead of the native click event.
  const handleMouseUp = useCallback((e) => {
    if (e.button !== 0 && e.button !== 1) return
    if (rblDragActiveRef.current) return // this mouseup is finishing an RBL drag, not a click

    const rect = interactiveRef.current?.getBoundingClientRect()
    if (!rect || !viewRef.current) return
    const pos    = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const target = resolveSlew(pos, allVisibleUnitsRef.current, viewRef.current)

    // .be + click — places the bullseye override at the clicked point.
    // Armed live while cmdBuffer is exactly ".be" (see pendingBe above);
    // typing on past that (a fix name or coordinates) disarms it and the
    // command instead resolves on Enter via execCommand.
    if (pendingBeRef.current) {
      if (e.button === 1) return
      const ll = canvasToLatLng(pos.x, pos.y, viewRef.current)
      setBullseyeOverride({ lat: ll.lat, lng: ll.lng })
      clearCmd()
      setCmdFeedback(`BULLSEYE SET ${ll.lat.toFixed(2)}/${ll.lng.toFixed(2)}`)
      return
    }

    // .clear + click — one-shot: disarms on this click regardless of
    // whether anything was actually under it.
    if (pendingClearClick) {
      if (e.button === 1) return
      setPendingClearClick(false)
      const hit = hitTestDrawingLayer(viewRef.current, drawingLayers, pos.x, pos.y)
      if (hit) {
        removeDrawingLayer(theatre, hit.id)
        setCmdFeedback(`CLEARED ${hit.name}`)
      } else {
        setCmdFeedback('NOTHING THERE')
      }
      return
    }

    // In-progress .line/.rect/.circ/.poly/.sect/.race/.text draw command —
    // takes priority over every other click behavior below (BRAA/threat/
    // dope/highlight/etc.) until it's committed or Escape-cancelled.
    // Middle-click is suppressed (not the usual toggleHighlight) while a
    // draw command is pending — rotation itself is now driven by the scroll
    // wheel (see the wheel listener below), not the middle-click.
    if (pendingDraw) {
      if (e.button === 1) return

      // .poly closes when a click lands near its first vertex (screen-pixel
      // distance, so it feels the same at any zoom level) — checked here,
      // not in advancePendingDraw, since that needs the view/projection to
      // test proximity and drawCommands.js is deliberately map-agnostic.
      if (pendingDraw.type === 'poly' && pendingDraw.vertices.length >= 3) {
        const originPx = latLngToCanvas(pendingDraw.vertices[0].lat, pendingDraw.vertices[0].lng, viewRef.current)
        if (Math.hypot(pos.x - originPx.x, pos.y - originPx.y) <= POLY_CLOSE_RADIUS_PX) {
          if (theatre) {
            addDrawnShape(theatre, 'poly', { vertices: pendingDraw.vertices })
            setCmdFeedback('POLY DRAWN')
          }
          setPendingDraw(null)
          return
        }
      }

      const clickLatLng = canvasToLatLng(pos.x, pos.y, viewRef.current)
      const result = advancePendingDraw(pendingDraw, clickLatLng, viewRef.current?.declinationDeg ?? 0, theatre)
      if (result.immediate) {
        if (theatre) {
          addDrawnShape(theatre, pendingDraw.type, result.immediate)
          setCmdFeedback(`${pendingDraw.type.toUpperCase()} DRAWN`)
        }
        setPendingDraw(null)
      } else {
        setPendingDraw(result.pending)
      }
      return
    }

    if (e.button === 1) {
      if (target) toggleHighlight(String(target.unitId))
      return
    }

    if (e.ctrlKey && e.shiftKey && !e.altKey) {
      if (target?.unit?.groupID != null) {
        const flight = useAbmMissionStore.getState().flights.find(f => f.groupId === target.unit.groupID)
        // FRAG is coalition-restricted like ATO — GM/admin sees everything,
        // blue/red sessions only their own side's flights.
        const ownSide = coalition !== 'blue' && coalition !== 'red' || flight?.coalition === coalition
        if (flight && ownSide) selectAtoGroup(flight.groupId)
      }
      return
    }

    if (e.shiftKey && !e.altKey && !e.ctrlKey) {
      if (target) removeBraaPairsForUnit(target.unitId)
      return
    }

    if (e.ctrlKey && e.altKey) {
      if (target) { toggleThreatRing(target.unitId); clearCmd() }
      return
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      if (!target) { clearPendingBraa(); return }
      const pending = useAbmStore.getState().pendingBraaFighter
      if (pending && target.unitId !== pending) { addBraaPair(pending, target.unitId); return }
      if (pending === target.unitId) clearPendingBraa()
      else setPendingBraaFighter(target.unitId)
      return
    }

    if (e.altKey && !e.ctrlKey) {
      if (!target) return
      const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
      const nearestId = findNearestBogey(target.unitId, target.unit, visibleUnitsRef.current, getDecl)
      if (nearestId) { addBraaPair(target.unitId, nearestId); setCmdFeedback('BOGEY DOPE') }
      else setCmdFeedback('NO BOGEY')
      return
    }

    const buf = cmdBuffer.trim().toLowerCase()

    if (buf === '.threat' || buf.match(/^\.threat\s+\d+(\.\d+)?$/)) {
      if (target) {
        if (buf !== '.threat') {
          displayStore.updateWindow(WINDOW_ID, { threatRadius: parseFloat(buf.split(/\s+/)[1]) })
        }
        toggleThreatRing(target.unitId)
        clearCmd()
      }
      return
    }

    if (buf === '.db') {
      if (target) { toggleDbHidden(target.unitId); clearCmd() }
      return
    }

    if (buf === '.dope') {
      if (!target) return
      const getDecl = (id, unit) => getEffectiveDeclaration(id, unit, myCoalitionNum)
      const nearestId = findNearestBogey(target.unitId, target.unit, visibleUnitsRef.current, getDecl)
      if (nearestId) { addBraaPair(target.unitId, nearestId); setCmdFeedback('BOGEY DOPE') }
      else setCmdFeedback('NO BOGEY')
      setCmdBuffer('')
      return
    }

    if (buf === '.rename' || buf.startsWith('.rename ')) {
      if (target) {
        const newCallsign = buf.slice(7).trim().toUpperCase() || null
        const { oldCallsign } = applyCallsignChange(target.unitId, target.unit, newCallsign)
        sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(target.unitId), oldCallsign, newCallsign })
        setCmdFeedback(newCallsign ? `RENAMED ${newCallsign}` : 'CALLSIGN RESET')
        setCmdBuffer('')
      }
      return
    }

    const pending = useAbmStore.getState().pendingBraaFighter
    if (pending && target && target.unitId !== pending) { addBraaPair(pending, target.unitId); return }
    if (pending && !target) { clearPendingBraa(); return }

    if (!target) return

    const digitMatch = cmdBuffer.trim().match(/^([1-9])$/)
    if (digitMatch) {
      const dir     = digitMatch[1]
      const current = useDisplayStore.getState().windows[WINDOW_ID]?.leaderDirs ?? {}
      displayStore.updateWindow(WINDOW_ID, { leaderDirs: { ...current, [String(target.unitId)]: dir } })
      clearCmd()
      return
    }

    if (pendingDeclaration) {
      const targets = resolveClassifyTargets(pos, allVisibleUnitsRef.current, viewRef.current)
      for (const t of targets) useAbmStore.getState().setDeclaration(t.unitId, pendingDeclaration)
      setCmdFeedback(pendingDeclaration)
      setPendingDeclaration(null)
    }

    // FRAG roster "blink datablock" cancel — a plain click on the blinking
    // contact turns it off, same as clicking it again in FRAG would
    // (toggleBlink). Resolved independently of `target` above: `target` is
    // whichever unit is nearest-overall to the click, so a blinking contact
    // sitting close to some other (non-blinking) contact could lose the hit
    // test to its neighbor and silently fail to cancel. Re-running
    // resolveSlew scoped to just the blink-eligible units (the blinking ids
    // themselves, plus their formation leads if .dbs suppression means only
    // the lead's datablock is actually on screen) guarantees a click near
    // the blinking contact always resolves to it.
    const liveBlinkIds = useAbmMissionStore.getState().blinkIds ?? []
    if (liveBlinkIds.length) {
      const dbSuppressOn = useDisplayStore.getState().windows[WINDOW_ID]?.dbSuppress ?? true
      const { leaderOf } = dbSuppressOn ? computeSuppressedIds(visibleUnitsRef.current) : { leaderOf: new Map() }
      const candidateIds = new Set(liveBlinkIds)
      for (const id of liveBlinkIds) {
        const lead = leaderOf.get(id)
        if (lead != null) candidateIds.add(lead)
      }
      const candidateUnits = {}
      for (const id of candidateIds) {
        if (allVisibleUnitsRef.current[id]) candidateUnits[id] = allVisibleUnitsRef.current[id]
      }
      const blinkTarget = resolveSlew(pos, candidateUnits, viewRef.current)
      if (blinkTarget) {
        const hitId = blinkTarget.unitId
        if (liveBlinkIds.includes(hitId)) {
          useAbmMissionStore.getState().toggleBlink(hitId)
        } else {
          for (const id of liveBlinkIds) {
            if (leaderOf.get(id) === hitId) useAbmMissionStore.getState().toggleBlink(id)
          }
        }
      }
    }
  }, [cmdBuffer, pendingDeclaration, displayStore, myCoalitionNum, getEffectiveDeclaration,
      addBraaPair, removeBraaPairsForUnit, setPendingBraaFighter, clearPendingBraa,
      pendingDraw, theatre, addDrawnShape,
      pendingClearClick, drawingLayers, removeDrawingLayer, coalition, selectAtoGroup])

  if (!windowSettings) return null

  // ── Command area preview — same pending-BRAA readout as AIC's cmdPreview.
  let cmdPreview
  if (pendingDeclaration) {
    cmdPreview = `${pendingDeclaration} +`
  } else if (pendingBraaFighter) {
    const fu = allVisibleUnits[pendingBraaFighter]
    cmdPreview = `BRAA: ${fu ? resolveCallsign(fu) : pendingBraaFighter} → ?`
  } else {
    cmdPreview = cmdBuffer
  }

  return (
    <div className="abm-scope" style={(basemapVisible || terrainVisible) ? { background: BASEMAP_SEA_COLOR } : undefined}>
      <div ref={canvasAreaRef} className="abm-canvas-area">
        <canvas ref={mapRef}      className="abm-layer" />
        <canvas ref={layersRef}   className="abm-layer" />
        <canvas ref={compassRef}  className="abm-layer" />
        <canvas ref={contactsRef} className="abm-layer" />
        <div
          ref={interactiveRef}
          className="abm-layer abm-interactive"
          tabIndex={0}
          onMouseDown={handleMouseDown}
          onMouseMove={handleCursorMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => setBecReadout(null)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!bullseyeEntry && !bullseyeOverride && <div className="abm-warn">NO BULLSEYE</div>}

        {clockVisible && (
          <div
            className="abm-clock"
            onClick={() => { setShowLocalTime((v) => !v); interactiveRef.current?.focus() }}
            title="Click to toggle Zulu / Local time"
          >
            {clockTime ?? (showLocalTime ? '--:--:--L' : '--:--:--Z')}
          </div>
        )}

        {groupedReadout.length > 0 && (() => {
          const cycling = groupedReadout.length > 1
          const active  = groupedReadout[readoutIdx] ?? groupedReadout[0]
          const fields  = active.kind === 'airport'
            ? buildAirportFields(active.airport)
            : active.kind === 'air'
              ? (active.isFriendly ? buildFriendlyAirFields(active.unit) : [active.revealed ? active.typeLabel : 'UNKNOWN'])
              : buildReadoutFields(groundUnitDb[active.unit.name])
          if ((active.kind === 'ground' || (active.kind === 'air' && !active.isFriendly)) && active.count > 1) {
            fields.push(`x${active.count}`)
          }
          if (!fields.length) return null
          return (
            <div className="abm-readout-box">
              <div
                key={cycling ? `${active.unitId}-${readoutIdx}` : active.unitId}
                className={`abm-readout-entry${cycling ? ' abm-readout-fade' : ''}`}
              >
                <div className="abm-readout-index">{readoutIdx + 1}/{groupedReadout.length}</div>
                {fields.map((value, i) => (
                  <div key={i}>{value}</div>
                ))}
              </div>
            </div>
          )
        })()}

        {coordsVisible && coordsReadout && (
          <div className="abm-coords-box">
            {coordsReadout.bullseye && (
              <div>BE {String(coordsReadout.bullseye.bearing).padStart(3, '0')}°M / {coordsReadout.bullseye.range}NM</div>
            )}
            <div>
              {coordFormat === 'ddm'
                ? formatDDM(coordsReadout.lat, coordsReadout.lng, 3)
                : formatDMS(coordsReadout.lat, coordsReadout.lng, 2)}
            </div>
            <div>{formatMGRS(coordsReadout.lat, coordsReadout.lng)}</div>
            <div>{formatElevation(coordsReadout.elevationM, elevUnit)}</div>
          </div>
        )}

        {becVisible && becReadout && (
          <div className="abm-bec-box" style={{ left: becReadout.x, top: becReadout.y }}>
            {String(becReadout.bearing).padStart(3, '0')} / {becReadout.range}
          </div>
        )}

        {cmdFeedback && (
          <div className="abm-cmd-feedback">{cmdFeedback}</div>
        )}

        {defineEntry && (
          <div className="abm-define" onClick={() => { setDefineEntry(null); interactiveRef.current?.focus() }}>
            <div className="abm-define-term">{defineEntry.term}</div>
            <div className="abm-define-text">{defineEntry.text}</div>
          </div>
        )}

        <div className="abm-cmd-area">
          <span className="abm-cmd-prompt">{'>'}</span>
          <span className={`abm-cmd-preview${pendingDeclaration ? ' abm-cmd-fkey' : ''}`}>
            {cmdPreview}
          </span>
          {!pendingDeclaration && <span className="abm-cmd-cursor">_</span>}
        </div>
      </div>
    </div>
  )
}
