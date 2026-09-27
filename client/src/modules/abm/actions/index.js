/**
 * ABM action library.
 *
 * Every command action is implemented here as a standalone function reading/
 * writing state via .getState() (never a closure) — same shape as AIC's
 * action library (modules/aic/actions/index.js) and STARS'.
 *
 * Each action receives:
 *   captures — named captures from commandParser.js
 *   context  — small set of caller-computed, non-store values that don't
 *              have an independent source of truth to read from .getState():
 *                raw             — the untouched, original-case command text
 *                                  (only the 7 draw commands need this, to
 *                                  preserve .text's label casing — everything
 *                                  else works fine from lowercased captures)
 *                windowId        — which displayStore.windows[] entry this
 *                                  scope instance owns ('abm-main', or
 *                                  'abm-focus-<callsign>' for a focus panel/
 *                                  popup — see AbmFocusPanel.jsx). getWin()/updateWin()
 *                                  take it explicitly rather than closing over
 *                                  a module constant, so a command typed in a
 *                                  focus popup never leaks into abm-main's state.
 *                theatre
 *                declinationDeg  — viewRef.current?.declinationDeg ?? 0
 *                                  (the view's declination, NOT the bullseye-
 *                                  relative one — draw commands only)
 *                myCoalitionNum
 *                allVisibleUnits — air+ground/naval union (.dec/.autodec only)
 *
 * Returns the command-feedback string to show the controller (never null).
 * AbmScope
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
 * AbmScope.jsx's execCommand wrapper.
 *
 * Every command with a persisted display setting pairs its updateWin(...)
 * call with an explicit saveAbmPrefs(...) call — updateWin sets the live
 * per-window value, saveAbmPrefs saves the seed default the next NEW window
 * inherits at open time (store/abmPrefs.js). This is the getWin/updateWin +
 * saveAbmPrefs pattern every per-window toggle in this file follows (see
 * store/abmPrefs.js header for why: a windowId-less shared store would make
 * toggling e.g. `.coords` in one ABM window leak into every other open one).
 */

import { useDisplayStore } from '../../../store/display.js'
import { useAbmFocusPanelsStore } from '../../../store/abmFocusPanels.js'
import { useAbmStore, DECLARATION, getAbmEffectiveDeclaration } from '../../../store/abm.js'
import { AUTO_DECLARE_MODE } from '../../../utils/createDeclarationStore.js'
import { useRoeStore, ROE_STATE } from '../../../store/roe.js'
import { loadAbmPrefs, saveAbmPrefs } from '../../../store/abmPrefs.js'
import { useNavdataStore } from '../../../store/navdata.js'
import { useAbmAirspaceStore } from '../../../store/abmAirspace.js'
import { useAbmDrawingsStore } from '../../../store/abmDrawings.js'
import { useAbmMissionStore } from '../../../store/abmMission.js'
import { useBrevityStore } from '../../../store/brevity.js'
import { useSessionStore } from '../../../store/session.js'
import { matchLiveByPrefix, sanitizeFocusToken } from '../../../utils/callsign.js'
import { DIR_TO_ANGLE } from '../../atc/stars/constants.js'
import { drawCmdTokens } from '../abmScopeHelpers.js'
import { trueDeclaration } from '../../../utils/tacticalHelpers.js'
import { parseDrawCommand } from '../draw/drawCommands.js'
import { navdataNotFound } from '../../../store/lnm.js'

const WINDOW_ID = 'abm-main'
const MAX_HISTORY = 10 // absolute cap on captured trail points, same as AbmScope.jsx's own constant

// .dec/.acq/.eng declaration letters — duplicated from AbmScope.jsx
// rather than imported, matching AIC's own DECLARATION_LETTER duplication
// convention (small, stable, per-scope constant — see that file's comment).
const DECLARATION_LETTER = {
  f: DECLARATION.FRIENDLY,
  n: DECLARATION.NEUTRAL,
  b: DECLARATION.BOGEY,
  h: DECLARATION.HOSTILE,
}
const ALL_DECLARATIONS = [DECLARATION.HOSTILE, DECLARATION.BOGEY, DECLARATION.NEUTRAL, DECLARATION.FRIENDLY]

// Per-category airspace toggles table.
const AIRSPACE_CATEGORIES = [
  'TMA', 'CTR', 'CTA', 'FIR', 'UIR', 'SUA', 'MIL', 'TRSA',
  'CLASS A', 'CLASS B', 'CLASS C', 'CLASS D', 'CLASS E', 'CLASS F', 'CLASS G',
]
const AIRSPACE_CMD_CATEGORY = {
  tma: 'TMA', ctr: 'CTR', cta: 'CTA', fir: 'FIR', uir: 'UIR', sua: 'SUA', mil: 'MIL', trsa: 'TRSA',
  classa: 'CLASS A', classb: 'CLASS B', classc: 'CLASS C', classd: 'CLASS D',
  classe: 'CLASS E', classf: 'CLASS F', classg: 'CLASS G',
}

function getWin(windowId) {
  return useDisplayStore.getState().windows[windowId ?? WINDOW_ID]
}

function updateWin(windowId, patch) {
  useDisplayStore.getState().updateWindow(windowId ?? WINDOW_ID, patch)
}

// ── Range rings ──────────────────────────────────────────────────────────────

export function RR_TOGGLE({ context }) {
  const on = !(getWin(context.windowId)?.ringsVisible ?? false)
  updateWin(context.windowId, { ringsVisible: on })
  saveAbmPrefs({ ringsVisible: on })
  return on ? `RANGE RINGS ${getWin(context.windowId)?.ringSpacingNm ?? 20}NM` : 'RANGE RINGS OFF'
}

