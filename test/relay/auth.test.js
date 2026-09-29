import { test, expect } from 'vitest'
import auth from '../../relay/auth.js'

const { passwordMatches } = auth
const passwords = { blue: 'b1', red: 'r1' }

test('accepts only the claimed coalition\'s own password', () => {
  expect(passwordMatches(passwords, 'blue', 'b1')).toBe(true)
  expect(passwordMatches(passwords, 'blue', 'x')).toBe(false)
  expect(passwordMatches(passwords, 'red', 'b1')).toBe(false)
  expect(passwordMatches(passwords, 'gm', '')).toBe(false)
})

test('never matches inherited properties or non-string input', () => {
  expect(passwordMatches(passwords, 'constructor', 'function Object() { [native code] }')).toBe(false)
  expect(passwordMatches(passwords, '__proto__', '[object Object]')).toBe(false)
  expect(passwordMatches(passwords, 'blue', {})).toBe(false)
  expect(passwordMatches(passwords, { toString: () => 'blue' }, 'b1')).toBe(false)
})
