import { describe, test, expect } from 'vitest'
import { parseLua, extractWeather, findCarriersAndAircraft, findAtoFlights, templateGroupId, isStaticTemplateText, splitUnitName, splitFlightId } from '../../client/src/utils/parseMission.js'

describe('parseLua', () => {
  test('parses nested tables, strings, numbers, booleans and nil', () => {
    const src = `mission = {
      ["name"] = "Test \\"quoted\\"", -- a comment
      ["count"] = -1.5e2,
      flag = true, off = false, none = nil,
      ["nested"] = { ["a"] = 1 },
    }`
    expect(parseLua(src)).toEqual({
      name: 'Test "quoted"', count: -150, flag: true, off: false, none: null, nested: { a: 1 },
    })
  })

  test('positional entries (no key) are numbered from 1, as a multiplayer .trk writes trig.actions', () => {
    const src = `mission = {
      trig = {
        actions = {
          "a_do_script(\\"x = 1\\");",
          "a_end_mission(\\"blue\\");",
        },
        flags = { true, false, nil },
      },
    }`
    expect(parseLua(src)).toEqual({
      trig: {
        actions: ['a_do_script("x = 1");', 'a_end_mission("blue");'],
        flags: [true, false, null],
      },
    })
  })

  test('tables with only integer keys become sorted arrays', () => {
    expect(parseLua('m = { [2] = "b", [1] = "a", [3] = "c" }')).toEqual(['a', 'b', 'c'])
  })

  test('mixed keys stay an object', () => {
    expect(parseLua('m = { [1] = "a", ["x"] = "b" }')).toEqual({ 1: 'a', x: 'b' })
  })

  test('strips a UTF-8 byte-order mark', () => {
    expect(parseLua('﻿m = { ["a"] = 1 }')).toEqual({ a: 1 })
  })
})

describe('extractWeather', () => {
  test('QNH, visibility and a BKN/OVC preset ceiling', () => {
    const out = extractWeather({ weather: {
      qnh: 760, visibility: { distance: 80000 }, clouds: { preset: 'Preset10', base: 1000 },
    } })
    expect(out).toMatchObject({ qnh: '2992', vis: '10', clg: '033' })
  })

  test('FEW/SCT presets have no ceiling', () => {
    const out = extractWeather({ weather: { clouds: { preset: 'Preset3', base: 1000 } } })
    expect(out.clg).toBe('')
    expect(out.ceilingNote).toMatch(/no ceiling/)
  })

  test('legacy density weather: 5 and up is a ceiling', () => {
    expect(extractWeather({ weather: { clouds: { density: 6, base: 1500 } } }).clg).toBe('049')
    expect(extractWeather({ weather: { clouds: { density: 4, base: 1500 } } }).clg).toBe('')
  })

  test('surface wind turned from blowing-to into blowing-from', () => {
    expect(extractWeather({ weather: { wind: { atGround: { speed: 5, dir: 90 } } } }).wind)
      .toEqual({ fromDeg: 270, speedMs: 5 })
    expect(extractWeather({ weather: { wind: { atGround: { speed: 5, dir: 270 } } } }).wind.fromDeg).toBe(90)
    expect(extractWeather({ weather: {} }).wind).toBeNull()
  })

  test('unknown presets are flagged, not guessed', () => {
    const out = extractWeather({ weather: { clouds: { preset: 'Preset99', base: 1000 } } })
    expect(out.clg).toBe('')
    expect(out.ceilingNote).toMatch(/Unknown preset/)
  })

  test('no weather block', () => {
    expect(extractWeather({})).toBe(null)
  })
})

const mission = {
  theatre: 'NoSuchTheatre',
  coalition: {
    blue: { country: [{
      ship: { group: [{ units: [{ unitId: 100, type: 'CVN_71' }] }] },
      plane: { group: [
        {
          groupId: 1, name: 'Hornet 1', task: 'CAP', frequency: 251,
          route: { points: [
            { action: 'From Parking Area', linkUnit: 100, x: 0, y: 0 },
            { action: 'Turning Point', x: 1, y: 1, name: '' },
            { action: 'Landing', airdromeId: 22, x: 2, y: 2 },
          ] },
          units: [
            { unitId: 11, name: 'Hornet 1-1', type: 'FA-18C_hornet', onboard_num: '301', skill: 'Client',
              callsign: { name: 'Enfield11' }, payload: { fuel: 4900, pylons: [{ CLSID: 'X' }] } },
          ],
        },
        {
          groupId: 2, name: 'Tanker', task: 'Nothing', lateActivation: true,
          route: { points: [{ action: 'Turning Point', x: 0, y: 0 }] },
          units: [{ unitId: 21, name: 'Texaco 1-1', type: 'KC135MPRS' }],
        },
      ] },
    }] },
  },
}

