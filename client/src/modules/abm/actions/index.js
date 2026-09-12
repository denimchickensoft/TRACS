/**
 * ABM action library.
 *
 * Every command action is implemented here as a standalone function reading/
 * writing state via .getState() (never a closure) — same shape as AIC's
 * action library (modules/aic/actions/index.js) and STARS' before it. Ported
 * from AbmScope.jsx's original inline execCommand 2026-08-22 — see
 * resources/specs/refactor-spec.md §10.
 *
 * Each action receives:
 *   captures — named captures from commandParser.js
 *   context  — small set of caller-computed, non-store values that don't
 *              have an independent source of truth to read from .getState():
 *                raw             — the untouched, original-case command text
 *                                  (only the 7 draw commands need this, to
 *                                  preserve .text's label casing — everything
 *                                  else works fine from lowercased captures)
 *                theatre
 *                declinationDeg  — viewRef.current?.declinationDeg ?? 0
 *                                  (the view's declination, NOT the bullseye-
 *                                  relative one — draw commands only)
 *                myCoalitionNum
 *                allVisibleUnits — air+ground/naval union (.class/.autoclass only)
 *
 * Returns the command-feedback string to show the controller (never null —
 * every one of these branches produced feedback in the original). AbmScope
 * still owns cmdFeedback as local state (not moved to a store — same
 * reasoning as AIC's: many non-command call sites, e.g. BRAA/rename/RBL
 * drag, that get no benefit from moving); the caller is expected to await
 * dispatch()'s result and pass it to setCmdFeedback directly. dispatch() is
 * async only because ASPCOLORS needs to await a palette-fetch on a cache
 * miss; every other action is a plain sync function.
 *
 * Two groups of commands are deliberately absent from this dispatch table,
 * matching AIC's own precedent — they're read directly off cmdBuffer inside
 * AbmScope.jsx's handleMouseUp/handleKeyDown, not routed through
 * parseCommand/dispatch: the BRAA/bogey-dope/threat-ring/highlight/rename/
 * FRAG/route/leader-direction click-modifier commands (Ctrl/Alt/Shift/
 * Ctrl+Alt+click, Ctrl+right-click, `.dope`/`.rename`/`.frag`/`.route`/
 * bare-digit + click), and the three click-completion
 * mechanisms (pendingDraw/pendingClearClick/pendingClearAllConfirm) plus the
 * `.dclear all` y/n confirmation intercept, which stays bespoke at the top of
 * AbmScope.jsx's execCommand wrapper per §10.0/§10.3 of the refactor spec.
 *
 * Some persisted fields also get an explicit saveAbmPrefs(...) call here
 * alongside the displayStore update — those are the fields store/abmPrefs.js
 * still owns (rings/leader/history/dbca/aspColorIdx, see that file's
 * header), not the ~24 fields store/abmUiPrefs.js auto-persists on every
 * setter call. Don't add saveAbmPrefs calls for uiPrefs-store fields — that
 * store already persists itself via its own subscribe() (see abmUiPrefs.js).
 */

import { useDisplayStore } from '../../../store/display.js'
import { useAbmStore, DECLARATION } from '../../../store/abm.js'
import { useRoeStore, ROE_STATE } from '../../../store/roe.js'
import { useAbmUiPrefsStore } from '../../../store/abmUiPrefs.js'
import { saveAbmPrefs } from '../../../store/abmPrefs.js'
import { useNavdataStore } from '../../../store/navdata.js'
import { useGeoStore } from '../../../store/geo.js'
import { useReliefStore } from '../../../store/relief.js'
import { useHoldingsStore } from '../../../store/holdings.js'
import { useMoraStore } from '../../../store/mora.js'
import { useAirwaysStore } from '../../../store/airways.js'
import { useAbmAirspaceStore } from '../../../store/abmAirspace.js'
import { useAbmDrawingsStore } from '../../../store/abmDrawings.js'
import { useAbmMissionStore } from '../../../store/abmMission.js'
import { useBrevityStore } from '../../../store/brevity.js'
import { useSessionStore } from '../../../store/session.js'
import { matchLiveByPrefix } from '../../../utils/callsign.js'
import { DIR_TO_ANGLE } from '../../atc/stars/constants.js'
import { trueDeclaration, drawCmdTokens } from '../abmScopeHelpers.js'
import { parseDrawCommand } from '../draw/drawCommands.js'

const WINDOW_ID = 'abm-main'
const MAX_HISTORY = 10 // absolute cap on captured trail points, same as AbmScope.jsx's own constant

// .class/.acq/.eng classification letters — duplicated from AbmScope.jsx
// rather than imported, matching AIC's own CLASS_LETTER duplication
// convention (small, stable, per-scope constant — see that file's comment).
const CLASS_LETTER = {
  f: DECLARATION.FRIENDLY,
  n: DECLARATION.NEUTRAL,
  b: DECLARATION.BOGEY,
  h: DECLARATION.HOSTILE,
}
const ALL_DECLARATIONS = [DECLARATION.HOSTILE, DECLARATION.BOGEY, DECLARATION.NEUTRAL, DECLARATION.FRIENDLY]

