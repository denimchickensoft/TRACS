/**
 * AIC PICTURE computation per ATP 3-52.4 / NTTP 6-02.9 / AFTTP 3-2.8.
 *
 * All bearings stored as TRUE. Callers supply magnetic input; they convert
 * before calling (sectorAxisBearing works in either system).
 */

const NM_DEG_LAT = 60   // nm per degree latitude

// ── Geo helpers ────────────────────────────────────────────────────────────────

function _nmPerDegLng(lat) {
  return NM_DEG_LAT * Math.cos(lat * Math.PI / 180)
}

function _distNm(lat1, lng1, lat2, lng2) {
  const ref = (lat1 + lat2) / 2
  const dN  = (lat2 - lat1) * NM_DEG_LAT
  const dE  = (lng2 - lng1) * _nmPerDegLng(ref)
  return Math.hypot(dN, dE)
}

function _bearingDeg(fromLat, fromLng, toLat, toLng) {
  const ref = (fromLat + toLat) / 2
  const dN  = (toLat - fromLat) * NM_DEG_LAT
  const dE  = (toLng - fromLng) * _nmPerDegLng(ref)
  return (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
}

const _C8 = ['NORTH','NORTHEAST','EAST','SOUTHEAST','SOUTH','SOUTHWEST','WEST','NORTHWEST']
function _card8(deg) {
  return _C8[Math.round(((deg % 360) + 360) % 360 / 45) % 8]
}

// ── Sector ─────────────────────────────────────────────────────────────────────

/** Bisector of the clockwise arc from → to (true bearings). */
export function sectorAxisBearing(fromBearing, toBearing) {
  const arc = ((toBearing - fromBearing + 360) % 360) || 360
  return (fromBearing + arc / 2) % 360
}

function _inSector(lat, lng, sector) {
  const { origin, fromBearing, toBearing, rangeNm } = sector
  if (_distNm(origin.lat, origin.lng, lat, lng) > rangeNm) return false
  const brg = _bearingDeg(origin.lat, origin.lng, lat, lng)
  const arc = ((toBearing - fromBearing + 360) % 360) || 360
  if (arc >= 360) return true
  return ((brg - fromBearing + 360) % 360) <= arc
}

function _projectOnAxis(lat, lng, sector) {
  const { origin, axisBearing } = sector
  const dN  = (lat - origin.lat) * NM_DEG_LAT
  const dE  = (lng - origin.lng) * _nmPerDegLng((lat + origin.lat) / 2)
  const rad = axisBearing * Math.PI / 180
  return {
    R: dN * Math.cos(rad) + dE * Math.sin(rad),   // along axis, + = outbound toward threats
    A: dE * Math.cos(rad) - dN * Math.sin(rad),   // lateral, + = right of axis
  }
}

// ── 3nm union-find clustering ──────────────────────────────────────────────────

function _cluster(contacts) {
  const n = contacts.length
  const p = contacts.map((_, i) => i)
  const find = i => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i] } return i }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (_distNm(contacts[i].lat, contacts[i].lng, contacts[j].lat, contacts[j].lng) <= 3)
        p[find(i)] = find(j)
  const map = new Map()
  for (let i = 0; i < n; i++) { const r = find(i); if (!map.has(r)) map.set(r, []); map.get(r).push(contacts[i]) }
  return [...map.values()]
}

// ── Group property computation ─────────────────────────────────────────────────