export function RR_SET({ captures, context }) {
  const nm = parseFloat(captures.nm)
  if (nm <= 0) {
    updateWin(context.windowId, { ringsVisible: false })
    saveAbmPrefs({ ringsVisible: false })
    return 'RANGE RINGS OFF'
  }
  updateWin(context.windowId, { ringsVisible: true, ringSpacingNm: nm })
  saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
  return `RANGE RINGS ${nm}NM`
}

// ── Label / datablock size ──────────────────────────────────────────────────

export function LABELSIZE_SHOW({ context }) {
  return `LABELSIZE: ${getWin(context.windowId)?.csMap ?? 2}`
}

export function LABELSIZE_SET({ captures, context }) {
  const n = parseInt(captures.n, 10)
  if (isNaN(n) || n < 0 || n > 5) return 'ILL VAL'
  updateWin(context.windowId, { csMap: n })
  saveAbmPrefs({ csMap: n })
  return `LABELSIZE ${n}`
}

export function DBSIZE_SHOW({ context }) {
  return `DBSIZE: ${getWin(context.windowId)?.dbSize ?? 2}`
}

export function DBSIZE_SET({ captures, context }) {
  const n = parseInt(captures.n, 10)
  if (isNaN(n) || n < 0 || n > 5) return 'ILL VAL'
  updateWin(context.windowId, { dbSize: n })
  saveAbmPrefs({ dbSize: n })
  return `DBSIZE ${n}`
}

export function RR_SET_ANCHOR({ captures, context }) {
  const nm = parseFloat(captures.nm)
  const anchor = captures.anchor
  if (nm <= 0) {
    updateWin(context.windowId, { ringsVisible: false })
    saveAbmPrefs({ ringsVisible: false })
    return 'RANGE RINGS OFF'
  }
  if (anchor === 'bullseye' || anchor === 'bs') {
    updateWin(context.windowId, { ringsVisible: true, ringSpacingNm: nm, ringAnchorLat: null, ringAnchorLng: null, ringAnchorId: null })
    saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
    return `RANGE RINGS ${nm}NM @ BULLSEYE`
  }
  const result = useNavdataStore.getState().lookupFix(anchor)
  if (!result) return navdataNotFound('FIX NOT FOUND')
  // Anchor lat/lng/id intentionally excluded from saveAbmPrefs — mission-
  // specific fix, not a persisted preference (see store/abmPrefs.js header).
  updateWin(context.windowId, { ringsVisible: true, ringSpacingNm: nm, ringAnchorLat: result.lat, ringAnchorLng: result.lon, ringAnchorId: result.id })
  saveAbmPrefs({ ringsVisible: true, ringSpacingNm: nm })
  return `RANGE RINGS ${nm}NM @ ${result.id}`
}

// ── Bullseye override ────────────────────────────────────────────────────────

export function BE_RESET({ context }) {
  updateWin(context.windowId, { bullseyeOverride: null })
  return 'BULLSEYE RESET'
}

export function BE_LATLNG({ captures, context }) {
  const lat = parseFloat(captures.lat)
  const lng = parseFloat(captures.lng)
  updateWin(context.windowId, { bullseyeOverride: { lat, lng } })
  return `BULLSEYE SET ${lat.toFixed(2)}/${lng.toFixed(2)}`
}

export function BE_FIX({ captures, context }) {
  const result = useNavdataStore.getState().lookupFix(captures.fix)
  if (!result) return navdataNotFound('FIX NOT FOUND')
  updateWin(context.windowId, { bullseyeOverride: { lat: result.lat, lng: result.lon } })
  return `BULLSEYE SET @ ${result.id}`
}

// ── Navdata layer toggles ────────────────────────────────────────────────────

// Per-window: TIME/UNITRO/GEO/RELIEF/HOLDS/MORA/AIRWAYS/ASP read/write via
// getWin/updateWin (same as ROSE_TOGGLE), not a windowId-less shared store
// or the navdata-layer stores' single `visible` flag — otherwise toggling
// any of them in a `.focus` window would leak into every other open ABM
// window. useGeoStore/useReliefStore/useHoldingsStore/
// useMoraStore/useAirwaysStore themselves are untouched here — they're
// shared with STARS/CATCC/AIC (data fetch + cache, via loadForTheatre in
// AbmScope.jsx), which have no window multiplicity and keep reading those
// stores' own `visible` field directly; only ABM's copy of "is this layer
// on in THIS window" moved to windowSettings.

export function TIME_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.timeVisible ?? true)
  updateWin(context.windowId, { timeVisible: next })
  saveAbmPrefs({ timeVisible: next })
  return next ? 'TIME ON' : 'TIME OFF'
}

export function UNITRO_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.unitReadoutVisible ?? true)
  updateWin(context.windowId, { unitReadoutVisible: next })
  saveAbmPrefs({ unitReadoutVisible: next })
  return next ? 'UNIT READOUT ON' : 'UNIT READOUT OFF'
}

export function ROSE_TOGGLE({ context }) {
  const wasVisible = (getWin(context.windowId)?.briteCmp ?? 70) > 0
  updateWin(context.windowId, { briteCmp: wasVisible ? 0 : null })
  saveAbmPrefs({ compassVisible: !wasVisible })
  return wasVisible ? 'ROSE OFF' : 'ROSE ON'
}

export function GEO_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.geoVisible ?? true)
  updateWin(context.windowId, { geoVisible: next })
  saveAbmPrefs({ geoVisible: next })
  return next ? 'GEO ON' : 'GEO OFF'
}

export function RELIEF_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.reliefVisible ?? false)
  updateWin(context.windowId, { reliefVisible: next })
  saveAbmPrefs({ reliefVisible: next })
  return next ? 'RELIEF ON' : 'RELIEF OFF'
}