// Per-category airspace toggles (2026-07-08) — same table AbmScope.jsx used
// inline; moved here wholesale (not duplicated) since execCommand was its
// only call site.
const AIRSPACE_CATEGORIES = [
  'TMA', 'CTR', 'CTA', 'FIR', 'UIR', 'SUA', 'MIL', 'TRSA',
  'CLASS A', 'CLASS B', 'CLASS C', 'CLASS D', 'CLASS E', 'CLASS F', 'CLASS G',
]
const AIRSPACE_CMD_CATEGORY = {
  tma: 'TMA', ctr: 'CTR', cta: 'CTA', fir: 'FIR', uir: 'UIR', sua: 'SUA', mil: 'MIL', trsa: 'TRSA',
  classa: 'CLASS A', classb: 'CLASS B', classc: 'CLASS C', classd: 'CLASS D',
  classe: 'CLASS E', classf: 'CLASS F', classg: 'CLASS G',
}

function getWin() {
  return useDisplayStore.getState().windows[WINDOW_ID]
}

function updateWin(patch) {
  useDisplayStore.getState().updateWindow(WINDOW_ID, patch)
}

// ── Range rings ──────────────────────────────────────────────────────────────

export function RR_TOGGLE() {
  const on = !(getWin()?.ringsVisible ?? false)
  updateWin({ ringsVisible: on })
  saveAbmPrefs({ ringsVisible: on })
  return on ? `RANGE RINGS ${getWin()?.ringSpacingNm ?? 20}NM` : 'RANGE RINGS OFF'
}

export function RR_SET({ captures }) {
  const nm = parseFloat(captures.nm)
  if (nm <= 0) {
    updateWin({ ringsVisible: false })
    saveAbmPrefs({ ringsVisible: false })
    return 'RANGE RINGS OFF'
  }
  updateWin({ ringsVisible: true, ringSpacingNm: nm })
  saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
  return `RANGE RINGS ${nm}NM`
}

export function RR_SET_ANCHOR({ captures }) {
  const nm = parseFloat(captures.nm)
  const anchor = captures.anchor
  if (nm <= 0) {
    updateWin({ ringsVisible: false })
    saveAbmPrefs({ ringsVisible: false })
    return 'RANGE RINGS OFF'
  }
  if (anchor === 'bullseye' || anchor === 'bs') {
    updateWin({ ringsVisible: true, ringSpacingNm: nm, ringAnchorLat: null, ringAnchorLng: null, ringAnchorId: null })
    saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
    return `RANGE RINGS ${nm}NM @ BULLSEYE`
  }
  const result = useNavdataStore.getState().lookupFix(anchor)
  if (!result) return 'FIX NOT FOUND'
  // Anchor lat/lng/id intentionally excluded from saveAbmPrefs — mission-
  // specific fix, not a persisted preference (see store/abmPrefs.js header).
  updateWin({ ringsVisible: true, ringSpacingNm: nm, ringAnchorLat: result.lat, ringAnchorLng: result.lon, ringAnchorId: result.id })
  saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
  return `RANGE RINGS ${nm}NM @ ${result.id}`
}

// ── Bullseye override ────────────────────────────────────────────────────────

export function BE_RESET() {
  updateWin({ bullseyeOverride: null })
  return 'BULLSEYE RESET'
}

export function BE_LATLNG({ captures }) {
  const lat = parseFloat(captures.lat)
  const lng = parseFloat(captures.lng)
  updateWin({ bullseyeOverride: { lat, lng } })
  return `BULLSEYE SET ${lat.toFixed(2)}/${lng.toFixed(2)}`
}

export function BE_FIX({ captures }) {
  const result = useNavdataStore.getState().lookupFix(captures.fix)
  if (!result) return 'FIX NOT FOUND'
  updateWin({ bullseyeOverride: { lat: result.lat, lng: result.lon } })
  return `BULLSEYE SET @ ${result.id}`
}

// ── Navdata layer toggles (§4.2) ─────────────────────────────────────────────

export function TIME_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.clockVisible
  prefs.setClockVisible(next)
  return next ? 'TIME ON' : 'TIME OFF'
}

export function UNITRO_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.unitReadoutVisible
  prefs.setUnitReadoutVisible(next)
  return next ? 'UNIT READOUT ON' : 'UNIT READOUT OFF'
}

export function GEO_TOGGLE() {
  useGeoStore.getState().toggleVisible()
  return useGeoStore.getState().visible ? 'GEO ON' : 'GEO OFF'
}

export function RELIEF_TOGGLE() {
  useReliefStore.getState().toggleVisible()
  return useReliefStore.getState().visible ? 'RELIEF ON' : 'RELIEF OFF'
}

export function HOLDS_TOGGLE() {
  useHoldingsStore.getState().toggleVisible()
  return useHoldingsStore.getState().visible ? 'HOLDS ON' : 'HOLDS OFF'
}

export function MORA_TOGGLE() {
  useMoraStore.getState().toggleVisible()
  return useMoraStore.getState().visible ? 'MORA ON' : 'MORA OFF'
}

export function AIRWAYS_TOGGLE() {
  const v = useAirwaysStore.getState().visible
  const anyOn = v.V || v.J || v.B
  useAirwaysStore.getState().setVisible({ V: !anyOn, J: !anyOn, B: !anyOn })
  return anyOn ? 'AIRWAYS OFF' : 'AIRWAYS ON'
}

