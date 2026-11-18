import { describe, it, expect, vi } from 'vitest'

// The stores mizFlightPlans.js pulls in touch localStorage and the window on load.
vi.hoisted(() => {
  globalThis.window = { location: { search: '' }, addEventListener: () => {} }
  const storage = () => {
    const mem = new Map()
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    }
  }
  globalThis.localStorage = storage()
  globalThis.sessionStorage = storage()
})

import { assignAids } from '../../client/src/utils/mizFlightPlans.js'

const strip = (name) => name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
const aidsFor = (names, coalition = 'blue') => {
  const entries = names.map((n) => ({ unit: {}, raw: strip(n), coalition }))
  assignAids(entries)
  return entries.map((e) => e.aid)
}

describe('assignAids', () => {
  it('keeps unit names that fit unchanged', () => {
    expect(aidsFor(['RMD-5-1', 'Zippo Hornet-1-1'])).toEqual(['RMD51', 'ZIPPOHORNET11'])
  })

  it('keeps the trailing slot digits when cutting a long name', () => {
    expect(aidsFor(['Akrotiri Hornet-1', 'Akrotiri Hornet-2', 'Akrotiri Hornet-3', 'Akrotiri Hornet-4']))
      .toEqual(['AKROTIRIHORN1', 'AKROTIRIHORN2', 'AKROTIRIHORN3', 'AKROTIRIHORN4'])
    expect(aidsFor(['Akrotiri THE MIRAGE-2-4'])).toEqual(['AKROTIRITHE24'])
  })

  it('gives a name that fits priority, and moves a cut one off it by swapping a letter', () => {
    // The cut name comes first in mission order but the uncut one keeps its AID.
    expect(aidsFor(['Akrotiri A10C II-1', 'Akrotiri A10C-1'])).toEqual(['AKROTIRIA10A1', 'AKROTIRIA10C1'])
  })

  it('makes repeated names unique', () => {
    expect(aidsFor(['Hornet-1', 'Hornet-1', 'Hornet-1'])).toEqual(['HORNET1', 'HORNEA1', 'HORNEB1'])
  })

  it('handles numeric unit names', () => {
    expect(aidsFor(['-1', '-1'])).toEqual(['1', 'A1'])
  })

  it('is unique per coalition only', () => {
    const entries = [
      { unit: {}, raw: 'HORNET1', coalition: 'blue' },
      { unit: {}, raw: 'HORNET1', coalition: 'red' },
    ]
    assignAids(entries)
    expect(entries.map((e) => e.aid)).toEqual(['HORNET1', 'HORNET1'])
  })

  it('never exceeds 13 characters and is the same on every run', () => {
    const names = Array.from({ length: 40 }, (_, i) => `Ramat David Viper-${Math.floor(i / 4) + 1}-${(i % 4) + 1}`)
    const a = aidsFor(names)
    expect(a.every((x) => x.length <= 13)).toBe(true)
    expect(new Set(a).size).toBe(40)
    expect(aidsFor(names)).toEqual(a)
  })
})