describe('findCarriersAndAircraft', () => {
  test('finds carriers and the aircraft launching from them', () => {
    const { carriers, aircraft } = findCarriersAndAircraft(mission)
    expect(carriers).toEqual([{ unitId: 100, type: 'CVN_71', display: 'CVN-71 Theodore Roosevelt', abbrev: 'CV71' }])
    expect(aircraft).toEqual([{ carrierUnitId: 100, callsign: 'HORNET11', type: 'F18C', modex: '301', task: 'CAP', skill: 'Client' }])
  })

  test('no carriers means no aircraft', () => {
    expect(findCarriersAndAircraft({ coalition: {} })).toEqual({ carriers: [], aircraft: [] })
  })
})

describe('findAtoFlights', () => {
  test('lists every plane group with launch, recovery and units', () => {
    const [hornet, tanker] = findAtoFlights(mission)
    expect(hornet).toMatchObject({
      flightId: 1, dcsGroupId: 1, groupName: 'Hornet 1', coalition: 'blue', name: 'HORNET1', task: 'CAP', frequency: 251,
      launch:   { type: 'carrier', carrierUnitId: 100, carrierAbbrev: 'CV71' },
      recovery: { type: 'airbase', airdromeId: 22 },
    })
    expect(hornet.units[0]).toMatchObject({
      unitName: 'Hornet 1-1', position: 1, type: 'F18C', modex: '301',
      payload: { fuel: 4900, pylons: [{ station: 1, clsid: 'X' }] },
    })
    // An empty waypoint name means unnamed; no projection params means no lat/lng.
    expect(hornet.route[1]).toMatchObject({ name: null, lat: null, lng: null })
    expect(tanker).toMatchObject({
      task: 'NONE', rawTask: 'Nothing', lateActivation: true,
      launch: { type: 'airstart' }, recovery: { type: 'unknown' },
    })
  })
})

// A Mission Editor static template: one squadron's flights, saved on their
// own, with file-local group/unit IDs and the DCS callsign left at default.
const template = {
  name: 'EXERCISE_ALPHA_20260101',
  theatre: 'NoSuchTheatre',
  coalition: {
    blue: { country: [{ plane: { group: [{
      groupId: 1, name: 'VIPER 2', task: 'CAP',
      route: { points: [{ action: 'From Parking Area', airdromeId: 47, x: 0, y: 0 }] },
      units: [
        { unitId: 1, name: 'VIPER 2-1', type: 'F-5E-3', callsign: { name: 'Enfield11' } },
        { unitId: 2, name: 'VIPER 2-2', type: 'F-5E-3', callsign: { name: 'Enfield12' } },
      ],
    }] } }] },
    red: { country: [{ plane: { group: [{
      groupId: 1, name: 'VIPER 2', task: 'CAP',
      route: { points: [] },
      units: [{ unitId: 1, name: 'Bandit', type: 'MiG-29A', callsign: { name: 'Dodge11' } }],
    }] } }] },
  },
}

describe('findAtoFlights on a static template', () => {
  test('identifies flights by coalition + group name, not the file-local IDs', () => {
    const [blue, red] = findAtoFlights(template, { template: true })
    expect(blue).toMatchObject({ source: 'stm', templateName: 'EXERCISE_ALPHA_20260101', coalition: 'blue' })
    expect(blue.flightId).toBe(templateGroupId('blue', 'VIPER 2'))
    expect(blue.flightId).toBeGreaterThanOrEqual(1e9)
    expect(blue.flightId).toBeLessThan(2e9)
    expect(blue.dcsGroupId).toBe(null)
    expect(red.flightId).not.toBe(blue.flightId)
  })

  test('units keep their unit names, and unit IDs are dropped', () => {
    const [blue, red] = findAtoFlights(template, { template: true })
    expect(blue.name).toBe('VIPER2')
    expect(blue.units.map((u) => u.unitName)).toEqual(['VIPER 2-1', 'VIPER 2-2'])
    expect(blue.units.every((u) => u.unitId === null)).toBe(true)
    expect(red.name).toBe('BANDIT')
  })

  test('a mission is unchanged without the template option', () => {
    const [blue] = findAtoFlights(template)
    expect(blue).toMatchObject({ flightId: 1, dcsGroupId: 1 })
    expect(blue.source).toBeUndefined()
    expect(blue.units[0]).toMatchObject({ unitId: 1, unitName: 'VIPER 2-1' })
    expect(blue.units[0].callsign).toBeUndefined()
  })

  test('recognizes template text by its variable name', () => {
    expect(isStaticTemplateText('staticTemplate = \n{ }')).toBe(true)
    expect(isStaticTemplateText('﻿staticTemplate = { }')).toBe(true)
    expect(isStaticTemplateText('mission = { }')).toBe(false)
  })
})

