import { describe, test, expect } from 'vitest'
import exporterRelayClient from '../../server/src/exporterRelayClient.js'

const { toTracsUnit } = exporterRelayClient

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
})
