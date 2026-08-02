// DCS mission-editor coordinates (flat-earth x/y, meters, theatre-specific
// origin) -> real lat/lng, via the same per-theatre TM grid used everywhere
// else in the app (see transverseMercator.js / projection_params.json).
//
// DCS convention: x = northing, y = easting (confirmed against the .rn5
// terrain-node reader in server/scripts/lib/airportPolygonsCore.js, the only
// other place in this codebase that converts raw DCS x/y).

import { tmInverse } from './transverseMercator.js'
import { getProjectionParams } from './magvar.js'

export function dcsPointToLatLng(x, y, theatre) {
  const params = getProjectionParams(theatre)
  if (!params) return null
  return tmInverse(y, x, params)
}