export function HOLDS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.holdingsVisible ?? false)
  updateWin(context.windowId, { holdingsVisible: next })
  saveAbmPrefs({ holdingsVisible: next })
  return next ? 'HOLDS ON' : 'HOLDS OFF'
}

export function MORA_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.moraVisible ?? false)
  updateWin(context.windowId, { moraVisible: next })
  saveAbmPrefs({ moraVisible: next })
  return next ? 'MORA ON' : 'MORA OFF'
}

export function AIRWAYS_TOGGLE({ context }) {
  const v = getWin(context.windowId)?.airwaysVisible ?? { V: false, J: false, B: false }
  const anyOn = v.V || v.J || v.B
  const next = { V: !anyOn, J: !anyOn, B: !anyOn }
  updateWin(context.windowId, { airwaysVisible: next })
  saveAbmPrefs({ airwaysVisible: next })
  return anyOn ? 'AIRWAYS OFF' : 'AIRWAYS ON'
}

export function AIRWAYS_TYPE({ captures, context }) {
  const type = captures.type.toUpperCase()
  const v = getWin(context.windowId)?.airwaysVisible ?? { V: false, J: false, B: false }
  const next = { ...v, [type]: !v[type] }
  updateWin(context.windowId, { airwaysVisible: next })
  saveAbmPrefs({ airwaysVisible: next })
  return `AIRWAYS ${type} ${next[type] ? 'ON' : 'OFF'}`
}

// .asp — bulk toggle: on if any category is
// currently visible, off otherwise, same anyOn pattern as .airways.
export function ASP_TOGGLE({ context }) {
  const asVisible = getWin(context.windowId)?.asVisible ?? {}
  const anyOn = AIRSPACE_CATEGORIES.some(c => asVisible[c])
  const next = anyOn ? {} : Object.fromEntries(AIRSPACE_CATEGORIES.map(c => [c, true]))
  updateWin(context.windowId, { asVisible: next })
  saveAbmPrefs({ asVisible: next })
  return anyOn ? 'AIRSPACE OFF' : 'AIRSPACE ON'
}

// Per-category airspace toggles — .tma/.ctr/.cta/.fir/.uir/.sua/
// .mil/.trsa/.classa-.classg. No procedure commands (SID/STAR/APPCH stay
// display-only, per direction).
export function ASP_CATEGORY({ captures, context }) {
  const cat = AIRSPACE_CMD_CATEGORY[captures.cat]
  const asVisible = getWin(context.windowId)?.asVisible ?? {}
  const next = { ...asVisible, [cat]: !asVisible[cat] }
  updateWin(context.windowId, { asVisible: next })
  saveAbmPrefs({ asVisible: next })
  return `${cat} ${next[cat] ? 'ON' : 'OFF'}`
}

// Same commands STARS uses for airspace palettes, reimplemented against
// useAbmAirspaceStore's own palette state rather than useMapsStore's, which
// is STARS-only (see store/abmAirspace.js). features/palettes stay global
// (shared fetch, also read by CatccScope.jsx); the *selected* palette index
// is per-window (aspColorIdx) for ABM's own canvas rendering, but this also
// still updates the shared store's paletteIdx so Drawings.jsx's single,
// non-windowed CUSTOM-color preview stays in sync (see store/abmAirspace.js
// header — that field was always meant to be a single global value for that
// one consumer, not a per-ABM-window one).
export async function ASPCOLORS({ captures, context }) {
  const name = captures.name.trim().toUpperCase()
  await useAbmAirspaceStore.getState().refreshPalettes()
  const palettes = useAbmAirspaceStore.getState().palettes
  const idx = palettes.findIndex(p => p.name.toUpperCase() === name)
  if (idx < 0) return 'INVALID PALETTE'
  updateWin(context.windowId, { aspColorIdx: idx })
  saveAbmPrefs({ aspColorIdx: idx })
  useAbmAirspaceStore.getState().setPaletteIdx(idx)
  return `ASP COLORS: ${palettes[idx].name.toUpperCase()}`
}

export async function REFRESH() {
  const success = await useAbmAirspaceStore.getState().refreshPalettes()
  return success ? 'PALETTES REFRESHED' : 'REFRESH FAILED'
}

// .labels/.lbl/.label — name-label toggle for both airspace and
// custom-drawing layers.
export function LABELS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.labelsVisible ?? false)
  updateWin(context.windowId, { labelsVisible: next })
  saveAbmPrefs({ labelsVisible: next })
  return next ? 'LABELS ON' : 'LABELS OFF'
}

// .fill — toggle airspace polygon fill, remembering the last percentage used.
export function FILL_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.fillVisible ?? false)
  updateWin(context.windowId, { fillVisible: next })
  saveAbmPrefs({ fillVisible: next })
  return next ? 'FILL ON' : 'FILL OFF'
}

export function FILL_SET({ captures, context }) {
  const pct = parseInt(captures.pct, 10)
  if (pct < 1 || pct > 100) return 'ILL VAL'
  updateWin(context.windowId, { fillVisible: true, fillPct: pct })
  saveAbmPrefs({ fillVisible: true, fillPct: pct })
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
  const { raw, theatre, declinationDeg, windowId } = context
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
  updateWin(windowId, { pendingDraw: result.pending })
  return DRAW_PENDING_FEEDBACK[type]
}

export function LINE({ context }) { return handleDrawCommand('line', { context }) }
export function RECT({ context }) { return handleDrawCommand('rect', { context }) }
export function CIRC({ context }) { return handleDrawCommand('circ', { context }) }
export function POLY({ context }) { return handleDrawCommand('poly', { context }) }
export function SECT({ context }) { return handleDrawCommand('sect', { context }) }
export function RACE({ context }) { return handleDrawCommand('race', { context }) }
export function TEXT({ context }) { return handleDrawCommand('text', { context }) }

