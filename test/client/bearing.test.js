import { describe, test, expect, beforeAll } from 'vitest'
import {
  trueBearingRangeNm, destinationPoint, localOffsetNm,
  gridBearingRangeNm, gridDestinationPoint, toMagneticFromTrue, toTrueFromMagnetic,
} from '../../client/src/utils/bearing.js'
import { setProjectionParams } from '../../client/src/utils/magvar.js'
import params from '../../client/public/projection_params.json'

beforeAll(() => setProjectionParams(params))

describe('true-frame bearings', () => {
  test('cardinal directions', () => {
    expect(trueBearingRangeNm(0, 0, 1, 0)).toEqual({ trueBearingDeg: 0, rangeNm: 60 })
    expect(trueBearingRangeNm(0, 0, 0, 1).trueBearingDeg).toBeCloseTo(90)
    expect(trueBearingRangeNm(0, 0, -1, 0).trueBearingDeg).toBeCloseTo(180)
    expect(trueBearingRangeNm(0, 0, 0, -1).trueBearingDeg).toBeCloseTo(270)
  })

  test('longitude is scaled by the cosine of latitude', () => {
    expect(trueBearingRangeNm(60, 0, 60, 1).rangeNm).toBeCloseTo(30, 6)
  })

  test('destinationPoint and localOffsetNm are exact inverses', () => {
    const dest = destinationPoint(42, 41, 37, 0.8)
    const { eastNm, northNm } = localOffsetNm(42, 41, dest.lat, dest.lng)
    expect(Math.hypot(eastNm, northNm)).toBeCloseTo(0.8, 10)
    expect(Math.atan2(eastNm, northNm) * 180 / Math.PI).toBeCloseTo(37, 10)
  })
})

describe('grid-frame bearings', () => {
  test('grid north differs from true north away from the central meridian', () => {
    // Tbilisi area, ~12° east of Caucasus's 33°E central meridian: a point
    // due true-north reads west of grid north by the convergence angle.
    const { gridBearingDeg } = gridBearingRangeNm(41.7, 44.9, 41.8, 44.9, 'Caucasus')
    expect(gridBearingDeg).toBeGreaterThan(350)
    expect(gridBearingDeg).toBeLessThan(353)
  })

  test('gridDestinationPoint inverts gridBearingRangeNm', () => {
    const dest = gridDestinationPoint(42, 41, 120, 25, 'Caucasus')
    const back = gridBearingRangeNm(42, 41, dest.lat, dest.lng, 'Caucasus')
    expect(back.gridBearingDeg).toBeCloseTo(120, 6)
    expect(back.rangeNm).toBeCloseTo(25, 6)
  })

  test('falls back to the true-frame math without projection params', () => {
    const grid = gridBearingRangeNm(0, 0, 1, 1, 'NoSuchTheatre')
    const flat = trueBearingRangeNm(0, 0, 1, 1)
    expect(grid).toEqual({ gridBearingDeg: flat.trueBearingDeg, rangeNm: flat.rangeNm })
  })
})

describe('magnetic conversion', () => {
  test('magnetic = true - declination, wrapped to [0, 360)', () => {
    expect(toMagneticFromTrue(5, 7)).toBe(358)
    expect(toMagneticFromTrue(90, -3)).toBe(93)
    expect(toTrueFromMagnetic(358, 7)).toBe(5)
  })
})
