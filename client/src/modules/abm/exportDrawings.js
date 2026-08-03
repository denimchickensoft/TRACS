// Bundles a theatre's custom drawings into a downloadable .zip for
// sharing/reloading — one small .geojson per drawing, matching
// AbmDrawingImport.jsx's existing "one file = one layer" convention, so
// unzipping (done automatically by that importer, see its .zip handling)
// restores the same N separate, named/colored drawings rather than merging
// them into one. Plain standard GeoJSON per entry (simplestyle `title`/
// `stroke` properties) — readable by any GIS tool even outside TRACS, not
// just this app's own importer.

import { zipSync } from 'fflate'

function sanitizeFilename(name) {
  return (name || 'drawing').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'drawing'
}

function layerToFeatureCollection(layer) {
  const features = layer.features.map(f => {
    const properties = { ...f.properties, title: f.properties?.title ?? layer.name }
    // layer.color is null for a layer that was never explicitly recolored
    // (store/abmDrawings.js) — omit `stroke` entirely rather than writing a
    // literal null, so a re-import still falls through to the CUSTOM
    // palette default instead of carrying a meaningless property.
    const stroke = f.properties?.stroke ?? layer.color
    if (stroke != null) properties.stroke = stroke
    return { type: 'Feature', properties, geometry: f.geometry }
  })
  return { type: 'FeatureCollection', features }
}

export function exportDrawingsZip(layers, theatre) {
  if (!layers?.length) return

  const files = {}
  const usedNames = new Set()
  const encoder = new TextEncoder()
  for (const layer of layers) {
    const base = sanitizeFilename(layer.name)
    let name = `${base}.geojson`
    let n = 2
    while (usedNames.has(name)) { name = `${base}_${n}.geojson`; n++ }
    usedNames.add(name)
    files[name] = encoder.encode(JSON.stringify(layerToFeatureCollection(layer), null, 2))
  }

  const zipped = zipSync(files)
  const blob = new Blob([zipped], { type: 'application/zip' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  const date = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `tracs-drawings-${sanitizeFilename(theatre ?? 'theatre')}-${date}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
