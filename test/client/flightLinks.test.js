import { describe, it, expect, beforeEach, vi } from 'vitest'

// The session store (read for the source type) touches localStorage and the
// window on load.
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

async function load(sourceType) {
  const { useSessionStore } = await import('../../client/src/store/session.js')
  useSessionStore.setState({ sourceType })
  return import('../../client/src/utils/flightLinks.js')
}

const unit = (unitId, unitName, position) => ({ unitId, unitName, position })
// Group RMD-1 (DCS ID 10), four slots; group VOLVO-1 (DCS ID 20), one AI.
const flights = [
  { flightId: 10, dcsGroupId: 10, groupName: 'RMD-1', coalition: 'blue', name: 'RMD1',
    units: [unit(101, 'RMD-1-1', 1), unit(102, 'RMD-1-2', 2), unit(103, 'RMD-1-3', 3), unit(104, 'RMD-1-4', 4)] },
  { flightId: 20, dcsGroupId: 20, groupName: 'VOLVO-1', coalition: 'blue', name: 'VOLVO1',
    units: [unit(201, 'VOLVO-1', null)] },
]

const linked = (links, flight, i) => links.live(flight, i)?.key ?? null

describe('buildFlightLinks', () => {
  it('Olympus / exporter host: numeric group ID, unit name in `callsign`', async () => {
    const { buildFlightLinks } = await load('olympus')
    const links = buildFlightLinks(flights, {
      // A player in RMD-1-2: unitName is the MP nickname, callsign the unit name.
      1: { id: 1, unitID: 102, groupID: 10, groupName: 'RMD-1', callsign: 'RMD-1-2', unitName: 'HAWK 1-2 | <player>', human: true },
      2: { id: 2, unitID: 201, groupID: 20, groupName: 'VOLVO-1', callsign: 'VOLVO-1', unitName: 'VOLVO-1' },
    })
    expect(linked(links, flights[0], 1)).toBe('1')
    expect(linked(links, flights[1], 0)).toBe('2')
    expect(links.flightOf('1')).toEqual({ flightId: 10, unitIndex: 1 })
  })

  it('exporter client: group name only, players placed by element digit', async () => {
    const { buildFlightLinks } = await load('exporter')
    const links = buildFlightLinks(flights, {
      // Runtime IDs, no numeric group ID; a player's name is the MP nickname.
      16790048: { id: 16790048, unitID: 16790048, groupName: 'RMD-1', callsign: 'HAWK 1-3 | <player>', unitName: 'HAWK 1-3 | <player>', human: true },
      16790049: { id: 16790049, unitID: 16790049, groupName: 'RMD-1', callsign: '<player2>', unitName: '<player2>', human: true },
      16790050: { id: 16790050, unitID: 16790050, groupName: 'VOLVO-1', callsign: 'VOLVO-1', unitName: 'VOLVO-1' },
    })
    expect(linked(links, flights[0], 2)).toBe('16790048') // HAWK 1-3 -> position 3
    expect(linked(links, flights[0], 0)).toBe('16790049') // no digit -> first free slot
    expect(linked(links, flights[1], 0)).toBe('16790050') // AI by unit name
  })

  it('Tacview: group name in `groupID`, AI by unit name in `unitName`', async () => {
    const { buildFlightLinks } = await load('tacview')
    const links = buildFlightLinks(flights, {
      9: { id: 9, unitID: 9, groupID: ' VOLVO-1 ', callsign: '', unitName: 'VOLVO-1' },
      8: { id: 8, unitID: 8, groupID: 'RMD-1', callsign: '', unitName: 'HAWK 1-1 | <player>' },
    })
    expect(linked(links, flights[1], 0)).toBe('9')
    expect(linked(links, flights[0], 0)).toBe('8')
  })

  it('a group name that trims to two groups links to none', async () => {
    const { buildFlightLinks } = await load('tacview')
    const twins = [
      { flightId: 1, dcsGroupId: 1, groupName: 'Tarawa UH-60L DAP', units: [unit(11, 'A', null)] },
      { flightId: 2, dcsGroupId: 2, groupName: 'Tarawa UH-60L DAP', units: [unit(21, 'B', null)] },
    ]
    const links = buildFlightLinks(twins, { 5: { id: 5, groupID: 'Tarawa UH-60L DAP', unitName: 'A' } })
    expect(links.flightOf('5')).toBe(null)
  })

  it('names that differ only by spaces: the exact name wins', async () => {
    const { buildFlightLinks } = await load('exporter')
    const slots = [
      { flightId: 1, groupName: 'Mozdok F-16', dcsGroupName: 'Mozdok F-16', units: [unit(null, 'A-1-1', 1)] },
      { flightId: 2, groupName: 'Mozdok F-16', dcsGroupName: 'Mozdok F-16 ', units: [unit(null, 'B-1-1', 1)] },
    ]
    const links = buildFlightLinks(slots, {
      5: { id: 5, groupName: 'Mozdok F-16 ', unitName: '<player>', human: true },
      6: { id: 6, groupName: 'Mozdok F-16', unitName: '<player2>', human: true },
    })
    expect(links.flightOf('5')).toEqual({ flightId: 2, unitIndex: 0 })
    expect(links.flightOf('6')).toEqual({ flightId: 1, unitIndex: 0 })
  })

  it('a missing human flag is not a player, even with a callsign-shaped name', async () => {
    const { buildFlightLinks } = await load('olympus')
    // AI whose name matches none of the group's units (a script rename).
    const links = buildFlightLinks(flights, { 7: { id: 7, groupID: 10, callsign: 'TRUMAN-1-1', unitName: 'TRUMAN-1-1' } })
    expect(links.flightOf('7')).toBe(null)
  })

  it('Tacview: an aircraft matching none of its group\'s unit names is the player', async () => {
    const { buildFlightLinks, isPlayerLink } = await load('tacview')
    const links = buildFlightLinks(flights, { 8: { id: 8, groupID: 'RMD-1', callsign: '', unitName: '<player>' } })
    expect(linked(links, flights[0], 0)).toBe('8')
    expect(isPlayerLink(links.live(flights[0], 0))).toBe(true)
  })

  it('exporter IDs are not trusted for the mission unit ID match unless the source says so', async () => {
    const { buildFlightLinks } = await load('tacview')
    // unitID 101 equals a mission unit ID by coincidence, in no known group.
    const links = buildFlightLinks(flights, { 5: { id: 5, unitID: 101, groupID: 'elsewhere', unitName: 'x' } })
    expect(links.flightOf('5')).toBe(null)
  })
})