// ── Clear (drawings only; RBL/BRAA/threat-ring bulk-clear is TCLEAR below) ──
// .dclear reads distinctly from TCLEAR's own tactical-clear command — the
// `d`/`t` prefix segments "clear a drawing" from
// "clear RBL/BRAA/threat rings" at a glance. Bare/click form arms
// pendingClearClick (handled in AbmScope.jsx's handleMouseUp, bespoke);
// `.dclear all` arms pendingClearAllConfirm instead, intercepted by
// AbmScope.jsx's execCommand wrapper on the NEXT submitted line as a bare
// yes/no answer (also bespoke — see this file's header).

export function DCLEAR_BARE({ context }) {
  const { theatre, windowId } = context
  if (!theatre) return 'NO THEATRE'
  updateWin(windowId, { pendingDraw: null, pendingClearClick: true })
  return 'CLEAR: CLICK A DRAWING'
}

export function DCLEAR_ALL({ context }) {
  const { theatre, windowId } = context
  if (!theatre) return 'NO THEATRE'
  const drawingLayers = useAbmDrawingsStore.getState().byTheatre[theatre] ?? []
  if (!drawingLayers.length) return 'NOTHING TO CLEAR'
  updateWin(windowId, { pendingClearAllConfirm: true })
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

export function FIXES_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.fixesVisible ?? false)
  updateWin(context.windowId, { fixesVisible: next })
  saveAbmPrefs({ fixesVisible: next })
  return next ? 'FIXES ON' : 'FIXES OFF'
}

export function NAVAIDS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.navaidsVisible ?? false)
  updateWin(context.windowId, { navaidsVisible: next })
  saveAbmPrefs({ navaidsVisible: next })
  return next ? 'NAVAIDS ON' : 'NAVAIDS OFF'
}

// .fix — with no argument, clears all pinned fixes for this theatre.
export function FIX_CLEAR({ context }) {
  const { theatre, windowId } = context
  if (!theatre) return 'NO THEATRE'
  const pinnedFixes = getWin(windowId)?.pinnedFixes ?? {}
  const merged = { ...pinnedFixes, [theatre]: [] }
  updateWin(windowId, { pinnedFixes: merged })
  saveAbmPrefs({ pinnedFixes: merged })
  return 'FIX CLEARED'
}

// .fix <name...> — force-show one or more fixes regardless of .fixes
// visibility. Each name toggles independently (repeat to un-pin); persisted
// per-theatre so pins survive a reload.
export function FIX_PIN({ captures, context }) {
  const { theatre, windowId } = context
  if (!theatre) return 'NO THEATRE'
  const names = captures.names.trim().split(/\s+/).map(n => n.toUpperCase()).filter(Boolean)
  if (!names.length) return 'ILL VAL'
  // Pinning only affects rendering of the `fixes` layer, so validate against
  // that list rather than lookupFix's broader fix/navaid/runway/airport
  // search — a name that resolves elsewhere would never actually draw pinned.
  const knownIds = new Set(useNavdataStore.getState().fixes.map(f => f.id.toUpperCase()))
  const notFound = names.filter(n => !knownIds.has(n))
  if (notFound.length) return navdataNotFound(`${notFound.join(' ')} NOT FOUND`)
  const pinnedFixes = getWin(windowId)?.pinnedFixes ?? {}
  const current = new Set(pinnedFixes[theatre] ?? [])
  for (const name of names) {
    if (current.has(name)) current.delete(name)
    else current.add(name)
  }
  const merged = { ...pinnedFixes, [theatre]: [...current] }
  updateWin(windowId, { pinnedFixes: merged })
  saveAbmPrefs({ pinnedFixes: merged })
  return `FIX ${names.join(' ')}`
}

// .find <fix> — drops a green square marker at the looked-up fix/navaid,
// cleared by Escape or another .find.
export function FIND({ captures, context }) {
  const result = useNavdataStore.getState().lookupFix(captures.fix)
  if (!result) return navdataNotFound()
  updateWin(context.windowId, { findMarker: result })
  useAbmMissionStore.getState().clearFind() // this find isn't tied to a FRAG row
  return `FIND ${result.id}`
}