export function AIRWAYS_TYPE({ captures }) {
  const type = captures.type.toUpperCase()
  useAirwaysStore.getState().toggleVisible(type)
  return `AIRWAYS ${type} ${useAirwaysStore.getState().visible[type] ? 'ON' : 'OFF'}`
}

// .asp — bulk toggle (was .airspace, 2026-07-08): on if any category is
// currently visible, off otherwise, same anyOn pattern as .airways.
export function ASP_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const anyOn = AIRSPACE_CATEGORIES.some(c => prefs.asVisible[c])
  const next = anyOn ? {} : Object.fromEntries(AIRSPACE_CATEGORIES.map(c => [c, true]))
  prefs.setAsVisible(next)
  return anyOn ? 'AIRSPACE OFF' : 'AIRSPACE ON'
}

// Per-category airspace toggles (2026-07-08) — .tma/.ctr/.cta/.fir/.uir/.sua/
// .mil/.trsa/.classa-.classg. No procedure commands (SID/STAR/APPCH stay
// display-only, per direction).
export function ASP_CATEGORY({ captures }) {
  const cat = AIRSPACE_CMD_CATEGORY[captures.cat]
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.asVisible[cat]
  prefs.setAsVisible(s => ({ ...s, [cat]: next }))
  return `${cat} ${next ? 'ON' : 'OFF'}`
}

// Same commands STARS uses for airspace palettes, reimplemented against
// useAbmAirspaceStore's own palette state rather than useMapsStore's, which
// is STARS-only (see store/abmAirspace.js).
export async function ASPCOLORS({ captures }) {
  const name = captures.name.trim().toUpperCase()
  await useAbmAirspaceStore.getState().refreshPalettes()
  const palettes = useAbmAirspaceStore.getState().palettes
  const idx = palettes.findIndex(p => p.name.toUpperCase() === name)
  if (idx < 0) return 'INVALID PALETTE'
  useAbmAirspaceStore.getState().setPaletteIdx(idx)
  saveAbmPrefs({ aspColorIdx: idx })
  return `ASP COLORS: ${palettes[idx].name.toUpperCase()}`
}

export async function REFRESH() {
  const success = await useAbmAirspaceStore.getState().refreshPalettes()
  return success ? 'PALETTES REFRESHED' : 'REFRESH FAILED'
}

// .labels/.lbl/.label — name-label toggle for both airspace and
// custom-drawing layers.
export function LABELS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.labelsVisible
  prefs.setLabelsVisible(next)
  return next ? 'LABELS ON' : 'LABELS OFF'
}

// .fill — toggle airspace polygon fill, remembering the last percentage used.
export function FILL_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.fillVisible
  prefs.setFillVisible(next)
  return next ? 'FILL ON' : 'FILL OFF'
}

export function FILL_SET({ captures }) {
  const pct = parseInt(captures.pct, 10)
  if (pct < 1 || pct > 100) return 'ILL VAL'
  const prefs = useAbmUiPrefsStore.getState()
  prefs.setFillVisible(true)
  prefs.setFillPct(pct)
  return `FILL ${pct}%`
}

