import { describe, test, expect } from 'vitest'
import { findShapedCallsign, parseUnitName, callsignFromDcsName } from '../../client/src/utils/callsignShape.js'

const acidOf = (name, opts) => findShapedCallsign(name, opts)?.acid ?? null

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

  test('only the first numbered part counts', () => {
    expect(acidOf('VIPER21 | COLT11')).toBe('VIPER21')
    expect(acidOf('VIPER 2-1 | COLT 1-1')).toBe('VIPER21')
    expect(acidOf('COLT 1-1 | DENIM12')).toBe('COLT11')
    expect(acidOf('DENIM12 | COLT 1-1')).toBe('DENIM12')
    expect(parseUnitName('DENIM12 | COLT 1-1')).toEqual({ acid: 'DENIM12', pilotName: 'COLT 1-1' })
  })

  test('the number must end the part', () => {
    expect(acidOf('SCOUT4ME DENIM23')).toBe(null)
    expect(acidOf('SCOUT4ME DENIM23', { flightOnly: true })).toBe(null)
    expect(acidOf('COLT11DENIM')).toBe(null)
    expect(acidOf('Lot 20 | COLT 1-1')).toBe(null)
  })

  test('a three-digit number is not a flight and element', () => {
    expect(acidOf('COLT 111')).toBe(null)
  })

  test('short airframe names do not read as callsigns', () => {
    expect(acidOf('F16 | COLT 1-1')).toBe('COLT11')
  })
})

describe('flight-only callsigns (players)', () => {
  test.each([
    'SCOUT 1 | Denim',
    'SCOUT 1 | Denim1',
    'SCOUT1 - DENIM 1',
    'SCOUT1 DENIM1',
    '203 | Scout-1 | Denim',
  ])('%s -> flight SCOUT, element 1', (name) => {
    expect(findShapedCallsign(name, { flightOnly: true })).toMatchObject({ acid: 'SCOUT1', flight: 'SCOUT', element: 1 })
  })

  test('the second element of the same flight', () => {
    expect(findShapedCallsign('SCOUT 2 | Someguy', { flightOnly: true })).toMatchObject({ acid: 'SCOUT2', flight: 'SCOUT', element: 2 })
  })

  test('two digits keep flight and element', () => {
    expect(findShapedCallsign('SCOUT 12 | Denim', { flightOnly: true })).toMatchObject({ acid: 'SCOUT12', flight: 'SCOUT1', element: 2 })
  })

  test('not without flightOnly (AI unit names, Tacview)', () => {
    expect(acidOf('SCOUT 1 | Denim')).toBe(null)
    expect(acidOf('Akrotiri Hornet-3')).toBe(null)
  })

  test('pilot name', () => {
    expect(parseUnitName('SCOUT 1 | Denim', { flightOnly: true })).toEqual({ acid: 'SCOUT1', pilotName: 'Denim' })
    expect(parseUnitName('SCOUT1 DENIM1', { flightOnly: true })).toEqual({ acid: 'SCOUT1', pilotName: 'DENIM1' })
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
  test('a flagged player with a flight-only callsign', () => {
    expect(callsignFromDcsName({ id: 7, unitName: 'SCOUT 1 | Denim', callsign: 'RMD-5-2', human: true })).toBe('SCOUT1')
    expect(callsignFromDcsName({ id: 7, unitName: 'SCOUT 1 | Denim', callsign: 'RMD-5-2' })).toBe('RMD52')
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
