import { describe, test, expect } from 'vitest'
import { findAirfieldWeather, starsAltimeter, catccQnh, formatWind, normalizeWind, deckWindKt, icaoToAirbaseName } from '../../client/src/utils/liveWeather.js'

const weather = {
  mission: null,
  airfields: {
    '1': { callsign: 'Batumi', qnhHpa: 1013.2 },
    '7': { callsign: 'CVN-71', unitId: 42, qnhHpa: 1009 },
  },
}

describe('findAirfieldWeather', () => {
  test('finds a carrier by unit id and an airfield by callsign', () => {
    expect(findAirfieldWeather(weather, { unitId: 42 }).callsign).toBe('CVN-71')
    expect(findAirfieldWeather(weather, { unitId: '42' }).callsign).toBe('CVN-71')
    expect(findAirfieldWeather(weather, { callsign: 'Batumi' }).qnhHpa).toBe(1013.2)
  })

  test('returns null when nothing matches or there is no weather', () => {
    expect(findAirfieldWeather(weather, { unitId: 99 })).toBeNull()
    expect(findAirfieldWeather(weather, { callsign: 'Kobuleti' })).toBeNull()
    expect(findAirfieldWeather(null, { callsign: 'Batumi' })).toBeNull()
    expect(findAirfieldWeather(weather)).toBeNull()
  })
})

describe('altimeter formats', () => {
  test('STARS: inHg to two places, or whole hPa when metric', () => {
    expect(starsAltimeter(1013.25, false)).toBe('29.92')
    expect(starsAltimeter(1013.25, true)).toBe('1013')
  })

  test('CATCC: inHg x 100, four digits', () => {
    expect(catccQnh(1013.25)).toBe('2992')
    expect(catccQnh(1009)).toBe('2980')
  })
})

describe('winds', () => {
  test('formatWind: magnetic, nearest 10 degrees, knots, 360 for north, calm', () => {
    expect(formatWind({ fromDeg: 245, speedMs: 6.17 }, 5)).toBe('240/12')
    expect(formatWind({ fromDeg: 3, speedMs: 5 }, 0)).toBe('360/10')
    expect(formatWind({ fromDeg: 90, speedMs: 0.1 }, 0)).toBe('000/00')
    expect(formatWind(null)).toBe('')
  })

  test('normalizeWind pads and validates typed winds', () => {
    expect(normalizeWind('270/6')).toBe('270/06')
    expect(normalizeWind('90/15')).toBe('090/15')
    expect(normalizeWind('361/10')).toBeNull()
    expect(normalizeWind('27')).toBeNull()
  })

  test('deckWindKt: carrier speed plus the headwind along the BRC', () => {
    expect(deckWindKt('090/10', 90, 20)).toBeCloseTo(30)
    expect(deckWindKt('270/10', 90, 20)).toBeCloseTo(10)
    expect(deckWindKt('000/10', 90, 20)).toBeCloseTo(20)
    expect(deckWindKt('', 90, 20)).toBeNull()
  })

  test('icaoToAirbaseName inverts the theatre table', () => {
    const mapping = { caucasus: { Kobuleti: 'UG5X', Batumi: 'UGSB' } }
    expect(icaoToAirbaseName(mapping, 'Caucasus', 'ugsb')).toBe('Batumi')
    expect(icaoToAirbaseName(mapping, 'Caucasus', 'XXXX')).toBeNull()
    expect(icaoToAirbaseName(null, 'Caucasus', 'UGSB')).toBeNull()
  })
})
