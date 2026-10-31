import { describe, test, expect } from 'vitest'
import { canonicalTheatre } from '../../client/src/utils/theatreName.js'
import { readMissionFile } from '../../client/src/utils/missionFile.js'

describe('canonicalTheatre', () => {
  test('translates the DCS names that differ from TRACS map keys', () => {
    expect(canonicalTheatre('GermanyCW')).toBe('Germany')
    expect(canonicalTheatre('Falklands')).toBe('SouthAtlantic')
    expect(canonicalTheatre('SinaiMap')).toBe('Sinai')
  })

  test('passes every other name through', () => {
    expect(canonicalTheatre('Caucasus')).toBe('Caucasus')
    expect(canonicalTheatre('Germany')).toBe('Germany')
    expect(canonicalTheatre(null)).toBe(null)
  })
})

describe('readMissionFile', () => {
  test('a static template is recognized and its theatre translated', async () => {
    const file = new File(['staticTemplate = { ["theatre"] = "GermanyCW", ["coalition"] = {} }'], 'flight.stm')
    const { kind, mission } = await readMissionFile(file)
    expect(kind).toBe('stm')
    expect(mission.theatre).toBe('Germany')
  })

  test('a bare mission file is not a template', async () => {
    const file = new File(['mission = { ["theatre"] = "Caucasus" }'], 'mission')
    expect(await readMissionFile(file)).toEqual({ kind: 'mission', mission: { theatre: 'Caucasus' } })
  })
})
