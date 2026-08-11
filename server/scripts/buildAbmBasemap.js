'use strict'

// Bakes four flat RGBA rasters per theatre — basemap (land/sea silhouette,
// wide/coarse), terrain (hypsometric relief wash + coastlines/country
// borders, tight/detailed), water (rivers/lakes), and roads (roads/rail) —
// laid out in that theatre's own unrotated TM nm-plane. The client places
// each with a single translate/rotate/scale (see drawAbmRaster.js) instead
// of reprojecting every pixel live the way the vector layers reproject every
// point — see the 2026-07-29 discussion on why Leaflet doesn't fit under
// ABM's TM + declination-rotated projection.
//
// Draw order (client, furthest-back first): basemap, terrain, water, roads,
// then the live vector layers (relief overlay, geo, etc). basemap/terrain
// were named "landfill"/"basemap" respectively until 2026-08-11 — renamed
// once terrain stopped being the sole land/sea source (see terrain's own
// comment below) and basemap graduated from a theatre-local preview to the
// layer that's actually responsible for land/sea color everywhere.
//
// water/roads are separate images (not baked into basemap/terrain) so they
// can be toggled independently (.water / .roads vs .map) — both transparent
// outside their own features so whatever's underneath still shows through.
//
// Reuses geo.json (Natural Earth boundaries/coastlines), relief.json (SRTM
// elevation contours), and the raw world land.geojson (all already built by
// buildGeoData.js) — plus mapcontext.json (Geofabrik roads/rail + Natural
// Earth water) wherever that happens to exist (water/roads are simply
// skipped elsewhere, and coverage can be extended later without touching
// this script).
//
// Usage:
//   node server/scripts/buildAbmBasemap.js            # all theatres
//   node server/scripts/buildAbmBasemap.js Caucasus    # one theatre

const fs   = require('fs')
const path = require('path')
const { encodePNG } = require('./lib/pngEncoder.js')
const { fillPolygonEvenOdd, strokeLine } = require('./lib/rasterCore.js')
const { extractLandRings } = require('./lib/polygonClip.js')

const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const PARAMS_PATH   = path.join(__dirname, '../navdata/config/projection_params.json')
const CACHE_DIR     = path.join(__dirname, '../navdata/cache')
// Raw, full-world Natural Earth land polygons (same source buildGeoData.js
// downloads to here) — read directly for the basemap layer below, since the
// per-theatre geo.json it also produces is only clipped to bbox+1°, far too
// narrow for basemap's own much wider reach.
const WORLD_LAND_PATH = path.join(__dirname, '../data/geo/land.geojson')

const M_PER_NM = 1852
const MAX_DIM  = 4800 // longer image axis, px — draw cost is a flat GPU blit regardless of
                       // source resolution, so this is a memory/build-time tradeoff, not a
                       // frame-rate one (2026-07-29 discussion) — doubled from 2400 for sharper
                       // roads/coastlines; well under typical 8192px+ texture-size limits
const PAD_NM   = 15   // margin beyond bbox so panning slightly past the edge isn't blank —
                       // buildReliefMap.js's FIELD_PAD_NM (2026-08-11) must stay >= this or
                       // the relief wash goes dead/flat inside this canvas's own outer ring;
                       // raise that constant too if this one grows

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

