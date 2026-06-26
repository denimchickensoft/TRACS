// Resolves a filed flight plan route string into drawable geometry.
// Returns segments (solid/dashed polylines), fixLabels (dots + idents),
// and missing (midpoint coords for '?' markers on unresolvable tokens).

const COORD_PREC  = 4     // decimal places for segment-endpoint key matching (~11m)
const NEAREST_TOL = 0.05  // degrees (~3nm) to snap fix coords to airway graph nodes

function coordKey(lon, lat) {
  return `${lon.toFixed(COORD_PREC)},${lat.toFixed(COORD_PREC)}`
}

function midpoint(a, b) {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
}

function coordsDiffer(a, b) {
  return Math.abs(a.lat - b.lat) > 1e-8 || Math.abs(a.lon - b.lon) > 1e-8
}

// BFS walk along a named airway from entryPt to exitPt.
// Returns ordered array of {lat, lon} nodes, or null on failure.
function walkAirway(airwayName, entryPt, exitPt, airways) {
  const segs = [
    ...(airways.V ?? []),
    ...(airways.J ?? []),
    ...(airways.B ?? []),
  ].filter(s => s.name === airwayName)

  if (!segs.length) return null

  const graph  = new Map()  // coordKey → Set<coordKey>
  const coords = new Map()  // coordKey → {lat, lon}

  for (const seg of segs) {
    const [fLon, fLat] = seg.from
    const [tLon, tLat] = seg.to
    const fk = coordKey(fLon, fLat)
    const tk = coordKey(tLon, tLat)
    coords.set(fk, { lat: fLat, lon: fLon })
    coords.set(tk, { lat: tLat, lon: tLon })
    if (!graph.has(fk)) graph.set(fk, new Set())
    if (!graph.has(tk)) graph.set(tk, new Set())
    graph.get(fk).add(tk)
    graph.get(tk).add(fk)
  }

  function nearest(targetLat, targetLon) {
    let bestKey = null, bestDist = Infinity
    for (const [k, pt] of coords) {
      const d = Math.hypot(pt.lat - targetLat, pt.lon - targetLon)
      if (d < bestDist) { bestDist = d; bestKey = k }
    }
    return bestDist <= NEAREST_TOL ? bestKey : null
  }

  const startKey = nearest(entryPt.lat, entryPt.lon)
  const endKey   = nearest(exitPt.lat,  exitPt.lon)
  if (!startKey || !endKey) return null
  if (startKey === endKey)  return [coords.get(startKey)]

  const parent = new Map([[startKey, null]])
  const queue  = [startKey]

  while (queue.length) {
    const curr = queue.shift()
    if (curr === endKey) break
    for (const nbr of (graph.get(curr) ?? [])) {
      if (!parent.has(nbr)) {
        parent.set(nbr, curr)
        queue.push(nbr)
      }
    }
  }

  if (!parent.has(endKey)) return null

  const path = []
  let curr = endKey
  while (curr !== null) {
    path.unshift(coords.get(curr))
    curr = parent.get(curr)
  }
  return path
}

// Extract leg points from a procedure by name + transition.
// Returns { pts: [{lat,lon,id}], procType: 'SID'|'STAR'|'APPCH' } or null.
function resolveProcLeg(procName, transId, rawProcs) {
  if (!rawProcs) return null

  for (const category of ['SID', 'STAR', 'APPCH']) {
    const catRaw = rawProcs[category]
    if (!catRaw) continue

    // Exact key match, then prefix match for runway-suffixed variants (e.g. GNSS3F)
    let proc = catRaw[procName]
    if (!proc) {
      const matchKey = Object.keys(catRaw).find(k => k.startsWith(procName))
      if (matchKey) proc = catRaw[matchKey]
    }
    if (!proc?.transitions) continue

    const common = proc.transitions[''] ?? []
    const trans  = transId ? (proc.transitions[transId] ?? []) : []
    const all    = [...common, ...trans]
    if (all.length > 0) return {
      pts:      all.map(l => ({ lat: l.lat, lon: l.lon, id: l.id ?? null })),
      procType: category,
    }
  }
  return null
}

