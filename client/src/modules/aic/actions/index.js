/**
 * AIC action library.
 *
 * Every command action is implemented here as a standalone function reading/
 * writing state via .getState() (never a closure) — same shape as STARS'
 * action library (atc/actions/index.js). Ported from AicScope.jsx's original
 * inline execCommand 2026-08-21 — see resources/specs/refactor-spec.md §9.
 *
 * Each action receives:
 *   captures — named captures from commandParser.js
 *   context  — small set of caller-computed, non-store values that don't
 *              have an independent source of truth to read from .getState()
 *              (bullseyeLat/Lng, declinationDeg, myCoalitionNum, visibleUnits)
 *
 * Returns the command-feedback string to show the controller (never null —
 * every one of these branches produced feedback in the original). AicScope
 * still owns cmdFeedback as local state (not moved to a store — it has ~15
 * other call sites outside command dispatch, e.g. BRAA/rename/RBL, that get
 * no benefit from moving); the caller is expected to await dispatch()'s
 * result and pass it to setCmdFeedback directly. dispatch() is async because
 * ASPCOLORS needs to await a palette fetch on a cache miss — every other
 * action is a plain sync function, which async/await handles uniformly.
 *
 * Validation note: several original branches validated parsed numeric args
 * (isNaN, range checks) that commandParser.js's regexes already guarantee
 * structurally (e.g. \d+ can't produce a non-numeric or negative string) —
 * those checks are correctly dropped here, not overlooked. Range checks the
 * regex can't express (e.g. .SYM's 1-5 bound, .PTL's 0-300 bound) are kept.
 */

import { useDisplayStore } from '../../../store/display.js'
import { useAicStore, DECLARATION } from '../../../store/aic.js'
import { useRoeStore, ROE_STATE } from '../../../store/roe.js'
import { useAicPrefsStore } from '../../../store/aicPrefs.js'
import { useNavdataStore } from '../../../store/navdata.js'
import { useGeoStore } from '../../../store/geo.js'
import { useReliefStore } from '../../../store/relief.js'
import { useMapsStore } from '../../../store/maps.js'
import { useBrevityStore } from '../../../store/brevity.js'
import { toTrueFromMagnetic } from '../../../utils/bearing.js'
import { sectorAxisBearing } from '../canvas/computePicture.js'

const WINDOW_ID = 'aic-main'

// .class classification letters — duplicated from AicScope.jsx rather than
// imported, matching this codebase's existing convention of keeping small
// stable per-scope helpers independent (see e.g. ABM's own trueDeclaration
// copy, kept separate from AIC's for the same reason).
const CLASS_LETTER = {
  f: DECLARATION.FRIENDLY,
  n: DECLARATION.NEUTRAL,
  b: DECLARATION.BOGEY,
  h: DECLARATION.HOSTILE,
}

function trueDeclaration(unit, myCoalitionNum) {
  if (unit.coalition === myCoalitionNum) return DECLARATION.FRIENDLY
  if (unit.coalition === 0) return DECLARATION.NEUTRAL
  return DECLARATION.HOSTILE
}

function getWin() {
  return useDisplayStore.getState().windows[WINDOW_ID]
}

function updateWin(patch) {
  useDisplayStore.getState().updateWindow(WINDOW_ID, patch)
}

export function CENTER_BULLSEYE() {
  updateWin({ centerOverridden: false })
  return 'CENTERED ON BULLSEYE'
}

export function CENTER_BRG_RNG({ captures, context }) {
  const brg = parseFloat(captures.brg)
  const rng = parseFloat(captures.rng)
  const { bullseyeLat, bullseyeLng, declinationDeg } = context
  const nmPerDegLng = 60 * Math.cos(bullseyeLat * Math.PI / 180)
  // brg is a user-typed magnetic bearing; convert to true for the lat/lng walk.
  const trueRad = ((brg + declinationDeg) % 360) * Math.PI / 180
  const newLat  = bullseyeLat + (rng * Math.cos(trueRad)) / 60
  const newLng  = bullseyeLng + (rng * Math.sin(trueRad)) / nmPerDegLng
  updateWin({ centerLat: newLat, centerLng: newLng, centerOverridden: true })
  return `CENTER ${Math.round(brg)}/${Math.round(rng)}`
}

export function CENTER_FIX({ captures }) {
  const result = useNavdataStore.getState().lookupFix(captures.fix)
  if (!result) return 'NOT FOUND'
  updateWin({ centerLat: result.lat, centerLng: result.lon, centerOverridden: true })
  return `CENTER ${captures.fix.toUpperCase()}`
}

export function FIND({ captures }) {
  const result = useNavdataStore.getState().lookupFix(captures.fix)
  if (!result) return 'NOT FOUND'
  updateWin({ findMarker: result })
  return `FIND ${result.id}`
}

