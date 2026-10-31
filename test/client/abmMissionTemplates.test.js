import { describe, it, expect, beforeEach, vi } from 'vitest'

// The store reads/writes localStorage on load and on every change, and the
// stores it imports read the window's URL.
beforeEach(() => {
  globalThis.window = { location: { search: '' }, addEventListener: () => {} }
  const mem = new Map()
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  }
  vi.resetModules()
})

const flight = (groupId, extra = {}) => ({ groupId, name: `G${groupId}`, units: [], route: [], ...extra })
const stm = (groupId, callsign, extra = {}) => flight(groupId, { source: 'stm', units: [{ callsign, unitId: null }], ...extra })

async function store() {
  const { useAbmMissionStore } = await import('../../client/src/store/abmMission.js')
  return useAbmMissionStore
}

describe('ABM static-template flights', () => {
  it('stack across loads and replace by groupId', async () => {
    const s = await store()
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41', { name: 'old' })])
    s.getState().mergeTemplateFlights([stm(1000000002, 'MARMOT11')])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41', { name: 'new' })])
    const ids = s.getState().flights.map((f) => [f.groupId, f.name])
    expect(ids).toEqual([[1000000002, 'G1000000002'], [1000000001, 'new']])
  })

  it('survive a .miz load, which replaces only the previous .miz flights', async () => {
    const s = await store()
    s.getState().setFlights([flight(1), flight(2)])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41')])
    s.getState().setFlights([flight(3)])
    expect(s.getState().flights.map((f) => f.groupId).sort()).toEqual([1000000001, 3])
  })

  it('are cleared by Clear Mission', async () => {
    const s = await store()
    s.getState().setFlights([flight(1)])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41')])
    s.getState().clearFlights()
    expect(s.getState().flights).toEqual([])
  })

  it('match a live Olympus unit by callsign when its numeric groupID matches nothing', async () => {
    const s = await store()
    s.getState().setFlights([flight(7, { units: [{ callsign: 'COLT11', unitId: 70 }] })])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41')])
    const resolve = (unit) => s.getState().resolveGroupIdForUnit({ id: 99, ...unit })
    expect(resolve({ groupID: 7, callsign: 'GUSTO41' })).toBe(7)
    expect(resolve({ groupID: 12, callsign: 'GUSTO41' })).toBe(1000000001)
    // A .miz flight keeps matching only by its numeric ID.
    expect(resolve({ groupID: 12, callsign: 'COLT11' })).toBe(12)
  })
})
