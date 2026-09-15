/**
 * ABM air-contact rendering — a distinct symbology from both AIC and ATC,
 * per 2026-07-05 direction: same declaration colors as AIC, but every
 * contact is a plain square (no HAFU dome/staple/triangle shapes), with
 * STARS/ASDE-X-style persistent datablocks + leader lines + history trails,
 * all colored to match the contact's declaration (not white/gray like
 * STARS/ASDE-X use). Declarations are ABM's own (store/abm.js) — kept
 * independent from AIC's, not shared (deferred, see abm-spec.md §1.2).
 */

import { latLngToCanvas } from '../../../utils/projection.js'
import { destinationPoint, gridBearingRangeNm, toMagneticFromTrue } from '../../../utils/bearing.js'
import { drawPtl, DECL_COLOR } from '../../aic/canvas/drawAicContacts.js'
import { DIR_TO_ANGLE, RIGHT_ALIGN_ANGLES, HIGHLIGHT_TEAL, HIGHLIGHT_PURPLE } from '../../atc/stars/constants.js'
import { DECLARATION } from '../../../store/abm.js'
import { placeDatablocks, DEFAULT_CANDIDATE_ANGLES_DEG } from '../../../utils/datablockPlacement.js'
import { resolveCallsign } from '../../../utils/callsign.js'

const SYM_HALF     = 3   // square half-width, px (hollow outline, not filled)
const CULL_MARGIN  = 60
const EMPTY_SET    = new Set()
const EMPTY_MAP    = new Map()
const EMPTY_ARRAY  = []
const BLINK_DIM    = '#C0C0C0'  // same dim gray STARS blinks a handoff datablock down to