/**
 * Resolve a filed route string into drawable geometry.
 *
 * @param {object}   fpl        { dep, dest, rte }
 * @param {Function} lookupFix  (id: string) => {lat, lon} | null
 * @param {object}   airways    { V, J, B } — flat segment arrays
 * @param {object}   depProcs   raw procedures JSON for dep airport, or null
 * @param {object}   destProcs  raw procedures JSON for dest airport, or null
 * @returns {{ segments, missing, fixLabels }}
 *   segments  — [{ points:[{lat,lon}], dashed:bool }]
 *   missing   — [{lat,lon}] midpoints for '?' markers
 *   fixLabels — [{lat,lon,id}] named waypoint dots + idents
 */
export function resolveRoute({ fpl, lookupFix, airways, depProcs, destProcs }) {
  const rte = (fpl?.rte ?? '').trim()
  if (!rte) return { segments: [], missing: [], fixLabels: [] }

  // Build set of known airway names for O(1) token classification
  const airwayNames = new Set()
  for (const type of ['V', 'J', 'B']) {
    for (const seg of (airways?.[type] ?? [])) airwayNames.add(seg.name)
  }

  const rawTokens = rte.split(/\s+/).filter(Boolean)

  // Classify each token into one of: airway | proc | fix
  const items = rawTokens.map(tok => {
    if (airwayNames.has(tok)) {
      return { kind: 'airway', name: tok }
    }
    if (tok.includes('.')) {
      const dotIdx   = tok.indexOf('.')
      const procName = tok.slice(0, dotIdx)
      const transId  = tok.slice(dotIdx + 1)
      const result   = resolveProcLeg(procName, transId, depProcs)
                    ?? resolveProcLeg(procName, transId, destProcs)
      return { kind: 'proc', token: tok, pts: result?.pts ?? null, procType: result?.procType ?? null }
    }
    const resolved = lookupFix(tok)
    if (resolved) {
      return { kind: 'fix', id: tok, coords: { lat: resolved.lat, lon: resolved.lon } }
    }
    // Not a navdata fix — try as a bare procedure name (no explicit transition)
    const result = resolveProcLeg(tok, '', depProcs) ?? resolveProcLeg(tok, '', destProcs)
    if (result) return { kind: 'proc', token: tok, pts: result.pts, procType: result.procType }
    return { kind: 'fix', id: tok, coords: null }
  })

  // Determine whether the route begins with a SID or ends with a STAR/APPCH.
  // Used to suppress the DEP→first-fix and last-fix→DEST legs respectively.
  const firstItem     = items[0]
  const lastItem      = items[items.length - 1]
  const startsWithSid = firstItem?.kind === 'proc' && firstItem?.procType === 'SID'
  const endsWithStar  = lastItem?.kind  === 'proc' &&
                        (lastItem?.procType === 'STAR' || lastItem?.procType === 'APPCH')

  const segments  = []  // { points:[{lat,lon}], dashed:bool }
  const missing   = []  // {lat,lon,a?,b?} — midpoint for '?'; a/b are segment endpoints for perpendicular offset
  const fixLabels = []  // {lat,lon,id} for named waypoint dots

  let prevPt          = null
  let firstResolvedPt = null  // first coordinate reached in the drawn route

  // Scan forward for the next item with resolvable coordinates.
  function findNextResolved(fromIdx) {
    for (let j = fromIdx; j < items.length; j++) {
      const it = items[j]
      if (it.kind === 'fix' && it.coords)
        return { index: j, kind: 'fix', pt: it.coords, id: it.id }
      if (it.kind === 'proc' && it.pts?.length > 0)
        return { index: j, kind: 'proc', pt: { lat: it.pts[0].lat, lon: it.pts[0].lon }, id: null }
    }
    return null
  }

  let i = 0
  while (i < items.length) {
    const item = items[i]

    // ── Airway ──────────────────────────────────────────────────────
    if (item.kind === 'airway') {
      const next = findNextResolved(i + 1)
      if (prevPt && next) {
        const walkPts = walkAirway(item.name, prevPt, next.pt, airways)
        if (walkPts && walkPts.length >= 2) {
          segments.push({ points: walkPts, dashed: false })
        } else {
          // Airway walk failed — dashed direct line + ? offset from midpoint
          segments.push({ points: [prevPt, next.pt], dashed: true })
          missing.push({ ...midpoint(prevPt, next.pt), a: prevPt, b: next.pt })
        }
        prevPt = next.pt
        if (next.kind === 'fix') {
          fixLabels.push({ ...next.pt, id: next.id })
          i = next.index + 1  // fix consumed; skip past it
        } else {
          i = next.index      // proc: let it self-process (guards zero-length connect)
        }
        continue
      }
      i++
      continue
    }

    // ── Procedure (SID/STAR/APPCH) ───────────────────────────────
    if (item.kind === 'proc') {
      if (item.pts?.length > 0) {
        // If prevPt matches a leg in the procedure, the route has already drawn up to that
        // fix explicitly — skip legs up to and including the match to avoid duplication.
        let startIdx = 0
        if (prevPt) {
          const matchIdx = item.pts.findIndex(
            p => Math.hypot(p.lat - prevPt.lat, p.lon - prevPt.lon) < 0.001
          )
          if (matchIdx >= 0) startIdx = matchIdx + 1
        }

        const drawPts = item.pts.slice(startIdx)
        if (drawPts.length > 0) {
          const firstPt = { lat: drawPts[0].lat, lon: drawPts[0].lon }
          if (!firstResolvedPt) firstResolvedPt = firstPt
          if (prevPt && coordsDiffer(prevPt, firstPt)) {
            segments.push({ points: [prevPt, firstPt], dashed: false })
          }
          segments.push({ points: drawPts.map(p => ({ lat: p.lat, lon: p.lon })), dashed: false })
          for (const p of drawPts) {
            if (p.id) fixLabels.push({ lat: p.lat, lon: p.lon, id: p.id })
          }
          prevPt = { lat: drawPts.at(-1).lat, lon: drawPts.at(-1).lon }
        }
      } else {
        // Unresolved procedure — '?' after last known point
        if (prevPt) missing.push({ ...prevPt })
      }
      i++
      continue
    }

    // ── Named fix / navaid ────────────────────────────────────────
    if (item.kind === 'fix') {
      if (item.coords) {
        if (!firstResolvedPt) firstResolvedPt = item.coords
        if (prevPt && coordsDiffer(prevPt, item.coords)) {
          segments.push({ points: [prevPt, item.coords], dashed: false })
        }
        fixLabels.push({ ...item.coords, id: item.id })
        prevPt = item.coords
      } else {
        // Unresolved fix — dashed gap to next resolved point, ? offset from midpoint
        const next = findNextResolved(i + 1)
        if (prevPt && next) {
          segments.push({ points: [prevPt, next.pt], dashed: true })
          missing.push({ ...midpoint(prevPt, next.pt), a: prevPt, b: next.pt })
          prevPt = next.pt
          i = next.index  // re-process next item to capture its fixLabel
          continue
        } else if (prevPt) {
          missing.push({ ...prevPt })
        }
      }
      i++
      continue
    }

    i++
  }

  // ── DEP → first fix (only when route does not begin with a SID) ──────────
  if (!startsWithSid && firstResolvedPt) {
    const depCoord = fpl?.dep ? lookupFix(fpl.dep) : null
    if (depCoord) {
      const dp = { lat: depCoord.lat, lon: depCoord.lon }
      if (coordsDiffer(dp, firstResolvedPt)) {
        segments.unshift({ points: [dp, firstResolvedPt], dashed: false })
        fixLabels.unshift({ lat: dp.lat, lon: dp.lon, id: fpl.dep })
      }
    }
  }

  // ── last fix → DEST (only when route does not end with a STAR/APPCH) ─────
  if (!endsWithStar && prevPt) {
    const destCoord = fpl?.dest ? lookupFix(fpl.dest) : null
    if (destCoord) {
      const dp = { lat: destCoord.lat, lon: destCoord.lon }
      if (coordsDiffer(prevPt, dp)) {
        segments.push({ points: [prevPt, dp], dashed: false })
        fixLabels.push({ lat: dp.lat, lon: dp.lon, id: fpl.dest })
      }
    }
  }

  return { segments, missing, fixLabels }
}