export function RR_TOGGLE() {
  const ringSpacingNm = getWin()?.ringSpacingNm ?? 20
  const next = ringSpacingNm > 0 ? 0 : 20
  updateWin({ ringSpacingNm: next })
  return next === 0 ? 'RANGE RINGS OFF' : 'RANGE RINGS ON'
}

export function RR_SET({ captures }) {
  const nm = parseFloat(captures.nm)
  updateWin({ ringSpacingNm: nm })
  return nm === 0 ? 'RANGE RINGS OFF' : `RR ${nm}NM`
}

export function PTL({ captures }) {
  const s = parseInt(captures.s, 10)
  if (s > 300) return 'INVALID: .PTL 0-300'
  updateWin({ ptlSeconds: s })
  return `PTL ${s}S`
}

export function SYM({ captures }) {
  const n = parseInt(captures.n, 10)
  if (n < 1 || n > 5) return 'INVALID: .SYM 1-5'
  updateWin({ symSize: n })
  return `SYM ${n}`
}

export function FADED({ captures }) {
  const s = parseInt(captures.s, 10)
  updateWin({ fadedSeconds: s })
  return `FADED ${s}S`
}

export function THREAT_CLEAR() {
  updateWin({ threatRings: [] })
  return 'THREAT RINGS CLEARED'
}

export function THREAT_RADIUS({ captures }) {
  const nm = parseFloat(captures.nm)
  updateWin({ threatRadius: nm })
  return `THREAT RING ${nm}NM`
}

export function CLEAR_ALL() {
  updateWin({ threatRings: [], rbl: null, sector: null, sectorVisible: true, ackPicture: null })
  const aic = useAicStore.getState()
  aic.braaList.forEach(p => aic.removeBraaPair(p.id))
  return 'ALL CLEARED'
}

// Returns every explicit declaration to its fog-of-war default (2026-07-07).
export function CLASS_RESET() {
  useAicStore.getState().resetDeclarations()
  return 'CLASS RESET'
}

// `.class <old> <new>` reclassifies every currently-visible contact whose
// *effective* declaration is <old> to <new> — e.g. `.class b h` turns every
// bogey into a hostile (2026-07-07).
export function CLASS_RECLASSIFY({ captures, context }) {
  const { myCoalitionNum, visibleUnits } = context
  const oldDecl = CLASS_LETTER[captures.oldLetter]
  const newDecl = CLASS_LETTER[captures.newLetter]
  const aic = useAicStore.getState()
  for (const [id, unit] of Object.entries(visibleUnits)) {
    if (aic.getEffectiveDeclaration(id, unit, myCoalitionNum) === oldDecl) {
      aic.setDeclaration(id, newDecl)
    }
  }
  return `CLASS ${oldDecl} → ${newDecl}`
}

// Toggles autoclassification (2026-07-08). Turning it ON sets every
// currently-visible contact to its TRUE (coalition-based) classification
// right away; ongoing auto-declaration of newly-visible units happens in
// AicScope's own useEffect. Turning it OFF does not revert anything already
// classified, it just stops future auto-declaration. `.class` (no args)
// overrides this and turns it back off.
export function AUTOCLASS({ context }) {
  const aic = useAicStore.getState()
  const next = !aic.autoClassify
  aic.setAutoClassify(next)
  if (!next) return 'AUTOCLASS OFF'
  const { myCoalitionNum, visibleUnits } = context
  for (const [id, unit] of Object.entries(visibleUnits)) {
    aic.setDeclaration(id, trueDeclaration(unit, myCoalitionNum))
  }
  return 'AUTOCLASS ON'
}

// Toggles automatic threat rings (2026-07-10): while on, every friendly
// aircraft within threatRadius of a HOSTILE/BOGEY aircraft gets its ring lit
// until the breach clears — see AicScope's own useEffect.
export function AUTOTHREAT() {
  const prefs = useAicPrefsStore.getState()
  const next = !prefs.autoThreat
  prefs.setAutoThreat(next)
  return next ? 'AUTOTHREAT ON' : 'AUTOTHREAT OFF'
}

export function ROE({ captures }) {
  const state = captures.state.toUpperCase() // 'FREE' | 'TIGHT' | 'HOLD'
  useRoeStore.getState().setRoe(ROE_STATE[state])
  return `WEAPONS ${state}`
}

export function ROE_TOGGLE() {
  const prefs = useAicPrefsStore.getState()
  const next = !prefs.roeVisible
  prefs.setRoeVisible(next)
  return next ? 'ROE ON' : 'ROE OFF'
}

export async function ASPCOLORS({ captures }) {
  const name = captures.name.trim().toUpperCase()
  let palettes = useMapsStore.getState().palettes
  if (!palettes.length) {
    try {
      const res = await fetch('/api/navdata/palettes')
      palettes = await res.json()
      useMapsStore.getState().setPalettes(palettes)
    } catch {
      return 'PALETTE LOAD FAILED'
    }
  }
  const idx = palettes.findIndex(p => p.name.toUpperCase() === name)
  if (idx < 0) return 'INVALID PALETTE'
  updateWin({ aspColorIdx: idx })
  return `COLORS ${palettes[idx].name.toUpperCase()}`
}

