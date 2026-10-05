// Parsing + click-state-transition logic for the ABM DRAW drawer's typed/
// click drawing commands (.line/.rect/.circ/.poly/.sect/.race/.text). Kept
// separate from AbmScope.jsx's already-large execCommand so each shape's
// grammar/arity rules read in one place; AbmScope.jsx wires the results
// into its pendingDraw state, the mousemove preview, and click commits.
//
// Every "resolvable" field (center/anchor/fix, then the size/second-point
// field) fills in a fixed priority order as clicks arrive: the position
// field first, then whatever's left. The moment every field a shape needs
// is known, that same click commits — there's no separate "confirm" click
// once nothing's left to determine (see .circ's "radius already typed"
// case: one click sets the center and commits immediately). Only when a
// field with no typed equivalent remains (.rect's opposite corner, .sect's
// bearings, .race's leg length/orientation) does an adjust phase follow,
// ending in the click that finally commits it.

import {
  trueBearingRangeNm, destinationPoint, localOffsetNm,
  gridBearingRangeNm, gridDestinationPoint,
  toMagneticFromTrue, toTrueFromMagnetic,
} from '../../../utils/bearing.js'

const NUM_RE = /^-?\d+(\.\d+)?$/
const isNum = (t) => NUM_RE.test(t)

export const ROTATION_STEP_DEG = 1
export const DEFAULT_RACE_TURN_RADIUS_NM = 1
export const DEFAULT_SECT_HALF_WIDTH_DEG = 15
export const DRAW_SNAP_STEP_NM = 1
// Screen-pixel radius (AbmScope.jsx's canvas coordinates) — clicking within
// this distance of .poly's first vertex closes the polygon there instead of
// adding another vertex. Lives here as documentation of the contract even
// though the actual hit-test (needs pixel projection) runs in AbmScope.jsx.
export const POLY_CLOSE_RADIUS_PX = 12

// .poly no longer has a rotation knob — a freeform polygon's "orientation"
// IS wherever its vertices were clicked, nothing left to spin independently.
const ROTATABLE_TYPES = new Set(['rect', 'race', 'text'])
export function supportsRotation(type) { return ROTATABLE_TYPES.has(type) }

// Every shape's cursor-driven distance — .circ's radius, .poly's apothem,
// .sect's radius, .race's leg length, and .rect's two side lengths (via
// snapRectOffsets below) — snaps to whole-NM steps while free-drawing
// rather than tracking the cursor's exact fractional distance: easier to
// read live and lands on a round number. Floored at one step so a preview
// never collapses to nothing right next to the anchor/center point. Values
// that were TYPED instead (e.g. `.circ 20`) bypass this entirely — only the
// mouse-driven case snaps.
function snapRadius(rangeNm) {
  return Math.max(DRAW_SNAP_STEP_NM, Math.round(rangeNm / DRAW_SNAP_STEP_NM) * DRAW_SNAP_STEP_NM)
}

// Signed variant for .rect's two independent side lengths (each can run
// either direction from the anchor, unlike a radius/apothem/leg which is
// always positive).
function snapSigned(nm) {
  const sign = nm < 0 ? -1 : 1
  return sign * Math.max(DRAW_SNAP_STEP_NM, Math.round(Math.abs(nm) / DRAW_SNAP_STEP_NM) * DRAW_SNAP_STEP_NM)
}

// Snaps a live cursor/click position to whole-NM steps along both local
// axes relative to `anchor` — via localOffsetNm/destinationPoint's shared
// fromLat-referenced convention (NOT trueBearingRangeNm's average-lat one),
// so this round-trips exactly with drawShapes.js's buildRectFeature, which
// decomposes the returned point the same way. Using trueBearingRangeNm here
// used to drift the east/west component (its average-of-both-endpoints
// reference latitude isn't anchor.lat, so a snapped whole-NM offset
// decomposed back out slightly off — north/south was unaffected since
// latitude-degree scaling doesn't depend on any longitude reference at all).
// Returns the snapped opposite-corner point AND the exact widthNm/heightNm
// that produced it — callers needing to DISPLAY the side lengths (the live
// dimension readout) must use these exact values rather than re-measuring
// the rendered corners with trueBearingRangeNm: a rectangle's two parallel
// edges sit at different average latitudes, so that formula's east-west
// scale factor differs slightly between them, making genuinely-equal sides
// read back as slightly different lengths.
function snapRectOffsets(anchor, point) {
  const { eastNm, northNm } = localOffsetNm(anchor.lat, anchor.lng, point.lat, point.lng)
  return { widthNm: snapSigned(eastNm), heightNm: snapSigned(northNm) }
}