async function buildTheatre(name, conf, params, tm, worldLandFeatures) {
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
  // about declination at all. Shared by terrain/water/roads below (all
  // three at the same tight bbox+PAD_NM extent — basemap is the one with
  // its own separate, much larger extent, see below), so they stay
  // pixel-registered with each other (and with the live vector layers).
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

  // ── basemap: flat land/sea silhouette only, no relief/coastline/border
  // detail, drawn on its own MUCH larger, coarser canvas so it can fill the
  // screen at true max zoom-out (AbmScope.jsx's RANGE_MAX=600nm) on a target
  // worst-case monitor aspect ratio, without touching terrain/water/roads'
  // resolution or extent at all — those stay exactly as they are below,
  // completely unchanged. 2026-08-11.
  //
  // Sizing: the scope's own zoom math (pixelsPerNm = min(w,h)/(2*rangeNm))
  // makes rangeNm the center-to-edge distance along the screen's SHORT axis
  // only — the long axis reaches rangeNm*aspectRatio. And since the view can
  // rotate (declination), "the screen's long axis" isn't fixed to one
  // direction on the map — it sweeps through all of them — so this canvas
  // has to be a SQUARE covering that worst-case reach in every direction,
  // not a rectangle shaped like a monitor. At terrain's own ~0.2-0.4nm/px
  // detail resolution that square would exceed the 8192px GPU texture
  // ceiling for anything wider than ~4:3 — this is exactly why basemap
  // needs its own coarser resolution rather than reusing terrain's: a flat
  // silhouette doesn't need relief-level detail to read correctly from this
  // far out.
  //
  // Drawn first/furthest-back client-side, underneath terrain/water/roads.
  const MAX_RANGE_NM  = 600  // must match AbmScope.jsx's RANGE_MAX
  const ASPECT_TARGET = 2.33 // 21:9 ultrawide — covers effectively all single/triple-wide gaming monitors
  const BM_MAX_DIM    = 4800 // same pixel budget as MAX_DIM above, comfortably under the 8192px ceiling

  const bmHalfExtentNm = MAX_RANGE_NM * ASPECT_TARGET
  const nmPerPixelBm = (2 * bmHalfExtentNm) / BM_MAX_DIM
  const bmMinE = -bmHalfExtentNm, bmMaxE = bmHalfExtentNm
  const bmMinN = -bmHalfExtentNm, bmMaxN = bmHalfExtentNm
  const bmWidth  = Math.max(2, Math.round((bmMaxE - bmMinE) / nmPerPixelBm))
  const bmHeight = Math.max(2, Math.round((bmMaxN - bmMinN) / nmPerPixelBm))

  function bmProject(lat, lon) {
    const p   = tm.tmForward(lat, lon, params)
    const nmE = (p.easting  - origin.easting)  / M_PER_NM
    const nmN = (p.northing - origin.northing) / M_PER_NM
    return [(nmE - bmMinE) / nmPerPixelBm, (bmMaxN - nmN) / nmPerPixelBm]
  }
  const bmProjectRing = (coords) => coords.map(([lon, lat]) => bmProject(lat, lon))
  const [bmOriginPx, bmOriginPy] = bmProject(originLat, originLng)
  const bmGridMeta = { originLat, originLng, originPx: bmOriginPx, originPy: bmOriginPy, nmPerPixel: nmPerPixelBm, width: bmWidth, height: bmHeight }

  // Land source: the raw, full-world land.geojson (worldLandFeatures, loaded
  // once in main() below) — NOT geo.json's land rings, which are only
  // clipped to bbox+1° (BBOX_PAD in buildGeoData.js), far narrower than
  // basemap's own ±bmHalfExtentNm reach. Clipped in degree-space (same
  // Sutherland–Hodgman helper buildGeoData.js uses, see lib/polygonClip.js)
  // to a generous pad — 1.1x the nm half-extent converted to degrees,
  // centered on the theatre's own ORIGIN (not added on top of the bbox
  // edges — that double-counted the bbox's own half-width on a previous
  // pass and needlessly dragged in extra geography).
  const bmDegPad = 1.1
  const bmLatPadDeg = (bmHalfExtentNm / 60) * bmDegPad
  const bmCosLat    = Math.max(0.2, Math.cos(originLat * Math.PI / 180))
  const bmLonPadDeg = (bmHalfExtentNm / 60 / bmCosLat) * bmDegPad
  const bmClipBbox = [originLng - bmLonPadDeg, originLat - bmLatPadDeg, originLng + bmLonPadDeg, originLat + bmLatPadDeg]
  const worldLandRings = worldLandFeatures ? extractLandRings(worldLandFeatures, bmClipBbox) : []

  let basemapKB = null
  if (worldLandRings.length) {
    const basemapBuf = newBuffer(bmWidth, bmHeight, SEA_COLOR)
    const [r, g, b] = RAMP[0][1]
    fillPolygonEvenOdd(basemapBuf, bmWidth, bmHeight, worldLandRings.map(bmProjectRing), r, g, b, 1)
    basemapKB = writeRaster(dataDir, 'basemap', basemapBuf, bmWidth, bmHeight, bmGridMeta) / 1024
  }

  // ── terrain: relief bands + coastline/boundary strokes, transparent
  // everywhere else ───────────────────────────────────────────────────────
  // 2026-08-11: used to be fully opaque (SEA_COLOR background + geo.json's
  // land polygon as a flat base coat under the relief bands) so that true
  // sea-level land — relief has nothing to draw there, since vectorize() in
  // buildReliefMap.js explicitly skips the elev=0 contour — never read as
  // ocean. Now that basemap.png exists as its own dedicated, wider-clipped
  // land/sea layer drawn underneath this one (see AbmScope.jsx draw order),
  // that job is basemap's alone: terrain only needs to show real elevation
  // detail and stays transparent wherever it has none, letting basemap show
  // through cleanly instead of terrain's own default color masking it in
  // its own PAD_NM margin (the "background water fill" symptom this
  // replaces). Extent/resolution otherwise unchanged (bbox+PAD_NM, MAX_DIM).
  const terrainBuf = newBuffer(width, height, null)
  if (relief) {
    const sorted = [...relief].sort((a, b) => a.elev - b.elev)
    for (const region of sorted) {
      const rings  = region.rings.map(projectRing)
      const [r, g, b] = hypso(region.elev)
      fillPolygonEvenOdd(terrainBuf, width, height, rings, r, g, b, 1)
    }
  }
  if (geo?.coastlines) {
    for (const c of geo.coastlines) strokeLine(terrainBuf, width, height, projectRing(c.coords), COASTLINE_COLOR[0], COASTLINE_COLOR[1], COASTLINE_COLOR[2], 0.8)
  }
  if (geo?.boundaries) {
    for (const b of geo.boundaries) strokeLine(terrainBuf, width, height, projectRing(b.coords), BOUNDARY_COLOR[0], BOUNDARY_COLOR[1], BOUNDARY_COLOR[2], 0.5)
  }
  const terrainKB = writeRaster(dataDir, 'terrain', terrainBuf, width, height, gridMeta) / 1024

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
    width, height, bmWidth, bmHeight, nmPerPixel, nmPerPixelBm,
    terrainKB, waterKB, roadsKB, basemapKB,
    reliefCount: relief?.length ?? 0,
    geoCount:    (geo?.boundaries?.length || 0) + (geo?.coastlines?.length || 0),
    mapctx,
  }
}

