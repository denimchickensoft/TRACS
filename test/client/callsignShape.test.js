import { describe, test, expect } from 'vitest'
import { findShapedCallsign, parseUnitName, callsignFromDcsName } from '../../client/src/utils/callsignShape.js'

const acidOf = (name, dcsCallsign) => findShapedCallsign(name, dcsCallsign)?.acid ?? null

describe('findShapedCallsign', () => {
  test.each([
    'Colt 1-1 | Denim',
    '203 | COLT 1-1 | DENIM',
    'DENIM | COLT 1-1 | 203',
    'COLT 1-1 - DENIM',
    'COLT11 DENIM',
    'COLT 11 DENIM',
    'COLT1-1-DENIM',
    'colt 1-1',
  ])('%s -> COLT11', (name) => {
    expect(acidOf(name)).toBe('COLT11')
  })

  test('a flight with no element digit is not a callsign', () => {
    expect(acidOf('COLT1')).toBe(null)
    expect(acidOf('COLT1 | DENIM')).toBe(null)
  })

  test('modex and pilot-name segments alone never match', () => {
    expect(acidOf('DENIM')).toBe(null)
    expect(acidOf('203')).toBe(null)
    expect(acidOf('203 | DENIM')).toBe(null)
  })

  test('empty or missing names', () => {
    expect(acidOf('')).toBe(null)
    expect(acidOf(undefined)).toBe(null)
  })

  test('two matches: the one agreeing with the DCS callsign field wins, else the first', () => {
    expect(acidOf('VIPER21 | COLT 1-1')).toBe('VIPER21')
    expect(acidOf('VIPER21 | COLT 1-1', 'Colt11')).toBe('COLT11')
    expect(acidOf('VIPER21 | COLT 1-1', 'Enfield11')).toBe('VIPER21')
  })

  test('a three-digit number is not a flight and element', () => {
    expect(acidOf('COLT 111')).toBe(null)
  })

  test('short airframe names do not read as callsigns', () => {
    expect(acidOf('F16 | COLT 1-1')).toBe('COLT11')
  })
})

describe('parseUnitName', () => {
  test('pilot name is the remaining letters', () => {
    expect(parseUnitName('Colt 1-1 | Denim')).toEqual({ acid: 'COLT11', pilotName: 'Denim' })
    expect(parseUnitName('203 | COLT 1-1 | DENIM')).toEqual({ acid: 'COLT11', pilotName: 'DENIM' })
    expect(parseUnitName('DENIM | COLT 1-1 | 203')).toEqual({ acid: 'COLT11', pilotName: 'DENIM' })
    expect(parseUnitName('COLT 1-1 - DENIM')).toEqual({ acid: 'COLT11', pilotName: 'DENIM' })
    expect(parseUnitName('COLT11 DENIM')).toEqual({ acid: 'COLT11', pilotName: 'DENIM' })
    expect(parseUnitName('COLT1-1-DENIM')).toEqual({ acid: 'COLT11', pilotName: 'DENIM' })
    expect(parseUnitName('COLT 1-1')).toEqual({ acid: 'COLT11', pilotName: null })
  })

  test('no callsign shape falls back to splitting at the first pipe', () => {
    expect(parseUnitName('COLT1 | Denim')).toEqual({ acid: 'COLT1', pilotName: 'Denim' })
    expect(parseUnitName('Denim')).toEqual({ acid: 'DENIM', pilotName: null })
    expect(parseUnitName('')).toEqual({ acid: '', pilotName: null })
  })
})

describe('callsignFromDcsName', () => {
  test('shape match first', () => {
    expect(callsignFromDcsName({ id: 7, unitName: '203 | COLT 1-1 | DENIM', callsign: 'Enfield11' })).toBe('COLT11')
  })
  test('then the DCS callsign field', () => {
    expect(callsignFromDcsName({ id: 7, unitName: 'COLT1 | DENIM', callsign: 'Enfield11' })).toBe('ENFIELD11')
  })
  test('then the text left of the pipe', () => {
    expect(callsignFromDcsName({ id: 7, unitName: 'COLT1 | DENIM' })).toBe('COLT1')
  })
  test('then the unit ID', () => {
    expect(callsignFromDcsName({ id: 7, unitName: '' })).toBe('7')
  })
})
