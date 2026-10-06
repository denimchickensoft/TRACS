import { describe, test, expect } from 'vitest'
import {
  IMPERIAL, METRIC, M_PER_NM, NM_TO_FT,
  distFromNm, distToNm, distUnit, formatDistance, formatRangeFine,
  formatAltitude, altHundreds, altFromFt, formatAltThousands, speedTens, speedFromMs,
} from '../../client/src/utils/units.js'

describe('distance', () => {
  test('converts NM to the display unit and back', () => {
    expect(distFromNm(10, IMPERIAL)).toBe(10)
    expect(distFromNm(10, METRIC)).toBeCloseTo(18.52)
    expect(distToNm(distFromNm(7.3, METRIC), METRIC)).toBeCloseTo(7.3)
    expect(distUnit(IMPERIAL)).toBe('NM')
    expect(distUnit(METRIC)).toBe('KM')
  })

  test('formatDistance keeps the requested precision', () => {
    expect(formatDistance(20, IMPERIAL)).toBe('20NM')
    expect(formatDistance(20, METRIC)).toBe('37KM')
    expect(formatDistance(1.234, IMPERIAL, 2)).toBe('1.23NM')
    expect(formatDistance(1, METRIC, 2)).toBe('1.85KM')
  })
})

describe('formatRangeFine', () => {
  test('imperial: feet below 1 NM, whole NM from 1 NM', () => {
    expect(formatRangeFine(0.5, IMPERIAL)).toBe(`${Math.round(0.5 * NM_TO_FT)}FT`)
    expect(formatRangeFine(0.99, IMPERIAL)).toBe(`${Math.round(0.99 * NM_TO_FT)}FT`)
    expect(formatRangeFine(1, IMPERIAL)).toBe('1NM')
    expect(formatRangeFine(12.4, IMPERIAL)).toBe('12NM')
  })

  test('metric: metres below 1 km, whole km from 1 km', () => {
    expect(formatRangeFine(500 / M_PER_NM, METRIC)).toBe('500M')
    expect(formatRangeFine(990 / M_PER_NM, METRIC)).toBe('990M')
    expect(formatRangeFine(1000 / M_PER_NM, METRIC)).toBe('1KM')
    // 0.6 NM is above 1 km, so metric stays in km where imperial drops to ft
    expect(formatRangeFine(0.6, METRIC)).toBe('1KM')
    expect(formatRangeFine(0.6, IMPERIAL)).toMatch(/FT$/)
  })
})

describe('altitude and speed', () => {
  test('formatAltitude rounds to whole ft / m and handles missing data', () => {
    expect(formatAltitude(100, IMPERIAL)).toBe('328FT')
    expect(formatAltitude(100, METRIC)).toBe('100M')
    expect(formatAltitude(null, METRIC)).toBe('ELEV N/A')
  })

  test('datablock fields are zero-padded hundreds / tens', () => {
    expect(altHundreds(7620, IMPERIAL)).toBe('250')
    expect(altHundreds(7600, METRIC)).toBe('076')
    expect(altHundreds(-5, METRIC)).toBe('000')
    expect(speedTens(450 / 1.94384, IMPERIAL)).toBe('45')
    expect(speedTens(830 / 3.6, METRIC)).toBe('83')
    expect(speedTens(1200 / 3.6, METRIC)).toBe('120')
    expect(speedFromMs(100, METRIC)).toBeCloseTo(360)
  })

  test('feet-sourced altitudes and brevity thousands', () => {
    expect(altFromFt(4500, IMPERIAL)).toBe(4500)
    expect(altFromFt(3280.84, METRIC)).toBeCloseTo(1000)
    expect(formatAltThousands(7620, IMPERIAL)).toBe('25k')
    expect(formatAltThousands(7620, METRIC)).toBe('7.6km')
  })
})
