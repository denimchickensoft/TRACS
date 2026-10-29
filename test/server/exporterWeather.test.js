import { describe, it, expect } from 'vitest'
import exporterWeather from '../../server/src/exporterWeather.js'

const { qnhHpa, toWind, toAirfieldWeather, toAirfieldsWeather } = exporterWeather

// ISA surface pressure at elevation h, for a standard-day sea-level 1013.25 hPa.
const isaPressurePa = (h) => 101325 * Math.pow(1 - 0.0065 * h / 288.15, 5.25588)

describe('qnhHpa', () => {
  it('is the surface pressure at sea level', () => {
    expect(qnhHpa(101325, 0)).toBeCloseTo(1013.25, 6)
  })

  it('reduces a field-elevation pressure through the standard atmosphere', () => {
    expect(qnhHpa(isaPressurePa(500), 500)).toBeCloseTo(1013.25, 6)
    expect(qnhHpa(isaPressurePa(1500) * 0.99, 1500)).toBeCloseTo(1013.25 * 0.99, 6)
  })

  it('treats a missing elevation as sea level and rejects bad pressures', () => {
    expect(qnhHpa(100000)).toBeCloseTo(1000, 6)
    expect(qnhHpa(0, 0)).toBeNull()
    expect(qnhHpa(undefined, 0)).toBeNull()
  })
})

describe('toWind', () => {
  it('gives the direction the wind blows from (x north, z east)', () => {
    expect(toWind(-10, 0)).toEqual({ fromDeg: 0, speedMs: 10 })   // air moving south
    expect(toWind(0, -5)).toEqual({ fromDeg: 90, speedMs: 5 })    // moving west
    expect(toWind(10, 0)).toEqual({ fromDeg: 180, speedMs: 10 })  // moving north
    expect(toWind(0, 5)).toEqual({ fromDeg: 270, speedMs: 5 })    // moving east
  })

  it('never returns 360 and rounds speed to 0.1 m/s', () => {
    expect(toWind(-10, 0.0001).fromDeg).toBe(0)
    expect(toWind(-3, -4)).toEqual({ fromDeg: 53, speedMs: 5 })
    expect(toWind(-0.123, 0).speedMs).toBe(0.1)
  })

  it('returns null without a vector', () => {
    expect(toWind(undefined, 1)).toBeNull()
  })
})

describe('toAirfieldWeather', () => {
  const rec = {
    callsign: 'Batumi', latitude: 41.6, longitude: 41.6, elevation: 0,
    t: 288.15, p: 101330, wx: -5, wz: 0,
    aloft: [{ ft: 3000, t: 282.25, wx: 0, wz: -12 }],
  }

  it('converts a raw record', () => {
    expect(toAirfieldWeather(rec)).toEqual({
      callsign: 'Batumi', latitude: 41.6, longitude: 41.6, elevationM: 0,
      qnhHpa: 1013.3, tempC: 15, wind: { fromDeg: 0, speedMs: 5 },
      aloft: [{ ft: 3000, tempC: 9.1, wind: { fromDeg: 90, speedMs: 12 } }],
    })
  })

  it('keeps a carrier unitId and tolerates a missing aloft list', () => {
    const out = toAirfieldWeather({ ...rec, unitId: 42, aloft: undefined })
    expect(out.unitId).toBe(42)
    expect(out.aloft).toEqual([])
  })

  it('drops unusable records', () => {
    expect(toAirfieldWeather(null)).toBeNull()
    expect(toAirfieldWeather({ p: 101325 })).toBeNull()
    expect(toAirfieldsWeather({ '1': rec, '2': null })).toEqual({ '1': toAirfieldWeather(rec) })
    expect(toAirfieldsWeather(null)).toEqual({})
  })
})
