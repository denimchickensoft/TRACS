'use strict'

// Downloads OSM's coastline-derived land polygons (osmdata.openstreetmap.de,
// itself built from OSM natural=coastline ways) and pre-clips+simplifies
// them for two different consumers per theatre, from TWO DIFFERENT source
// variants (see "why two sources" below):
//
//   server/navdata/cache/<folder>/osmLand.json  { rings: [[lon,lat], ...][] }
//     — ABM basemap's land/sea FILL, from the "split" variant, clipped to
//     basemap's own huge worst-case reach (lib/basemapExtent.js) and
//     simplified coarsely (~basemap's own ~1080m/px render resolution).
//
//   server/navdata/cache/<folder>/geo.json  ('coastlines' field, merged in —
//   'boundaries'/'land' left exactly as buildGeoData.js wrote them)
//     — the same shared vector file STARS/CATCC/AIC/ABM-terrain-stroke all
//     read live every frame (drawGeo.js), from the "complete" variant,
//     clipped to the theatre's normal tight bbox+GEO_BBOX_PAD, simplified at
//     ~100m (GEO_COASTLINE_SIMPLIFY_TOLERANCE_DEG — coarser than
//     simplify.js's roads-grade 20m default), and with any piece smaller
//     than GEO_COASTLINE_MIN_SIZE_M dropped outright. Both exist for
//     performance, not just file size: drawGeo.js reprojects
//     every point through full Transverse Mercator math live on every pan/
//     zoom/rotate (no baking) — fjord/archipelago theatres (Kola, South
//     Atlantic) carry tens of thousands of skerry-sized rings from the
//     "complete" source, each still costing a full cull-check + reprojection
//     regardless of how tiny it is. Measured on Kola before this: 67,338
//     rings, 19.4MB, ~14s of pure TM math per pan/zoom/rotate interaction
//     (Chrome perf trace). After: ~4,400 rings, ~2.9MB. STARS/CATCC's
//     tightest zoom (6nm range, ~9m/px) would in principle resolve finer
//     than 100m, but nobody's realistically zoomed that tight staring at
//     open coastline far from an airport — basemap's own coarse rings
//     (osmLand.json, ~1080m/px) still aren't reused here since even 100m is
//     far finer than that.
//
// Why this exists: both were sourced from Natural Earth (ne_10m_land /
// ne_10m_coastline via buildGeoData.js), while roads/rail/water come from
// OSM (buildRoadsWaterData.js) — two independently-traced coastlines that
// disagree in harbors/deltas/reclaimed land, making roads appear to run
// into the ocean wherever Natural Earth's coarser coastline cuts differently
// than OSM's actual one. This gives every consumer the same coastline the
// roads layer is already built from, so they agree.
//
// IMPORTANT ordering note: this script MERGES into geo.json rather than
// replacing it outright — it reads whatever buildGeoData.js already wrote
// there (for boundaries/land) and only overwrites the coastlines field. That
// means buildGeoData.js must run FIRST (at least once, so geo.json exists to
// merge into), and re-running buildGeoData.js afterward will overwrite
// coastlines back to Natural Earth — re-run this script after any
// buildGeoData.js run to restore the OSM merge.
//
// Why TWO sources (using "split" for both makes geo.json's coastline stroke
// come out as a visible grid):
// osmdata.openstreetmap.de's "split" variant deliberately chunks large
// landmasses into smaller, overlapping tiles on a regular grid — great for
// bulk area FILL (a fill only cares which pixels end up covered, not the
// shape of each chunk's own boundary), but each chunk's ring also includes
// the ARTIFICIAL straight edges where OSM's tool sliced it out of the larger
// landmass. Nothing in the data distinguishes "real coastline edge" from
// "artificial tile-cut edge" — harmless for a fill, but stroking every
// ring's full boundary (geo.json's coastline layer) draws those cut edges
// too, and since the tiling grid is regular, they visibly form a grid,
// including straight lines cutting across open water. The "complete"
// variant doesn't pre-chunk — genuinely closed rings tracing only real
// coastline — so it's the correct source specifically for a line-stroke
// consumer. Risk: without pre-chunking, one very large connected landmass
// (e.g. Eurasia+Africa) could exist as a single enormous ring — this script
// still only holds one feature's coordinates in memory at a time (shapefile
// streams feature-by-feature), but that one feature could itself be huge;
// unproven until run for real.
//
// ~880MB zipped per variant — two big static files, same one-time-bulk-
// download pattern as Geofabrik roads/rail (extract_osm_roads.py) and
// Natural Earth (buildGeoData.js), cached in resources/osm-build/ like the
// former.
//
// Each variant gets its own streaming pass over its own shapefile: every
// ring is tested against every theatre's own clip bbox and, if it
// intersects, clipped+simplified and kept for that theatre — nothing is
// held in memory for a theatre it doesn't belong to, and simplification
// happens immediately so surviving rings stay cheap. This mirrors
// buildRoadsWaterData.js's clipRoadsRail() (bounded memory, one pass per
// source) rather than buildGeoData.js's "load whole world, clip per
// theatre" pattern — Natural Earth's whole-world land.geojson is 10MB;
// OSM's equivalents start at ~880MB zipped each, far too large to hold
// unfiltered.
//
// Usage:
//   node server/scripts/buildOsmLand.js            # all theatres
//   node server/scripts/buildOsmLand.js Syria       # one theatre