// Tactical brevity glossary lookup (ATP 1-02.1, see store/brevity.js). Shown
// in its own readout, not cmdFeedback — see AbmScope's defineEntry usage.
export function DEFINE({ captures, context }) {
  const result = useBrevityStore.getState().lookup(captures.term)
  if (!result) {
    updateWin(context.windowId, { defineEntry: null })
    return 'NOT FOUND'
  }
  updateWin(context.windowId, { defineEntry: result })
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

// ── FRAG / route finding ─────────────────────────────────────────────────────

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

// ── Focus-panel window management ────────────────────────────────────────────

// `.focus <callsign> [range]` — opens (or brings to front / live-updates the
// range of) an in-page floating focus panel (AbmFocusPanel.jsx) permanently
// centered on that live contact. Exported so AbmScope.jsx's
// double-click-a-contact handler can reuse the exact same logic. If a panel
// for this callsign is already open, this just pushes the new range straight
// into its displayStore window and brings it to front — no need to reopen.
export function openAbmFocusPanel(callsign, rangeNm) {
  const windowId = `abm-focus-${sanitizeFocusToken(callsign)}`
  const panels = useAbmFocusPanelsStore.getState()
  if (panels.order.includes(callsign)) {
    useDisplayStore.getState().updateWindow(windowId, { rangeNm })
    panels.bringToFront(callsign)
    return
  }
  panels.openPanel(callsign, rangeNm)
}

// The focus panel's own "pop out" button hands off to a real OS popup
// (AbmFocusWindow.jsx) for anyone who wants it on a separate monitor / truly
// always-on-top of the OS — window.open()'s native same-name behavior
// (navigates/refocuses an already-open window sharing that name, rather than
// opening a duplicate) means popping the same callsign out twice reuses the
// same popup — see sanitizeFocusToken's header (utils/callsign.js) for why
// the popup name and the focus scope's own windowId are derived identically.
export function popOutAbmFocusPanel(callsign, rangeNm) {
  const token = sanitizeFocusToken(callsign)
  // facilityId/positionName scope the popup's cross-window sync to this
  // position, the same as every other pop-out (see App.jsx's makeUndockHandler).
  const { facilityId, positionName } = useSessionStore.getState()
  const params = new URLSearchParams({ window: 'abm-focus', callsign, range: String(rangeNm), facilityId, positionName })
  const popup = window.open(`/?${params}`, `abm-focus-${token}`, 'width=520,height=580,resizable=yes')
  popup?.focus()
}

// Bare `.focus <range>` (digits only — see commandParser.js's ordering
// against FOCUS_OPEN/FOCUS_OPEN_RANGE) sets the default range used whenever
// a `.focus <callsign>` / double-click doesn't specify one. Opens no panel.
export function FOCUS_DEFAULT_RANGE({ captures }) {
  const nm = parseFloat(captures.nm)
  if (!(nm > 0)) return 'ILL VAL'
  saveAbmPrefs({ focusDefaultRangeNm: nm })
  return `FOCUS RANGE ${nm}NM`
}

export function FOCUS_OPEN_RANGE({ captures, context }) {
  const matches = matchLiveByPrefix(captures.callsign, context.allVisibleUnits)
  if (matches.length === 0) return 'NOT FOUND'
  if (matches.length > 1) return 'AMBIGUOUS'
  const nm = parseFloat(captures.nm)
  openAbmFocusPanel(matches[0].callsign, nm)
  return `FOCUS ${matches[0].callsign} ${nm}NM`
}

export function FOCUS_OPEN({ captures, context }) {
  const matches = matchLiveByPrefix(captures.callsign, context.allVisibleUnits)
  if (matches.length === 0) return 'NOT FOUND'
  if (matches.length > 1) return 'AMBIGUOUS'
  const nm = loadAbmPrefs().focusDefaultRangeNm ?? 20
  openAbmFocusPanel(matches[0].callsign, nm)
  return `FOCUS ${matches[0].callsign} ${nm}NM`
}

// ── Runways / polygons / grid / towns / raster layers ───────────────────────

export function RUNWAYS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.runwaysVisible ?? false)
  updateWin(context.windowId, { runwaysVisible: next })
  saveAbmPrefs({ runwaysVisible: next })
  return next ? 'RUNWAYS ON' : 'RUNWAYS OFF'
}

export function POLYGONS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.polygonsVisible ?? false)
  updateWin(context.windowId, { polygonsVisible: next })
  saveAbmPrefs({ polygonsVisible: next })
  return next ? 'POLYGONS ON' : 'POLYGONS OFF'
}

export function MGRS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.mgrsVisible ?? false)
  updateWin(context.windowId, { mgrsVisible: next })
  saveAbmPrefs({ mgrsVisible: next })
  return next ? 'MGRS GRID ON' : 'MGRS GRID OFF'
}

export function TOWNS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.townsVisible ?? false)
  updateWin(context.windowId, { townsVisible: next })
  saveAbmPrefs({ townsVisible: next })
  return next ? 'TOWNS ON' : 'TOWNS OFF'
}

export function BASE_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.basemapVisible ?? false)
  updateWin(context.windowId, { basemapVisible: next })
  saveAbmPrefs({ basemapVisible: next })
  return next ? 'BASE ON' : 'BASE OFF'
}

export function TERRAIN_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.terrainVisible ?? false)
  updateWin(context.windowId, { terrainVisible: next })
  saveAbmPrefs({ terrainVisible: next })
  return next ? 'TERRAIN ON' : 'TERRAIN OFF'
}

// .map — bulk toggle for all four raster layers (base/terrain/water/roads)
// plus .geo's live coastline/boundary layer, same any-on pattern as .asp.
export function MAP_TOGGLE({ context }) {
  const win = getWin(context.windowId)
  const anyOn = (win?.basemapVisible ?? false) || (win?.terrainVisible ?? false) ||
    (win?.waterVisible ?? false) || (win?.roadsVisible ?? false) || (win?.geoVisible ?? true)
  const next = !anyOn
  const patch = { basemapVisible: next, terrainVisible: next, waterVisible: next, roadsVisible: next, geoVisible: next }
  updateWin(context.windowId, patch)
  saveAbmPrefs(patch)
  return next ? 'MAP ON' : 'MAP OFF'
}

export function WATER_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.waterVisible ?? false)
  updateWin(context.windowId, { waterVisible: next })
  saveAbmPrefs({ waterVisible: next })
  return next ? 'WATER ON' : 'WATER OFF'
}

export function ROADS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.roadsVisible ?? false)
  updateWin(context.windowId, { roadsVisible: next })
  saveAbmPrefs({ roadsVisible: next })
  return next ? 'ROADS ON' : 'ROADS OFF'
}

// ── Cursor position readout / bullseye-on-cursor / bullseye-on-datablock ───

export function COORDS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.coordsVisible ?? false)
  updateWin(context.windowId, { coordsVisible: next })
  saveAbmPrefs({ coordsVisible: next })
  return next ? 'COORDS ON' : 'COORDS OFF'
}

export function BEC_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.becVisible ?? false)
  updateWin(context.windowId, { becVisible: next })
  saveAbmPrefs({ becVisible: next })
  return next ? 'BULLSEYE-ON-CURSOR ON' : 'BULLSEYE-ON-CURSOR OFF'
}