// .custom/.cust — interchangeable: bare form is a bulk toggle for
// user-imported GeoJSON drawings; `.custom <name>`/`.cust <name>` toggles
// just the drawing(s) matching that name (case-insensitive, could be more
// than one after manual renames).
export function CUSTOM_TOGGLE({ context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  const drawingLayers = useAbmDrawingsStore.getState().byTheatre[theatre] ?? []
  const anyOn = drawingLayers.some(l => l.visible)
  useAbmDrawingsStore.getState().toggleAll(theatre)
  return anyOn ? 'CUSTOM OFF' : 'CUSTOM ON'
}

export function CUSTOM_NAME({ captures, context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  // Collapse internal whitespace, matching the original's tokenize-then-
  // rejoin (drawCmdTokens(str, raw).join(' ')) rather than a raw capture.
  const arg = captures.name.trim().split(/\s+/).join(' ')
  const drawingLayers = useAbmDrawingsStore.getState().byTheatre[theatre] ?? []
  const matches = drawingLayers.filter(l => l.name.toUpperCase() === arg.toUpperCase())
  if (!matches.length) return 'NOT FOUND'
  const anyOn = matches.some(l => l.visible)
  useAbmDrawingsStore.getState().toggleLayersByName(theatre, arg)
  return `${arg.toUpperCase()} ${anyOn ? 'OFF' : 'ON'}`
}

// ── Draw commands ────────────────────────────────────────────────────────────
// .line/.rect/.circ/.poly/.sect/.race/.text — fully-typed args commit
// immediately (addDrawnShape); anything left unresolved arms pendingDraw and
// waits for click(s), handled by AbmScope.jsx's handleMouseUp (bespoke, see
// this file's header). See ../draw/drawCommands.js for the per-shape
// grammar/arity — this only wraps it in the parser/action shape.
//
// Tokens are re-derived from context.raw here (not from commandParser.js's
// captures) so .text's label content keeps the controller's original
// casing — see commandParser.js's header for why.
const DRAW_PENDING_FEEDBACK = {
  line: 'LINE: CLICK TO PLACE',
  rect: 'RECT: CLICK TO PLACE',
  circ: 'CIRC: CLICK TO PLACE',
  poly: 'POLY: CLICK VERTICES, CLICK NEAR START TO CLOSE',
  sect: 'SECT: CLICK TO PLACE',
  race: 'RACE: CLICK TO PLACE',
  text: 'TEXT: CLICK TO PLACE',
}
const DRAW_DONE_FEEDBACK = {
  line: 'LINE DRAWN',
  rect: 'RECT DRAWN',
  circ: 'CIRCLE DRAWN',
  poly: 'POLY DRAWN',
  race: 'RACETRACK DRAWN',
  text: 'TEXT DRAWN',
}

function handleDrawCommand(type, { context }) {
  const { raw, theatre, declinationDeg } = context
  if (!theatre) return 'NO THEATRE'
  const str = raw.trim().toLowerCase()
  const tokens = drawCmdTokens(str, raw)
  const result = parseDrawCommand(type, tokens, useNavdataStore.getState().lookupFix, declinationDeg, theatre)
  if (result.error) return result.error
  if (result.immediate) {
    if (type === 'sect' && Array.isArray(result.immediate)) {
      // .sect <id> <brg1> <brg2>...<brgN> <radius> draws N-1 adjoining
      // sectors sharing that radius — result.immediate is an array here
      // (every other command's `immediate` is a single params object).
      for (const sector of result.immediate) useAbmDrawingsStore.getState().addDrawnShape(theatre, 'sect', sector)
      return result.immediate.length > 1 ? `${result.immediate.length} SECTORS DRAWN` : 'SECTOR DRAWN'
    }
    useAbmDrawingsStore.getState().addDrawnShape(theatre, type, result.immediate)
    return DRAW_DONE_FEEDBACK[type]
  }
  updateWin({ pendingDraw: result.pending })
  return DRAW_PENDING_FEEDBACK[type]
}

export function LINE({ context }) { return handleDrawCommand('line', { context }) }
export function RECT({ context }) { return handleDrawCommand('rect', { context }) }
export function CIRC({ context }) { return handleDrawCommand('circ', { context }) }
export function POLY({ context }) { return handleDrawCommand('poly', { context }) }
export function SECT({ context }) { return handleDrawCommand('sect', { context }) }
export function RACE({ context }) { return handleDrawCommand('race', { context }) }
export function TEXT({ context }) { return handleDrawCommand('text', { context }) }

// ── Clear (drawings only — post-§10.3 fix; RBL/BRAA/threat-ring bulk-clear
// is TCLEAR below) ───────────────────────────────────────────────────────────
// Renamed .clear → .dclear (2026-08-22) to read distinctly from TCLEAR's own
// tactical-clear command — `d`/`t` prefix now segments "clear a drawing" from
// "clear RBL/BRAA/threat rings" at a glance. Bare/click form arms
// pendingClearClick (handled in AbmScope.jsx's handleMouseUp, bespoke);
// `.dclear all` arms pendingClearAllConfirm instead, intercepted by
// AbmScope.jsx's execCommand wrapper on the NEXT submitted line as a bare
// yes/no answer (also bespoke — see this file's header).

export function DCLEAR_BARE({ context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  updateWin({ pendingDraw: null, pendingClearClick: true })
  return 'CLEAR: CLICK A DRAWING'
}

export function DCLEAR_ALL({ context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  const drawingLayers = useAbmDrawingsStore.getState().byTheatre[theatre] ?? []
  if (!drawingLayers.length) return 'NOTHING TO CLEAR'
  updateWin({ pendingClearAllConfirm: true })
  return `CLEAR ALL ${drawingLayers.length} DRAWINGS? Y TO CONFIRM`
}

export function DCLEAR_NAME({ captures, context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  // Collapse internal whitespace, matching the original's tokenize-then-
  // rejoin (drawCmdTokens(str, raw).join(' ')) rather than a raw capture.
  const arg = captures.name.trim().split(/\s+/).join(' ')
  const drawingLayers = useAbmDrawingsStore.getState().byTheatre[theatre] ?? []
  const matches = drawingLayers.filter(l => l.name.toUpperCase() === arg.toUpperCase())
  if (!matches.length) return 'NOT FOUND'
  useAbmDrawingsStore.getState().removeLayersByName(theatre, arg)
  return matches.length > 1 ? `CLEARED ${matches.length} ${arg.toUpperCase()}` : `CLEARED ${matches[0].name}`
}

// ── Fixes / navaids ──────────────────────────────────────────────────────────

export function FIXES_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.fixesVisible
  prefs.setFixesVisible(next)
  return next ? 'FIXES ON' : 'FIXES OFF'
}

export function NAVAIDS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.navaidsVisible
  prefs.setNavaidsVisible(next)
  return next ? 'NAVAIDS ON' : 'NAVAIDS OFF'
}

// .fix — with no argument, clears all pinned fixes for this theatre.
export function FIX_CLEAR({ context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  const prefs = useAbmUiPrefsStore.getState()
  const merged = { ...prefs.pinnedFixes, [theatre]: [] }
  prefs.setPinnedFixes(merged)
  return 'FIX CLEARED'
}

// .fix <name...> — force-show one or more fixes regardless of .fixes
// visibility. Each name toggles independently (repeat to un-pin); persisted
// per-theatre so pins survive a reload.
export function FIX_PIN({ captures, context }) {
  const { theatre } = context
  if (!theatre) return 'NO THEATRE'
  const names = captures.names.trim().split(/\s+/).map(n => n.toUpperCase()).filter(Boolean)
  if (!names.length) return 'ILL VAL'
  // Pinning only affects rendering of the `fixes` layer, so validate against
  // that list rather than lookupFix's broader fix/navaid/runway/airport
  // search — a name that resolves elsewhere would never actually draw pinned.
  const knownIds = new Set(useNavdataStore.getState().fixes.map(f => f.id.toUpperCase()))
  const notFound = names.filter(n => !knownIds.has(n))
  if (notFound.length) return `${notFound.join(' ')} NOT FOUND`
  const prefs = useAbmUiPrefsStore.getState()
  const current = new Set(prefs.pinnedFixes[theatre] ?? [])
  for (const name of names) {
    if (current.has(name)) current.delete(name)
    else current.add(name)
  }
  const merged = { ...prefs.pinnedFixes, [theatre]: [...current] }
  prefs.setPinnedFixes(merged)
  return `FIX ${names.join(' ')}`
}

// .find <fix> — drops a green square marker at the looked-up fix/navaid,
// cleared by Escape or another .find.
export function FIND({ captures }) {
  const result = useNavdataStore.getState().lookupFix(captures.fix)
  if (!result) return 'NOT FOUND'
  updateWin({ findMarker: result })
  useAbmMissionStore.getState().clearFind() // this find isn't tied to a FRAG row
  return `FIND ${result.id}`
}

// Tactical brevity glossary lookup (ATP 1-02.1, see store/brevity.js). Shown
// in its own readout, not cmdFeedback — see AbmScope's defineEntry usage.
export function DEFINE({ captures }) {
  const result = useBrevityStore.getState().lookup(captures.term)
  if (!result) {
    updateWin({ defineEntry: null })
    return 'NOT FOUND'
  }
  updateWin({ defineEntry: result })
  return ''
}

// `.where <callsign>` — same effect as clicking a roster row's callsign in
// FRAG (Frag.jsx's toggleBlink): blinks that live contact's datablock on the
// scope so the controller can spot it. Prefix-matched against every live
// contact's resolveCallsign() output (matchLiveByPrefix, utils/callsign.js —
// the same helper manual ATO flights use to find their own roster), so it
// responds to a controller's own .rename override, not just the mission-file
// callsign. Ambiguous (multiple contacts share the prefix) or empty matches
// give NOT FOUND/AMBIGUOUS feedback and do nothing, rather than guessing —
// same terse feedback convention FIND/DEFINE already use.
export function WHERE({ captures, context }) {
  const matches = matchLiveByPrefix(captures.callsign, context.allVisibleUnits)
  if (matches.length === 0) return 'NOT FOUND'
  if (matches.length > 1) return 'AMBIGUOUS'
  useAbmMissionStore.getState().toggleBlink(matches[0].key)
  return `WHERE ${matches[0].callsign}`
}

// `.frag <callsign>` — text-argument sibling of the click-based `.frag` +
// click / Ctrl+Shift+click handlers in AbmScope.jsx's handleMouseUp: opens
// the FRAG panel for the flight that contact belongs to, without needing a
// click. Same prefix-match/ambiguity rules as WHERE above; the live contact's
// DCS groupID is then joined against useAbmMissionStore's flights (same join
// the click handlers use) and gated by the same own-coalition check (GM/admin
// sees every flight, blue/red sessions only their own side's).
export function FRAG_FIND({ captures, context }) {
  const matches = matchLiveByPrefix(captures.callsign, context.allVisibleUnits)
  if (matches.length === 0) return 'NOT FOUND'
  if (matches.length > 1) return 'AMBIGUOUS'
  const groupId = useAbmMissionStore.getState().resolveGroupIdForUnit(matches[0].unit)
  const flight = groupId != null
    ? useAbmMissionStore.getState().flights.find(f => f.groupId === groupId)
    : null
  const coalition = useSessionStore.getState().coalition
  const ownSide = coalition !== 'blue' && coalition !== 'red' || flight?.coalition === coalition
  if (!flight || !ownSide) return 'NO FRAG'
  useAbmMissionStore.getState().selectGroup(flight.groupId)
  return `FRAG ${matches[0].callsign}`
}

// `.route <callsign>` — text-argument sibling of the Ctrl+right-click/.route
// + click handlers in AbmScope.jsx. Same prefix-match/ambiguity/coalition
// rules as FRAG_FIND, but toggles routeGroupIds instead of calling
// selectGroup — this one deliberately never opens the FRAG panel.
export function ROUTE_FIND({ captures, context }) {
  const matches = matchLiveByPrefix(captures.callsign, context.allVisibleUnits)
  if (matches.length === 0) return 'NOT FOUND'
  if (matches.length > 1) return 'AMBIGUOUS'
  const groupId = useAbmMissionStore.getState().resolveGroupIdForUnit(matches[0].unit)
  const flight = groupId != null
    ? useAbmMissionStore.getState().flights.find(f => f.groupId === groupId)
    : null
  const coalition = useSessionStore.getState().coalition
  const ownSide = coalition !== 'blue' && coalition !== 'red' || flight?.coalition === coalition
  if (!flight || !ownSide) return 'NO ROUTE'
  const mission = useAbmMissionStore.getState()
  const wasOn = mission.routeGroupIds.includes(flight.groupId)
  mission.toggleRouteGroup(flight.groupId)
  return `ROUTE ${wasOn ? 'OFF' : 'ON'} ${matches[0].callsign}`
}

// `.rclear` — clears every route currently shown on the scope: both
// routeGroupIds (Ctrl+right-click/.route/.route <callsign>) and FRAG's own
// routeVisible toggle, so this is a full "hide all routes" regardless of
// which mechanism turned each one on. Separate from TCLEAR (RBL/BRAA/threat
// rings) by design — routes aren't tactical-picture clutter in the same
// sense, so they get their own dedicated clear command.
export function RCLEAR() {
  const mission = useAbmMissionStore.getState()
  mission.clearRouteGroups()
  mission.clearRouteVisible()
  return 'ROUTES CLEARED'
}

// ── Runways / polygons / grid / towns / raster layers ───────────────────────

export function RUNWAYS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.runwaysVisible
  prefs.setRunwaysVisible(next)
  return next ? 'RUNWAYS ON' : 'RUNWAYS OFF'
}

export function POLYGONS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.polygonsVisible
  prefs.setPolygonsVisible(next)
  return next ? 'POLYGONS ON' : 'POLYGONS OFF'
}

export function MGRS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.mgrsVisible
  prefs.setMgrsVisible(next)
  return next ? 'MGRS GRID ON' : 'MGRS GRID OFF'
}

export function TOWNS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.townsVisible
  prefs.setTownsVisible(next)
  return next ? 'TOWNS ON' : 'TOWNS OFF'
}

