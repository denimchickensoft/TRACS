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

  const decl    = contacts.some(c => c.decl === 'HOSTILE') ? 'HOSTILE' : 'UNKNOWN'
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
    isBogeySpades:   decl === 'UNKNOWN',
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

function _cardFromOrigin(g, sector) {
  if (!sector) return ''
  return _card8(_bearingDeg(sector.origin.lat, sector.origin.lng, g.lat, g.lng))
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

function _nameGroups(formation, sector) {
  const { subtype, sorted } = formation

  switch (subtype) {
    case 'SINGLE':
      return [{ ...sorted[0], name: 'SINGLE GROUP' }]

    case 'AZIMUTH': {
      const [a, b] = [...sorted].sort((x, y) => x.A - y.A)
      return [
        { ...a, name: `${_cardFromOrigin(a, sector)} GROUP` },
        { ...b, name: `${_cardFromOrigin(b, sector)} GROUP` },
      ]
    }

    case 'RANGE':
      return [
        { ...sorted[0], name: 'LEAD GROUP',  openingClosing: _oc(sorted[0], sorted[1]) },
        { ...sorted[1], name: 'TRAIL GROUP' },
      ]

    case 'WALL': {
      const { sortedByA } = formation
      return sortedByA.map((g, i) => {
        let name
        if (i === 0 || i === sortedByA.length - 1) name = `${_cardFromOrigin(g, sector)} GROUP`
        else if (sortedByA.length === 3) name = 'MIDDLE GROUP'
        else name = `${_cardFromOrigin(g, sector)} MIDDLE GROUP`
        return { ...g, name }
      })
    }

    case 'VIC': {
      const [lead, t1, t2] = sorted
      const [tL, tR] = [t1, t2].sort((a, b) => a.A - b.A)
      return [
        { ...lead, name: 'LEAD GROUP', openingClosing: _oc(lead, t1) },
        { ...tL,   name: `${_cardFromOrigin(tL, sector)} TRAIL GROUP` },
        { ...tR,   name: `${_cardFromOrigin(tR, sector)} TRAIL GROUP` },
      ]
    }

    case 'CHAMPAGNE': {
      const [l1, l2, trail] = sorted
      const [lL, lR] = [l1, l2].sort((a, b) => a.A - b.A)
      return [
        { ...lL,   name: `${_cardFromOrigin(lL, sector)} LEAD GROUP` },
        { ...lR,   name: `${_cardFromOrigin(lR, sector)} LEAD GROUP` },
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
        { ...lL, name: `${_cardFromOrigin(lL, sector)} LEAD GROUP`  },
        { ...lR, name: `${_cardFromOrigin(lR, sector)} LEAD GROUP`  },
        { ...tL, name: `${_cardFromOrigin(tL, sector)} TRAIL GROUP` },
        { ...tR, name: `${_cardFromOrigin(tR, sector)} TRAIL GROUP` },
      ]
    }

    case 'LEADING_EDGE': {
      const leadSlice  = sorted.slice(0, Math.min(3, sorted.length))
      const followSlice = sorted.slice(Math.min(3, sorted.length))
      const named   = _nameGroups(_detectFormation(leadSlice), sector)
      const follows = followSlice.map((g, i) => ({
        ...g,
        name: followSlice.length === 1 ? 'FOLLOW ON GROUP' : `${_ord(i + 2)} FOLLOW ON GROUP`,
        isFollowOn: true,
      }))
      return [...named, ...follows]
    }

    default:
      return sorted.map((g, i) => ({ ...g, name: `GROUP ${i + 1}` }))
  }
}

// ── Amplifiers ─────────────────────────────────────────────────────────────────

function _amplifiers(formation, sector) {
  const { subtype, sorted } = formation
  const result = { openingClosing: null, weighted: null, echelon: null, dimensionStr: '' }

  const totalDepth = sorted.length > 1 ? Math.round(sorted[sorted.length - 1].R - sorted[0].R) : 0
  const sortedByA  = formation.sortedByA ?? [...sorted].sort((a, b) => a.A - b.A)
  const totalWidth = sortedByA.length > 1
    ? Math.round(sortedByA[sortedByA.length - 1].A - sortedByA[0].A) : 0

  switch (subtype) {
    case 'AZIMUTH': {
      result.dimensionStr = `${totalWidth}`
      const d = Math.abs(sorted[1].R - sorted[0].R)
      if (d > 5) {
        const off = sorted[1].R > sorted[0].R ? sorted[1] : sorted[0]
        result.echelon = _cardFromOrigin(off, sector)
      }
      break
    }

    case 'RANGE': {
      const d = Math.round(Math.abs(sorted[1].R - sorted[0].R))
      const w = Math.round(Math.abs(sorted[1].A - sorted[0].A))
      result.dimensionStr    = `${d}`
      result.openingClosing  = _oc(sorted[0], sorted[1])
      if (w >= 3) result.echelon = _cardFromOrigin(sorted[1], sector)
      break
    }

    case 'WALL': {
      result.dimensionStr = `${totalWidth} WIDE`
      if (sorted.length >= 3 && totalWidth > 0) {
        const aMin  = sortedByA[0].A
        for (let i = 1; i < sortedByA.length - 1; i++) {
          const frac = (sortedByA[i].A - aMin) / totalWidth
          if (frac < 1 / 3 || frac > 2 / 3) { result.weighted = _cardFromOrigin(sortedByA[i], sector); break }
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
      if (tSpan > 0 && Math.abs(lead.A - midA) > tSpan / 3) result.weighted = _cardFromOrigin(lead, sector)
      break
    }

    case 'CHAMPAGNE': {
      const [l1, l2, trail] = sorted
      const leadW = Math.round(Math.abs(l2.A - l1.A))
      result.dimensionStr   = `${leadW} WIDE ${totalDepth} DEEP`
      result.openingClosing = _oc(l1, trail)
      const midA  = (l1.A + l2.A) / 2
      const lSpan = Math.abs(l2.A - l1.A)
      if (lSpan > 0 && Math.abs(trail.A - midA) > lSpan / 3) result.weighted = _cardFromOrigin(trail, sector)
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

    default:
      break
  }

  return result
}

// ── Auto-sector ────────────────────────────────────────────────────────────────

export function deriveAutoSector(visibleUnits, getEffectiveDecl, myCoalitionNum) {
  let best = Infinity, bestF = null, bestH = null
  for (const [fId, f] of Object.entries(visibleUnits)) {
    if (!f.position || getEffectiveDecl(fId, f) !== 'FRIENDLY') continue
    for (const [hId, h] of Object.entries(visibleUnits)) {
      if (!h.position) continue
      const hd = getEffectiveDecl(hId, h)
      if (hd !== 'HOSTILE' && hd !== 'UNKNOWN') continue
      const d = _distNm(f.position.lat, f.position.lng, h.position.lat, h.position.lng)
      if (d < best) { best = d; bestF = f; bestH = h }
    }
  }
  if (!bestF || !bestH) return null

  const axis = _bearingDeg(bestF.position.lat, bestF.position.lng, bestH.position.lat, bestH.position.lng)
  return {
    origin:      { lat: bestF.position.lat, lng: bestF.position.lng },
    fromBearing: (axis - 45 + 360) % 360,
    toBearing:   (axis + 45)       % 360,
    rangeNm:     150,
    axisBearing: axis,
    isAuto:      true,
  }
}

// ── Label string ───────────────────────────────────────────────────────────────

const _SUBTYPE_WORD = {
  SINGLE: 'SINGLE GROUP', AZIMUTH: 'AZIMUTH', RANGE: 'RANGE',
  WALL: 'WALL', VIC: 'VIC', CHAMPAGNE: 'CHAMPAGNE', LADDER: 'LADDER',
  BOX: 'BOX', LEADING_EDGE: 'LEADING EDGE',
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function computePicture(visibleUnits, getEffectiveDecl, myCoalitionNum, sector, bsLat, bsLng, magvar) {
  const effectiveSector = sector
    ?? deriveAutoSector(visibleUnits, getEffectiveDecl, myCoalitionNum)
    ?? { origin: { lat: bsLat, lng: bsLng }, fromBearing: 0, toBearing: 0, rangeNm: 99999, axisBearing: 0, isAuto: true }

  const contacts = []
  for (const [id, unit] of Object.entries(visibleUnits)) {
    if (!unit.position) continue
    const decl = getEffectiveDecl(id, unit)
    if (decl !== 'HOSTILE' && decl !== 'UNKNOWN') continue
    if (!_inSector(unit.position.lat, unit.position.lng, effectiveSector)) continue
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
    return { totalGroups: 0, groups: [], label: 'CLEAN', labelKey: 'CLEAN', amplifiers: null, autoSector: effectiveSector.isAuto ?? false }
  }

  const groups = _cluster(contacts).map(c => _groupProps(c, bsLat, bsLng, magvar, effectiveSector))
  groups.sort((a, b) => a.R - b.R)

  const formation   = _detectFormation(groups)
  const namedGroups = _nameGroups(formation, effectiveSector)
  const ampls       = _amplifiers(formation, effectiveSector)

  const n    = groups.length
  const word = _SUBTYPE_WORD[formation.subtype] ?? formation.subtype
  const label = formation.subtype === 'SINGLE' ? 'SINGLE GROUP' : `${n} GROUPS ${word}`

  return {
    totalGroups: n,
    groups:      namedGroups,
    label,
    labelKey:    formation.subtype,
    amplifiers:  ampls,
    autoSector:  effectiveSector.isAuto ?? false,
  }
}
