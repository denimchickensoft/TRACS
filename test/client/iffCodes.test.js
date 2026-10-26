import { describe, test, expect } from 'vitest'
import { isValidIffCode } from '../../client/src/utils/transponder.js'
import { parseIffCsv } from '../../client/src/utils/csvIffAssignments.js'

describe('isValidIffCode', () => {
  test('Mode 1 is exactly 2 octal digits (00-77)', () => {
    expect(isValidIffCode('mode1', '00')).toBe(true)
    expect(isValidIffCode('mode1', '77')).toBe(true)
    expect(isValidIffCode('mode1', '78')).toBe(false)
    expect(isValidIffCode('mode1', '5')).toBe(false)
    expect(isValidIffCode('mode1', '123')).toBe(false)
  })

  test('Mode 2/3 are exactly 4 octal digits', () => {
    expect(isValidIffCode('mode3', '7227')).toBe(true)
    expect(isValidIffCode('mode2', '0000')).toBe(true)
    expect(isValidIffCode('mode3', '8899')).toBe(false)
    expect(isValidIffCode('mode3', '722')).toBe(false)
    expect(isValidIffCode('mode3', '72270')).toBe(false)
  })

  test('rejects unknown modes and empty input', () => {
    expect(isValidIffCode('mode4', '00')).toBe(false)
    expect(isValidIffCode('mode3', null)).toBe(false)
  })
})

describe('parseIffCsv', () => {
  test('pads short codes, drops invalid ones per field, blank clears', () => {
    const [row] = parseIffCsv('callsign,mode1,mode2,mode3\nVIPER 1-1,5,,8899\n')
    expect(row).toEqual({ callsign: 'VIPER11', mode1: '05', mode2: null, mode3: undefined, dropped: ['M3 8899'] })
  })

  test('zero-pads spreadsheet-stripped Mode 3 codes', () => {
    const [row] = parseIffCsv('callsign,mode3\nENFIELD11,400\n')
    expect(row.mode3).toBe('0400')
    expect(row.dropped).toEqual([])
  })

  test('over-long and non-digit codes are dropped', () => {
    const [row] = parseIffCsv('callsign,mode1,mode2\nHAVOC11,123,12-34\n')
    expect(row.mode1).toBeUndefined()
    expect(row.mode2).toBeUndefined()
    expect(row.dropped).toEqual(['M1 123', 'M2 12-34'])
  })
})
