import { describe, test, expect } from 'vitest'
import registryAuthority from '../../relay/registryAuthority.js'

const { resolvePosition, mintEntry, nextAvailableLetter, globalUsedLetters } = registryAuthority

describe('resolvePosition', () => {
  test('returns the requested position when free', () => {
    expect(resolvePosition('KLAS_APP', ['KLAS_TWR'])).toBe('KLAS_APP')
  })

  test('inserts a collision index before the last segment', () => {
    expect(resolvePosition('KLAS_APP', ['KLAS_APP'])).toBe('KLAS_1_APP')
    expect(resolvePosition('KLAS_APP', ['KLAS_APP', 'KLAS_1_APP'])).toBe('KLAS_2_APP')
  })

  test('appends the index when there is no underscore', () => {
    expect(resolvePosition('AIC', ['AIC'])).toBe('AIC_1')
  })
})

describe('letters', () => {
  test('nextAvailableLetter skips used letters', () => {
    expect(nextAvailableLetter(new Set(['A', 'B']))).toBe('C')
    expect(nextAvailableLetter(new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'))).toBe(null)
  })

  test('globalUsedLetters ignores entries without a letter', () => {
    expect(globalUsedLetters({ x: { letter: 'A' }, y: { letter: null }, z: { letter: 'C' } })).toEqual(new Set(['A', 'C']))
  })
})

describe('mintEntry', () => {
  const base = { position: 'KLAS_APP', facility: 'KLAS', suffix: 'APP', frequency: '125.900' }

  test('assigns a new group number and a controllerId for track-capable positions', () => {
    const { entry, groupAssignments, nextGroupNumber } = mintEntry({
      ...base, hints: { preferredLetter: 'R', canAssumeTrack: true, displayName: 'Approach' },
      registry: {}, groupAssignments: {}, nextGroupNumber: 1,
    })
    expect(entry).toMatchObject({ letter: 'R', controllerId: '1R', groupNumber: 1, displayName: 'Approach', positionSymbol: 'R' })
    expect(groupAssignments).toEqual({ KLAS: 1 })
    expect(nextGroupNumber).toBe(2)
  })

  test('reuses the facility group number', () => {
    const { entry, nextGroupNumber } = mintEntry({
      ...base, hints: { preferredLetter: 'R', canAssumeTrack: true },
      registry: {}, groupAssignments: { KLAS: 3 }, nextGroupNumber: 5,
    })
    expect(entry.controllerId).toBe('3R')
    expect(nextGroupNumber).toBe(5)
  })

  test('falls back to the next free letter when the preferred one is taken', () => {
    const { entry } = mintEntry({
      ...base, hints: { preferredLetter: 'A', canAssumeTrack: true },
      registry: { other: { letter: 'A' } }, groupAssignments: {}, nextGroupNumber: 1,
    })
    expect(entry.letter).toBe('B')
  })

  test('no controllerId without track capability; displayName defaults to the suffix', () => {
    const { entry } = mintEntry({
      ...base, hints: { preferredLetter: 'T' },
      registry: {}, groupAssignments: {}, nextGroupNumber: 1,
    })
    expect(entry).toMatchObject({ controllerId: null, canAssumeTrack: false, displayName: 'APP' })
  })

  test('does not mutate the passed group assignments', () => {
    const groupAssignments = {}
    mintEntry({ ...base, hints: {}, registry: {}, groupAssignments, nextGroupNumber: 1 })
    expect(groupAssignments).toEqual({})
  })
})
