import { describe, test, expect } from 'vitest'
import { buildMetar } from '../../client/src/utils/metar.js'

const airfield = { elevationM: 10, qnhHpa: 1013.2, tempC: 15.2, wind: { fromDeg: 244, speedMs: 6.17 } }
const utc = { day: 29, h: 14, m: 5 }

describe('buildMetar', () => {
  test('preset clouds shifted by the mission base, dew point from the lowest layer', () => {
    const weather = {
      mission: { visibility: { distance: 80000 }, clouds: { preset: 'Preset3', base: 1000 } },
      cloudPreset: { precipitationPower: -1, layers: [
        { altitudeMin: 2500, coverage: 0.45 },
        { altitudeMin: 6500, coverage: 0.2 },
        { altitudeMin: 9000, coverage: 0 },
      ] },
    }
    // Layers at 1000 m and 5000 m MSL; lowest 990 m AGL -> spread ~7.9 C.
    expect(buildMetar({ icao: 'UGSB', airfield, weather, utc }))
      .toBe('METAR UGSB 291405Z 24012KT 9999 SCT032 FEW160 15/07 Q1013')
  })

  test('US-style field: statute miles, inches, CLR, ME base for dew point', () => {
    const weather = { mission: { visibility: { distance: 80000 }, clouds: { density: 0, base: 1260 } } }
    expect(buildMetar({ icao: 'KLSV', airfield: { ...airfield, elevationM: 0 }, weather, utc }))
      .toBe('METAR KLSV 291405Z 24012KT 10SM CLR 15/05 A2992')
  })

  test('fog sets visibility and dew point; legacy rain', () => {
    const weather = {
      mission: { visibility: { distance: 80000 }, clouds: { density: 8, base: 300, iprecptns: 1 } },
      fog: { visibility: 600, thickness: 200 },
    }
    expect(buildMetar({ icao: 'UGSB', airfield, weather, utc }))
      .toBe('METAR UGSB 291405Z 24012KT 0600 RA FG BKN010 15/15 Q1013')
  })

  test('calm, negative temperatures, no airfield sample', () => {
    const weather = { mission: { visibility: { distance: 4000 }, clouds: { density: 0, base: 500 } } }
    const cold = { elevationM: 0, qnhHpa: 1020, tempC: -3, wind: { fromDeg: 0, speedMs: 0 } }
    expect(buildMetar({ icao: 'UGSB', airfield: cold, weather, utc }))
      .toBe('METAR UGSB 291405Z 00000KT 4000 NSC M03/M07 Q1020')
    expect(buildMetar({ icao: 'UGSB', airfield: null, weather, utc })).toBeNull()
  })
})
