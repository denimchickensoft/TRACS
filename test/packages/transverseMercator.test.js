import { describe, test, expect } from 'vitest'
import { tmForward, tmInverse } from '../../packages/geo-math/transverseMercator.js'
import params from '../../client/public/projection_params.json'

// Reference values from PROJ (pyproj, +proj=tmerc +ellps=WGS84) using each
// theatre's projection_params.json entry.
const REFERENCE = [
  { theatre: 'Caucasus', lat: 41.93, lng: 41.86, easting: 635360.2114268471, northing: -317981.62062111776 },
  { theatre: 'Caucasus', lat: 43.0,  lng: 40.0,  easting: 471140.1553724032, northing: -213464.3389665084 },
  // 12° off Kola's central meridian, where a naive series breaks down.
  { theatre: 'Kola',     lat: 69.0,  lng: 33.0,  easting: 414612.666633944,  northing: 157616.86895841546 },
]

describe('transverse Mercator', () => {
  test.each(REFERENCE)('tmForward matches PROJ at $theatre $lat,$lng', ({ theatre, lat, lng, easting, northing }) => {
    const out = tmForward(lat, lng, params[theatre])
    expect(Math.abs(out.easting - easting)).toBeLessThan(0.001)
    expect(Math.abs(out.northing - northing)).toBeLessThan(0.001)
  })

  test.each(REFERENCE)('tmInverse round-trips $theatre $lat,$lng', ({ theatre, easting, northing, lat, lng }) => {
    const out = tmInverse(easting, northing, params[theatre])
    expect(out.lat).toBeCloseTo(lat, 8)
    expect(out.lng).toBeCloseTo(lng, 8)
  })

  test('the central meridian maps to the false easting', () => {
    const p = params.Caucasus
    expect(tmForward(42, p.central_meridian, p).easting).toBeCloseTo(p.false_easting, 6)
  })
})
