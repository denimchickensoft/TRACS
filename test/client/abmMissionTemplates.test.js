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

const flight = (flightId, extra = {}) => ({ flightId, name: `G${flightId}`, units: [], route: [], ...extra })
const stm = (flightId, unitName, extra = {}) => flight(flightId, { source: 'stm', units: [{ unitName, unitId: null }], ...extra })

async function store() {
  const { useAbmMissionStore } = await import('../../client/src/store/abmMission.js')
  return useAbmMissionStore
}

describe('ABM static-template flights', () => {
  it('stack across loads and replace by flightId', async () => {
    const s = await store()
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41', { name: 'old' })])
    s.getState().mergeTemplateFlights([stm(1000000002, 'MARMOT11')])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41', { name: 'new' })])
    const ids = s.getState().flights.map((f) => [f.flightId, f.name])
    expect(ids).toEqual([[1000000002, 'G1000000002'], [1000000001, 'new']])
  })

  it('survive a .miz load, which replaces only the previous .miz flights', async () => {
    const s = await store()
    s.getState().setFlights([flight(1), flight(2)])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41')])
    s.getState().setFlights([flight(3)])
    expect(s.getState().flights.map((f) => f.flightId).sort()).toEqual([1000000001, 3])
  })

  it('are cleared by Clear Mission', async () => {
    const s = await store()
    s.getState().setFlights([flight(1)])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41')])
    s.getState().clearFlights()
    expect(s.getState().flights).toEqual([])
  })

  it('link a live unit by group name and unit name when no numeric group ID matches', async () => {
    const s = await store()
    const { useUnitsStore } = await import('../../client/src/store/units.js')
    s.getState().setFlights([flight(7, { dcsGroupId: 7, groupName: 'COLT', units: [{ unitName: 'COLT-1-1', unitId: 70 }] })])
    s.getState().mergeTemplateFlights([stm(1000000001, 'GUSTO41', { dcsGroupId: null, groupName: 'GUSTO 4', coalition: 'blue', units: [{ unitName: 'GUSTO-4-1', unitId: null }] })])
    const live = {
      1: { id: 1, groupID: 7, callsign: 'COLT-1-1' },
      2: { id: 2, groupID: 12, groupName: 'GUSTO 4', callsign: 'GUSTO-4-1' },
      3: { id: 3, groupID: 12, groupName: 'nowhere', callsign: 'COLT-1-1' },
    }
    useUnitsStore.setState({ units: live })
    const resolve = (id) => s.getState().resolveFlightIdForUnit(live[id])
    expect(resolve(1)).toBe(7)
    expect(resolve(2)).toBe(1000000001)
    expect(resolve(3)).toBe(null)
  })
})
