import { describe, test, expect } from 'vitest'
import exporterRelayClient from '../../server/src/exporterRelayClient.js'

const { toTracsUnit, toDateAndTime, hookPresenceIssue } = exporterRelayClient

const rec = {
  name: 'Aerial-1-1', type: 'F-16C_50', coalition: 2, groupId: 7, groupName: 'Aerial-1', category: 0,
  lat: 26.1, lon: 56.2, alt: 3000, agl: 2950, heading: -Math.PI / 2, pitch: Math.PI / 18,
  vx: 3, vy: 4, vz: 12, inAir: true, life: 50, life0: 100, callsign: 'Enfield11',
}

describe('toTracsUnit', () => {
  test('maps fields the way Olympus sends them', () => {
    const u = toTracsUnit('16777217', rec)
    expect(u).toMatchObject({
      id: 16777217, unitID: 16777217,
      name: 'F-16C_50', unitName: 'Aerial-1-1', callsign: 'Aerial-1-1',
      category: 'Aircraft', coalition: 2, groupID: 7, groupName: 'Aerial-1',
      position: { lat: 26.1, lng: 56.2, alt: 3000 }, agl: 2950,
      airborne: true, alive: true, human: false, health: 50,
    })
  })

  test('normalises heading to 0..2π and pitch to degrees', () => {
    const u = toTracsUnit('1', rec)
    expect(u.heading).toBeCloseTo(3 * Math.PI / 2)
    expect(u.pitch).toBeCloseTo(10)
  })

  test('derives speeds from the velocity vector', () => {
    const u = toTracsUnit('1', rec)
    expect(u.speed).toBeCloseTo(13)
    expect(u.horizontalVelocity).toBeCloseTo(Math.hypot(3, 12))
    expect(u.verticalVelocity).toBe(4)
  })

  test('a player is the unitName and makes the unit human', () => {
    const u = toTracsUnit('1', { ...rec, player: 'Pilot' })
    expect(u.unitName).toBe('Pilot')
    expect(u.callsign).toBe('Aerial-1-1')
    expect(u.human).toBe(true)
  })

  test('maps every tracked group category and drops the rest', () => {
    expect([0, 1, 2, 3].map((category) => toTracsUnit('1', { ...rec, category }).category))
      .toEqual(['Aircraft', 'Helicopter', 'GroundUnit', 'NavyUnit'])
    expect(toTracsUnit('1', { ...rec, category: 4 })).toBeNull()
    expect(toTracsUnit('1', null)).toBeNull()
  })

  test('life below 1 is dead; no life0 means no health', () => {
    const u = toTracsUnit('1', { ...rec, life: 0, life0: 0 })
    expect(u.alive).toBe(false)
    expect(u.health).toBeUndefined()
  })

  test('a client-side record: no life is alive, human flag, no health or group id', () => {
    const { life: _life, life0: _life0, groupId: _groupId, callsign: _callsign, ...client } = rec
    const u = toTracsUnit('1', { ...client, human: true })
    expect(u.alive).toBe(true)
    expect(u.human).toBe(true)
    expect(u.health).toBeUndefined()
    expect(u.groupID).toBeUndefined()
    expect(u.unitName).toBe('Aerial-1-1')
  })
})

describe('toDateAndTime', () => {
  const date = { Day: 15, Month: 6, Year: 2016 }

  test('splits absTime into the time of day on the start date', () => {
    expect(toDateAndTime({ date, absTime: 28800 + 1830 + 0.7, startTime: 28800 })).toEqual({
      date: { Day: 15, Month: 6, Year: 2016 },
      time: { h: 8, m: 30, s: 30 },
      startTime: 28800,
    })
  })

  test('rolls the date forward past midnight, across month and year ends', () => {
    expect(toDateAndTime({ date, absTime: 86400 + 3600 })).toMatchObject({
      date: { Day: 16, Month: 6, Year: 2016 }, time: { h: 1, m: 0, s: 0 },
    })
    expect(toDateAndTime({ date: { Day: 31, Month: 12, Year: 2016 }, absTime: 86400 * 2 + 59 })).toMatchObject({
      date: { Day: 2, Month: 1, Year: 2017 }, time: { h: 0, m: 0, s: 59 },
    })
  })

  test('null for a record it cannot use', () => {
    expect(toDateAndTime(null)).toBeNull()
    expect(toDateAndTime({ date, absTime: -1 })).toBeNull()
    expect(toDateAndTime({ date: { Day: 1, Month: 1 }, absTime: 0 })).toBeNull()
    expect(toDateAndTime({ absTime: 100 })).toBeNull()
  })
})