// .bedb — adds a 3rd datablock line per contact: bearing/range from
// bullseye (e.g. "090/20"), same magnetic-bearing convention as .bec/.coords'
// bullseye readout (drawAbmContacts.js). Off by default.
export function BEDB_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.bedbVisible ?? false)
  updateWin(context.windowId, { bedbVisible: next })
  saveAbmPrefs({ bedbVisible: next })
  return next ? 'BULLSEYE DATABLOCK ON' : 'BULLSEYE DATABLOCK OFF'
}

// .malert — feature toggle for enemy missile-launch alerting (sound + blink,
// see missileAlert/useMissileAlertTracker.js). Independent of .vol: this
// gates whether the alert is computed at all, .vol only scales its tone.
export function MALERT_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.missileAlertEnabled ?? true)
  updateWin(context.windowId, { missileAlertEnabled: next })
  saveAbmPrefs({ missileAlertEnabled: next })
  return next ? 'MISSILE ALERT ON' : 'MISSILE ALERT OFF'
}

// .vol [0-10] — master volume for ABM alert tones (0 = mute). Shared knob
// for any alert channel, not just missile-launch (currently its only
// consumer) — same role as STARS' windowSettings.vol.
export function VOL_SHOW({ context }) {
  return `VOL: ${getWin(context.windowId)?.alertVol ?? 10}`
}

export function VOL_SET({ captures, context }) {
  const n = parseInt(captures.n, 10)
  if (isNaN(n) || n < 0 || n > 10) return 'ILL VAL'
  updateWin(context.windowId, { alertVol: n })
  saveAbmPrefs({ alertVol: n })
  return `VOL ${n}`
}

export function DDM({ context }) {
  updateWin(context.windowId, { coordFormat: 'ddm' })
  saveAbmPrefs({ coordFormat: 'ddm' })
  return 'DDM — DEGREES DECIMAL MINUTES'
}

export function DMS({ context }) {
  updateWin(context.windowId, { coordFormat: 'dms' })
  saveAbmPrefs({ coordFormat: 'dms' })
  return 'DMS — DEGREES MINUTES SECONDS'
}

export function METERS({ context }) {
  updateWin(context.windowId, { elevUnit: 'meters' })
  saveAbmPrefs({ elevUnit: 'meters' })
  return 'ELEV METERS'
}

export function FEET({ context }) {
  updateWin(context.windowId, { elevUnit: 'feet' })
  saveAbmPrefs({ elevUnit: 'feet' })
  return 'ELEV FEET'
}

// ── Contact display commands ─────────────────────────────────────────────────

export function PTL({ captures, context }) {
  const mins = parseFloat(captures.mins)
  if (mins < 0 || mins > 5) return 'INVALID: .PTL 0-5'
  updateWin(context.windowId, { ptlMinutes: mins })
  saveAbmPrefs({ ptlMinutes: mins })
  return mins === 0 ? 'PTL OFF' : `PTL ${mins}MIN`
}

export function FADED({ captures, context }) {
  const s = parseInt(captures.s, 10)
  updateWin(context.windowId, { fadedSeconds: s })
  saveAbmPrefs({ fadedSeconds: s })
  return `FADED ${s}S`
}

// .history — toggleable position-history trail. Bare `.history` toggles
// visibility; `.history <len>` sets trail length (0 = off); `.history <len>
// <rate>` also sets capture rate (seconds).
export function HISTORY_TOGGLE({ context }) {
  const win = getWin(context.windowId)
  const next = !(win?.historyVisible ?? true)
  updateWin(context.windowId, { historyVisible: next })
  saveAbmPrefs({ historyVisible: next })
  return next ? `HISTORY ${win?.historyLength ?? 4}/${win?.historyRate ?? 4.5}` : 'HISTORY OFF'
}

export function HISTORY_LEN_RATE({ captures, context }) {
  const len = Math.min(MAX_HISTORY, parseInt(captures.len, 10))
  const rate = parseFloat(captures.rate)
  if (len <= 0) {
    updateWin(context.windowId, { historyVisible: false })
    saveAbmPrefs({ historyVisible: false })
    return 'HISTORY OFF'
  }
  updateWin(context.windowId, { historyVisible: true, historyLength: len, historyRate: rate })
  saveAbmPrefs({ historyVisible: true, historyLength: len, historyRate: rate })
  return `HISTORY ${len}/${rate}`
}

export function HISTORY_LEN({ captures, context }) {
  const len = Math.min(MAX_HISTORY, parseInt(captures.len, 10))
  if (len <= 0) {
    updateWin(context.windowId, { historyVisible: false })
    saveAbmPrefs({ historyVisible: false })
    return 'HISTORY OFF'
  }
  updateWin(context.windowId, { historyVisible: true, historyLength: len })
  saveAbmPrefs({ historyVisible: true, historyLength: len })
  return `HISTORY ${len}/${getWin(context.windowId)?.historyRate ?? 4.5}`
}

export function DB_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.dbVisible ?? true)
  updateWin(context.windowId, { dbVisible: next })
  saveAbmPrefs({ dbVisible: next })
  return next ? 'DATABLOCKS ON' : 'DATABLOCKS OFF'
}

// Clears every .db + click per-contact override (dbHiddenIds), returning all
// contacts to the global dbVisible/formation-suppression behavior.
export function DBRESET({ context }) {
  updateWin(context.windowId, { dbHiddenIds: [] })
  return 'DATABLOCKS RESET'
}

// Datablock collision avoidance (shared algorithm w/ CATCC, see
// utils/datablockPlacement.js). Off by default for ABM.
export function DBCA_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.dbca ?? false)
  updateWin(context.windowId, { dbca: next })
  saveAbmPrefs({ dbca: next })
  return next ? 'DBCA ON' : 'DBCA OFF'
}