async function main() {
  const theatres   = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const allParams  = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'))
  const tm         = await import('../../client/src/utils/transverseMercator.js')

  // Loaded once, reused across every theatre below — same pattern as
  // theatres.json/allParams/tm above. buildGeoData.js must have run at
  // least once already (any theatre) for this file to exist.
  let worldLandFeatures = null
  if (fs.existsSync(WORLD_LAND_PATH)) {
    worldLandFeatures = JSON.parse(fs.readFileSync(WORLD_LAND_PATH, 'utf8')).features
  } else {
    console.log(`No ${WORLD_LAND_PATH} — basemap layer will be skipped (run buildGeoData.js first for any theatre to fetch it).\n`)
  }

  const only = process.argv[2]
  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }
  const entries = only ? [[only, theatres[only]]] : Object.entries(theatres)

  console.log(`\nBuilding ABM rasters — ${entries.length} theatre(s)\n`)
  for (const [name, conf] of entries) {
    const t0 = process.hrtime.bigint()
    const result = await buildTheatre(name, conf, allParams[name], tm, worldLandFeatures)
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (!result) continue
    const { width, height, bmWidth, bmHeight, nmPerPixel, nmPerPixelBm, terrainKB, waterKB, roadsKB, basemapKB, reliefCount, geoCount, mapctx } = result
    console.log(
      `${name.padEnd(16)} ${String(width).padStart(4)}x${String(height).padEnd(4)}px  ` +
      `${(nmPerPixel * 1852).toFixed(0)}m/px  relief:${reliefCount} geo:${geoCount}  ` +
      `terrain:${terrainKB.toFixed(0)}KB` +
      (waterKB != null ? ` water:${waterKB.toFixed(0)}KB(${mapctx.water.length})` : '') +
      (roadsKB != null ? ` roads:${roadsKB.toFixed(0)}KB(${(mapctx.roads?.length||0)+(mapctx.rail?.length||0)})` : '') +
      (basemapKB != null ? `  ·  basemap ${bmWidth}x${bmHeight}px ${(nmPerPixelBm * 1852).toFixed(0)}m/px ${basemapKB.toFixed(0)}KB` : '') +
      `  ·  ${(ms / 1000).toFixed(1)}s`
    )
  }
  console.log('\nDone.\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
