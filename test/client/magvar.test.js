import { describe, test, expect } from 'vitest'
import { computeMagvar, missionDecimalYear, theatreConvergence, setProjectionParams } from '../../client/src/utils/magvar.js'
import params from '../../client/public/projection_params.json'

// Reference declinations from ppigrf's IGRF-14 (igrf_gc) evaluated the way
// computeMagvar does: geodetic latitude used as geocentric, at the IGRF
// reference radius. A full geodetic evaluation differs by ~0.1-0.15° at
// these points (6.9997, 12.4456, 16.7884), well below display resolution.
const REFERENCE = [
  { lat: 41.93, lng: 41.86,  year: 2025.5, decl: 7.0940 },
  { lat: 36.2,  lng: -115.0, year: 2010.0, decl: 12.5548 },
  { lat: 69.0,  lng: 33.0,   year: 2020.0, decl: 16.9378 },
]

describe('computeMagvar', () => {
  test.each(REFERENCE)('matches IGRF-14 at $lat,$lng in $year', ({ lat, lng, year, decl }) => {
    expect(computeMagvar(lat, lng, year)).toBeCloseTo(decl, 2)
  })

  test('accepts a DCS mission date object', () => {
    const date = { Day: 1, Month: 1, Year: 2020 }
    expect(computeMagvar(69, 33, date)).toBeCloseTo(computeMagvar(69, 33, 2020.0), 10)
  })
})

describe('missionDecimalYear', () => {
  test('converts a DCS date to a decimal year', () => {
    expect(missionDecimalYear({ Day: 1, Month: 1, Year: 2020 })).toBe(2020)
    expect(missionDecimalYear({ Day: 2, Month: 7, Year: 2021 })).toBeCloseTo(2021 + 182 / 365, 10)
  })
})

describe('theatreConvergence', () => {
  test('is zero on the central meridian and grows with distance from it', () => {
    setProjectionParams(params)
    expect(theatreConvergence('Caucasus', 42, 33)).toBe(0)
    expect(theatreConvergence('Caucasus', 42, 44)).toBeCloseTo(11 * Math.sin(42 * Math.PI / 180), 10)
    expect(theatreConvergence('NoSuchTheatre', 42, 44)).toBe(0)
  })
})