// Same truncation AIC's readout uses: strip suffix after _/space, then
// collapse a double-hyphen type name to its first two segments. Exported
// for AbmScope's cursor-proximity air-unit readout, which needs the same
// abbreviation the datablock's line 2 already uses.
export function typeAbbrev(unit) {
  return (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1')
}

// ── Formation datablock suppression (§3, 2026-07-08) ────────────────────────
// "FORD 1-1" / "FORD1-1" / "FORD-1-1" / "ford_1_1" all name the same
// callsign+flight — strip every separator and read the trailing digit run
// as flightNumber+elementNumber (last digit = element, e.g. "FORD" + "21"
// -> flight FORD-2, element 1). A bare callsign with no digits, or only a
// single trailing digit (no way to split flight from element), can't be
// grouped and is left alone.
const FLIGHT_RE = /^([A-Z]+)(\d{2,})$/

// Exported for Ato.jsx's CALLSIGN column, which needs the same flight/
// element split to show the flight's own callsign ("SHELL1") without the
// individual lead aircraft's element digit ("SHELL11").
export function parseFlightElement(unit) {
  const raw = resolveCallsign(unit)
  if (!raw) return null
  const cleaned = raw.replace(/[^a-z0-9]/gi, '').toUpperCase()
  const m = cleaned.match(FLIGHT_RE)
  if (!m) return null
  const [, prefix, digits] = m
  const element  = parseInt(digits.slice(-1), 10)
  const flightNo = digits.slice(0, -1)
  return { flightKey: `${prefix}${flightNo}`, element }
}

// Uncorrelated, transponder-equipped contact — line 1 cycles through
// whichever of Mode 1/2/3/4 are actually present/on, labeled (e.g. "M1 11" —
// Mode 1 is a real 2-digit octal code, unlike Mode 2/3's 4-digit "M3 3333" —
// "M4 ON"), 2 seconds per mode, skipping unset modes. Empty when there's nothing to show
// (not srsCapable, or srsCapable with no live code/mode4 at all) — that case
// stays the plain 1-line non-friendly datablock, unchanged. See
// resources/specs/transponder-correlation-spec.md.
function buildIffFrames(unit) {
  const t = unit?.transponder
  if (!unit?.srsCapable || !t) return []
  const frames = []
  if (t.status === 1 || t.status === 2) {
    if (typeof t.mode1 === 'number' && t.mode1 >= 0) frames.push(`M1 ${String(t.mode1).padStart(2, '0')}`)
    if (typeof t.mode2 === 'number' && t.mode2 >= 0) frames.push(`M2 ${String(t.mode2).padStart(4, '0')}`)
    if (typeof t.mode3 === 'number' && t.mode3 >= 0) frames.push(`M3 ${String(t.mode3).padStart(4, '0')}`)
  }
  if (t.mode4 === true) frames.push('M4 ON')
  return frames
}

// A follower qualifies for suppression if it's within a 3NM-per-side box
// centered on the lead and oriented to the lead's track — i.e. up to 3NM
// ahead/behind *and* up to 3NM abeam, not a 3NM radius (so an aircraft 3NM
// behind and 3NM abeam, ~4.24NM straight-line, still qualifies).
const FORMATION_BOX_NM = 3

function withinFormationBox(lead, other) {
  if (!lead.position || !other.position) return false
  const nmPerDegLng = 60 * Math.cos(lead.position.lat * Math.PI / 180)
  const dN = (other.position.lat - lead.position.lat) * 60
  const dE = (other.position.lng - lead.position.lng) * nmPerDegLng
  const hdg = lead.track ?? 0
  const alongTrack = dN * Math.cos(hdg) + dE * Math.sin(hdg)
  const crossTrack  = dE * Math.cos(hdg) - dN * Math.sin(hdg)
  return Math.abs(alongTrack) <= FORMATION_BOX_NM && Math.abs(crossTrack) <= FORMATION_BOX_NM
}

// Greedy, non-transitive leader assignment: process same-flight members in
// ascending element order; the first not-yet-claimed member becomes a lead
// and claims (suppresses) any still-unclaimed higher-numbered member within
// its box. A flight that splits into two clusters (1-1/1-2 together,
// 1-3/1-4 elsewhere) ends up with two leads (1-1 and 1-3), not one
// (2026-07-08 direction — explicitly non-transitive, box is always
// evaluated against the current cluster's lead, never chained).
// Exported so AbmScope's click handler can resolve the same
// follower -> lead mapping used here, letting a click on the lead (the only
// datablock actually on screen for a suppressed formation) stop a blink
// that's really targeting one of its covered wingmen.
export function computeSuppressedIds(units) {
  const groups = new Map()
  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const fe = parseFlightElement(unit)
    if (!fe) continue
    if (!groups.has(fe.flightKey)) groups.set(fe.flightKey, [])
    groups.get(fe.flightKey).push({ id, element: fe.element, unit })
  }

  const suppressed = new Set()
  const leaderOf    = new Map()   // followerId -> the lead id whose datablock covers it
  for (const members of groups.values()) {
    if (members.length < 2) continue
    members.sort((a, b) => a.element - b.element)
    const claimed = new Set()
    for (let i = 0; i < members.length; i++) {
      const lead = members[i]
      if (claimed.has(lead.id)) continue
      for (let j = i + 1; j < members.length; j++) {
        const follower = members[j]
        if (claimed.has(follower.id)) continue
        if (withinFormationBox(lead.unit, follower.unit)) {
          claimed.add(follower.id)
          suppressed.add(follower.id)
          leaderOf.set(follower.id, lead.id)
        }
      }
    }
  }
  return { suppressed, leaderOf }
}