export function BASE_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.basemapVisible
  prefs.setBasemapVisible(next)
  return next ? 'BASE ON' : 'BASE OFF'
}

export function TERRAIN_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.terrainVisible
  prefs.setTerrainVisible(next)
  return next ? 'TERRAIN ON' : 'TERRAIN OFF'
}

// .map — bulk toggle for all four raster layers (base/terrain/water/roads)
// plus .geo's live coastline/boundary layer, same any-on pattern as .asp.
export function MAP_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const geoVisible = useGeoStore.getState().visible
  const anyOn = prefs.basemapVisible || prefs.terrainVisible || prefs.waterVisible || prefs.roadsVisible || geoVisible
  const next = !anyOn
  prefs.setBasemapVisible(next)
  prefs.setTerrainVisible(next)
  prefs.setWaterVisible(next)
  prefs.setRoadsVisible(next)
  useGeoStore.getState().setVisible(next)
  return next ? 'MAP ON' : 'MAP OFF'
}

export function WATER_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.waterVisible
  prefs.setWaterVisible(next)
  return next ? 'WATER ON' : 'WATER OFF'
}

export function ROADS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.roadsVisible
  prefs.setRoadsVisible(next)
  return next ? 'ROADS ON' : 'ROADS OFF'
}

// ── Cursor position readout / bullseye-on-cursor ────────────────────────────