// Formation datablock suppression: when two or more
// same-flight aircraft are within a 3NM box of the flight's lead, only the
// lead's datablock shows. On by default.
export function DBS_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.dbSuppress ?? true)
  updateWin(context.windowId, { dbSuppress: next })
  saveAbmPrefs({ dbSuppress: next })
  return next ? 'DB SUPPRESSION ON' : 'DB SUPPRESSION OFF'
}

export function LDR({ captures, context }) {
  const length = parseInt(captures.length, 10)
  const dir = captures.dir
  updateWin(context.windowId, { ldrLength: length, ldrAngleDeg: DIR_TO_ANGLE[dir] })
  saveAbmPrefs({ ldrLength: length, ldrAngleDeg: DIR_TO_ANGLE[dir] })
  return `LDR ${length} ${dir}`
}

// ── BRAA line / bogey dope / threat rings — ported from AIC, same commands.
// Ctrl+click/Alt+click/Ctrl+Alt+click/Shift+click and .dope +
// click are handled in handleMouseUp (bespoke); these are the Enter-only (no
// click) forms.

export function THREAT_CLEAR({ context }) {
  updateWin(context.windowId, { threatRings: [] })
  return 'THREAT RINGS CLEARED'
}

export function THREAT_RADIUS({ captures, context }) {
  const nm = parseFloat(captures.nm)
  updateWin(context.windowId, { threatRadius: nm })
  saveAbmPrefs({ threatRadius: nm })
  return `THREAT RING ${nm}NM`
}

// Clears RBL, BRAA/bogey-dope pairs, and threat rings (.tclear — distinct
// from the drawings-only .dclear above).
export function TCLEAR({ context }) {
  updateWin(context.windowId, { rbl: null, threatRings: [] })
  const abm = useAbmStore.getState()
  abm.braaList.forEach(p => abm.removeBraaPair(p.id))
  return 'ALL CLEARED'
}

// ── Bulk redeclaration ───────────────────────────────────────────────────────
// `.dec` alone returns every explicit declaration to its fog-of-war
// default; `.dec <old> <new>` (letters f/n/b/h) redeclares every
// currently-visible contact whose *effective* declaration is <old> to <new>
// — e.g. `.dec b h` turns every bogey into a hostile. Applies across air +
// ground/naval (allVisibleUnits).

export function DECLARATION_RESET() {
  useAbmStore.getState().resetDeclarations()
  return 'DEC RESET'
}

export function DECLARATION_SET_BULK({ captures, context }) {
  const oldDecl = DECLARATION_LETTER[captures.oldLetter]
  const newDecl = DECLARATION_LETTER[captures.newLetter]
  const { myCoalitionNum, allVisibleUnits } = context
  const abm = useAbmStore.getState()
  for (const [id, unit] of Object.entries(allVisibleUnits)) {
    if (getAbmEffectiveDeclaration(id, unit, myCoalitionNum) === oldDecl) {
      abm.setDeclaration(id, newDecl)
    }
  }
  return `DEC ${oldDecl} → ${newDecl}`
}

// .autodec — declares every currently-visible undeclared air/ground/naval
// contact to its TRUE (coalition-based) declaration right away, and
// AbmScope's own useEffect keeps auto-declaring newly-visible units from then
// on. Mutually exclusive with .autodec iff. Turning either off does not
// revert anything already declared, it just stops future auto-declaration.
// `.dec` (no args) overrides this and turns it back off.
export function AUTO_DECLARE({ context }) {
  const abm = useAbmStore.getState()
  const next = abm.autoDeclareMode === AUTO_DECLARE_MODE.COALITION ? AUTO_DECLARE_MODE.OFF : AUTO_DECLARE_MODE.COALITION
  abm.setAutoDeclareMode(next)
  if (next === AUTO_DECLARE_MODE.OFF) return 'AUTODEC OFF'
  const { myCoalitionNum, allVisibleUnits } = context
  for (const [id, unit] of Object.entries(allVisibleUnits)) {
    abm.setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
  }
  return 'AUTODEC ON'
}

// .autodec iff — FRIENDLY-only auto-declare: a non-srsCapable same-coalition
// contact declares unconditionally, same as always; an srsCapable
// same-coalition contact declares only when correlationEngine.js's
// computeCorrelations has bound it to a FRAG-assigned aircraft (any of Mode
// 1/2/3/4 matching, plus the callsign safety net). Never declares
// HOSTILE/NEUTRAL/BOGEY. Mutually exclusive with plain .autodec.
export function AUTO_DECLARE_IFF({ context }) {
  const abm = useAbmStore.getState()
  const next = abm.autoDeclareMode === AUTO_DECLARE_MODE.IFF ? AUTO_DECLARE_MODE.OFF : AUTO_DECLARE_MODE.IFF
  abm.setAutoDeclareMode(next)
  if (next === AUTO_DECLARE_MODE.OFF) return 'AUTODEC IFF OFF'
  const { myCoalitionNum, allVisibleUnits, correlatedUnitIds } = context
  for (const [id, unit] of Object.entries(allVisibleUnits)) {
    if (trueDeclaration(unit, myCoalitionNum) !== DECLARATION.FRIENDLY) continue
    if (unit.srsCapable && !correlatedUnitIds?.has(String(id))) continue
    abm.setDeclaration(id, DECLARATION.FRIENDLY)
  }
  return 'AUTODEC IFF ON'
}

// Toggles automatic threat rings: while on, every friendly
// aircraft within threatRadius of a HOSTILE/BOGEY aircraft gets its ring lit
// until the breach clears — see AbmScope's own useEffect.
export function AUTOTHREAT({ context }) {
  const next = !(getWin(context.windowId)?.autoThreat ?? false)
  updateWin(context.windowId, { autoThreat: next })
  saveAbmPrefs({ autoThreat: next })
  return next ? 'AUTOTHREAT ON' : 'AUTOTHREAT OFF'
}

