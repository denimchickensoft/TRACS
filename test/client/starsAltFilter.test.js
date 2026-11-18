import { describe, it, expect, vi } from 'vitest'

// starsScopeHelpers.js pulls in stores that touch localStorage and the window on load.
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

import { computeStarsFilteredUnits, fmtAltFilterLimit } from '../../client/src/modules/atc/stars/starsScopeHelpers.js'

const FT = 0.3048
const unit = (ft) => ({ position: { alt: ft * FT } })
const units = { below: unit(-50), ground: unit(0), mid: unit(14900), high: unit(70000) }
const symbols = Object.fromEntries(Object.keys(units).map((id) => [id, { sym: '*' }]))
const shown = (lo, hi) => Object.keys(computeStarsFilteredUnits(units, symbols, { loU: lo, hiU: hi, loA: lo, hiA: hi }))

describe('altitude filter', () => {
  it('a lower limit of 000 has no floor', () => {
    expect(shown(0, 600)).toEqual(['below', 'ground', 'mid'])
  })

  it('a lower limit above 000 is a floor', () => {
    expect(shown(1, 600)).toEqual(['mid'])
  })

  it('999 999 shows only 99,900 ft', () => {
    expect(shown(999, 999)).toEqual([])
  })
})

describe('fmtAltFilterLimit', () => {
  it('shows a lower limit of 000 as N99', () => {
    expect(fmtAltFilterLimit(0, true)).toBe('N99')
    expect(fmtAltFilterLimit(1, true)).toBe('001')
    expect(fmtAltFilterLimit(0, false)).toBe('000')
    expect(fmtAltFilterLimit(600, false)).toBe('600')
  })
})
