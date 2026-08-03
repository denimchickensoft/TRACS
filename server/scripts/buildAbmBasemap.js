'use strict'

// Bakes three flat RGBA rasters per theatre — basemap (terrain hypsometric
// wash + sea + coastlines/country borders), water (rivers/lakes), and roads
// (roads/rail) — laid out in that theatre's own unrotated TM nm-plane. The
// client places each with a single translate/rotate/scale (see
// drawAbmRaster.js) instead of reprojecting every pixel live the way the
// vector layers reproject every point — see the 2026-07-29 discussion on why
// Leaflet doesn't fit under ABM's TM + declination-rotated projection.
//
// water/roads are separate images (not baked into basemap) so they can be
// toggled independently (.water / .roads vs .map) — both transparent outside
// their own features so whatever's underneath still shows through.
//
// Reuses geo.json (Natural Earth boundaries/coastlines) and relief.json
// (SRTM elevation contours) — both already built for every theatre — plus
// mapcontext.json (Geofabrik roads/rail + Natural Earth water) wherever that
// happens to exist (currently Syria only; water/roads are simply skipped
// elsewhere, and coverage can be extended later without touching this
// script).
//
// Usage:
//   node server/scripts/buildAbmBasemap.js            # all theatres
//   node server/scripts/buildAbmBasemap.js Caucasus    # one theatre

const fs   = require('fs')
const path = require('path')
const { encodePNG } = require('./lib/pngEncoder.js')
const { fillPolygonEvenOdd, strokeLine } = require('./lib/rasterCore.js')

const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const PARAMS_PATH   = path.join(__dirname, '../navdata/config/projection_params.json')
const CACHE_DIR     = path.join(__dirname, '../navdata/cache')

const M_PER_NM = 1852
const MAX_DIM  = 4800 // longer image axis, px — draw cost is a flat GPU blit regardless of
                       // source resolution, so this is a memory/build-time tradeoff, not a
                       // frame-rate one (2026-07-29 discussion) — doubled from 2400 for sharper
                       // roads/coastlines; well under typical 8192px+ texture-size limits
const PAD_NM   = 15   // margin beyond bbox so panning slightly past the edge isn't blank

// ── Palette ───────────────────────────────────────────────────────────────
// Terrain bands painted opaque, lowest elevation first — each higher band's
// polygon is fully nested inside the one below it (that's how the d3-contour
// output in relief.json works), so painting ascending just naturally
// overwrites each band's footprint with the next one up. No alpha
// accumulation needed here, unlike drawRelief.js's live translucent version.
const SEA_COLOR = [26, 38, 48]
const RAMP = [
  [    0, [ 46,  74,  53]],
  [ 1500, [ 66, 100,  62]],
  [ 3000, [110, 130,  70]],
  [ 5000, [160, 150,  90]],
  [ 8000, [150, 110,  80]],
  [11000, [140,  90,  80]],
  [14000, [210, 210, 215]],
]
function hypso(ft) {
  if (ft <= RAMP[0][0]) return RAMP[0][1]
  if (ft >= RAMP[RAMP.length - 1][0]) return RAMP[RAMP.length - 1][1]
  for (let i = 1; i < RAMP.length; i++) {
    if (ft <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1]
      const [b, cb] = RAMP[i]
      const t = (ft - a) / (b - a)
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * t),
        Math.round(ca[1] + (cb[1] - ca[1]) * t),
        Math.round(ca[2] + (cb[2] - ca[2]) * t),
      ]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

const BOUNDARY_COLOR  = [200, 160, 60]
const COASTLINE_COLOR = [180, 200, 210]
const ROAD_COLOR      = [190, 175, 130]
const RAIL_COLOR      = [150, 130, 150]
const WATER_COLOR     = [60, 130, 170]