export function COORDS_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.coordsVisible
  prefs.setCoordsVisible(next)
  return next ? 'COORDS ON' : 'COORDS OFF'
}

export function BEC_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.becVisible
  prefs.setBecVisible(next)
  return next ? 'BULLSEYE-ON-CURSOR ON' : 'BULLSEYE-ON-CURSOR OFF'
}

export function DDM() {
  useAbmUiPrefsStore.getState().setCoordFormat('ddm')
  return 'DDM — DEGREES DECIMAL MINUTES'
}

export function DMS() {
  useAbmUiPrefsStore.getState().setCoordFormat('dms')
  return 'DMS — DEGREES MINUTES SECONDS'
}

export function METERS() {
  useAbmUiPrefsStore.getState().setElevUnit('meters')
  return 'ELEV METERS'
}

export function FEET() {
  useAbmUiPrefsStore.getState().setElevUnit('feet')
  return 'ELEV FEET'
}

// ── Contact display commands (§3, 2026-07-05) ───────────────────────────────

export function PTL({ captures }) {
  const mins = parseFloat(captures.mins)
  if (mins < 0 || mins > 5) return 'INVALID: .PTL 0-5'
  updateWin({ ptlMinutes: mins })
  saveAbmPrefs({ ptlMinutes: mins })
  return mins === 0 ? 'PTL OFF' : `PTL ${mins}MIN`
}

export function FADED({ captures }) {
  const s = parseInt(captures.s, 10)
  updateWin({ fadedSeconds: s })
  saveAbmPrefs({ fadedSeconds: s })
  return `FADED ${s}S`
}

// .history — toggleable position-history trail. Bare `.history` toggles
// visibility; `.history <len>` sets trail length (0 = off); `.history <len>
// <rate>` also sets capture rate (seconds).
export function HISTORY_TOGGLE() {
  const win = getWin()
  const next = !(win?.historyVisible ?? true)
  updateWin({ historyVisible: next })
  saveAbmPrefs({ historyVisible: next })
  return next ? `HISTORY ${win?.historyLength ?? 4}/${win?.historyRate ?? 4.5}` : 'HISTORY OFF'
}

export function HISTORY_LEN_RATE({ captures }) {
  const len = Math.min(MAX_HISTORY, parseInt(captures.len, 10))
  const rate = parseFloat(captures.rate)
  if (len <= 0) {
    updateWin({ historyVisible: false })
    saveAbmPrefs({ historyVisible: false })
    return 'HISTORY OFF'
  }
  updateWin({ historyVisible: true, historyLength: len, historyRate: rate })
  saveAbmPrefs({ historyVisible: true, historyLength: len, historyRate: rate })
  return `HISTORY ${len}/${rate}`
}

