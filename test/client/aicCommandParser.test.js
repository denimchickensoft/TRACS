import { describe, test, expect } from 'vitest'
import { parseCommand } from '../../client/src/modules/aic/input/commandParser.js'

const idOf = (buffer) => parseCommand(buffer)?.command.id ?? null

describe('AIC parseCommand', () => {
  test('trims and lowercases the buffer', () => {
    expect(parseCommand('  .RR 20 ')).toMatchObject({ command: { id: 'RR_SET' }, captures: { nm: '20' } })
  })

  test('.center: bullseye, bearing/range, then fix as the catch-all', () => {
    expect(idOf('.center')).toBe('CENTER_BULLSEYE')
    expect(parseCommand('.center 270 45.5')).toMatchObject({ command: { id: 'CENTER_BRG_RNG' }, captures: { brg: '270', rng: '45.5' } })
    expect(parseCommand('.center batumi')).toMatchObject({ command: { id: 'CENTER_FIX' }, captures: { fix: 'batumi' } })
  })

  test('declarations', () => {
    expect(idOf('.dec')).toBe('DECLARATION_RESET')
    expect(parseCommand('.dec b h').captures).toEqual({ oldLetter: 'b', newLetter: 'h' })
    expect(idOf('.dec x h')).toBe(null)
    expect(idOf('.autodec')).toBe('AUTO_DECLARE')
    expect(idOf('.autodec iff')).toBe('AUTO_DECLARE_IFF')
  })

  test('ROE', () => {
    expect(idOf('.roe')).toBe('ROE_TOGGLE')
    expect(parseCommand('.ROE Tight').captures).toEqual({ state: 'tight' })
    expect(idOf('.roe weapons')).toBe(null)
  })

  test('sector', () => {
    expect(idOf('.sector')).toBe('SECTOR_ON')
    expect(idOf('.sector off')).toBe('SECTOR_CLEAR')
    expect(parseCommand('.sector 300 060 80').captures).toEqual({ fromMag: '300', toMag: '060', rng: '80' })
  })

  test('bullseye: reset, lat/lng, fix', () => {
    expect(idOf('.be')).toBe('BE_RESET')
    expect(parseCommand('.be -41.5 42.25').captures).toEqual({ lat: '-41.5', lng: '42.25' })
    expect(parseCommand('.be kobuleti').captures).toEqual({ fix: 'kobuleti' })
  })

  test('.centroid and .axis are commands', () => {
    expect(idOf('.centroid')).toBe('CENTROID_TOGGLE')
    expect(idOf('.axis')).toBe('AXIS_TOGGLE')
  })

  test('.define and its .def alias', () => {
    expect(parseCommand('.define bogey').captures).toEqual({ term: 'bogey' })
    expect(parseCommand('.def bogey').captures).toEqual({ term: 'bogey' })
  })

  test('unknown input matches nothing', () => {
    expect(idOf('.nope')).toBe(null)
    expect(idOf('')).toBe(null)
  })
})