function readJson(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

function newBuffer(width, height, bgColor) {
  const buf = new Uint8ClampedArray(width * height * 4)
  if (bgColor) {
    for (let i = 0; i < width * height; i++) {
      buf[i * 4] = bgColor[0]; buf[i * 4 + 1] = bgColor[1]; buf[i * 4 + 2] = bgColor[2]; buf[i * 4 + 3] = 255
    }
  }
  return buf
}

function writeRaster(dataDir, layerName, buf, width, height, meta) {
  const png = encodePNG(width, height, buf)
  fs.writeFileSync(path.join(dataDir, `${layerName}.png`), png)
  fs.writeFileSync(path.join(dataDir, `${layerName}.json`), JSON.stringify(meta))
  return png.length
}

async function buildTheatre(name, conf, params, tm) {
  if (!params) {
    console.log(`${name.padEnd(16)} skipped — no TM projection params`)
    return
  }
  const dataDir = path.join(CACHE_DIR, conf.folder)
  const geo     = readJson(path.join(dataDir, 'geo.json'))
  const relief  = readJson(path.join(dataDir, 'relief.json'))
  if (!geo && !relief) {
    console.log(`${name.padEnd(16)} skipped — no geo.json/relief.json`)
    return
  }
  const mapctx = readJson(path.join(dataDir, 'mapcontext.json'))

  const [lonMin, latMin, lonMax, latMax] = conf.bbox
  const originLat = (latMin + latMax) / 2
  const originLng = (lonMin + lonMax) / 2
  const origin = tm.tmForward(originLat, originLng, params)

  // Project bbox corners + edge midpoints to find the nm extent in the
  // theatre's own unrotated TM plane — same corner+edge-midpoint sampling
  // drawMgrsGrid.js uses for screen extent, just against the bbox instead.
  const samples = [
    [lonMin, latMin], [(lonMin + lonMax) / 2, latMin], [lonMax, latMin],
    [lonMin, (latMin + latMax) / 2],                   [lonMax, (latMin + latMax) / 2],
    [lonMin, latMax], [(lonMin + lonMax) / 2, latMax], [lonMax, latMax],
  ]
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity
  for (const [lon, lat] of samples) {
    const p   = tm.tmForward(lat, lon, params)
    const nmE = (p.easting  - origin.easting)  / M_PER_NM
    const nmN = (p.northing - origin.northing) / M_PER_NM
    if (nmE < minE) minE = nmE; if (nmE > maxE) maxE = nmE
    if (nmN < minN) minN = nmN; if (nmN > maxN) maxN = nmN
  }
  minE -= PAD_NM; maxE += PAD_NM; minN -= PAD_NM; maxN += PAD_NM
  const nmWidth  = maxE - minE
  const nmHeight = maxN - minN
  const nmPerPixel = Math.max(nmWidth, nmHeight) / MAX_DIM
  const width  = Math.max(2, Math.round(nmWidth  / nmPerPixel))
  const height = Math.max(2, Math.round(nmHeight / nmPerPixel))

  // Image pixel (px,py): px=0 at minE (west edge), py=0 at maxN (north edge,
  // top row first) — north-up, unrotated. The client applies declination
  // rotation itself at render time (drawAbmRaster.js), the same way
  // projection.js rotates vector points, so this file never needs to know
  // about declination at all. Shared by all three rasters below, so they
  // stay pixel-registered with each other (and with the live vector layers).
  function project(lat, lon) {
    const p   = tm.tmForward(lat, lon, params)
    const nmE = (p.easting  - origin.easting)  / M_PER_NM
    const nmN = (p.northing - origin.northing) / M_PER_NM
    return [(nmE - minE) / nmPerPixel, (maxN - nmN) / nmPerPixel]
  }
  const projectRing = (coords) => coords.map(([lon, lat]) => project(lat, lon))

  // Pixel position of the origin point itself — NOT necessarily the image
  // center. minE/maxE come from projecting bbox corners relative to origin,
  // and since a theatre's bbox is rarely symmetric around its own central
  // meridian (Syria's west edge sits ~11° from its CM, the east edge only
  // ~3°), the origin can land well off-center in nmEast alone. The client
  // needs this exact pixel to anchor the image, not an assumed
  // imgW/2,imgH/2 — using the center silently mismatches the raster against
  // every live-reprojected vector layer (geo/relief/etc), which all anchor
  // on the true origin lat/lng, not the image's own bounding box.
  const [originPx, originPy] = project(originLat, originLng)
  const gridMeta = { originLat, originLng, originPx, originPy, nmPerPixel, width, height }

  // ── basemap: terrain + sea + coastlines + boundaries, fully opaque ───────
  const basemapBuf = newBuffer(width, height, SEA_COLOR)
  // Real land/sea mask (geo.json's land rings — see buildGeoData.js's
  // extractLandRings/clipRingToBbox) painted before the relief bands, which
  // only cover elevation > 0 and otherwise leave true sea level (both actual
  // ocean and low-lying coastal land) as SEA_COLOR. Without this, flat
  // coastal land reads as ocean; this ensures dry land is never left sea-
  // colored even where relief has nothing to draw over it.
  if (geo?.land?.length) {
    const [r, g, b] = RAMP[0][1]
    fillPolygonEvenOdd(basemapBuf, width, height, geo.land.map(projectRing), r, g, b, 1)
  }
  if (relief) {
    const sorted = [...relief].sort((a, b) => a.elev - b.elev)
    for (const region of sorted) {
      const rings  = region.rings.map(projectRing)
      const [r, g, b] = hypso(region.elev)
      fillPolygonEvenOdd(basemapBuf, width, height, rings, r, g, b, 1)
    }
  }
  if (geo?.coastlines) {
    for (const c of geo.coastlines) strokeLine(basemapBuf, width, height, projectRing(c.coords), COASTLINE_COLOR[0], COASTLINE_COLOR[1], COASTLINE_COLOR[2], 0.8)
  }
  if (geo?.boundaries) {
    for (const b of geo.boundaries) strokeLine(basemapBuf, width, height, projectRing(b.coords), BOUNDARY_COLOR[0], BOUNDARY_COLOR[1], BOUNDARY_COLOR[2], 0.5)
  }
  const basemapKB = writeRaster(dataDir, 'basemap', basemapBuf, width, height, gridMeta) / 1024

  // ── water: rivers + lakes, transparent elsewhere ─────────────────────────
  let waterKB = null
  if (mapctx?.water?.length) {
    const waterBuf = newBuffer(width, height, null)
    for (const w of mapctx.water) {
      const pts = projectRing(w.coords)
      if (w.type === 'lake') fillPolygonEvenOdd(waterBuf, width, height, [pts], WATER_COLOR[0], WATER_COLOR[1], WATER_COLOR[2], 1)
      else strokeLine(waterBuf, width, height, pts, WATER_COLOR[0], WATER_COLOR[1], WATER_COLOR[2], 0.85)
    }
    waterKB = writeRaster(dataDir, 'water', waterBuf, width, height, gridMeta) / 1024
  }

  // ── roads: roads + rail, transparent elsewhere ───────────────────────────
  let roadsKB = null
  if (mapctx?.roads?.length || mapctx?.rail?.length) {
    const roadsBuf = newBuffer(width, height, null)
    for (const rd of mapctx.roads ?? []) strokeLine(roadsBuf, width, height, projectRing(rd.coords), ROAD_COLOR[0], ROAD_COLOR[1], ROAD_COLOR[2], 0.75)
    for (const rl of mapctx.rail  ?? []) strokeLine(roadsBuf, width, height, projectRing(rl.coords), RAIL_COLOR[0], RAIL_COLOR[1], RAIL_COLOR[2], 0.7)
    roadsKB = writeRaster(dataDir, 'roads', roadsBuf, width, height, gridMeta) / 1024
  }

  return {
    width, height, nmPerPixel, basemapKB, waterKB, roadsKB,
    reliefCount: relief?.length ?? 0,
    geoCount:    (geo?.boundaries?.length || 0) + (geo?.coastlines?.length || 0),
    mapctx,
  }
}

async function main() {
  const theatres   = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const allParams  = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'))
  const tm         = await import('../../client/src/utils/transverseMercator.js')

  const only = process.argv[2]
  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }
  const entries = only ? [[only, theatres[only]]] : Object.entries(theatres)

  console.log(`\nBuilding ABM rasters — ${entries.length} theatre(s)\n`)
  for (const [name, conf] of entries) {
    const t0 = process.hrtime.bigint()
    const result = await buildTheatre(name, conf, allParams[name], tm)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (!result) continue
    const { width, height, nmPerPixel, basemapKB, waterKB, roadsKB, reliefCount, geoCount, mapctx } = result
    console.log(
      `${name.padEnd(16)} ${String(width).padStart(4)}x${String(height).padEnd(4)}px  ` +
      `${(nmPerPixel * 1852).toFixed(0)}m/px  relief:${reliefCount} geo:${geoCount}  ` +
      `basemap:${basemapKB.toFixed(0)}KB` +
      (waterKB != null ? ` water:${waterKB.toFixed(0)}KB(${mapctx.water.length})` : '') +
      (roadsKB != null ? ` roads:${roadsKB.toFixed(0)}KB(${(mapctx.roads?.length||0)+(mapctx.rail?.length||0)})` : '') +
      `  ·  ${(ms / 1000).toFixed(1)}s`
    )
  }
  console.log('\nDone.\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
