import { describe, it, expect, beforeEach, vi } from 'vitest'

// callsign.js pulls in stores that touch localStorage and the window on load.
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

const load = () => import('../../client/src/modules/atc/stars/stca/formations.js')

describe('computeWingmanIds', () => {
  it('groups by numeric groupID', async () => {
    const { computeWingmanIds } = await load()
    const units = {
      1: { id: 1, unitID: 1, groupID: 7, callsign: 'Enfield 1-1' },
      2: { id: 2, unitID: 2, groupID: 7, callsign: 'Enfield 1-2' },
    }
    expect([...computeWingmanIds(units, {})]).toEqual(['2'])
  })

  it('falls back to groupName when the source sends no groupID (exporter client-side hook)', async () => {
    const { computeWingmanIds } = await load()
    const units = {
      16777300: { id: 16777300, groupName: 'Enfield', callsign: 'Enfield 1-1', unitName: 'Enfield 1-1' },
      16777301: { id: 16777301, groupName: 'Enfield', callsign: 'Enfield 1-2', unitName: 'Enfield 1-2' },
      16777302: { id: 16777302, groupName: 'Other', callsign: 'Colt 1-1', unitName: 'Colt 1-1' },
    }
    expect([...computeWingmanIds(units, {})]).toEqual(['16777301'])
  })

  it('picks the lowest live id as lead when there is no unitID or element digit', async () => {
    const { computeWingmanIds } = await load()
    const units = {
      20: { id: 20, groupName: 'Pkg', callsign: 'Alpha', unitName: 'Alpha' },
      10: { id: 10, groupName: 'Pkg', callsign: 'Bravo', unitName: 'Bravo' },
    }
    expect([...computeWingmanIds(units, {})]).toEqual(['20'])
  })

  it('never makes an owned track a wingman', async () => {
    const { computeWingmanIds } = await load()
    const units = {
      1: { id: 1, groupName: 'G', callsign: 'Enfield 1-1' },
      2: { id: 2, groupName: 'G', callsign: 'Enfield 1-2' },
    }
    expect(computeWingmanIds(units, { 2: 'A' }).size).toBe(0)
  })
})
