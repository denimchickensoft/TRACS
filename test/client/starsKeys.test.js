import { describe, test, expect } from 'vitest'
import { shouldAppendToken } from '../../client/src/utils/starsKeys.js'

describe('shouldAppendToken', () => {
  test('a function key enters its token once', () => {
    expect(shouldAppendToken('F4', 'TC', '', false)).toBe(true)
    expect(shouldAppendToken('F4', 'TC', 'TC', false)).toBe(false)
    expect(shouldAppendToken('F7', 'MF ', 'MF ', false)).toBe(false)
  })
  test('holding a function key does not repeat it', () => {
    expect(shouldAppendToken('F7', 'MF ', '', true)).toBe(false)
  })
  test('a different function key still appends', () => {
    expect(shouldAppendToken('F5', 'HO ', 'MF ', false)).toBe(true)
  })
  test('other token keys can repeat', () => {
    expect(shouldAppendToken('Backquote', 'Δ', 'Δ', false)).toBe(true)
  })
})