export function HISTORY_LEN({ captures }) {
  const len = Math.min(MAX_HISTORY, parseInt(captures.len, 10))
  if (len <= 0) {
    updateWin({ historyVisible: false })
    saveAbmPrefs({ historyVisible: false })
    return 'HISTORY OFF'
  }
  updateWin({ historyVisible: true, historyLength: len })
  saveAbmPrefs({ historyVisible: true, historyLength: len })
  return `HISTORY ${len}/${getWin()?.historyRate ?? 4.5}`
}

export function DB_TOGGLE() {
  const next = !(getWin()?.dbVisible ?? true)
  updateWin({ dbVisible: next })
  saveAbmPrefs({ dbVisible: next })
  return next ? 'DATABLOCKS ON' : 'DATABLOCKS OFF'
}

// Clears every .db + click per-contact override (dbHiddenIds), returning all
// contacts to the global dbVisible/formation-suppression behavior.
export function DBRESET() {
  updateWin({ dbHiddenIds: [] })
  return 'DATABLOCKS RESET'
}

// Datablock collision avoidance (shared algorithm w/ CATCC, see
// utils/datablockPlacement.js). Off by default for ABM.
export function DBCA_TOGGLE() {
  const next = !(getWin()?.dbca ?? false)
  updateWin({ dbca: next })
  saveAbmPrefs({ dbca: next })
  return next ? 'DBCA ON' : 'DBCA OFF'
}

// Formation datablock suppression (§3, 2026-07-08): when two or more
// same-flight aircraft are within a 3NM box of the flight's lead, only the
// lead's datablock shows. On by default.
export function DBS_TOGGLE() {
  const next = !(getWin()?.dbSuppress ?? true)
  updateWin({ dbSuppress: next })
  saveAbmPrefs({ dbSuppress: next })
  return next ? 'DB SUPPRESSION ON' : 'DB SUPPRESSION OFF'
}

export function LDR({ captures }) {
  const length = parseInt(captures.length, 10)
  const dir = captures.dir
  updateWin({ ldrLength: length, ldrAngleDeg: DIR_TO_ANGLE[dir] })
  saveAbmPrefs({ ldrLength: length, ldrAngleDeg: DIR_TO_ANGLE[dir] })
  return `LDR ${length} ${dir}`
}

// ── BRAA line / bogey dope / threat rings — ported from AIC, same commands
// (2026-07-07). Ctrl+click/Alt+click/Ctrl+Alt+click/Shift+click and .dope +
// click are handled in handleMouseUp (bespoke); these are the Enter-only (no
// click) forms.

export function THREAT_CLEAR() {
  updateWin({ threatRings: [] })
  return 'THREAT RINGS CLEARED'
}

export function THREAT_RADIUS({ captures }) {
  const nm = parseFloat(captures.nm)
  updateWin({ threatRadius: nm })
  saveAbmPrefs({ threatRadius: nm })
  return `THREAT RING ${nm}NM`
}

// Clears RBL, BRAA/bogey-dope pairs, and threat rings (2026-07-07, renamed
// from .clear 2026-08-21 — see resources/specs/refactor-spec.md §10.3: the
// drawings `.clear` handler added a month later already matched bare
// `.clear` first, making the original binding unreachable — a real bug, not
// a deliberate redesign).
export function TCLEAR() {
  updateWin({ rbl: null, threatRings: [] })
  const abm = useAbmStore.getState()
  abm.braaList.forEach(p => abm.removeBraaPair(p.id))
  return 'ALL CLEARED'
}

// ── Bulk reclassification (2026-07-07) ──────────────────────────────────────
// `.class` alone returns every explicit declaration to its fog-of-war
// default; `.class <old> <new>` (letters f/n/b/h) reclassifies every
// currently-visible contact whose *effective* declaration is <old> to <new>
// — e.g. `.class b h` turns every bogey into a hostile. Applies across air +
// ground/naval (allVisibleUnits).

export function CLASS_RESET() {
  useAbmStore.getState().resetDeclarations()
  return 'CLASS RESET'
}

export function CLASS_RECLASSIFY({ captures, context }) {
  const oldDecl = CLASS_LETTER[captures.oldLetter]
  const newDecl = CLASS_LETTER[captures.newLetter]
  const { myCoalitionNum, allVisibleUnits } = context
  const abm = useAbmStore.getState()
  for (const [id, unit] of Object.entries(allVisibleUnits)) {
    if (abm.getEffectiveDeclaration(id, unit, myCoalitionNum) === oldDecl) {
      abm.setDeclaration(id, newDecl)
    }
  }
  return `CLASS ${oldDecl} → ${newDecl}`
}

// Toggles autoclassification (2026-07-08): ON sets every currently-visible
// air/ground/naval contact to its TRUE (coalition-based) classification
// right away, and AbmScope's own useEffect keeps auto-declaring newly-visible
// units from then on. OFF does not revert anything already classified, it
// just stops future auto-declaration. `.class` (no args) overrides this and
// turns it off.
export function AUTOCLASS({ context }) {
  const abm = useAbmStore.getState()
  const next = !abm.autoClassify
  abm.setAutoClassify(next)
  if (!next) return 'AUTOCLASS OFF'
  const { myCoalitionNum, allVisibleUnits } = context
  for (const [id, unit] of Object.entries(allVisibleUnits)) {
    abm.setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
  }
  return 'AUTOCLASS ON'
}