function rectOppositeFromOffsets(anchor, widthNm, heightNm) {
  const snappedBrg   = (Math.atan2(widthNm, heightNm) * 180 / Math.PI + 360) % 360
  const snappedRange = Math.hypot(widthNm, heightNm)
  return destinationPoint(anchor.lat, anchor.lng, snappedBrg, snappedRange)
}

// Locks a raw cursor-derived TRUE bearing to the nearest whole-degree
// MAGNETIC heading (ROTATION_STEP_DEG) — declination is a constant offset
// regardless of heading, so stepping/rounding works the same in either
// frame, but the LATTICE (which true values are "round") shifts with
// declination, so the rounding itself must happen in magnetic space.
function lockMagneticBearing(trueBearingDeg, declinationDeg) {
  const mag = toMagneticFromTrue(trueBearingDeg, declinationDeg)
  const lockedMag = (Math.round(mag / ROTATION_STEP_DEG) * ROTATION_STEP_DEG + 360) % 360
  return toTrueFromMagnetic(lockedMag, declinationDeg)
}

// .rect/.poly/.race/.text's rotationDeg defaults to "no rotation" — but
// true-bearing 0 (its old hardcoded default) is only a round MAGNETIC
// heading when declination happens to be 0. The default needs the TRUE
// bearing whose magnetic equivalent is exactly 0, computed directly — not
// lockMagneticBearing(0, declinationDeg), which rounds true-bearing-0's own
// magnetic reading (typically already a few degrees off cardinal) to the
// nearest whole degree, landing on some arbitrary nearby integer instead of
// 0 (e.g. 358M, not 000M, at a 2.3°E-declination location). No rounding is
// needed here at all: 0 is already a whole magnetic degree, so its true
// equivalent reads back as exactly 000/090 with no drift.
function initialRotationDeg(declinationDeg) {
  return toTrueFromMagnetic(0, declinationDeg)
}

function toLatLng(fix) {
  return fix ? { lat: fix.lat, lng: fix.lon } : null
}

// Raw lat/lng coordinate tokens, either hemisphere-prefix (N20W040) or
// hemisphere-suffix (25N056E) — decimal degrees accepted on either part
// (N20.5W040.25). Whole-degree examples pad longitude to 3 digits by
// convention but the regex doesn't require it either way.
const LATLON_PREFIX_RE = /^([NS])(\d+(?:\.\d+)?)([EW])(\d+(?:\.\d+)?)$/
const LATLON_SUFFIX_RE = /^(\d+(?:\.\d+)?)([NS])(\d+(?:\.\d+)?)([EW])$/

