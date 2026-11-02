import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import leasesModule from '../../relay/leases.js'

const { createLeases } = leasesModule

describe('createLeases', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const make = (opts = {}) => {
    const freed = []
    const leases = createLeases({ ttlMs: 1000, onFree: (k) => freed.push(k), timers: { setTimeout, clearTimeout }, ...opts })
    return { leases, freed }
  }

  test('one holder at a time; others are told who holds it', () => {
    const { leases } = make()
    expect(leases.acquire('room|sb', 'A')).toEqual({ granted: true })
    expect(leases.acquire('room|sb', 'B')).toEqual({ granted: false, holder: 'A' })
    expect(leases.acquire('room|fp', 'B')).toEqual({ granted: true })
  })

  test('release by the holder frees it; by anyone else does nothing', () => {
    const { leases, freed } = make()
    leases.acquire('k', 'A')
    expect(leases.release('k', 'B')).toBe(false)
    expect(leases.holderOf('k')).toBe('A')
    expect(leases.release('k', 'A')).toBe(true)
    expect(freed).toEqual(['k'])
    expect(leases.acquire('k', 'B')).toEqual({ granted: true })
  })

  test('lapses after the TTL; the holder asking again renews it', () => {
    const { leases, freed } = make()
    leases.acquire('k', 'A')
    vi.advanceTimersByTime(800)
    leases.acquire('k', 'A')
    vi.advanceTimersByTime(800)
    expect(leases.holderOf('k')).toBe('A')
    vi.advanceTimersByTime(300)
    expect(leases.holderOf('k')).toBeNull()
    expect(freed).toEqual(['k'])
  })

  test('releaseAll frees everything one holder held', () => {
    const { leases, freed } = make()
    leases.acquire('a', 'A')
    leases.acquire('b', 'A')
    leases.acquire('c', 'B')
    leases.releaseAll('A')
    expect(freed.sort()).toEqual(['a', 'b'])
    expect(leases.holderOf('c')).toBe('B')
  })
})
