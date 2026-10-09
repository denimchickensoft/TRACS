import { describe, test, expect, afterEach } from 'vitest'
import net from 'node:net'
import tacview from '../../server/src/tacview.js'
import tacviewCore from '../../server/src/tacviewCore.js'

const { UNIT_ID_OFFSET } = tacviewCore
const idFor = (hex) => String(parseInt(hex, 16) + UNIT_ID_OFFSET)

const ACMI = [
  'FileType=text/acmi/tacview',
  'FileVersion=2.2',
  '0,ReferenceLongitude=50,ReferenceLatitude=25',
  '#0',
  '1603,T=5|1|3000,Type=Air+FixedWing,Name=F-15ESE,Pilot=Pilotname,Color=Blue,AGL=2500',
  '#1',
  '1603,T=5.01|1|3000',
  '',
].join('\n')

// A fake Tacview RTT server: greets, waits for the client handshake, sends
// one session's telemetry, then ends the session by closing the socket.
function fakeTacview() {
  const server = net.createServer((sock) => {
    sock.write('XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nHost\n\0')
    sock.once('data', () => {
      sock.write(ACMI)
      setTimeout(() => sock.end(), 1500)
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

let server = null
afterEach(() => {
  tacview.stop()
  server?.close()
  server = null
})

describe('tacview reconnect', () => {
  test("a closed session's units are removed instead of left as ghosts", async () => {
    server = await fakeTacview()
    const deltas = []
    const removedOnClose = new Promise((resolve) => {
      tacview.start({ olympusUrl: `http://127.0.0.1:${server.address().port}`, coalition: 'admin' }, {
        onUnitsDelta: (delta) => {
          deltas.push(delta)
          if (delta.removed.length) resolve(delta)
        },
      })
    })

    const removal = await removedOnClose
    expect(deltas.some((d) => d.updated[idFor('1603')]?.unitName === 'Pilotname')).toBe(true)
    expect(removal.removed).toEqual([idFor('1603')])
  }, 10000)
})