// ROE is shared cross-module state (store/roe.js) — either an AIC or ABM
// controller can set it, and it syncs live to every other connected client.
export function ROE({ captures }) {
  const state = captures.state.toUpperCase() // 'FREE' | 'TIGHT' | 'HOLD'
  useRoeStore.getState().setRoe(ROE_STATE[state])
  return `WEAPONS ${state}`
}

export function ROE_TOGGLE({ context }) {
  const next = !(getWin(context.windowId)?.roeVisible ?? true)
  updateWin(context.windowId, { roeVisible: next })
  saveAbmPrefs({ roeVisible: next })
  return next ? 'ROE ON' : 'ROE OFF'
}

// ── Ground/naval acq/eng range-ring visibility ───────────────────────────────
// `.acq`/`.eng` toggle all four declarations' rings at once; `.acq h`/
// `.eng b` etc. toggle just that declaration (f/n/b/h — matches the F-key
// declaration letters, b for BOGEY).

export function ACQ_DECL({ captures, context }) {
  const decl = DECLARATION_LETTER[captures.letter]
  const acqHidden = getWin(context.windowId)?.acqHidden ?? new Set()
  const wasHidden = acqHidden.has(decl)
  const next = new Set(acqHidden)
  wasHidden ? next.delete(decl) : next.add(decl)
  updateWin(context.windowId, { acqHidden: next })
  saveAbmPrefs({ acqHidden: [...next] })
  return `ACQ ${decl} ${wasHidden ? 'ON' : 'OFF'}`
}

export function ACQ_TOGGLE({ context }) {
  const acqHidden = getWin(context.windowId)?.acqHidden ?? new Set()
  const next = acqHidden.size ? new Set() : new Set(ALL_DECLARATIONS)
  updateWin(context.windowId, { acqHidden: next })
  saveAbmPrefs({ acqHidden: [...next] })
  return next.size ? 'ACQ OFF' : 'ACQ ON'
}

export function ENG_DECL({ captures, context }) {
  const decl = DECLARATION_LETTER[captures.letter]
  const engHidden = getWin(context.windowId)?.engHidden ?? new Set()
  const wasHidden = engHidden.has(decl)
  const next = new Set(engHidden)
  wasHidden ? next.delete(decl) : next.add(decl)
  updateWin(context.windowId, { engHidden: next })
  saveAbmPrefs({ engHidden: [...next] })
  return `ENG ${decl} ${wasHidden ? 'ON' : 'OFF'}`
}

export function ENG_TOGGLE({ context }) {
  const engHidden = getWin(context.windowId)?.engHidden ?? new Set()
  const next = engHidden.size ? new Set() : new Set(ALL_DECLARATIONS)
  updateWin(context.windowId, { engHidden: next })
  saveAbmPrefs({ engHidden: [...next] })
  return next.size ? 'ENG OFF' : 'ENG ON'
}

const ACTION_MAP = {
  RR_TOGGLE, RR_SET, RR_SET_ANCHOR,
  LABELSIZE_SHOW, LABELSIZE_SET, DBSIZE_SHOW, DBSIZE_SET,
  BE_RESET, BE_LATLNG, BE_FIX,
  TIME_TOGGLE, UNITRO_TOGGLE, ROSE_TOGGLE, GEO_TOGGLE, RELIEF_TOGGLE, HOLDS_TOGGLE, MORA_TOGGLE,
  AIRWAYS_TOGGLE, AIRWAYS_TYPE, ASP_TOGGLE, ASP_CATEGORY, ASPCOLORS, REFRESH,
  LABELS_TOGGLE, FILL_TOGGLE, FILL_SET, CUSTOM_TOGGLE, CUSTOM_NAME,
  LINE, RECT, CIRC, POLY, SECT, RACE, TEXT,
  DCLEAR_BARE, DCLEAR_ALL, DCLEAR_NAME,
  FIXES_TOGGLE, NAVAIDS_TOGGLE, FIX_CLEAR, FIX_PIN, FIND, DEFINE, WHERE, FRAG_FIND, ROUTE_FIND, RCLEAR,
  FOCUS_DEFAULT_RANGE, FOCUS_OPEN_RANGE, FOCUS_OPEN,
  RUNWAYS_TOGGLE, POLYGONS_TOGGLE, MGRS_TOGGLE, TOWNS_TOGGLE, BASE_TOGGLE, TERRAIN_TOGGLE,
  MAP_TOGGLE, WATER_TOGGLE, ROADS_TOGGLE,
  COORDS_TOGGLE, BEC_TOGGLE, BEDB_TOGGLE, MALERT_TOGGLE, VOL_SHOW, VOL_SET, DDM, DMS, METERS, FEET,
  PTL, FADED, HISTORY_TOGGLE, HISTORY_LEN_RATE, HISTORY_LEN,
  DB_TOGGLE, DBRESET, DBCA_TOGGLE, DBS_TOGGLE, LDR,
  THREAT_CLEAR, THREAT_RADIUS, TCLEAR,
  DECLARATION_RESET, DECLARATION_SET_BULK, AUTO_DECLARE, AUTO_DECLARE_IFF, AUTOTHREAT, ROE, ROE_TOGGLE,
  ACQ_DECL, ACQ_TOGGLE, ENG_DECL, ENG_TOGGLE,
}

/**
 * @param {{ command, captures }} parsed  commandParser.js's parseCommand() result
 * @param {object} context  { raw, windowId, theatre, declinationDeg, myCoalitionNum, allVisibleUnits }
 * @returns {Promise<string>} feedback message for cmdFeedback
 */
export async function dispatch(parsed, context) {
  const handler = ACTION_MAP[parsed.command.id]
  if (!handler) return `UNIMPLEMENTED: ${parsed.command.id}`
  return await handler({ captures: parsed.captures, context })
}
