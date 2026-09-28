import { describe, test, expect } from 'vitest'
import { findOrphanedTracks } from '../../client/src/modules/atc/shared/orphanedTracks.js'

describe('findOrphanedTracks', () => {
  test('returns only tracks whose owner is not in the registry', () => {
    const ownership = { 101: '1A', 102: '2B', 103: '5A', 104: '1A' }
    expect(findOrphanedTracks(ownership, new Set(['1A', '2B']))).toEqual(['103'])
  })
  test('nothing is orphaned when every owner is known', () => {
    expect(findOrphanedTracks({ 101: '1A' }, new Set(['1A']))).toEqual([])
  })
  test('an empty registry makes every owned track look orphaned', () => {
    // FORCE_DROP_ALL refuses to run with an empty registry for this reason.
    expect(findOrphanedTracks({ 101: '1A', 102: '2B' }, new Set())).toEqual(['101', '102'])
  })
})