describe('splitUnitName', () => {
  test.each([
    ['RMD-1-2', 'RMD-1', 2],
    ['Elvis5-1', 'Elvis5', 1],
    ['INC-10-3', 'INC-10', 3],
    ['KC-135MRPS 35Y 235Mhz TEX 1-1-1', 'KC-135MRPS 35Y 235Mhz TEX 1-1', 1],
    ['GKE_C130-1', 'GKE_C130', 1],
    ['Warden-1', 'Warden-1', null],
    ['VOLVO-1', 'VOLVO-1', null],
    ['F/A-18C Lot 20', 'F/A-18C Lot 20', null],
    ['  RAYAK ', 'RAYAK', null],
  ])('%s', (name, base, position) => {
    expect(splitUnitName(name)).toEqual({ base, position })
  })
})

describe('findAtoFlights flight split', () => {
  const unit = (unitId, name, type = 'FA-18C_hornet') => ({ unitId, name, type })
  const m = {
    theatre: 'NoSuchTheatre',
    coalition: {
      blue: { country: [{
        plane: { group: [
          { groupId: 5, name: 'North_CAP', task: 'CAP', route: { points: [] },
            units: [unit(51, 'ELVIS-5-1'), unit(52, 'ELVIS-5-2'), unit(53, 'HAWK-1-1'), unit(54, 'HAWK-1-2')] },
          { groupId: 6, name: 'Warden Flight', route: { points: [] }, units: [unit(61, 'Warden-1'), unit(62, 'Warden-2')] },
        ] },
        helicopter: { group: [
          { groupId: 7, name: 'VOLVO-1', route: { points: [] }, units: [unit(71, 'VOLVO-1', 'UH-60L')] },
        ] },
      }] },
    },
  }

  test('a group splits into flights by base unit name, with stable IDs', () => {
    const flights = findAtoFlights(m)
    const north = flights.filter((f) => f.dcsGroupId === 5)
    expect(north.map((f) => f.name)).toEqual(['ELVIS5', 'HAWK1'])
    expect(north.map((f) => f.units.map((u) => u.position))).toEqual([[1, 2], [1, 2]])
    expect(north[0].flightId).toBe(splitFlightId('blue', 5, 'ELVIS5'))
    expect(north[0].flightId).toBeGreaterThanOrEqual(2e9)
    expect(north[0].flightId).not.toBe(north[1].flightId)
    expect(north[0].groupName).toBe('North_CAP')
  })

  test('one-number names are single-ship flights', () => {
    const warden = findAtoFlights(m).filter((f) => f.dcsGroupId === 6)
    expect(warden.map((f) => f.name)).toEqual(['WARDEN1', 'WARDEN2'])
  })

  test('helicopter groups are listed', () => {
    const volvo = findAtoFlights(m).find((f) => f.dcsGroupId === 7)
    expect(volvo).toMatchObject({ flightId: 7, name: 'VOLVO1' })
  })
})

describe('findAtoFlights with numeric names', () => {
  // A server mission stored some unit names as bare Lua numbers
  // (`["name"] = -1`); parsing must not throw on them.
  test('treats number names as text', () => {
    const numeric = {
      coalition: { blue: { country: [{ plane: { group: [{
        groupId: 7, name: 12, task: 'CAP',
        route: { points: [{ name: 3, x: 0, y: 0, alt: 1000, type: 'Turning Point' }] },
        units: [{ unitId: 70, name: -1, type: 'F-15C' }, { unitId: 71, name: -2, type: 'F-15C' }],
      }] } }] } },
    }
    const flights = findAtoFlights(numeric)
    expect(flights.map((f) => f.units.map((u) => u.unitName))).toEqual([['-1'], ['-2']])
    expect(flights[0]).toMatchObject({ groupName: '12', dcsGroupName: '12' })
    expect(flights[0].route[0].name).toBe('3')
    expect(splitUnitName(5)).toEqual({ base: '5', position: null })
  })
})