const https      = require('https')
const fs         = require('fs')
const path       = require('path')
const yauzl      = require('yauzl')
const shapefile  = require('shapefile')
const { clipRingToBbox, clipRingToOpenPolylines, bboxOf, bboxIntersects } = require('./lib/polygonClip.js')
const { simplifyAndRound } = require('./lib/simplify.js')
const { computeBmClipBbox, bmNmPerPixel } = require('./lib/basemapExtent.js')

// basemap's own render resolution is ~1080m/px (bmNmPerPixel(), a flat
// land/sea silhouette at up to 600nm zoom-out) — nowhere near roads/rivers'
// ~150m/px, so simplify.js's roads-tuned 20m default tolerance was wildly
// over-preserving detail here (measured: 32MB/150k rings for Syria alone,
// clipped to just this one theatre's own reach). ~1/10 of a basemap pixel
// stays comfortably lossless at that render scale while cutting file size
// substantially.
const LAND_SIMPLIFY_TOLERANCE_DEG = (bmNmPerPixel() * 1852 / 10) / 111320 // meters -> degrees at the equator (same fixed-degree approximation simplify.js's own default already makes)

// geo.json's own clip pad — must match buildGeoData.js's BBOX_PAD so the
// merged coastlines cover exactly the same extent boundaries/land already do.
const GEO_BBOX_PAD = 1.0

// See the header comment above for why these are much coarser than
// simplify.js's ~20m default — this is a live-reprojected layer, not a
// baked one, and fjord/archipelago theatres have too many tiny rings for
// that to stay cheap otherwise.
const GEO_COASTLINE_SIMPLIFY_TOLERANCE_DEG = 100 / 111320 // ~100m
const GEO_COASTLINE_MIN_SIZE_M = 500

function paddedBbox(bbox, pad) {
  const [lonMin, latMin, lonMax, latMax] = bbox
  return [lonMin - pad, latMin - pad, lonMax + pad, latMax + pad]
}

function bboxDiagMeters(bbox) {
  const [lonMin, latMin, lonMax, latMax] = bbox
  const midLat = (latMin + latMax) / 2
  const dLat = (latMax - latMin) * 111320
  const dLon = (lonMax - lonMin) * 111320 * Math.cos(midLat * Math.PI / 180)
  return Math.sqrt(dLat * dLat + dLon * dLon)
}

const THEATRES_PATH = path.join(__dirname, '../navdata/config/theatres.json')
const CACHE_DIR     = path.join(__dirname, '../navdata/cache')
const OSM_BUILD_DIR = path.join(__dirname, '../../resources/osm-build')

const SPLIT_SOURCE = {
  url:     'https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip',
  zipPath: path.join(OSM_BUILD_DIR, 'land-polygons-split-4326.zip'),
  shpPath: path.join(OSM_BUILD_DIR, 'land_polygons_split.shp'),
}
const COMPLETE_SOURCE = {
  url:     'https://osmdata.openstreetmap.de/download/land-polygons-complete-4326.zip',
  zipPath: path.join(OSM_BUILD_DIR, 'land-polygons-complete-4326.zip'),
  shpPath: path.join(OSM_BUILD_DIR, 'land_polygons_complete.shp'),
}

