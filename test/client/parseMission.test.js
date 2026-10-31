import { describe, test, expect } from 'vitest'
import { parseLua, extractWeather, findCarriersAndAircraft, findAtoFlights, templateGroupId, isStaticTemplateText } from '../../client/src/utils/parseMission.js'

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
      groupId: 1, coalition: 'blue', name: 'Hornet 1', task: 'CAP', frequency: 251,
      launch:   { type: 'carrier', carrierUnitId: 100, carrierAbbrev: 'CV71' },
      recovery: { type: 'airbase', airdromeId: 22 },
    })
    expect(hornet.units[0]).toMatchObject({
      callsign: 'Enfield11', type: 'F18C', modex: '301',
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
        { unitId: 1, name: 'Sqn-1 F-5E VIPER 2-1', type: 'F-5E-3', callsign: { name: 'Enfield11' } },
        { unitId: 2, name: 'VIPER 2-2 | Pilot', type: 'F-5E-3', callsign: { name: 'Enfield12' } },
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
    expect(blue.groupId).toBe(templateGroupId('blue', 'VIPER 2'))
    expect(blue.groupId).toBeGreaterThanOrEqual(1e9)
    expect(blue.groupId).toBeLessThan(2e9)
    expect(red.groupId).not.toBe(blue.groupId)
    expect(templateGroupId('blue', 'VIPER 2')).toBe(blue.groupId)
  })

  test('callsigns come from the unit name, and unit IDs are dropped', () => {
    const [blue, red] = findAtoFlights(template, { template: true })
    expect(blue.units.map((u) => u.callsign)).toEqual(['VIPER21', 'VIPER22'])
    expect(blue.units.every((u) => u.unitId === null)).toBe(true)
    // No callsign-shaped part: keeps the name as written.
    expect(red.units[0].callsign).toBe('BANDIT')
  })

  test('a mission is unchanged without the template option', () => {
    const [blue] = findAtoFlights(template)
    expect(blue).toMatchObject({ groupId: 1 })
    expect(blue.source).toBeUndefined()
    expect(blue.units[0]).toMatchObject({ unitId: 1, callsign: 'Enfield11' })
  })

  test('recognizes template text by its variable name', () => {
    expect(isStaticTemplateText('staticTemplate = \n{ }')).toBe(true)
    expect(isStaticTemplateText('﻿staticTemplate = { }')).toBe(true)
    expect(isStaticTemplateText('mission = { }')).toBe(false)
  })
})
