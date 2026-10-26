import { describe, test, expect } from 'vitest'
import { airwayNameSet, splitAirwayArgs } from '../../client/src/store/airways.js'

describe('.airway argument handling', () => {
  test('bare V/J/B are class tokens, everything else is an airway name', () => {
    expect(splitAirwayArgs('j v66  b j70')).toEqual({ types: ['J', 'B'], names: ['V66', 'J70'] })
    expect(splitAirwayArgs('   ')).toEqual({ types: [], names: [] })
  })

  test('name set spans every class, upper-cased', () => {
    const airways = {
      V: [{ name: 'V66' }, { name: 'V66' }],
      J: [{ name: 'j70' }],
      B: [],
    }
    expect([...airwayNameSet(airways)].sort()).toEqual(['J70', 'V66'])
    expect(airwayNameSet(null).size).toBe(0)
  })
})