// ── download (streamed straight to disk, never buffered whole in memory —
// unlike buildGeoData.js/buildRoadsWaterData.js's fetchUrl, which is fine
// for their ~10MB GeoJSON sources but not for a ~925MB zip) ────────────────
function downloadToFile(url, dest, depth = 0) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'))
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if ([301, 302, 307].includes(res.statusCode)) {
        res.resume()
        return resolve(downloadToFile(res.headers.location, dest, depth + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0, lastPct = -1
      const tmp = dest + '.part'
      const out = fs.createWriteStream(tmp)
      res.on('data', (chunk) => {
        received += chunk.length
        if (!total) return
        const pct = Math.floor((received / total) * 100)
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct
          process.stdout.write(`\r  downloading... ${pct}% (${(received / 1024 / 1024).toFixed(0)}MB / ${(total / 1024 / 1024).toFixed(0)}MB)`)
        }
      })
      res.pipe(out)
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); process.stdout.write('\n'); resolve() }))
      out.on('error', reject)
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

// ── unzip: pull out just the .shp entry (geometry only — no .dbf needed,
// none of the land polygons' attributes are used here) ─────────────────────
function extractShp(zipPath, destPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      let found = false
      zipfile.on('entry', (entry) => {
        if (!found && /\.shp$/i.test(entry.fileName)) {
          found = true
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err)
            const tmp = destPath + '.part'
            const out = fs.createWriteStream(tmp)
            readStream.pipe(out)
            out.on('finish', () => { fs.renameSync(tmp, destPath); zipfile.close(); resolve() })
            out.on('error', reject)
          })
        } else {
          zipfile.readEntry()
        }
      })
      zipfile.on('end', () => { if (!found) reject(new Error(`No .shp entry found in ${zipPath}`)) })
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

// ── ensure a source's zip is downloaded and its .shp extracted, skipping
// whatever's already cached on disk ─────────────────────────────────────────
async function ensureShp(source) {
  if (fs.existsSync(source.zipPath)) {
    console.log(`Using cached ${path.basename(source.zipPath)} (${(fs.statSync(source.zipPath).size / 1024 / 1024).toFixed(0)}MB)`)
  } else {
    console.log(`Downloading ${source.url}`)
    await downloadToFile(source.url, source.zipPath)
  }

  if (fs.existsSync(source.shpPath)) {
    console.log(`Using cached ${path.basename(source.shpPath)} (${(fs.statSync(source.shpPath).size / 1024 / 1024).toFixed(0)}MB)`)
  } else {
    console.log('Extracting .shp from zip...')
    await extractShp(source.zipPath, source.shpPath)
  }
}

// Scans one shapefile source in a single streaming pass, calling
// onRing(ring, clip) for every (ring, theatre-clip) pair whose bboxes
// intersect — onRing does its own clip+simplify+store, since the split and
// complete passes below want different bboxes/tolerances/output fields.
async function scanShapefile(shpPath, clips, getBbox, onRing) {
  const source = await shapefile.open(shpPath)
  let scanned = 0, kept = 0
  while (true) {
    const result = await source.read()
    if (result.done) break
    scanned++
    if (scanned % 20000 === 0) process.stdout.write(`\r  scanned ${scanned} features, kept ${kept} ring(s)`)

    const geom = result.value.geometry
    if (!geom) continue
    const polys = geom.type === 'Polygon'      ? [geom.coordinates]
                : geom.type === 'MultiPolygon' ? geom.coordinates
                : []
    for (const rings of polys) {
      for (const ring of rings) {
        const ringBbox = bboxOf(ring)
        for (const clip of clips) {
          if (!bboxIntersects(ringBbox, getBbox(clip))) continue
          kept += onRing(ring, clip)
        }
      }
    }
  }
  process.stdout.write(`\r  scanned ${scanned} features, kept ${kept} ring(s) total\n\n`)
}

// ── driver ────────────────────────────────────────────────────────────────

