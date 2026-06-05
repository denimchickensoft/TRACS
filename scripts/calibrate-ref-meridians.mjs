/**
 * Back-calculates the DCS grid reference meridian for each theatre from runway data.
 *
 * Key insight: course_true_deg is the DCS grid heading; the geographic heading
 * can be derived directly from the endpoint lat/lon coordinates.
 * Their difference is meridian convergence — no IGRF needed.
 *
 *   convergence  = course_true_deg − geographic_heading_from_endpoints
 *   ref_meridian = lng − convergence / sin(lat)
 *
 * The reference meridian is a per-theatre constant, so averaging over many
 * runways gives a precise estimate.
 */

import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const D2R = Math.PI / 180

function normalise180(d) {
  while (d > 180)  d -= 360
  while (d < -180) d += 360
  return d
}

// Geographic heading from point A → point B (small-angle flat-earth)
function geoBearing(latA, lngA, latB, lngB) {
  const cosLat = Math.cos((latA + latB) / 2 * D2R)
  const dLng   = (lngB - lngA) * cosLat
  const dLat   = latB - latA
  return Math.atan2(dLng, dLat) / D2R
}

const runwayDir = join(__dirname, '../client/public/runways')
const files     = readdirSync(runwayDir).filter(f => f.endsWith('.json'))
const results   = {}

for (const file of files) {
  const data    = JSON.parse(readFileSync(join(runwayDir, file), 'utf8'))
  const theatre = data.theatre
  const samples = []

  for (const ab of data.airbases ?? []) {
    const runways = Array.isArray(ab.runways) ? ab.runways : []
    for (const rwy of runways) {
      if (!rwy.end1?.lat || !rwy.end2?.lat) continue
      if (rwy.length_ft < 2000)             continue  // skip helipads / junk entries
      if (rwy.course_true_deg == null)      continue

      const lat = rwy.lat
      const lng = rwy.lon
      const sinLat = Math.sin(lat * D2R)
      if (Math.abs(sinLat) < 0.1) continue  // near-equator unstable

      // Geographic heading end2 → end1 (matches runway store's headingRad convention)
      const geoHdg = geoBearing(rwy.end2.lat, rwy.end2.lon, rwy.end1.lat, rwy.end1.lon)

      // DCS grid heading end2 → end1: runway store uses headingDeg = -course_true_deg
      const gridHdg = -rwy.course_true_deg

      // Convergence: grid diverges from geographic by this amount
      const convergence = normalise180(gridHdg - geoHdg)

      // Skip implausible convergence (>10° would imply ref meridian is far off)
      if (Math.abs(convergence) > 10) continue

      const refMeridian = lng - convergence / sinLat
      samples.push({ airbase: ab.airbase, rwyName: rwy.name, lat, lng, gridHdg, geoHdg, convergence, refMeridian })
    }
  }

  if (samples.length === 0) {
    console.log(`${theatre}: no usable samples`)
    continue
  }

  const sorted = [...samples].sort((a, b) => a.refMeridian - b.refMeridian)
  const n      = sorted.length
  const q1     = sorted[Math.floor(n * 0.25)].refMeridian
  const q3     = sorted[Math.floor(n * 0.75)].refMeridian
  const iqr    = q3 - q1
  const lo     = q1 - 1.5 * iqr
  const hi     = q3 + 1.5 * iqr
  const inliers = sorted.filter(s => s.refMeridian >= lo && s.refMeridian <= hi)

  const median = inliers[Math.floor(inliers.length / 2)].refMeridian
  const mean   = inliers.reduce((s, x) => s + x.refMeridian, 0) / inliers.length
  const stddev = Math.sqrt(inliers.reduce((s, x) => s + (x.refMeridian - mean) ** 2, 0) / inliers.length)

  results[theatre] = { mean, median, stddev, n: inliers.length, total: n }

  const outlierCount = n - inliers.length
  console.log(`\n── ${theatre} (${inliers.length}/${n} inliers) ──`)
  console.log(`  median  ref meridian: ${median.toFixed(2)}°`)
  console.log(`  mean    ref meridian: ${mean.toFixed(2)}°  (stddev ${stddev.toFixed(2)}°)`)
  if (outlierCount > 0) console.log(`  outliers removed: ${outlierCount}`)

  // Show all samples when few; otherwise first 3 as spot-check
  const showCount = inliers.length <= 30 ? inliers.length : 3
  for (const s of inliers.slice(0, showCount)) {
    console.log(`  ${s.airbase} rwy${s.rwyName} (${s.lng.toFixed(1)}°E): conv=${s.convergence.toFixed(2)} refMerid=${s.refMeridian.toFixed(1)}`)
  }
}

console.log('\n\n── Summary — recommended _THEATRE_REF_MERIDIAN values ──')
for (const [theatre, r] of Object.entries(results)) {
  console.log(`  ${theatre.padEnd(20)}: ${r.median.toFixed(1)}°  (n=${r.n}, σ=${r.stddev.toFixed(2)}°)`)
}
