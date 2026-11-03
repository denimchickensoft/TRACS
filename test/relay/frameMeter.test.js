import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createFrameMeter } = require('../../relay/frameMeter.js')

const second = (t) => ({ type: 'timing', group: 'frames', kind: 'second', t, frames: 3, ms: 17, maxMs: 18, frameMs: [16.5, 17, 18] })
const meterFiles = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('frame-meter-')).sort()
const dirBytes = (dir) => meterFiles(dir).reduce((sum, n) => sum + fs.statSync(path.join(dir, n)).size, 0)
const flush = (meter) => new Promise((resolve) => { meter.stop(); setTimeout(resolve, 50) })

describe('frame meter', () => {
  let dir
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracs-frame-meter-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('writes a mission line, then one line per second with frame times', async () => {
    const meter = createFrameMeter(dir)
    meter.start({ theatre: 'Caucasus', side: 'server', missionFile: 'x.miz' })
    meter.record(second(1))
    meter.record({ type: 'timing', group: 'frames', kind: 'slow', ms: 40 })
    meter.record({ type: 'timing', group: 'units', ms: 1 })
    await flush(meter)
    const [name] = meterFiles(dir)
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0].mission).toMatchObject({ theatre: 'Caucasus', side: 'server', missionFile: 'x.miz' })
    expect(lines[1]).toMatchObject({ t: 1, frameMs: [16.5, 17, 18] })
    expect(lines[1].type).toBeUndefined()
  })

  test('deletes the oldest files to stay under the cap, leaving other files alone', async () => {
    fs.writeFileSync(path.join(dir, 'frame-meter-20260101-000000.jsonl'), 'x'.repeat(600))
    fs.writeFileSync(path.join(dir, 'frame-meter-20260102-000000.jsonl'), 'x'.repeat(600))
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'.repeat(5000))
    const meter = createFrameMeter(dir, { maxBytes: 1500 })
    meter.start({ side: 'server' })
    for (let t = 0; t < 5; t++) meter.record(second(t))
    await flush(meter)
    const names = meterFiles(dir)
    expect(names).not.toContain('frame-meter-20260101-000000.jsonl')
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
    expect(dirBytes(dir)).toBeLessThanOrEqual(1500)
  })

  test('stops recording a mission once its own file reaches the cap', async () => {
    const meter = createFrameMeter(dir, { maxBytes: 600 })
    meter.start({ side: 'server' })
    for (let t = 0; t < 50; t++) meter.record(second(t))
    await flush(meter)
    const [name] = meterFiles(dir)
    const size = fs.statSync(path.join(dir, name)).size
    expect(size).toBeLessThan(600 + 200)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
