import { describe, test, expect } from 'vitest'
import exporter from '../../relay/exporter.js'

const { applyGroupMessage, splitLines } = exporter

describe('applyGroupMessage', () => {
  test('full replaces the group', () => {
    const groups = { units: { data: { a: 1, b: 2 }, seq: 1, t: 0 } }
    applyGroupMessage(groups, { group: 'units', kind: 'full', seq: 2, t: 5, data: { c: 3 } })
    expect(groups.units).toEqual({ data: { c: 3 }, seq: 2, t: 5 })
  })

  test('delta merges keys and removes nulls', () => {
    const groups = { units: { data: { a: 1, b: 2 }, seq: 1, t: 0 } }
    applyGroupMessage(groups, { group: 'units', kind: 'delta', seq: 2, t: 5, data: { b: null, c: 3 } })
    expect(groups.units.data).toEqual({ a: 1, c: 3 })
  })

  test('delta on an unknown group starts from empty', () => {
    const groups = {}
    applyGroupMessage(groups, { group: 'weather', kind: 'delta', seq: 1, t: 0, data: { qnh: 1013 } })
    expect(groups.weather.data).toEqual({ qnh: 1013 })
  })

  test('rejects a message without a group name', () => {
    const groups = {}
    expect(applyGroupMessage(groups, { kind: 'full', data: {} })).toBe(false)
    expect(groups).toEqual({})
  })
})

describe('splitLines', () => {
  test('keeps the unfinished tail', () => {
    expect(splitLines('', '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
  })

  test('joins the tail with the next chunk', () => {
    expect(splitLines('{"b"', ':2}\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
  })

  test('skips blank lines', () => {
    expect(splitLines('', '\n\n{"a":1}\n')).toEqual({ lines: ['{"a":1}'], rest: '' })
  })
})

describe('formatTiming', () => {
  test('lists numeric fields after the group', () => {
    const line = exporter.formatTiming({ type: 'timing', group: 'units', kind: 'delta', ms: 12.345, bytes: 2048, maxStepMs: 9.5 })
    expect(line).toBe('units (delta): ms=12.35 bytes=2048 maxStepMs=9.50')
  })
})
