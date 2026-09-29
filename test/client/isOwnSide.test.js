import { describe, test, expect } from 'vitest'
import { isOwnSide } from '../../client/src/utils/tacticalHelpers.js'

describe('isOwnSide', () => {
  test('only the viewer\'s own coalition', () => {
    expect(isOwnSide({ coalition: 2 }, 'blue')).toBe(true)
    expect(isOwnSide({ coalition: 1 }, 'blue')).toBe(false)
    expect(isOwnSide({ coalition: 1 }, 'red')).toBe(true)
    expect(isOwnSide({ coalition: 0 }, 'red')).toBe(false)
  })
  test('GM and Admin see both sides', () => {
    expect(isOwnSide({ coalition: 1 }, 'gm')).toBe(true)
    expect(isOwnSide({ coalition: 2 }, 'admin')).toBe(true)
  })
  test('no unit is never own side', () => {
    expect(isOwnSide(undefined, 'blue')).toBe(false)
  })
})
