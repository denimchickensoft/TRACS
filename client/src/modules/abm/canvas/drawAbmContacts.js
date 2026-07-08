/**
 * ABM air-contact rendering — a distinct symbology from both AIC and ATC,
 * per 2026-07-05 direction: same declaration colors as AIC, but every
 * contact is a plain square (no HAFU dome/staple/triangle shapes), with
 * STARS/ASDE-X-style persistent datablocks + leader lines + history trails,
 * all colored to match the contact's classification (not white/gray like
 * STARS/ASDE-X use). Declarations are ABM's own (store/abm.js) — kept
 * independent from AIC's, not shared (deferred, see abm-spec.md §1.2).
 */

import { latLngToCanvas } from '../../atc/stars/canvas/projection.js'
import { drawPtl, DECL_COLOR } from '../../aic/canvas/drawAicContacts.js'
import { DIR_TO_ANGLE, RIGHT_ALIGN_ANGLES } from '../../atc/stars/constants.js'
import { DECLARATION } from '../../../store/abm.js'
import { useAtcStore }  from '../../../store/atc.js'

const SYM_HALF     = 3   // square half-width, px (hollow outline, not filled)
const CULL_MARGIN  = 60
const EMPTY_SET    = new Set()

function resolveCallsignDisplay(unit) {
  const override = useAtcStore.getState().callsignOverrides[String(unit.id)]
  return override || unit.callsign || unit.unitName || unit.name || '?'
}

// Same truncation AIC's readout uses: strip suffix after _/space, then
// collapse a double-hyphen type name to its first two segments.
function typeAbbrev(unit) {
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

function parseFlightElement(unit) {
  const raw = resolveCallsignDisplay(unit)
  if (!raw) return null
  const cleaned = raw.replace(/[^a-z0-9]/gi, '').toUpperCase()
  const m = cleaned.match(FLIGHT_RE)
  if (!m) return null
  const [, prefix, digits] = m
  const element  = parseInt(digits.slice(-1), 10)
  const flightNo = digits.slice(0, -1)
  return { flightKey: `${prefix}${flightNo}`, element }
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
function computeSuppressedIds(units) {
  const groups = new Map()
  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const fe = parseFlightElement(unit)
    if (!fe) continue
    if (!groups.has(fe.flightKey)) groups.set(fe.flightKey, [])
    groups.get(fe.flightKey).push({ id, element: fe.element, unit })
  }

  const suppressed = new Set()
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
        }
      }
    }
  }
  return suppressed
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
    const nmPerDegLng = 60 * Math.cos(unit.position.lat * Math.PI / 180)
    const coastLat    = unit.position.lat + (Math.cos(track) * distNm) / 60
    const coastLng    = unit.position.lng + (Math.sin(track) * distNm) / nmPerDegLng
    const { x, y }    = latLngToCanvas(coastLat, coastLng, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue

    if (ptlMinutes > 0) drawPtl(ctx, x, y, unit, view, ptlMinutes * 60, '#888')

    ctx.strokeStyle = '#888'
    ctx.lineWidth   = 1.5
    ctx.strokeRect(x - SYM_HALF, y - SYM_HALF, SYM_HALF * 2, SYM_HALF * 2)
  }

  ctx.restore()
}

