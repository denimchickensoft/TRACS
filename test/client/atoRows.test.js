import { describe, it, expect, beforeEach, vi } from 'vitest'

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

const unit = (unitId, unitName, position) => ({ unitId, unitName, position })
const rmd = {
  flightId: 10, dcsGroupId: 10, groupName: 'RMD-1', coalition: 'blue', name: 'RMD1',
  units: [unit(101, 'RMD-1-1', 1), unit(102, 'RMD-1-2', 2), unit(103, 'RMD-1-3', 3), unit(104, 'RMD-1-4', 4)],
}
const player = (id, unitID, slot, nick) => ({ id, unitID, groupID: 10, callsign: slot, unitName: nick, human: true })

async function load(live) {
  const { useSessionStore } = await import('../../client/src/store/session.js')
  useSessionStore.setState({ sourceType: 'olympus', useDcsNames: true })
  const { buildFlightLinks } = await import('../../client/src/utils/flightLinks.js')
  const rows = await import('../../client/src/modules/abm/atoRows.js')
  return { ...rows, links: buildFlightLinks([rmd], live) }
}

describe('flightRows', () => {
  it('one row for a flight with no players', async () => {
    const { flightRows, links } = await load({})
    expect(flightRows(rmd, links)).toEqual([{ row: null, callsign: null, unitIndices: [0, 1, 2, 3] }])
  })

  it('a row per MP flight callsign, plus a base row for the rest', async () => {
    const { flightRows, selectedUnitIndices, links } = await load({
      1: player(1, 101, 'RMD-1-1', 'HAWK 1-1 | <a>'),
      2: player(2, 102, 'RMD-1-2', 'HAWK 1-2 | <b>'),
      3: player(3, 103, 'RMD-1-3', 'VIPER 2-2 | <c>'),
    })
    expect(flightRows(rmd, links)).toEqual([
      { row: 'HAWK1', callsign: 'HAWK1', unitIndices: [0, 1] },
      { row: 'VIPER2', callsign: 'VIPER2', unitIndices: [2] },
      { row: '', callsign: null, unitIndices: [3] },
    ])
    expect(selectedUnitIndices(rmd, links, '')).toEqual([3])
    // A row whose players left falls back to the whole flight.
    expect(selectedUnitIndices(rmd, links, 'COLT1')).toEqual([0, 1, 2, 3])
  })

  it('an AI unit linked by name keeps the base row', async () => {
    const { flightRows, links } = await load({
      1: { id: 1, unitID: 101, groupID: 10, callsign: 'RMD-1-1', unitName: 'RMD-1-1', human: false },
    })
    expect(flightRows(rmd, links)).toHaveLength(1)
  })
})

describe('rowOfLiveUnit', () => {
  it('a scope click opens the row the aircraft shows in', async () => {
    const { rowOfLiveUnit, links } = await load({
      1: player(1, 102, 'RMD-1-2', 'MALLET 3-1 | <a>'),
      2: { id: 2, unitID: 101, groupID: 10, callsign: 'RMD-1-1', unitName: 'RMD-1-1' },
    })
    expect(rowOfLiveUnit(rmd, links, 1)).toBe('MALLET3')
    expect(rowOfLiveUnit(rmd, links, 2)).toBe('')
    expect(rowOfLiveUnit(rmd, links, 99)).toBe(null)
  })

  it('null when the flight is a single row', async () => {
    const { rowOfLiveUnit, links } = await load({ 2: { id: 2, unitID: 101, groupID: 10, callsign: 'RMD-1-1', unitName: 'RMD-1-1' } })
    expect(rowOfLiveUnit(rmd, links, 2)).toBe(null)
  })
})
