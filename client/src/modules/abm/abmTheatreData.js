// Per-theatre static data every AbmScope needs: airport polygons, town
// labels, the ground/navy unit DB and the four baked raster layers. Each
// focus window mounts its own AbmScope, so without this every window
// re-downloaded and re-parsed the polygons (several MB of JSON) and decoded
// its own copy of each raster (tens of MB of bitmap apiece). Here each one is
// fetched once per window and every scope shares the same parsed object and
// the same decoded Image.
//
// Only the most recent theatre is kept; asking for a different one drops
// the old theatre's entries. A network failure resolves to the fallback
// value and isn't cached, so the next caller tries again (same as
// utils/icaoMapping.js).

let _theatre = null
const _cache = new Map()

function cached(theatre, key, load, fallback) {
  if (theatre !== _theatre) {
    _cache.clear()
    _theatre = theatre
  }
  const k = `${theatre}|${key}`
  let p = _cache.get(k)
  if (!p) {
    p = load().catch(() => {
      if (_cache.get(k) === p) _cache.delete(k)
      return fallback
    })
    _cache.set(k, p)
  }
  return p
}

// A non-OK response (e.g. 404, no data for this theatre) is a real answer
// and resolves to null; only a network/parse failure rejects.
function fetchJson(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : null))
}

export function getAirportPolygonFeatures(theatre) {
  return cached(theatre, 'polygons',
    () => fetchJson(`/api/airports/polygons/${encodeURIComponent(theatre)}`).then((g) => g?.features ?? []), [])
}

export function getTowns(theatre) {
  return cached(theatre, 'towns',
    () => fetchJson(`/towns/${encodeURIComponent(theatre)}.json`).then((d) => d?.towns ?? []), [])
}

// Not theatre-specific, so it lives outside the per-theatre cache.
let _unitDb = null
export function getGroundUnitDb() {
  if (!_unitDb) {
    _unitDb = Promise.all([
      fetchJson('/units/groundunitdatabase.json'),
      fetchJson('/units/navyunitdatabase.json'),
    ]).then(([ground, navy]) => ({ ...ground, ...navy }))
      .catch(() => {
        _unitDb = null
        return {}
      })
  }
  return _unitDb
}

// Resolves to { ...meta, img } once the image has decoded, or null when the
// theatre has no data for that layer.
export function getRasterLayer(theatre, layer) {
  const base = `/api/abm/raster/${encodeURIComponent(theatre)}/${layer}`
  return cached(theatre, `raster:${layer}`, () => fetchJson(base).then((meta) => {
    if (!meta) return null
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ ...meta, img })
      img.onerror = () => reject(new Error(`raster ${layer} failed to load`))
      img.src = `${base}/image.png`
    })
  }), null)
}
