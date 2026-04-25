/**
 * Lat/lng ↔ canvas pixel projection.
 *
 * Equirectangular, scaled so 1 NM = pixelsPerNm pixels at the reference lat.
 * When view.magvar is set (degrees East), the display is rotated so magnetic
 * north appears at the top of the screen.
 *
 * view: { centerLat, centerLng, pixelsPerNm, width, height, magvar? }
 */

const NM_PER_DEGREE_LAT = 60

export function latLngToCanvas(lat, lng, view) {
  const { centerLat, centerLng, pixelsPerNm, width, height, magvar = 0 } = view

  const nmPerDegreeLng = NM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180)

  const nmNorth = (lat - centerLat) * NM_PER_DEGREE_LAT
  const nmEast  = (lng - centerLng) * nmPerDegreeLng

  // Rotate counterclockwise by magvar so magnetic north sits at screen top.
  // For East declination (+magvar), true north shifts slightly left of top.
  const rad = magvar * Math.PI / 180
  const rE  = nmEast * Math.cos(rad) - nmNorth * Math.sin(rad)
  const rN  = nmEast * Math.sin(rad) + nmNorth * Math.cos(rad)

  return {
    x: width  / 2 + rE * pixelsPerNm,
    y: height / 2 - rN * pixelsPerNm,
  }
}

export function canvasToLatLng(x, y, view) {
  const { centerLat, centerLng, pixelsPerNm, width, height, magvar = 0 } = view

  const nmPerDegreeLng = NM_PER_DEGREE_LAT * Math.cos(centerLat * Math.PI / 180)

  const rE = (x - width  / 2) / pixelsPerNm
  const rN = (height / 2 - y) / pixelsPerNm

  // Inverse: clockwise rotation by magvar
  const rad    = magvar * Math.PI / 180
  const nmEast  =  rE * Math.cos(rad) + rN * Math.sin(rad)
  const nmNorth = -rE * Math.sin(rad) + rN * Math.cos(rad)

  return {
    lat: centerLat + nmNorth / NM_PER_DEGREE_LAT,
    lng: centerLng + nmEast  / nmPerDegreeLng,
  }
}

export function rangeToPixelsPerNm(rangeNm, width, height) {
  return (Math.min(width, height) / 2) / rangeNm
}