export function drawAbmContacts(
  ctx, view, units, getDecl,
  ptlMinutes, dbVisible, altToggle,
  ldrLength, ldrAngleDeg, leaderDirs,
  history, historyLimit,
  fadedContacts = {}, fadedNow = 0,
  dbSuppress = true,
  myCoalitionNum = null,
) {
  const { width, height } = view
  ctx.font = '11px "Roboto Mono", monospace'

  const suppressedIds = dbSuppress ? computeSuppressedIds(units) : EMPTY_SET

  for (const [id, unit] of Object.entries(units)) {
    if (!unit.position) continue
    const { x, y } = latLngToCanvas(unit.position.lat, unit.position.lng, view)
    if (x < -CULL_MARGIN || x > width + CULL_MARGIN || y < -CULL_MARGIN || y > height + CULL_MARGIN) continue

    const decl  = getDecl(id, unit)
    const color = DECL_COLOR[decl] ?? DECL_COLOR[DECLARATION.BOGEY]

    if (ptlMinutes > 0) drawPtl(ctx, x, y, unit, view, ptlMinutes * 60, color)

    // History trail — small squares in the same classification color, fading
    const trail = (history ?? {})[id] || []
    for (let i = 0; i < trail.length && i < historyLimit; i++) {
      const hp = latLngToCanvas(trail[i].lat, trail[i].lng, view)
      ctx.globalAlpha = Math.max(0.15, 0.6 - i * 0.12)
      ctx.fillStyle   = color
      ctx.fillRect(hp.x - SYM_HALF / 2, hp.y - SYM_HALF / 2, SYM_HALF, SYM_HALF)
    }
    ctx.globalAlpha = 1

    // Symbol — plain hollow square, no shape variation by declaration
    ctx.strokeStyle = color
    ctx.lineWidth   = 1.5
    ctx.strokeRect(x - SYM_HALF, y - SYM_HALF, SYM_HALF * 2, SYM_HALF * 2)

    if (!dbVisible) continue
    if (suppressedIds.has(id)) continue  // formation lead's datablock covers this wingman

    const unitDir    = leaderDirs?.[String(id)]
    const angleDeg   = unitDir != null ? (DIR_TO_ANGLE[unitDir] ?? ldrAngleDeg) : ldrAngleDeg
    const angleRad   = angleDeg * Math.PI / 180
    const ldrPx      = ldrLength * 10
    const rightAlign = RIGHT_ALIGN_ANGLES.has(angleDeg)

    const lx0 = x + Math.cos(angleRad) * SYM_HALF
    const ly0 = y + Math.sin(angleRad) * SYM_HALF
    const lx1 = x + Math.cos(angleRad) * ldrPx
    const ly1 = y + Math.sin(angleRad) * ldrPx

    ctx.strokeStyle = color
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(lx0, ly0)
    ctx.lineTo(lx1, ly1)
    ctx.stroke()

    // Datablock — friendly gets callsign + alt/speed-or-type; everyone else
    // gets a single alt/speed line (no callsign — same "IFF doesn't know the
    // bogey's name" convention AIC's readout already uses). Keyed off the
    // unit's *actual* coalition, not the (possibly manually overridden)
    // declaration — a controller tagging a real hostile/neutral as FRIENDLY
    // (F4) changes its color but must not grant it the friendly-only 2-line
    // datablock (2026-07-08).
    const isFriendly = unit.coalition === myCoalitionNum
    const altFt   = Math.round((unit.position.alt ?? 0) * 3.28084)
    const alt100  = String(Math.round(altFt / 100)).padStart(3, '0')
    const spdKts  = (unit.speed ?? 0) * 1.94384
    const spd10   = String(Math.round(spdKts / 10)).padStart(2, '0')
    const tx      = lx1 + (rightAlign ? -2 : 2)

    ctx.fillStyle    = '#ffffff'
    ctx.textAlign    = rightAlign ? 'right' : 'left'
    ctx.textBaseline = 'alphabetic'

    if (isFriendly) {
      ctx.fillText(resolveCallsignDisplay(unit).toUpperCase(), tx, ly1 - 6)
      const line2 = altToggle ? `${alt100} ${typeAbbrev(unit)}` : `${alt100} ${spd10}`
      ctx.fillText(line2, tx, ly1 + 6)
    } else {
      ctx.fillText(`${alt100} ${spd10}`, tx, ly1)
    }
  }

  // Faded / coasting contacts
  drawFadedContacts(ctx, view, fadedContacts, fadedNow, ptlMinutes)
}
