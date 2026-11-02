import { describe, test, expect } from 'vitest'
import { missionEntriesPatch, mergeMissionFlights, intentWinner } from '../../client/src/missionData/merge.js'

describe('missionEntriesPatch', () => {
  const ac = (callsign) => ({ callsign, modex: '100', type: 'FA18C', task: 'CAP' })

  test('adds only aircraft not on the board, ids past nextId', () => {
    const s = { entries: [{ id: 1, callsign: 'ROOK11' }], nextId: 2 }
    const p = missionEntriesPatch(s, [ac('ROOK11'), ac('ROOK12'), ac('ROOK12'), ac('ROOK13')])
    expect(p.entries.map((e) => e.callsign)).toEqual(['ROOK11', 'ROOK12', 'ROOK13'])
    expect(p.entries.slice(1).map((e) => e.id)).toEqual([2, 3])
    expect(p.nextId).toBe(4)
  })

  test('applying the same mission twice adds nothing the second time', () => {
    const once = missionEntriesPatch({ entries: [], nextId: 1 }, [ac('A'), ac('B')])
    const twice = missionEntriesPatch(once, [ac('A'), ac('B')])
    expect(twice.entries).toEqual(once.entries)
  })
})

describe('mergeMissionFlights', () => {
  const f = (groupId, extra = {}) => ({ groupId, name: `G${groupId}`, ...extra })

  test('same mission: adds missing flights, keeps edits on loaded ones', () => {
    const s = { missionId: 'm1', flights: [f(1, { iffRoster: { a: '1234' } }), f(-1, { manual: true })] }
    const r = mergeMissionFlights(s, [f(1), f(2)], 'm1')
    expect(r.replaced).toBe(false)
    expect(r.flights.map((x) => x.groupId)).toEqual([1, -1, 2])
    expect(r.flights[0].iffRoster).toEqual({ a: '1234' })
  })

  test('after a manual load (no mission id): add only', () => {
    const r = mergeMissionFlights({ missionId: null, flights: [f(1)] }, [f(1), f(3)], 'm2')
    expect(r.flights.map((x) => x.groupId)).toEqual([1, 3])
  })

  test('a different mission replaces imported flights, keeps manual and .stm', () => {
    const s = { missionId: 'm1', flights: [f(1), f(-1, { manual: true }), f(9, { source: 'stm' })] }
    const r = mergeMissionFlights(s, [f(5)], 'm2')
    expect(r.replaced).toBe(true)
    expect(r.flights.map((x) => x.groupId)).toEqual([5, -1, 9])
  })
})

describe('intentWinner', () => {
  const now = 100_000

  test('earliest room join wins; ties go to the lower peer id', () => {
    const m = new Map([['b', { joinedAt: 10, at: now }], ['a', { joinedAt: 20, at: now }]])
    expect(intentWinner(m, now)).toBe('b')
    m.set('a', { joinedAt: 10, at: now })
    expect(intentWinner(m, now)).toBe('a')
  })

  test('a stale intent does not count', () => {
    const m = new Map([['old', { joinedAt: 1, at: now - 40_000 }], ['me', { joinedAt: 50, at: now }]])
    expect(intentWinner(m, now, 30_000)).toBe('me')
    expect(intentWinner(new Map(), now)).toBeNull()
  })
})