function _groupProps(contacts, bsLat, bsLng, magvar, sector) {
  const n    = contacts.length
  const lat  = contacts.reduce((s, c) => s + c.lat, 0) / n
  const lng  = contacts.reduce((s, c) => s + c.lng, 0) / n

  const altsM    = contacts.map(c => c.alt ?? 0)
  const avgAltFt = (altsM.reduce((s, a) => s + a, 0) / n) * 3.28084
  const maxAltFt = Math.max(...altsM) * 3.28084
  const minAltFt = Math.min(...altsM) * 3.28084

  // Velocity components (m/s; track is TRUE bearing in radians)
  const avgVx    = contacts.reduce((s, c) => s + (c.speed ?? 0) * Math.sin(c.track ?? 0), 0) / n
  const avgVy    = contacts.reduce((s, c) => s + (c.speed ?? 0) * Math.cos(c.track ?? 0), 0) / n
  const avgSpdKts = contacts.reduce((s, c) => s + (c.speed ?? 0) * 1.94384, 0) / n

  const trueTrkDeg = (Math.atan2(avgVx, avgVy) * 180 / Math.PI + 360) % 360
  const magTrkDeg  = (trueTrkDeg - magvar + 360) % 360
  const trackDir   = Math.hypot(avgVx, avgVy) > 0.5 ? _card8(magTrkDeg) : null

  // Velocity along axis (kts); sector.axisBearing is TRUE
  let velocityAlongAxis = 0
  if (sector) {
    const rad = sector.axisBearing * Math.PI / 180
    velocityAlongAxis = (avgVy * Math.cos(rad) + avgVx * Math.sin(rad)) * 1.94384
  }

  // Bullseye (magnetic)
  const bsDN   = (lat - bsLat) * NM_DEG_LAT
  const bsDE   = (lng - bsLng) * _nmPerDegLng((lat + bsLat) / 2)
  const trueBrg = (Math.atan2(bsDE, bsDN) * 180 / Math.PI + 360) % 360
  const magBrg  = Math.round((trueBrg - magvar + 360) % 360) || 360

  const decl    = contacts.some(c => c.decl === 'HOSTILE') ? 'HOSTILE' : 'BOGEY'
  const platform = contacts.map(c => c.typeName).find(Boolean) ?? null
  const isStack = maxAltFt - minAltFt >= 10000

  const { R, A } = sector ? _projectOnAxis(lat, lng, sector) : { R: 0, A: 0 }

  return {
    lat, lng, R, A,
    bullseye:        { brg: magBrg, range: Math.round(Math.hypot(bsDN, bsDE)) },
    altFt:           Math.round(avgAltFt / 1000) * 1000,
    trackDir,
    decl,
    contactCount:    n,
    isHeavy:         n >= 3,
    isStack,
    stackHighFt:     isStack ? Math.round(maxAltFt / 1000) * 1000 : null,
    stackLowFt:      isStack ? Math.round(minAltFt / 1000) * 1000 : null,
    isHigh:          avgAltFt >= 40000,
    isFast:          avgSpdKts >= 600 && avgSpdKts < 900,
    isVeryFast:      avgSpdKts >= 900,
    platform,
    velocityAlongAxis,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _oc(lead, trail) {
  const rate = trail.velocityAlongAxis - lead.velocityAlongAxis
  if (rate < -30) return 'CLOSING'
  if (rate >  30) return 'OPENING'
  return null
}

// Direction of a group relative to another hostile group (or a reference
// point derived from other hostiles) — never relative to the threat axis
// or a picture-wide centroid. Two distinct points' mutual bearing is always
// ~180° apart from the reverse direction, so this can never produce the
// same compass octant for both ends of a pair — unlike bearing-to-a-shared-
// point schemes (axis or centroid), which can collide when two groups are
// laterally close together.
function _cardBetween(fromLat, fromLng, toLat, toLng, magvar) {
  const trueBrg = _bearingDeg(fromLat, fromLng, toLat, toLng)
  return _card8((trueBrg - magvar + 360) % 360)
}

function _centroidOf(groups) {
  const n = groups.length
  return {
    lat: groups.reduce((s, g) => s + g.lat, 0) / n,
    lng: groups.reduce((s, g) => s + g.lng, 0) / n,
  }
}

const _ORDS = ['', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH']
function _ord(n) { return _ORDS[n] ?? `${n}TH` }

// ── Formation detection ────────────────────────────────────────────────────────

function _detectFormation(groups) {
  const n      = groups.length
  const sorted = [...groups].sort((a, b) => a.R - b.R)

  if (n === 1) return { subtype: 'SINGLE', sorted }

  if (n === 2) {
    const depth  = sorted[1].R - sorted[0].R
    const latSep = Math.abs(sorted[1].A - sorted[0].A)
    return { subtype: latSep >= depth ? 'AZIMUTH' : 'RANGE', sorted, depth, latSep }
  }

  // 3+ groups
  const dTotal   = sorted[n - 1].R - sorted[0].R
  const sortedByA = [...sorted].sort((a, b) => a.A - b.A)

  if (dTotal <= 5) return { subtype: 'WALL', sorted, sortedByA, dTotal }

  if (n === 3) {
    const d01 = sorted[1].R - sorted[0].R
    const d12 = sorted[2].R - sorted[1].R
    if (d01 <= 5 && d12 > 5 && Math.abs(sorted[1].A - sorted[0].A) >= 3)
      return { subtype: 'CHAMPAGNE', sorted, d01, d12 }
    if (d12 <= 5 && d01 > 5 && Math.abs(sorted[2].A - sorted[1].A) >= 3)
      return { subtype: 'VIC', sorted, d01, d12 }
    return { subtype: 'LADDER', sorted }
  }

  if (n === 4) {
    const d01 = sorted[1].R - sorted[0].R
    const d12 = sorted[2].R - sorted[1].R
    const d23 = sorted[3].R - sorted[2].R
    if (d01 <= 5 && d23 <= 5 && d12 > 5 &&
        Math.abs(sorted[1].A - sorted[0].A) >= 3 &&
        Math.abs(sorted[3].A - sorted[2].A) >= 3)
      return { subtype: 'BOX', sorted, d01, dMid: d12, d23 }
  }

  return { subtype: 'LEADING_EDGE', sorted }
}

// ── Group naming ───────────────────────────────────────────────────────────────

function _nameGroups(formation, magvar) {
  const { subtype, sorted } = formation

  switch (subtype) {
    case 'SINGLE':
      return [{ ...sorted[0], name: 'SINGLE GROUP' }]

    case 'AZIMUTH': {
      const [a, b] = [...sorted].sort((x, y) => x.A - y.A)
      return [
        { ...a, name: `${_cardBetween(b.lat, b.lng, a.lat, a.lng, magvar)} GROUP` },
        { ...b, name: `${_cardBetween(a.lat, a.lng, b.lat, b.lng, magvar)} GROUP` },
      ]
    }

    case 'RANGE':
      return [
        { ...sorted[0], name: 'LEAD GROUP',  openingClosing: _oc(sorted[0], sorted[1]) },
        { ...sorted[1], name: 'TRAIL GROUP' },
      ]

    case 'WALL': {
      const { sortedByA } = formation
      const nOuter = sortedByA.length
      const first  = sortedByA[0]
      const last   = sortedByA[nOuter - 1]
      const cardFirst = _cardBetween(last.lat, last.lng, first.lat, first.lng, magvar)
      const cardLast  = _cardBetween(first.lat, first.lng, last.lat, last.lng, magvar)
      const aMin = first.A, totalWidth = last.A - first.A
      return sortedByA.map((g, i) => {
        let name
        if (i === 0)                name = `${cardFirst} GROUP`
        else if (i === nOuter - 1)  name = `${cardLast} GROUP`
        else if (nOuter === 3)      name = 'MIDDLE GROUP'
        else {
          const frac = totalWidth !== 0 ? (g.A - aMin) / totalWidth : 0.5
          name = `${frac < 0.5 ? cardFirst : cardLast} MIDDLE GROUP`
        }
        return { ...g, name }
      })
    }

    case 'VIC': {
      const [lead, t1, t2] = sorted
      const [tL, tR] = [t1, t2].sort((a, b) => a.A - b.A)
      return [
        { ...lead, name: 'LEAD GROUP', openingClosing: _oc(lead, t1) },
        { ...tL,   name: `${_cardBetween(tR.lat, tR.lng, tL.lat, tL.lng, magvar)} TRAIL GROUP` },
        { ...tR,   name: `${_cardBetween(tL.lat, tL.lng, tR.lat, tR.lng, magvar)} TRAIL GROUP` },
      ]
    }

    case 'CHAMPAGNE': {
      const [l1, l2, trail] = sorted
      const [lL, lR] = [l1, l2].sort((a, b) => a.A - b.A)
      return [
        { ...lL,   name: `${_cardBetween(lR.lat, lR.lng, lL.lat, lL.lng, magvar)} LEAD GROUP` },
        { ...lR,   name: `${_cardBetween(lL.lat, lL.lng, lR.lat, lR.lng, magvar)} LEAD GROUP` },
        { ...trail, name: 'TRAIL GROUP', openingClosing: _oc(l1, trail) },
      ]
    }

    case 'LADDER':
      return sorted.map((g, i) => {
        let name
        if (i === 0)                  name = 'LEAD GROUP'
        else if (i === sorted.length - 1) name = 'TRAIL GROUP'
        else if (sorted.length === 3)  name = 'MIDDLE GROUP'
        else                           name = `${_ord(i + 1)} GROUP`
        return { ...g, name }
      })

    case 'BOX': {
      const [g0, g1, g2, g3] = sorted
      const [lL, lR] = [g0, g1].sort((a, b) => a.A - b.A)
      const [tL, tR] = [g2, g3].sort((a, b) => a.A - b.A)
      return [
        { ...lL, name: `${_cardBetween(lR.lat, lR.lng, lL.lat, lL.lng, magvar)} LEAD GROUP`  },
        { ...lR, name: `${_cardBetween(lL.lat, lL.lng, lR.lat, lR.lng, magvar)} LEAD GROUP`  },
        { ...tL, name: `${_cardBetween(tR.lat, tR.lng, tL.lat, tL.lng, magvar)} TRAIL GROUP` },
        { ...tR, name: `${_cardBetween(tL.lat, tL.lng, tR.lat, tR.lng, magvar)} TRAIL GROUP` },
      ]
    }

    // FOLLOW ON groups are not named/detailed as their own PICTURE entries —
    // doctrine reports them as a single distance amplifier (see _amplifiers).
    // They're still tagged and returned so the scope can track/select them.
    case 'LEADING_EDGE': {
      const leadSlice  = sorted.slice(0, Math.min(3, sorted.length))
      const followSlice = sorted.slice(Math.min(3, sorted.length))
      const named   = _nameGroups(_detectFormation(leadSlice), magvar)
      const follows = followSlice.map(g => ({ ...g, name: 'FOLLOW ON', isFollowOn: true }))
      return [...named, ...follows]
    }

    default:
      return sorted.map((g, i) => ({ ...g, name: `GROUP ${i + 1}` }))
  }
}

// ── Amplifiers ─────────────────────────────────────────────────────────────────

function _amplifiers(formation, magvar) {
  const { subtype, sorted } = formation
  const result = { openingClosing: null, weighted: null, echelon: null, dimensionStr: '', followOnNm: null }

  const totalDepth = sorted.length > 1 ? Math.round(sorted[sorted.length - 1].R - sorted[0].R) : 0
  const sortedByA  = formation.sortedByA ?? [...sorted].sort((a, b) => a.A - b.A)
  const totalWidth = sortedByA.length > 1
    ? Math.round(sortedByA[sortedByA.length - 1].A - sortedByA[0].A) : 0

  switch (subtype) {
    case 'AZIMUTH': {
      result.dimensionStr = `${totalWidth}`
      const d = Math.abs(sorted[1].R - sorted[0].R)
      if (d > 5) {
        const [near, off] = sorted[1].R > sorted[0].R ? [sorted[0], sorted[1]] : [sorted[1], sorted[0]]
        result.echelon = _cardBetween(near.lat, near.lng, off.lat, off.lng, magvar)
      }
      break
    }

    case 'RANGE': {
      const d = Math.round(Math.abs(sorted[1].R - sorted[0].R))
      const w = Math.round(Math.abs(sorted[1].A - sorted[0].A))
      result.dimensionStr    = `${d}`
      result.openingClosing  = _oc(sorted[0], sorted[1])
      if (w >= 3) result.echelon = _cardBetween(sorted[0].lat, sorted[0].lng, sorted[1].lat, sorted[1].lng, magvar)
      break
    }

    case 'WALL': {
      result.dimensionStr = `${totalWidth} WIDE`
      if (sorted.length >= 3 && totalWidth > 0) {
        const first = sortedByA[0], last = sortedByA[sortedByA.length - 1]
        const midLat = (first.lat + last.lat) / 2, midLng = (first.lng + last.lng) / 2
        const aMin  = first.A
        for (let i = 1; i < sortedByA.length - 1; i++) {
          const frac = (sortedByA[i].A - aMin) / totalWidth
          if (frac < 1 / 3 || frac > 2 / 3) {
            result.weighted = _cardBetween(midLat, midLng, sortedByA[i].lat, sortedByA[i].lng, magvar)
            break
          }
        }
      }
      break
    }

    case 'VIC': {
      const [lead, t1, t2] = sorted
      const trailW = Math.round(Math.abs(t2.A - t1.A))
      result.dimensionStr   = `${totalDepth} DEEP ${trailW} WIDE`
      result.openingClosing = _oc(lead, t1)
      const midA  = (t1.A + t2.A) / 2
      const tSpan = Math.abs(t2.A - t1.A)
      if (tSpan > 0 && Math.abs(lead.A - midA) > tSpan / 3) {
        const midLat = (t1.lat + t2.lat) / 2, midLng = (t1.lng + t2.lng) / 2
        result.weighted = _cardBetween(midLat, midLng, lead.lat, lead.lng, magvar)
      }
      break
    }

    case 'CHAMPAGNE': {
      const [l1, l2, trail] = sorted
      const leadW = Math.round(Math.abs(l2.A - l1.A))
      result.dimensionStr   = `${leadW} WIDE ${totalDepth} DEEP`
      result.openingClosing = _oc(l1, trail)
      const midA  = (l1.A + l2.A) / 2
      const lSpan = Math.abs(l2.A - l1.A)
      if (lSpan > 0 && Math.abs(trail.A - midA) > lSpan / 3) {
        const midLat = (l1.lat + l2.lat) / 2, midLng = (l1.lng + l2.lng) / 2
        result.weighted = _cardBetween(midLat, midLng, trail.lat, trail.lng, magvar)
      }
      break
    }

    case 'LADDER': {
      result.dimensionStr   = `${totalDepth} DEEP`
      result.openingClosing = _oc(sorted[0], sorted[sorted.length - 1])
      break
    }

    case 'BOX': {
      const [g0, g1, g2, g3] = sorted
      const boxW = Math.round(Math.max(Math.abs(g1.A - g0.A), Math.abs(g3.A - g2.A)))
      result.dimensionStr = `${boxW} WIDE ${totalDepth} DEEP`
      break
    }

    // FOLLOW ON is a single parallel-to-axis distance from the leading edge
    // to the closest follow-on group — not a per-group breakdown.
    case 'LEADING_EDGE': {
      const leadSlice   = sorted.slice(0, Math.min(3, sorted.length))
      const followSlice = sorted.slice(Math.min(3, sorted.length))
      if (followSlice.length) {
        result.followOnNm = Math.round(followSlice[0].R - leadSlice[leadSlice.length - 1].R)
      }
      break
    }

    default:
      break
  }

  return result
}

// ── Threat axis ────────────────────────────────────────────────────────────────
// The threat axis is dynamic, not the bisector of a drawn sector — a manual
// .sector only scopes which contacts are "in play." The axis itself is a line
// from a friendly toward the hostile picture:
//   - sector set, friendlies in it   → friendly nearest a hostile → centroid
//                                      of hostiles in the sector.
//   - sector set, no friendlies in it → sector origin → centroid of hostiles
//                                      in the sector.
//   - no sector                     → friendly nearest a hostile → centroid
//                                      of all visible hostiles.
function _deriveThreatAxis(hostiles, friendlies, sector, bsLat, bsLng) {
  const hostileCentroid = _centroidOf(hostiles)

  let origin
  if (friendlies.length) {
    let best = Infinity, bestF = null
    for (const f of friendlies) {
      for (const h of hostiles) {
        const d = _distNm(f.lat, f.lng, h.lat, h.lng)
        if (d < best) { best = d; bestF = f }
      }
    }
    origin = bestF
  } else if (sector) {
    origin = sector.origin
  } else {
    origin = { lat: bsLat, lng: bsLng }
  }

  const dist = _distNm(origin.lat, origin.lng, hostileCentroid.lat, hostileCentroid.lng)
  const axisBearing = dist > 0.01
    ? _bearingDeg(origin.lat, origin.lng, hostileCentroid.lat, hostileCentroid.lng)
    : 0
  return { origin, axisBearing, centroid: hostileCentroid }
}

// ── Label string ───────────────────────────────────────────────────────────────

const _SUBTYPE_WORD = {
  SINGLE: 'SINGLE GROUP', AZIMUTH: 'AZIMUTH', RANGE: 'RANGE',
  WALL: 'WALL', VIC: 'VIC', CHAMPAGNE: 'CHAMPAGNE', LADDER: 'LADDER',
  BOX: 'BOX', LEADING_EDGE: 'LEADING EDGE',
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function computePicture(visibleUnits, getEffectiveDecl, myCoalitionNum, sector, bsLat, bsLng, magvar) {
  // Hostile/bogey contacts — scoped to the sector if one is set, otherwise
  // every visible hostile/bogey is in play.
  const contacts = []
  for (const [id, unit] of Object.entries(visibleUnits)) {
    if (!unit.position) continue
    const decl = getEffectiveDecl(id, unit)
    if (decl !== 'HOSTILE' && decl !== 'BOGEY') continue
    if (sector && !_inSector(unit.position.lat, unit.position.lng, sector)) continue
    contacts.push({
      id, lat: unit.position.lat, lng: unit.position.lng,
      alt:      unit.position.alt ?? 0,
      speed:    unit.speed        ?? 0,
      track:    unit.track        ?? 0,
      decl,
      typeName: (unit.name ?? '').replace(/[_ ].*$/, '').replace(/^([^-]*-[^-]*)-.*$/, '$1') || null,
    })
  }

  if (!contacts.length) {
    return { totalGroups: 0, groups: [], label: 'CLEAN', labelKey: 'CLEAN', amplifiers: null, autoSector: !sector }
  }

  // Friendlies, scoped the same way as the hostiles — used only to derive
  // the threat axis, never to fill out the PICTURE itself.
  const friendlies = []
  for (const [id, unit] of Object.entries(visibleUnits)) {
    if (!unit.position) continue
    if (getEffectiveDecl(id, unit) !== 'FRIENDLY') continue
    if (sector && !_inSector(unit.position.lat, unit.position.lng, sector)) continue
    friendlies.push({ lat: unit.position.lat, lng: unit.position.lng })
  }

  const axis = _deriveThreatAxis(contacts, friendlies, sector, bsLat, bsLng)

  const groups = _cluster(contacts).map(c => _groupProps(c, bsLat, bsLng, magvar, axis))
  groups.sort((a, b) => a.R - b.R)

  const formation   = _detectFormation(groups)
  const namedGroups = _nameGroups(formation, magvar)
  const ampls       = _amplifiers(formation, magvar)

  // Hard guarantee: no two groups ever share a display name. Mutual-bearing
  // naming makes collisions essentially impossible (two distinct points'
  // bearing is always ~180° apart from the reverse), but this remains as a
  // safety net for pathological many-group walls the fraction split doesn't
  // cleanly resolve.
  const nameCounts = new Map()
  for (const g of namedGroups) {
    const count = (nameCounts.get(g.name) ?? 0) + 1
    nameCounts.set(g.name, count)
    if (count > 1) g.name = `${g.name} ${count}`
  }

  const n    = groups.length
  const word = _SUBTYPE_WORD[formation.subtype] ?? formation.subtype
  const label = formation.subtype === 'SINGLE' ? 'SINGLE GROUP' : `${n} GROUPS ${word}`

  return {
    totalGroups: n,
    groups:      namedGroups,
    label,
    labelKey:    formation.subtype,
    amplifiers:  ampls,
    autoSector:  !sector,
    centroid:    axis.centroid,
    axisOrigin:  axis.origin,
    axisBearing: axis.axisBearing,
  }
}
