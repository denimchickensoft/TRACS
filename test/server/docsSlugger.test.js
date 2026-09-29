import { test, expect } from 'vitest'
import docs from '../../server/src/routes/docs.js'

// Expected slugs are what GitHub generates for the same headings.
test('heading slugs match GitHub', () => {
  const slug = docs.makeSlugger()
  expect(slug('Missile Tracking & Launch Alert')).toBe('missile-tracking--launch-alert')
  expect(slug('Getting Started')).toBe('getting-started')
  expect(slug('ABM: .vol and .malert')).toBe('abm-vol-and-malert')
  expect(slug('snake_case-and-dashes')).toBe('snake_case-and-dashes')
})

test('repeated headings get -1, -2 suffixes', () => {
  const slug = docs.makeSlugger()
  expect([slug('Commands'), slug('Commands'), slug('Commands')]).toEqual(['commands', 'commands-1', 'commands-2'])
})