async function main() {
  const theatres = JSON.parse(fs.readFileSync(THEATRES_PATH, 'utf8'))
  const only = process.argv[2]
  if (only && !theatres[only]) {
    console.error(`Unknown theatre "${only}". Options: ${Object.keys(theatres).join(', ')}`)
    process.exit(1)
  }
  const entries = only ? [[only, theatres[only]]] : Object.entries(theatres)

  fs.mkdirSync(OSM_BUILD_DIR, { recursive: true })
  await ensureShp(SPLIT_SOURCE)
  await ensureShp(COMPLETE_SOURCE)

  // Every theatre's own clip bboxes, computed once up front — bmBbox matches
  // buildAbmBasemap.js's basemap layer reach (lib/basemapExtent.js); geoBbox
  // matches buildGeoData.js's own tight bbox+GEO_BBOX_PAD (geo.json's extent).
  const clips = entries.map(([name, conf]) => ({
    name, folder: conf.folder,
    bmBbox: computeBmClipBbox(conf.bbox).bbox,
    bmRings: [],
    geoBbox: paddedBbox(conf.bbox, GEO_BBOX_PAD),
    geoCoastlines: [],
  }))

  console.log(`\nScanning "split" land polygons for basemap fill (${clips.length} theatre(s))...`)
  await scanShapefile(SPLIT_SOURCE.shpPath, clips, (clip) => clip.bmBbox, (ring, clip) => {
    const clipped = clipRingToBbox(ring, clip.bmBbox)
    if (clipped.length < 3) return 0
    clip.bmRings.push(simplifyAndRound(clipped, LAND_SIMPLIFY_TOLERANCE_DEG))
    return 1
  })

  // Open-polyline clip here, NOT clipRingToBbox — clipRingToBbox produces a
  // closed shape (correct for the fill above, wrong for a stroke): see
  // lib/polygonClip.js's clipRingToOpenPolylines comment for why a closed-
  // polygon clip draws a fake coastline hugging the clip rectangle wherever
  // the source ring extends past geoBbox.
  console.log(`Scanning "complete" land polygons for geo.json coastlines (${clips.length} theatre(s))...`)
  await scanShapefile(COMPLETE_SOURCE.shpPath, clips, (clip) => clip.geoBbox, (ring, clip) => {
    const pieces = clipRingToOpenPolylines(ring, clip.geoBbox)
    let kept = 0
    for (const piece of pieces) {
      const coords = simplifyAndRound(piece, GEO_COASTLINE_SIMPLIFY_TOLERANCE_DEG)
      if (coords.length < 2) continue
      const bbox = bboxOf(coords)
      if (bboxDiagMeters(bbox) < GEO_COASTLINE_MIN_SIZE_M) continue
      clip.geoCoastlines.push({ coords, bbox })
      kept++
    }
    return kept
  })

  for (const clip of clips) {
    const outDir = path.join(CACHE_DIR, clip.folder)
    fs.mkdirSync(outDir, { recursive: true })

    const landJson = JSON.stringify({ rings: clip.bmRings })
    fs.writeFileSync(path.join(outDir, 'osmLand.json'), landJson)

    const geoPath = path.join(outDir, 'geo.json')
    if (!fs.existsSync(geoPath)) {
      console.log(`${clip.name.padEnd(16)} ${String(clip.bmRings.length).padStart(4)} land rings  ${(landJson.length / 1024).toFixed(1).padStart(8)} KB` +
        `   ·  geo.json not found, skipping coastline merge (run buildGeoData.js first)`)
      continue
    }
    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'))
    const mergedGeoJson = JSON.stringify({ ...geo, coastlines: clip.geoCoastlines })
    fs.writeFileSync(geoPath, mergedGeoJson)

    console.log(`${clip.name.padEnd(16)} ${String(clip.bmRings.length).padStart(4)} land rings  ${(landJson.length / 1024).toFixed(1).padStart(8)} KB` +
      `   ·  ${String(clip.geoCoastlines.length).padStart(4)} geo coastlines  ${(mergedGeoJson.length / 1024).toFixed(1).padStart(8)} KB`)
  }

  console.log('\nDone. Run buildAbmBasemap.js next to bake osmLand.json into basemap.png.\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