// Faded / coasting contacts — same dead-reckon-from-last-position model as
// AIC's drawFadedContacts, adapted to ABM's plain-square symbol (no HAFU
// shape) and no datablock/history (AIC's faded contacts carry no readout
// either).
function drawFadedContacts(ctx, view, fadedContacts, now, ptlMinutes) {
  const { width, height } = view
  ctx.save()
  ctx.globalAlpha = 0.5

  for (const [, entry] of Object.entries(fadedContacts)) {
    const { unit, disappearedAt } = entry
    if (!unit.position) continue
    const elapsed     = (now - disappearedAt) / 1000
    const distNm      = (unit.speed ?? 0) * elapsed / 1852
    const track       = unit.track ?? 0
    const { lat: coastLat, lng: coastLng } = destinationPoint(unit.position.lat, unit.position.lng, track * 180 / Math.PI, distNm)
    const { x, y }    = latLngToCanvas(coastLat, coastLng, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue

    if (ptlMinutes > 0) drawPtl(ctx, x, y, unit, view, ptlMinutes * 60, '#888')

    ctx.strokeStyle = '#888'
    ctx.lineWidth   = 1.5
    ctx.strokeRect(x - SYM_HALF, y - SYM_HALF, SYM_HALF * 2, SYM_HALF * 2)
  }

  ctx.restore()
}

// Small squares in the contact's own color, fading with age. Shared by
// drawAbmContacts (aircraft) and drawAbmMissiles (missiles, ABM only —
// AIC's call site never passes a non-empty history/historyLimit).
function drawHistoryTrail(ctx, view, trail, historyLimit, color) {
  for (let i = 0; i < trail.length && i < historyLimit; i++) {
    const hp = latLngToCanvas(trail[i].lat, trail[i].lng, view)
    ctx.globalAlpha = Math.max(0.15, 0.6 - i * 0.12)
    ctx.fillStyle   = color
    ctx.fillRect(hp.x - SYM_HALF / 2, hp.y - SYM_HALF / 2, SYM_HALF, SYM_HALF)
  }
  ctx.globalAlpha = 1
}

// Missile tracking — small filled triangle pointing in the direction of
// travel (weapon.heading — DCS's raw engine-frame heading, validated
// reliable true-frame data per utils/bearing.js's header, unlike Olympus's
// own .track field), colored via the same DECL_COLOR declaration scheme as
// every other contact for consistency with the rest of the scope. In
// practice this almost always resolves to FRIENDLY: a non-friendly missile
// is only ever passed in here at all once independently AWACS/EWR-detected
// (server/src/missileDetection.js), own-coalition/neutral missiles are
// unconditionally visible — see abmScopeHelpers.js's getAbmVisibleMissiles.
//
// ptlSeconds/history/historyLimit default off so AIC's call site (which
// passes neither) keeps its current minimal treatment (triangle + PTL, no
// trail) without needing any changes there beyond ptlSeconds.
export function drawAbmMissiles(ctx, view, missiles, getDecl, ptlSeconds = 0, history = null, historyLimit = 0) {
  for (const [id, weapon] of Object.entries(missiles)) {
    if (!weapon.position) continue
    const decl = getDecl(id, weapon)
    const color = DECL_COLOR[decl] ?? DECL_COLOR[DECLARATION.BOGEY]
    const { x, y } = latLngToCanvas(weapon.position.lat, weapon.position.lng, view)

    drawHistoryTrail(ctx, view, (history ?? {})[id] || [], historyLimit, color)

    if (ptlSeconds > 0) drawPtl(ctx, x, y, { ...weapon, track: weapon.heading }, view, ptlSeconds, color)

    const headingRad = weapon.heading ?? 0
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(headingRad - (view.declinationDeg ?? 0) * Math.PI / 180)
    ctx.beginPath()
    ctx.moveTo(0, -4)
    ctx.lineTo(2.5, 3)
    ctx.lineTo(-2.5, 3)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  }
}

export function drawAbmContacts(
  ctx, view, units, getDecl,
  ptlMinutes, dbVisible, altToggle,
  ldrLength, ldrAngleDeg, leaderDirs,
  history, historyLimit,
  fadedContacts = {}, fadedNow = 0,
  dbSuppress = true,
  rwrKnownIds = EMPTY_SET,
  dbca = false,
  dbHiddenIds = EMPTY_SET,
  highlightedIds = EMPTY_SET,
  blinkingIds = EMPTY_SET,
  blinkOn = true,
  correlatedUnitIds = EMPTY_SET,
  iffCycleIndex = 0,
  bedbVisible = false,
  hasBullseye = false,
  bullseyeLat = 0,
  bullseyeLng = 0,
  theatre = null,
  declinationDeg = 0,
  dbSize = 2,
) {
  const { width, height } = view
  const fontPx     = 8 + dbSize * 2
  const lineHeight = Math.round(fontPx * 12 / 11)
  const halfLine   = Math.round(lineHeight / 2)
  const dbAscent   = Math.round(fontPx * 8 / 11)
  const dbDescent  = Math.round(fontPx * 2 / 11)
  ctx.font = `${fontPx}px "Roboto Mono", monospace`

  const { suppressed: suppressedIds, leaderOf } = dbSuppress
    ? computeSuppressedIds(units)
    : { suppressed: EMPTY_SET, leaderOf: EMPTY_MAP }

  // A blinking wingman whose datablock is currently suppressed (.dbs) never
  // gets its own text drawn — the blink has to surface on the formation
  // lead's datablock instead, since that's the only one actually on screen.
  const blinkViaLead = new Set()
  for (const followerId of blinkingIds) {
    const leadId = leaderOf.get(followerId)
    if (leadId != null) blinkViaLead.add(leadId)
  }

  // Collision-avoidance candidates — only populated when dbca is on; drawn
  // in a second pass once placeDatablocks has resolved every direction
  // against every other contact's symbol/label (see utils/datablockPlacement.js).
  const dbCandidates = []

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const { x, y } = latLngToCanvas(unit.position.lat, unit.position.lng, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue

    const decl  = getDecl(id, unit)
    const color = DECL_COLOR[decl] ?? DECL_COLOR[DECLARATION.BOGEY]
    // Middle-click highlight override — symbol/leader/text/PTL, not the
    // history trail (that stays in the contact's own declaration color).
    // Non-friendly (HOSTILE/BOGEY) highlights purple instead of teal, so a
    // highlighted bandit doesn't read as friendly-adjacent at a glance.
    const isHighlighted  = highlightedIds.has(id)
    const highlightColor = (decl === DECLARATION.HOSTILE || decl === DECLARATION.BOGEY) ? HIGHLIGHT_PURPLE : HIGHLIGHT_TEAL
    const dbColor        = isHighlighted ? highlightColor : color
    // FRAG roster "blink datablock" click — same white/gray blink STARS uses
    // for an incoming handoff, and takes priority over the highlight color
    // since it's the more transient, attention-grabbing cue of the two.
    const isBlinkUnit    = blinkingIds.has(id) || blinkViaLead.has(id)
    const textColor      = isBlinkUnit ? (blinkOn ? '#ffffff' : BLINK_DIM)
                          : isHighlighted ? highlightColor : '#ffffff'

    if (ptlMinutes > 0) drawPtl(ctx, x, y, unit, view, ptlMinutes * 60, dbColor)

    drawHistoryTrail(ctx, view, (history ?? {})[id] || [], historyLimit, color)

    // Symbol — plain hollow square, no shape variation by declaration
    ctx.strokeStyle = dbColor
    ctx.lineWidth   = 1.5
    ctx.strokeRect(x - SYM_HALF, y - SYM_HALF, SYM_HALF * 2, SYM_HALF * 2)

    if (!dbVisible) continue
    if (suppressedIds.has(id)) continue  // formation lead's datablock covers this wingman
    if (dbHiddenIds.has(id)) continue    // .db + click per-contact override

    // Datablock — friendly (or correlated to a FRAG-assigned aircraft, see
    // correlationEngine.js) gets callsign + alt/speed-or-type; an
    // uncorrelated, transponder-equipped contact cycles its live Mode 1/2/3/4
    // through line 1 instead of a callsign (buildIffFrames, above) — reduced
    // info rather than full anonymity, same STARS-LDB-style philosophy used
    // elsewhere in resources/specs/transponder-correlation-spec.md.
    //
    // Identity reveal vs. declaration, deliberately decoupled (2026-09-14,
    // corrected after a live report): declaration/color always stays exactly
    // what's in `decl` — that part is sticky by design and untouched here.
    // But for an `srsCapable` contact, callsign/type reveal is driven by
    // CURRENT correlation alone, not by `decl`. A sticky FRIENDLY declaration
    // (via .autodec iff or manual F4) does NOT by itself keep the callsign
    // visible — if the live transponder stops correlating, the datablock
    // reverts to cycling codes even though the tag stays friendly-colored.
    // This intentionally differs from a plain F4-declared non-srsCapable
    // contact (below), which still reveals unconditionally on declare — for
    // those, ground truth via declaration is the only signal that ever
    // existed, there's no live correlation concept to defer to.
    const correlated = correlatedUnitIds.has(String(id))
    const isFriendly = unit.srsCapable ? correlated : decl === DECLARATION.FRIENDLY
    const iffFrames  = (!isFriendly) ? buildIffFrames(unit) : EMPTY_ARRAY
    const showsBlock = isFriendly || iffFrames.length > 0
    // Non-friendly type is only known once RWR has ever painted it
    // (rwrKnownIds — same sticky reveal as the air-unit readout in
    // AbmScope.jsx); until then it can't cycle to a type it doesn't have.
    const knowsType = isFriendly || rwrKnownIds.has(id)
    const altFt   = Math.round((unit.position.alt ?? 0) * 3.28084)
    const alt100  = String(Math.round(altFt / 100)).padStart(3, '0')
    const spdKts  = (unit.speed ?? 0) * 1.94384
    const spd10   = String(Math.round(spdKts / 10)).padStart(2, '0')

    const unitDir   = leaderDirs?.[String(id)]
    const altSpdLine = `${alt100} ${spd10}`
    const line2      = (altToggle && knowsType) ? `${alt100} ${typeAbbrev(unit)}` : altSpdLine
    const line1      = isFriendly ? resolveCallsign(unit).toUpperCase() : iffFrames[iffCycleIndex % iffFrames.length]
    const lines      = showsBlock ? [line1, line2] : [line2]

    // .bedb — 3rd datablock line: magnetic bearing/range from bullseye, same
    // convention as the .bec/.coords bullseye readout (never shows "000",
    // shown as "360" instead — see AbmScope.jsx's becReadout/coordsReadout).
    if (showsBlock && bedbVisible && hasBullseye) {
      const { gridBearingDeg, rangeNm } = gridBearingRangeNm(bullseyeLat, bullseyeLng, unit.position.lat, unit.position.lng, theatre)
      const magBrg = toMagneticFromTrue(gridBearingDeg, declinationDeg)
      lines.push(`${String(Math.round(magBrg) || 360).padStart(3, '0')}/${Math.round(rangeNm)}`)
    }

    if (dbca) {
      dbCandidates.push({
        id, x, y, color: dbColor, textColor, lines,
        prefAngleDeg: unitDir != null ? (DIR_TO_ANGLE[unitDir] ?? ldrAngleDeg) : ldrAngleDeg,
        prefTier: unitDir != null ? 'unit' : 'global',
      })
      continue
    }

    const angleDeg   = unitDir != null ? (DIR_TO_ANGLE[unitDir] ?? ldrAngleDeg) : ldrAngleDeg
    const angleRad   = angleDeg * Math.PI / 180
    const ldrPx      = ldrLength * 10
    const rightAlign = RIGHT_ALIGN_ANGLES.has(angleDeg)

    const lx0 = x + Math.cos(angleRad) * SYM_HALF
    const ly0 = y + Math.sin(angleRad) * SYM_HALF
    const lx1 = x + Math.cos(angleRad) * ldrPx
    const ly1 = y + Math.sin(angleRad) * ldrPx

    ctx.strokeStyle = dbColor
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly1)
    ctx.stroke()

    const tx = lx1 + (rightAlign ? -2 : 2)

    ctx.fillStyle    = textColor
    ctx.textAlign    = rightAlign ? 'right' : 'left'
    ctx.textBaseline = 'alphabetic'

    if (showsBlock) {
      // First 2 lines keep their original fixed offsets (-6/+6, i.e. centered
      // on the leader tip) so .bedb off stays pixel-identical to before; a
      // 3rd (bullseye) line extends downward at the same 12px line height
      // the dbca placement path (below) uses.
      ctx.fillText(lines[0], tx, ly1 - halfLine)
      ctx.fillText(lines[1], tx, ly1 + halfLine)
      for (let i = 2; i < lines.length; i++) ctx.fillText(lines[i], tx, ly1 + halfLine + (i - 1) * lineHeight)
    } else {
      ctx.fillText(lines[0], tx, ly1)
    }
  }

  // ── Collision-avoided datablocks (dbca on) — placed once against every
  //    other contact's symbol/label, then drawn in a second pass ───────────
  if (dbca && dbCandidates.length > 0) {
    const placements = placeDatablocks(
      dbCandidates.map((c) => ({
        id: c.id, x: c.x, y: c.y,
        lineWidths: c.lines.map((t) => ctx.measureText(t).width),
        prefAngleDeg: c.prefAngleDeg,
        prefTier: c.prefTier,
      })),
      {
        candidateAnglesDeg: DEFAULT_CANDIDATE_ANGLES_DEG,
        symbolRadius: SYM_HALF,
        leaderLen: ldrLength * 10,
        lineHeight,
        ascent: dbAscent,
        descent: dbDescent,
        padding: 2,
      },
    )

    ctx.textBaseline = 'alphabetic'
    for (const c of dbCandidates) {
      const placement = placements[c.id]
      if (!placement) continue
      const { bbox, leaderStart, leaderEnd } = placement

      ctx.strokeStyle = c.color
      ctx.lineWidth   = 1
      ctx.beginPath()
      ctx.moveTo(leaderStart.x, leaderStart.y)
      ctx.lineTo(leaderEnd.x, leaderEnd.y)
      ctx.stroke()

      ctx.fillStyle = c.textColor
      ctx.textAlign = bbox.align
      for (let i = 0; i < c.lines.length; i++) {
        ctx.fillText(c.lines[i], bbox.textX, bbox.ly1 + i * lineHeight)
      }
    }
  }

  // Faded / coasting contacts
  drawFadedContacts(ctx, view, fadedContacts, fadedNow, ptlMinutes)
}
