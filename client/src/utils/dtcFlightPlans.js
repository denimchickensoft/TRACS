// Parses DCS's in-game Data Transfer Cartridge (.dtc, JSON) files for
// flight-plan import. Schema reverse-engineered from sample files (no public
// spec exists) -- see resources/specs/pilot-flightplan-ingestion-spec.md §6.

import { dcsPointToLatLng } from './dcsCoords.js'
import { matchFixName } from './fixMatch.js'
import { formatIcaoRoutePoint } from './coords.js'

const M_TO_FT = 3.28084
const ROUTE_SLOTS = ['R1', 'R2', 'R3']

// ALT is stored as hundreds of feet MSL (e.g. 35,000 ft -> "350"), per
// resources/specs/flightplans-strips-spec.md's field convention.
function metersToAltField(m) {
  return String(Math.round(m * M_TO_FT / 100))
}

function detectFamily(dtcType) {
  const t = (dtcType ?? '').toUpperCase().replace(/-/g, '')
  if (t.startsWith('F16')) return 'f16c'
  if (t.startsWith('FA18')) return 'fa18c'
  return null
}

function getNavPts(data, family) {
  if (family === 'f16c') return data?.MPD?.NAV_PTS ?? []
  if (family === 'fa18c') return data?.WYPT?.NAV_PTS ?? []
  return []
}

// F-16C carries a single `note` field per point; the F/A-18C carries two
// (`note` and `text_note`) -- confirmed via sample data that `text_note`,
// not `note`, is the Hornet's intended fix-name field (spec §6.2).
function fixNameField(family) {
  return family === 'fa18c' ? 'text_note' : 'note'
}

// Returns { family, theatre, slots }, where `slots` is one entry per
// populated R1/R2/R3 route (points ordered by that slot's own `_order`
// field) -- a DTC point can belong to up to three independently-ordered
// stored routes at once, and the file carries no signal for which one the
// pilot means, so the import UI must let the controller pick (spec §6.3).
export function dtcRouteSlots(dtcJson) {
  const family = detectFamily(dtcJson?.type)
  if (!family) throw new Error(`Unsupported DTC aircraft type: "${dtcJson?.type}"`)

  const pts = getNavPts(dtcJson.data, family)
  const slots = []
  for (const slot of ROUTE_SLOTS) {
    const inSlot = pts.filter((p) => p[slot] === true)
    if (inSlot.length === 0) continue
    inSlot.sort((a, b) => (a[`${slot}_order`] ?? 0) - (b[`${slot}_order`] ?? 0))
    slots.push({ slot, points: inSlot })
  }
  return { family, theatre: dtcJson.data?.terrain ?? null, slots }
}

// Builds one flight-plan candidate from a chosen route slot's points. DTC
// files carry no callsign at all (unlike .miz/CSV) -- the controller
// supplies `aid` in the import UI.
export function buildDtcFlightPlan(family, theatre, slotPoints, aid) {
  const field = fixNameField(family)
  const tokens = []
  const alts = []
  for (const p of slotPoints) {
    const ll = theatre ? dcsPointToLatLng(p.x, p.y, theatre) : null
    if (p.alt != null) alts.push(p.alt)
    const matched = ll ? matchFixName(p[field], ll.lat, ll.lng) : null
    tokens.push(matched ?? (ll ? formatIcaoRoutePoint(ll.lat, ll.lng) : (p[field] || '?')))
  }
  const maxAlt = alts.length ? metersToAltField(Math.max(...alts)) : ''

  return {
    aid: (aid ?? '').toUpperCase(),
    typ: family === 'f16c' ? 'F16C' : 'FA18C',
    eq: '',
    dep: '',
    dest: '',
    spd: '',
    alt: maxAlt,
    rte: tokens.join(' '),
    rmk: '',
    flightRules: 'IFR',
    source: 'dtc',
  }
}