function signedLatLng(ns, latStr, ew, lngStr) {
  const lat = parseFloat(latStr) * (ns === 'S' ? -1 : 1)
  const lng = parseFloat(lngStr) * (ew === 'W' ? -1 : 1)
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function parseLatLonToken(token) {
  const t = token.toUpperCase()
  let m = LATLON_PREFIX_RE.exec(t)
  if (m) return signedLatLng(m[1], m[2], m[3], m[4])
  m = LATLON_SUFFIX_RE.exec(t)
  if (m) return signedLatLng(m[2], m[1], m[4], m[3])
  return null
}

// Resolves ANY point token — a raw N20W040/20N040W coordinate first (a
// precise format match, so no risk of misreading a real fix id), falling
// back to a fix/navaid/airport lookup. The one shared point-resolver every
// draw command's parser (and `.focus`) uses, so a coordinate token works
// anywhere an identifier already did.
export function resolvePoint(token, lookupFix) {
  return parseLatLonToken(token) ?? toLatLng(lookupFix(token))
}

// Shared by .line's second endpoint and .poly's next vertex — both are
// "the next freehand point, chained off the previous one": bearing locks to
// the nearest whole-degree magnetic heading, distance snaps to whole NM,
// then reprojects from `from` so the stored point reflects exactly those
// locked/snapped numbers (not the cursor's raw fractional position). Grid-
// frame throughout (gridBearingRangeNm/gridDestinationPoint) so the drawn
// line reads back as the same clean magnetic number via RBL — see
// utils/bearing.js.
function lockedVertexFrom(from, to, declinationDeg, theatre) {
  const { gridBearingDeg, rangeNm } = gridBearingRangeNm(from.lat, from.lng, to.lat, to.lng, theatre)
  const lockedBrg = lockMagneticBearing(gridBearingDeg, declinationDeg)
  const snappedNm = snapRadius(rangeNm)
  return {
    point: gridDestinationPoint(from.lat, from.lng, lockedBrg, snappedNm, theatre),
    rangeNm: snappedNm,
    trueBearingDeg: lockedBrg,
  }
}

// ─────────────────────────── command parsing ───────────────────────────────
// Each parser returns exactly one of:
//   { immediate: params }  — everything needed was typed, commit right away
//   { pending: state }     — arms pendingDraw, waiting on click(s)
//   { error: 'MESSAGE' }   — bad args, surfaced via setCmdFeedback

function parseLine(tokens, lookupFix) {
  if (tokens.length > 2) return { error: 'TOO MANY ARGS' }
  const points = tokens.map(t => resolvePoint(t, lookupFix))
  if (points.some(p => p === null)) return { error: 'FIX NOT FOUND' }
  const [p1 = null, p2 = null] = points
  if (p1 && p2) return { immediate: { p1, p2 } }
  return { pending: { type: 'line', p1, p2 } }
}

function parseRect(tokens, lookupFix, declinationDeg) {
  const rotationDeg = initialRotationDeg(declinationDeg)
  if (tokens.length > 1) return { error: 'TOO MANY ARGS' }
  if (!tokens.length) return { pending: { type: 'rect', anchor: null, rotationDeg } }
  const anchor = resolvePoint(tokens[0], lookupFix)
  if (!anchor) return { error: 'FIX NOT FOUND' }
  return { pending: { type: 'rect', anchor, rotationDeg } }
}

function parseCirc(tokens, lookupFix) {
  let center = null, radiusNm = null
  for (const t of tokens) {
    if (isNum(t)) {
      if (radiusNm !== null) return { error: 'TOO MANY ARGS' }
      radiusNm = parseFloat(t)
      continue
    }
    if (center !== null) return { error: 'TOO MANY ARGS' }
    center = resolvePoint(t, lookupFix)
    if (!center) return { error: 'FIX NOT FOUND' }
  }
  if (center && radiusNm != null) return { immediate: { center, radiusNm } }
  return { pending: { type: 'circ', center, radiusNm } }
}

// .poly no longer has a "sides" concept at all — every point typed (or
// clicked) becomes a vertex, in order, and the ring closes between the
// last and first. 3+ points typed commits immediately (already a complete
// polygon); 0-2 arms the freeform multi-click mode with whatever was
// pre-placed, same as .line's optional leading point(s).
function parsePoly(tokens, lookupFix) {
  const points = tokens.map(t => resolvePoint(t, lookupFix))
  if (points.some(p => p === null)) return { error: 'FIX NOT FOUND' }
  if (points.length >= 3) return { immediate: { vertices: points } }
  return { pending: { type: 'poly', vertices: points } }
}

// Typed form is <id> <brg1> <brg2> ... <brgN> <radiusNm> — N boundary
// bearings (2+) sharing one trailing radius, producing N-1 adjoining
// sectors (brg1-brg2, brg2-brg3, ...) all at that same center/radius. The
// plain single-sector form (.sect OMDM 270 090 100) is just the N=2 case of
// this same pattern, not a separate code path. Bearings are typed as
// MAGNETIC (a controller means "the 090 radial", not true 090 — same
// convention as .race's radial below), converted via toTrueFromMagnetic
// here — grid frame (DCS's own "true" — see utils/bearing.js), since
// buildSectFeature uses gridDestinationPoint, unlike most other builders.
// NOTE: unlike every other command, a multi-sector result's
// `immediate` is an ARRAY of param objects (one per sector), not a single
// object — see the .sect branch in AbmScope.jsx's execCommand.
function parseSect(tokens, lookupFix, declinationDeg, theatre) {
  let center = null
  const nums = []
  for (const t of tokens) {
    if (isNum(t)) { nums.push(parseFloat(t)); continue }
    if (center !== null) return { error: 'TOO MANY ARGS' }
    center = resolvePoint(t, lookupFix)
    if (!center) return { error: 'FIX NOT FOUND' }
  }
  if (nums.length >= 3 && center) {
    const radiusNm = nums[nums.length - 1]
    // toTrueFromMagnetic == grid frame (DCS's own "true" — see
    // utils/bearing.js), matching buildSectFeature's gridDestinationPoint.
    const gridBrgs = nums.slice(0, -1).map(b => toTrueFromMagnetic(b, declinationDeg))
    const sectors = []
    for (let i = 0; i < gridBrgs.length - 1; i++) {
      sectors.push({ center, startBrg: gridBrgs[i], endBrg: gridBrgs[i + 1], radiusNm, theatre })
    }
    return { immediate: sectors }
  }
  if (nums.length > 0) return { error: 'INCOMPLETE ARGS' }
  return { pending: { type: 'sect', center, halfWidthDeg: DEFAULT_SECT_HALF_WIDTH_DEG } }
}

function parseRace(tokens, lookupFix, declinationDeg) {
  let fix = null, turnDir = null
  const nums = []
  for (const t of tokens) {
    if (isNum(t)) { nums.push(parseFloat(t)); continue }
    if (/^[lr]$/i.test(t)) { turnDir = t.toUpperCase(); continue }
    if (fix !== null) return { error: 'TOO MANY ARGS' }
    fix = resolvePoint(t, lookupFix)
    if (!fix) return { error: 'FIX NOT FOUND' }
  }
  if (fix && turnDir && nums.length >= 2) {
    // radialDeg is typed as MAGNETIC (real-world VOR radials always are) —
    // convert to true here so it's stored the same way the click-driven
    // form's rotationDeg already is (rotatePendingDraw locks/steps in
    // magnetic space but stores the equivalent true bearing).
    const [radialDeg, legNm, turnRadiusNm = DEFAULT_RACE_TURN_RADIUS_NM] = nums
    return { immediate: { fix, radialDeg: toTrueFromMagnetic(radialDeg, declinationDeg), turnDir, legNm, turnRadiusNm } }
  }
  if (nums.length > 0 || turnDir) return { error: 'INCOMPLETE ARGS' }
  return {
    pending: {
      type: 'race', fix, rotationDeg: initialRotationDeg(declinationDeg),
      turnDir: 'R', turnRadiusNm: DEFAULT_RACE_TURN_RADIUS_NM,
    },
  }
}

// rawTokens must come from the ORIGINAL-case command text (not the
// lowercased `str` execCommand matches against) so label text keeps
// whatever case the controller typed.
function parseText(rawTokens, lookupFix, declinationDeg) {
  if (!rawTokens.length) return { error: 'NO TEXT' }
  const anchor = resolvePoint(rawTokens[0], lookupFix)
  const textTokens = anchor ? rawTokens.slice(1) : rawTokens
  const text = textTokens.join(' ')
  if (!text) return { error: 'NO TEXT' }
  return { pending: { type: 'text', anchor, text, rotationDeg: initialRotationDeg(declinationDeg) } }
}

const PARSERS = {
  line: parseLine, rect: parseRect, circ: parseCirc,
  poly: parsePoly, sect: parseSect, race: parseRace, text: parseText,
}

export function parseDrawCommand(type, tokens, lookupFix, declinationDeg = 0, theatre = null) {
  return PARSERS[type](tokens, lookupFix, declinationDeg, theatre)
}

// ───────────────────────── click state transitions ─────────────────────────
// Returns { pending: nextState } to keep waiting, or { immediate: params }
// to commit now via addDrawnShape.

export function advancePendingDraw(pd, click, declinationDeg = 0, theatre = null) {
  switch (pd.type) {
    case 'line': {
      if (!pd.p1) return { pending: { ...pd, p1: click } }
      const { point: p2 } = lockedVertexFrom(pd.p1, click, declinationDeg, theatre)
      return { immediate: { p1: pd.p1, p2 } }
    }
    case 'rect': {
      if (!pd.anchor) return { pending: { ...pd, anchor: click } }
      const { widthNm, heightNm } = snapRectOffsets(pd.anchor, click)
      const opposite = rectOppositeFromOffsets(pd.anchor, widthNm, heightNm)
      return { immediate: { anchor: pd.anchor, opposite, rotationDeg: pd.rotationDeg, theatre } }
    }
    case 'circ': {
      if (!pd.center) {
        if (pd.radiusNm != null) return { immediate: { center: click, radiusNm: pd.radiusNm } }
        return { pending: { ...pd, center: click } }
      }
      const { rangeNm } = trueBearingRangeNm(pd.center.lat, pd.center.lng, click.lat, click.lng)
      return { immediate: { center: pd.center, radiusNm: snapRadius(rangeNm) } }
    }
    // .poly's "close near the first vertex" click is intercepted in
    // AbmScope.jsx (needs a screen-pixel proximity test against vertices[0],
    // which requires the view/projection this module doesn't have) before
    // advancePendingDraw is ever called — so every click that reaches here
    // is simply "add another vertex."
    case 'poly': {
      const last = pd.vertices[pd.vertices.length - 1]
      const next = last ? lockedVertexFrom(last, click, declinationDeg, theatre).point : click
      return { pending: { ...pd, vertices: [...pd.vertices, next] } }
    }
    case 'sect': {
      if (!pd.center) return { pending: { ...pd, center: click } }
      const { gridBearingDeg, rangeNm } = gridBearingRangeNm(pd.center.lat, pd.center.lng, click.lat, click.lng, theatre)
      const lockedBrg = lockMagneticBearing(gridBearingDeg, declinationDeg)
      const half = pd.halfWidthDeg ?? DEFAULT_SECT_HALF_WIDTH_DEG
      return {
        immediate: {
          center: pd.center,
          startBrg: (lockedBrg - half + 360) % 360,
          endBrg:   (lockedBrg + half) % 360,
          radiusNm: snapRadius(rangeNm),
          theatre,
        },
      }
    }
    case 'race': {
      if (!pd.fix) return { pending: { ...pd, fix: click } }
      const { rangeNm } = trueBearingRangeNm(pd.fix.lat, pd.fix.lng, click.lat, click.lng)
      return {
        immediate: {
          fix: pd.fix, radialDeg: pd.rotationDeg, turnDir: pd.turnDir,
          legNm: snapRadius(rangeNm), turnRadiusNm: pd.turnRadiusNm,
        },
      }
    }
    case 'text': {
      if (!pd.anchor) return { pending: { ...pd, anchor: click } }
      return { immediate: { anchor: pd.anchor, text: pd.text, rotationDeg: pd.rotationDeg } }
    }
    default:
      return { immediate: null }
  }
}

// .rect/.poly/.race/.text's scroll-driven rotationDeg is stored as a TRUE
// bearing (so drawShapes.js's builders can keep using it directly, no
// declination-awareness needed there), but every STEP is computed in
// magnetic space so the result always lands on a whole-degree magnetic
// heading regardless of the theatre's declination — rounding the CURRENT
// value first (not just adding a step) means even the very first scroll
// from the rotationDeg:0 default snaps onto the lattice, not just steps
// that follow it.
export function rotatePendingDraw(pd, direction = 1, declinationDeg = 0) {
  const currentMag = toMagneticFromTrue(pd.rotationDeg, declinationDeg)
  const roundedMag = Math.round(currentMag / ROTATION_STEP_DEG) * ROTATION_STEP_DEG
  const nextMag     = (roundedMag + direction * ROTATION_STEP_DEG + 360) % 360
  return { ...pd, rotationDeg: toTrueFromMagnetic(nextMag, declinationDeg) }
}

// ───────────────────────────── live preview ─────────────────────────────────
// Params for drawShapes.js's matching builder, given the current cursor
// position — null means "nothing to show yet" (e.g. no point placed at
// all). Never mutates pendingDraw or touches the store.

export function previewParams(pd, cursor, declinationDeg = 0, theatre = null) {
  if (!cursor) return null
  switch (pd.type) {
    case 'line': {
      if (!pd.p1) return null
      const { gridBearingDeg, rangeNm } = gridBearingRangeNm(pd.p1.lat, pd.p1.lng, cursor.lat, cursor.lng, theatre)
      const lockedBrg  = lockMagneticBearing(gridBearingDeg, declinationDeg)
      const snappedNm  = snapRadius(rangeNm)
      // rangeNm/trueBearingDeg carried through exactly (not re-measured from
      // p1/p2 later) — see the rect note below for why that matters.
      return {
        p1: pd.p1, p2: gridDestinationPoint(pd.p1.lat, pd.p1.lng, lockedBrg, snappedNm, theatre),
        rangeNm: snappedNm, trueBearingDeg: lockedBrg,
      }
    }
    case 'rect': {
      if (!pd.anchor) return null
      const { widthNm, heightNm } = snapRectOffsets(pd.anchor, cursor)
      // widthNm/heightNm carried through exactly for the dimension readout —
      // re-measuring the two rendered opposite corners with
      // trueBearingRangeNm would read the parallel sides as slightly
      // different lengths (different average-latitude reference per edge).
      return {
        anchor: pd.anchor, opposite: rectOppositeFromOffsets(pd.anchor, widthNm, heightNm),
        rotationDeg: pd.rotationDeg, widthNm, heightNm, theatre,
      }
    }
    case 'circ': {
      const center = pd.center ?? cursor
      const radiusNm = pd.radiusNm != null
        ? pd.radiusNm
        : (pd.center ? snapRadius(trueBearingRangeNm(pd.center.lat, pd.center.lng, cursor.lat, cursor.lng).rangeNm) : null)
      if (radiusNm == null) return null
      return { center, radiusNm }
    }
    case 'poly': {
      if (!pd.vertices.length) return null
      const last = pd.vertices[pd.vertices.length - 1]
      const { point, rangeNm, trueBearingDeg } = lockedVertexFrom(last, cursor, declinationDeg, theatre)
      // vertices includes the live cursor point (locked/snapped the same
      // way a click would commit it) appended after whatever's already
      // placed — drawPendingDraw.js reads vertices[0] to draw the "closing
      // here" hint and vertices.length-2 for the segment being drawn now.
      return { vertices: [...pd.vertices, point], rangeNm, trueBearingDeg }
    }
    case 'sect': {
      if (!pd.center) return null
      const { gridBearingDeg, rangeNm } = gridBearingRangeNm(pd.center.lat, pd.center.lng, cursor.lat, cursor.lng, theatre)
      const lockedBrg = lockMagneticBearing(gridBearingDeg, declinationDeg)
      const half = pd.halfWidthDeg ?? DEFAULT_SECT_HALF_WIDTH_DEG
      return {
        center: pd.center,
        startBrg: (lockedBrg - half + 360) % 360,
        endBrg:   (lockedBrg + half) % 360,
        radiusNm: snapRadius(rangeNm),
        theatre,
      }
    }
    case 'race': {
      if (!pd.fix) return null
      const { rangeNm } = trueBearingRangeNm(pd.fix.lat, pd.fix.lng, cursor.lat, cursor.lng)
      return {
        fix: pd.fix, radialDeg: pd.rotationDeg, turnDir: pd.turnDir,
        legNm: snapRadius(rangeNm), turnRadiusNm: pd.turnRadiusNm,
      }
    }
    case 'text': {
      if (!pd.anchor) return null
      return { anchor: pd.anchor, text: pd.text, rotationDeg: pd.rotationDeg }
    }
    default:
      return null
  }
}