describe('hookPresenceIssue', () => {
  const failed = { theatre: 'Caucasus', dll: { ok: false, error: 'self-test failed: getPoint' } }

  test('a failed DLL is a DISCONNECTED issue carrying its error', () => {
    expect(hookPresenceIssue(failed, null))
      .toEqual({ retrying: false, reason: 'exporter_dll_failed', detail: 'self-test failed: getPoint' })
  })

  test('the same failure again changes nothing', () => {
    const current = hookPresenceIssue(failed, null)
    expect(hookPresenceIssue(failed, current)).toBeUndefined()
  })

  test('a working hook clears a DLL failure or a missing hook', () => {
    const ok = { dll: { ok: true } }
    expect(hookPresenceIssue(ok, hookPresenceIssue(failed, null))).toBeNull()
    expect(hookPresenceIssue(ok, { retrying: true, reason: 'exporter_no_hook' })).toBeNull()
  })

  test('a working hook leaves other issues alone', () => {
    expect(hookPresenceIssue({ dll: { ok: true } }, { retrying: false, reason: 'exporter_object_export_denied' })).toBeUndefined()
  })

  test('the hook going away replaces a DLL failure with no-hook', () => {
    expect(hookPresenceIssue(null, hookPresenceIssue(failed, null))).toEqual({ retrying: true, reason: 'exporter_no_hook' })
    expect(hookPresenceIssue(null, null)).toEqual({ retrying: true, reason: 'exporter_no_hook' })
  })
})

describe('mission data', () => {
  test('exporterMission is published once per mission and cleared when the hook goes', async () => {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: 0 })
    const port = wss.address().port
    const seen = []
    const done = new Promise((resolve) => {
      wss.on('connection', (sock) => {
        sock.once('message', () => {
          const mission = { id: 'abc', theatre: 'Caucasus', text: 'mission = {}' }
          sock.send(JSON.stringify({ type: 'exporterMission', mission }))
          sock.send(JSON.stringify({ type: 'exporterMission', mission }))
          sock.send(JSON.stringify({ type: 'exporterReset' }))
          setTimeout(resolve, 100)
        })
      })
    })
    exporterRelayClient.start({ relayUrl: `ws://127.0.0.1:${port}`, password: 'x', coalition: 'blue' }, {
      onMissionData: (m) => seen.push(m && { id: m.id, theatre: m.theatre, text: m.text }),
    })
    try {
      await done
      // The repeated message for the same mission is not passed on again.
      expect(seen).toEqual([{ id: 'abc', theatre: 'Caucasus', text: 'mission = {}' }, null])
    } finally {
      exporterRelayClient.stop()
      wss.close()
    }
  })

  test('a missing multiplayer track is passed on once, then replaced by the mission', async () => {
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: 0 })
    const port = wss.address().port
    const seen = []
    const done = new Promise((resolve) => {
      wss.on('connection', (sock) => {
        sock.once('message', () => {
          sock.send(JSON.stringify({ type: 'exporterMission', mission: { unavailable: 'no_track' } }))
          sock.send(JSON.stringify({ type: 'exporterMission', mission: { unavailable: 'no_track' } }))
          sock.send(JSON.stringify({ type: 'exporterMission', mission: { id: 'abc', theatre: 'Caucasus', text: 'mission = {}' } }))
          setTimeout(resolve, 100)
        })
      })
    })
    exporterRelayClient.start({ relayUrl: `ws://127.0.0.1:${port}`, password: 'x', coalition: 'blue' }, {
      onMissionData: (m) => seen.push(m),
    })
    try {
      await done
      expect(seen).toEqual([{ unavailable: 'no_track' }, { id: 'abc', theatre: 'Caucasus', text: 'mission = {}' }])
    } finally {
      exporterRelayClient.stop()
      wss.close()
    }
  })
})
