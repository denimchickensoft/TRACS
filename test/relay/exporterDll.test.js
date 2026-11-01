import { describe, test, expect } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs tracs_exporter.dll in a real Lua 5.1.5 (built by
// `node relay/native/build.js --harness`) against a fake relay, to exercise
// its network thread and scheduler outside DCS. Skipped where the harness
// isn't built (anything but a Windows machine that built it).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HARNESS = path.join(ROOT, 'relay', 'native', 'build', 'harness')
const SCRIPT = path.join(ROOT, 'test', 'relay', 'fixtures', 'exporterHarness.lua')
const available = process.platform === 'win32' && fs.existsSync(path.join(HARNESS, 'lua.exe'))

const RUN_S = 11
const config = (logTimings) => ({
  type: 'config', v: 1, eventBufferSize: 50, logTimings,
  collectors: { fast: { rateSec: 1 }, failing: { rateSec: 5 } },
})

describe.skipIf(!available)('tracs_exporter.dll in a Lua harness', () => {
  test('hello, demand, data, timings, events, reconnect, clean exit', async () => {
    const conns = []
    const server = net.createServer((sock) => {
      const conn = { lines: [], beforeTimings: null }
      conns.push(conn)
      let buf = ''
      sock.setEncoding('utf8')
      sock.on('error', () => {})
      sock.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          conn.lines.push(JSON.parse(buf.slice(0, i)))
          buf = buf.slice(i + 1)
        }
      })
      const send = (msg) => sock.write(JSON.stringify(msg) + '\n')
      send(config(false))
      send({ type: 'demand', subscribers: 1 })
      if (conns.length === 1) {
        // Timings switch on mid-connection, then the relay drops the
        // connection and the hook has to come back on its own.
        setTimeout(() => {
          conn.beforeTimings = conn.lines.length
          send(config(true))
        }, 2500)
        setTimeout(() => sock.destroy(), 4500)
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    const proc = spawn(path.join(HARNESS, 'lua.exe'), [SCRIPT, String(port), String(RUN_S), HARNESS], { cwd: HARNESS })
    let out = ''
    proc.stdout.on('data', (d) => { out += d })
    proc.stderr.on('data', (d) => { out += d })
    const code = await new Promise((resolve) => proc.on('exit', resolve))
    await new Promise((resolve) => server.close(resolve))

    // A clean exit with the network thread running: the DLL unloads when
    // lua.exe closes its state.
    expect(code, out).toBe(0)
    expect(out).toContain('ABI 5')
    expect(out).toContain('UNKNOWN NATIVE no native collector named noSuchCollector')
    expect(out).toContain('DONE')
    expect(out).toMatch(/LOG INFO connected to relay on 127\.0\.0\.1:\d+/)
    expect(out).toMatch(/LOG INFO disconnected from relay \(relay closed the connection\)/)
    expect(out).toContain('LOG INFO relay has subscribers - collecting')
    expect(out).toMatch(/LOG ERROR collector failing failed: .*collector blew up/)

    expect(conns.length).toBeGreaterThanOrEqual(2)
    for (const c of conns) {
      expect(c.lines[0]).toMatchObject({
        type: 'hello', v: 1, side: 'server', multiplayer: true, theatre: 'Caucasus',
        collectors: ['fast', 'sliced', 'clientOnly', 'once', 'failing', 'exportStatus'],
        dll: { ok: true, version: 'test' },
      })
    }

    const [first, second] = conns
    const data = (c) => c.lines.filter((l) => l.type === 'data')
    const seqs = data(first).map((l) => l.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)

    const groups = conns.flatMap((c) => data(c).map((l) => l.group))
    expect(groups).toContain('fast')
    expect(groups).not.toContain('clientOnly')
    expect(groups).not.toContain('exportStatus')
    expect(groups.filter((g) => g === 'once')).toHaveLength(1)
    expect(data(first).find((l) => l.group === 'fast').data).toEqual({ n: 1 })

    const sliced = data(first).filter((l) => l.group === 'sliced').map((l) => l.kind)
    expect(sliced[0]).toBe('full')
    expect(sliced.slice(1)).toContain('delta')

    // Nothing timing-related until the relay asks for it.
    expect(first.beforeTimings).toBeGreaterThan(1)
    expect(first.lines.slice(0, first.beforeTimings).some((l) => l.type === 'timing')).toBe(false)
    const timings = first.lines.slice(first.beforeTimings).filter((l) => l.type === 'timing')
    expect(timings.some((l) => l.group === 'fast' && typeof l.ms === 'number')).toBe(true)
    expect(timings.some((l) => l.group === 'sliced' && l.extra === 7 && l.srvKb === 90)).toBe(true)
    expect(timings.some((l) => l.group === 'frames' && l.kind === 'second' && l.frames > 0)).toBe(true)
    // ...and nothing on the second connection, whose config has it off.
    expect(second.lines.some((l) => l.type === 'timing')).toBe(false)

    const events = first.lines.filter((l) => l.type === 'events').flatMap((l) => l.events)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]).toEqual({ id: expect.any(Number) })

    expect(data(second).some((l) => l.group === 'fast')).toBe(true)
  }, (RUN_S + 15) * 1000)
})