// Toggles automatic threat rings (2026-07-10): while on, every friendly
// aircraft within threatRadius of a HOSTILE/BOGEY aircraft gets its ring lit
// until the breach clears — see AbmScope's own useEffect.
export function AUTOTHREAT() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.autoThreat
  prefs.setAutoThreat(next)
  return next ? 'AUTOTHREAT ON' : 'AUTOTHREAT OFF'
}

// ROE is shared cross-module state (store/roe.js) — either an AIC or ABM
// controller can set it, and it syncs live to every other connected client.
export function ROE({ captures }) {
  const state = captures.state.toUpperCase() // 'FREE' | 'TIGHT' | 'HOLD'
  useRoeStore.getState().setRoe(ROE_STATE[state])
  return `WEAPONS ${state}`
}

export function ROE_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = !prefs.roeVisible
  prefs.setRoeVisible(next)
  return next ? 'ROE ON' : 'ROE OFF'
}

// ── Ground/naval acq/eng range-ring visibility (§7, 2026-07-07) ─────────────
// `.acq`/`.eng` toggle all four classifications' rings at once; `.acq h`/
// `.eng b` etc. toggle just that classification (f/n/b/h — matches the F-key
// declaration letters, b for BOGEY).

export function ACQ_CLASS({ captures }) {
  const decl = CLASS_LETTER[captures.letter]
  const prefs = useAbmUiPrefsStore.getState()
  const wasHidden = prefs.acqHidden.has(decl)
  const next = new Set(prefs.acqHidden)
  wasHidden ? next.delete(decl) : next.add(decl)
  prefs.setAcqHidden(next)
  return `ACQ ${decl} ${wasHidden ? 'ON' : 'OFF'}`
}

export function ACQ_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = prefs.acqHidden.size ? new Set() : new Set(ALL_DECLARATIONS)
  prefs.setAcqHidden(next)
  return next.size ? 'ACQ OFF' : 'ACQ ON'
}

export function ENG_CLASS({ captures }) {
  const decl = CLASS_LETTER[captures.letter]
  const prefs = useAbmUiPrefsStore.getState()
  const wasHidden = prefs.engHidden.has(decl)
  const next = new Set(prefs.engHidden)
  wasHidden ? next.delete(decl) : next.add(decl)
  prefs.setEngHidden(next)
  return `ENG ${decl} ${wasHidden ? 'ON' : 'OFF'}`
}

export function ENG_TOGGLE() {
  const prefs = useAbmUiPrefsStore.getState()
  const next = prefs.engHidden.size ? new Set() : new Set(ALL_DECLARATIONS)
  prefs.setEngHidden(next)
  return next.size ? 'ENG OFF' : 'ENG ON'
}

const ACTION_MAP = {
  RR_TOGGLE, RR_SET, RR_SET_ANCHOR,
  BE_RESET, BE_LATLNG, BE_FIX,
  TIME_TOGGLE, UNITRO_TOGGLE, GEO_TOGGLE, RELIEF_TOGGLE, HOLDS_TOGGLE, MORA_TOGGLE,
  AIRWAYS_TOGGLE, AIRWAYS_TYPE, ASP_TOGGLE, ASP_CATEGORY, ASPCOLORS, REFRESH,
  LABELS_TOGGLE, FILL_TOGGLE, FILL_SET, CUSTOM_TOGGLE, CUSTOM_NAME,
  LINE, RECT, CIRC, POLY, SECT, RACE, TEXT,
  DCLEAR_BARE, DCLEAR_ALL, DCLEAR_NAME,
  FIXES_TOGGLE, NAVAIDS_TOGGLE, FIX_CLEAR, FIX_PIN, FIND, DEFINE, WHERE, FRAG_FIND, ROUTE_FIND, RCLEAR,
  RUNWAYS_TOGGLE, POLYGONS_TOGGLE, MGRS_TOGGLE, TOWNS_TOGGLE, BASE_TOGGLE, TERRAIN_TOGGLE,
  MAP_TOGGLE, WATER_TOGGLE, ROADS_TOGGLE,
  COORDS_TOGGLE, BEC_TOGGLE, DDM, DMS, METERS, FEET,
  PTL, FADED, HISTORY_TOGGLE, HISTORY_LEN_RATE, HISTORY_LEN,
  DB_TOGGLE, DBRESET, DBCA_TOGGLE, DBS_TOGGLE, LDR,
  THREAT_CLEAR, THREAT_RADIUS, TCLEAR,
  CLASS_RESET, CLASS_RECLASSIFY, AUTOCLASS, AUTOTHREAT, ROE, ROE_TOGGLE,
  ACQ_CLASS, ACQ_TOGGLE, ENG_CLASS, ENG_TOGGLE,
}

/**
 * @param {{ command, captures }} parsed  commandParser.js's parseCommand() result
 * @param {object} context  { raw, theatre, declinationDeg, myCoalitionNum, allVisibleUnits }
 * @returns {Promise<string>} feedback message for cmdFeedback
 */
export async function dispatch(parsed, context) {
  const handler = ACTION_MAP[parsed.command.id]
  if (!handler) return `UNIMPLEMENTED: ${parsed.command.id}`
  return await handler({ captures: parsed.captures, context })
}