export function GEO_TOGGLE() {
  useGeoStore.getState().toggleVisible()
  return useGeoStore.getState().visible ? 'GEO ON' : 'GEO OFF'
}

export function RELIEF_TOGGLE() {
  useReliefStore.getState().toggleVisible()
  return useReliefStore.getState().visible ? 'RELIEF ON' : 'RELIEF OFF'
}

export function CENTROID_TOGGLE() {
  const showCentroid = getWin()?.showCentroid ?? false
  updateWin({ showCentroid: !showCentroid })
  return !showCentroid ? 'CENTROID ON' : 'CENTROID OFF'
}

export function AXIS_TOGGLE() {
  const showAxis = getWin()?.showAxis ?? false
  updateWin({ showAxis: !showAxis })
  return !showAxis ? 'AXIS ON' : 'AXIS OFF'
}

export function PICTURE_TOGGLE() {
  const prefs = useAicPrefsStore.getState()
  const next = !prefs.showPicture
  prefs.setShowPicture(next)
  return next ? 'PICTURE ON' : 'PICTURE OFF'
}

export function BEC_TOGGLE() {
  const prefs = useAicPrefsStore.getState()
  const next = !prefs.becVisible
  prefs.setBecVisible(next)
  return next ? 'BULLSEYE-ON-CURSOR ON' : 'BULLSEYE-ON-CURSOR OFF'
}

export function SECTOR_ON() {
  if (!getWin()?.sector) return 'NO SECTOR'
  updateWin({ sectorVisible: true })
  return 'SECTOR ON'
}

export function SECTOR_CLEAR() {
  updateWin({ sector: null, sectorVisible: true, sectorPreviewOrigin: null, ackPicture: null })
  return 'SECTOR CLEARED'
}

// Place at bullseye when Enter pressed with no prior click.
export function SECTOR_SET({ captures, context }) {
  const fromMag = parseFloat(captures.fromMag) % 360
  const toMag   = parseFloat(captures.toMag) % 360
  const rng     = parseFloat(captures.rng)
  const { bullseyeLat, bullseyeLng, declinationDeg } = context
  const fromTrue = toTrueFromMagnetic(fromMag, declinationDeg)
  const toTrue   = toTrueFromMagnetic(toMag, declinationDeg)
  updateWin({
    sector: {
      origin:      { lat: bullseyeLat, lng: bullseyeLng },
      fromBearing: fromTrue, toBearing: toTrue, rangeNm: rng,
      axisBearing: sectorAxisBearing(fromTrue, toTrue),
    },
    sectorVisible: true,
    sectorPreviewOrigin: null,
  })
  return `SECTOR ${Math.round(fromMag)}/${Math.round(toMag)} ${Math.round(rng)}NM @BE`
}

// Bare form (Enter, no click) clears the override and reverts to the mission
// bullseye; typed bare and then clicked instead (see AicScope's pendingBe/
// handleMouseUp), it places the override at the click.
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

// Tactical brevity glossary lookup (ATP 1-02.1, see store/brevity.js). Shown
// in its own readout, not cmdFeedback — see AicScope's defineEntry usage.
export function DEFINE({ captures }) {
  const result = useBrevityStore.getState().lookup(captures.term)
  if (!result) {
    updateWin({ defineEntry: null })
    return 'NOT FOUND'
  }
  updateWin({ defineEntry: result })
  return ''
}

const ACTION_MAP = {
  CENTER_BULLSEYE, CENTER_BRG_RNG, CENTER_FIX, FIND, RR_TOGGLE, RR_SET, PTL, SYM, FADED,
  THREAT_CLEAR, THREAT_RADIUS, CLEAR_ALL, CLASS_RESET, CLASS_RECLASSIFY, AUTOCLASS, AUTOTHREAT,
  ROE, ROE_TOGGLE, ASPCOLORS, GEO_TOGGLE, RELIEF_TOGGLE, CENTROID_TOGGLE, AXIS_TOGGLE, PICTURE_TOGGLE,
  BEC_TOGGLE, SECTOR_ON, SECTOR_CLEAR, SECTOR_SET, BE_RESET, BE_LATLNG, BE_FIX, DEFINE,
}

/**
 * @param {{ command, captures }} parsed  commandParser.js's parseCommand() result
 * @param {object} context  { bullseyeLat, bullseyeLng, declinationDeg, myCoalitionNum, visibleUnits }
 * @returns {Promise<string>} feedback message for cmdFeedback
 */
export async function dispatch(parsed, context) {
  const handler = ACTION_MAP[parsed.command.id]
  if (!handler) return `UNIMPLEMENTED: ${parsed.command.id}`
  return await handler({ captures: parsed.captures, context })
}
