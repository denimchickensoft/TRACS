import { describe, test, expect } from 'vitest'
import zlib from 'node:zlib'
import tacviewCore from '../../server/src/tacviewCore.js'

const { createParser, buildClientHandshake, UNIT_ID_OFFSET } = tacviewCore

const idFor = (hex) => String(parseInt(hex, 16) + UNIT_ID_OFFSET)
const EARTH_RADIUS_M = 6371008.8

describe('tacviewCore parser', () => {
  test('applies the reference point and maps a unit', () => {
    const p = createParser()
    const { updated, positions } = p.parseLines([
      'FileType=text/acmi/tacview',
      '0,ReferenceLongitude=40,ReferenceLatitude=42',
      '#0',
      'a1,T=1.5|0.25|3000,Type=Air+FixedWing,Name=F-16C,Pilot=VIPER11,Color=Blue,AGL=2500,Group=Viper',
    ])
    const unit = updated[idFor('a1')]
    expect(unit).toMatchObject({
      unitID: parseInt('a1', 16) + UNIT_ID_OFFSET,
      name: 'F-16C', unitName: 'VIPER11', groupID: 'Viper',
      coalition: 2, category: 'Aircraft', agl: 2500, airborne: true,
      position: { lat: 42.25, lng: 41.5, alt: 3000 },
    })
    expect(positions).toEqual([{ lat: 42.25, lng: 41.5, alt: 3000 }])
  })

  test('classifies object types', () => {
    const p = createParser()
    const { updated } = p.parseLines([
      '1,T=0|0|0,Type=Air+Rotorcraft',
      '2,T=0|0|0,Type=Ground+Vehicle',
      '3,T=0|0|0,Type=Sea+Watercraft',
      '4,T=0|0|0,Type=Weapon+Missile',
      '5,T=0|0|0,Type=Weapon+Bomb',
      '6,T=0|0|0,Type=Ground+Static+Building',
    ])
    expect(updated[idFor('1')].category).toBe('Helicopter')
    expect(updated[idFor('2')].category).toBe('GroundUnit')
    expect(updated[idFor('3')].category).toBe('NavyUnit')
    expect(updated[idFor('4')].category).toBe('Missile')
    expect(updated[idFor('5')]).toBeUndefined()
    expect(updated[idFor('6')]).toBeUndefined()
  })

  test('colors other than Blue/Red are neutral', () => {
    const p = createParser()
    const { updated } = p.parseLines(['1,T=0|0|0,Type=Air,Color=Red', '2,T=0|0|0,Type=Air,Color=Grey'])
    expect(updated[idFor('1')].coalition).toBe(1)
    expect(updated[idFor('2')].coalition).toBe(0)
  })

  test('keeps unchanged T= fields from earlier frames', () => {
    const p = createParser()
    p.parseLines(['1,T=10|20|500,Type=Air'])
    const { updated } = p.parseLines(['1,T=|21|'])
    expect(updated[idFor('1')].position).toEqual({ lat: 21, lng: 10, alt: 500 })
  })

  test('heading comes from the 9-field T= trailing slot, in radians', () => {
    const p = createParser()
    const { updated } = p.parseLines(['1,T=0|0|0|0|5|0|0|0|90,Type=Air'])
    expect(updated[idFor('1')].heading).toBeCloseTo(Math.PI / 2)
    expect(updated[idFor('1')].pitch).toBe(5)
  })

  test('falls back to HDM for heading', () => {
    const p = createParser()
    const { updated } = p.parseLines(['1,T=0|0|0,Type=Air,HDM=180'])
    expect(updated[idFor('1')].heading).toBeCloseTo(Math.PI)
  })

  test('splits properties only on unescaped commas', () => {
    const p = createParser()
    const { updated } = p.parseLines(['1,T=0|0|0,Type=Air,Name=Hello\\, World,Pilot=X'])
    expect(updated[idFor('1')]).toMatchObject({ name: 'Hello, World', unitName: 'X' })
  })

  test('derives groundspeed over at least 3 s of stream time', () => {
    const p = createParser()
    p.parseLines(['#0', '1,T=0|0|0,Type=Air'])
    // 1 s later: too soon to sample, no speed yet.
    let { updated } = p.parseLines(['#1', '1,T=0|0.01|0'])
    expect(updated[idFor('1')].speed).toBeUndefined()
    // 3 s after the first sample: 1 arc-minute of latitude north.
    ;({ updated } = p.parseLines(['#3', '1,T=0|0.0166666667|0']))
    const expected = EARTH_RADIUS_M * (0.0166666667 * Math.PI / 180) / 3
    expect(updated[idFor('1')].speed).toBeCloseTo(expected, 3)
  })

  test('reports removals only for objects it emitted', () => {
    const p = createParser()
    p.parseLines(['1,T=0|0|0,Type=Air', '2,T=0|0|0,Type=Weapon+Bomb'])
    const { removed } = p.parseLines(['-1', '-2'])
    expect(removed).toEqual([idFor('1')])
  })

  test('collects bullseyes by coalition instead of emitting them as units', () => {
    const p = createParser()
    const { updated, bullseyes } = p.parseLines([
      '0,ReferenceLongitude=40,ReferenceLatitude=42',
      '9,T=1|2|0,Type=Navaid+Static+Bullseye,Color=Blue',
    ])
    expect(updated).toEqual({})
    expect(bullseyes).toEqual({ bullseyes: { blue: { coalition: 'blue', latitude: 44, longitude: 41 } } })
  })

  test('mission time is ReferenceTime plus the stream offset', () => {
    const p = createParser()
    expect(p.getCurrentMissionUtcMs()).toBe(null)
    p.parseLines(['0,ReferenceTime=2011-06-25T09:30:00Z', '#90.5'])
    expect(p.getCurrentMissionUtcMs()).toBe(Date.parse('2011-06-25T09:30:00Z') + 90500)
  })

  test('ignores comments, headers and CRLF endings', () => {
    const p = createParser()
    const { updated } = p.parseLines(['// comment', 'FileVersion=2.2', '1,T=0|0|0,Type=Air\r'])
    expect(Object.keys(updated)).toEqual([idFor('1')])
  })
})

describe('tacviewCore buildClientHandshake', () => {
  const crcHex = (text) => zlib.crc32(Buffer.from(text, 'utf16le')).toString(16).padStart(8, '0')

  test('hashes the password as lowercase CRC-32 of its UTF-16LE text', () => {
    expect(buildClientHandshake('TRACS', 'secret'))
      .toBe(`XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nTRACS\n${crcHex('secret')}\0`)
  })

  test('hashes "0" when there is no password', () => {
    expect(buildClientHandshake('TRACS')).toBe(`XtraLib.Stream.0\nTacview.RealTimeTelemetry.0\nTRACS\n${crcHex('0')}\0`)
  })
})
