import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import update from '../../relay/update.js'
import pkg from '../../relay/package.json'

const { scheduleChecks } = update
const MIN = 60_000

describe('relay update checks', () => {
  let logs
  beforeEach(() => {
    vi.useFakeTimers()
    logs = []
    vi.spyOn(console, 'log').mockImplementation((m) => logs.push(m))
    vi.spyOn(console, 'error').mockImplementation((m) => logs.push(m))
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('a failed first check still schedules the later ones', async () => {
    const check = vi.fn()
      .mockRejectedValueOnce(new Error('github.com returned 504'))
      .mockResolvedValue(true)

    await scheduleChecks(check, 15 * MIN)
    expect(check).toHaveBeenCalledTimes(1)
    expect(logs).toEqual(['[relay:update] check failed: github.com returned 504 - retrying in 15 min'])

    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(check).toHaveBeenCalledTimes(2)
    expect(logs[1]).toBe(`[relay:update] check succeeded again - up to date (v${pkg.version})`)

    await vi.advanceTimersByTimeAsync(15 * MIN)
    expect(check).toHaveBeenCalledTimes(3)
    expect(logs).toHaveLength(2)
  })

  test('up to date is logged on the first check only', async () => {
    const check = vi.fn().mockResolvedValue(true)

    await scheduleChecks(check, 15 * MIN)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(check).toHaveBeenCalledTimes(3)
    expect(logs).toEqual([`[relay:update] up to date (v${pkg.version})`])
  })

  test('nothing extra is logged when an update was found', async () => {
    const check = vi.fn().mockResolvedValue(false)

    await scheduleChecks(check, 15 * MIN)
    expect(logs).toEqual([])
  })
})
