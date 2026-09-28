import { describe, test, expect } from 'vitest'
import { sortBraaRows } from '../../client/src/modules/aic/braaSort.js'

const rows = [
  { id: 'a', fighterCallsign: 'VIPER11', braa: { range: 40 }, intercept: { ttiSeconds: 300 } },
  { id: 'b', fighterCallsign: null,      braa: { range: 10 }, intercept: null },
  { id: 'c', fighterCallsign: 'COLT11',  braa: null,          intercept: { ttiSeconds: 90 } },
  { id: 'd', fighterCallsign: 'ENFIELD11', braa: { range: 25 }, intercept: { ttiSeconds: Infinity } },
]
const ids = (sorted) => sorted.map((r) => r.id).join('')

describe('sortBraaRows', () => {
  test('added keeps insertion order, descending reverses it', () => {
    expect(ids(sortBraaRows(rows, { key: 'added', dir: 'asc' }))).toBe('abcd')
    expect(ids(sortBraaRows(rows, { key: 'added', dir: 'desc' }))).toBe('dcba')
  })
  test('callsign: rows with no revealed callsign go last in both directions', () => {
    expect(ids(sortBraaRows(rows, { key: 'callsign', dir: 'asc' }))).toBe('cdab')
    expect(ids(sortBraaRows(rows, { key: 'callsign', dir: 'desc' }))).toBe('adcb')
  })
  test('range: no BRAA goes last', () => {
    expect(ids(sortBraaRows(rows, { key: 'range', dir: 'asc' }))).toBe('bdac')
    expect(ids(sortBraaRows(rows, { key: 'range', dir: 'desc' }))).toBe('adbc')
  })
  test('tti: no intercept solution goes last, in the order added', () => {
    expect(ids(sortBraaRows(rows, { key: 'tti', dir: 'asc' }))).toBe('cabd')
    expect(ids(sortBraaRows(rows, { key: 'tti', dir: 'desc' }))).toBe('acbd')
  })
  test('does not modify the input', () => {
    sortBraaRows(rows, { key: 'range', dir: 'asc' })
    expect(ids(rows)).toBe('abcd')
  })
})
