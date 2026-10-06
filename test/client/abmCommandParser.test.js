import { describe, test, expect } from 'vitest'
import { parseCommand } from '../../client/src/modules/abm/input/commandParser.js'

const idOf = (buffer) => parseCommand(buffer)?.command.id ?? null

describe('ABM parseCommand', () => {
  test('range rings: toggle, set, set with anchor', () => {
    expect(idOf('.rr')).toBe('RR_TOGGLE')
    expect(parseCommand('.rr 10').captures).toEqual({ dist: '10' })
    expect(parseCommand('.RR 10 BATUMI')).toMatchObject({ command: { id: 'RR_SET_ANCHOR' }, captures: { dist: '10', anchor: 'batumi' } })
  })

  test('unit system commands', () => {
    expect(idOf('.metric')).toBe('METRIC_UNITS')
    expect(idOf('.IMPERIAL')).toBe('IMPERIAL_UNITS')
    expect(idOf('.meters')).toBe(null)
  })

  test('draw commands detect the shape with or without arguments', () => {
    expect(idOf('.line')).toBe('LINE')
    expect(idOf('.text Hello World')).toBe('TEXT')
    expect(parseCommand('.circ 5').captures).toEqual({})
    // Shape names must be whole words.
    expect(idOf('.lines')).toBe(null)
  })

  test('.dclear: bare, all, then name as the catch-all', () => {
    expect(idOf('.dclear')).toBe('DCLEAR_BARE')
    expect(idOf('.dclear all')).toBe('DCLEAR_ALL')
    expect(parseCommand('.dclear cap north').captures).toEqual({ name: 'cap north' })
  })

  test('.focus: a bare number is the default range, not a callsign', () => {
    expect(parseCommand('.focus 50')).toMatchObject({ command: { id: 'FOCUS_DEFAULT_RANGE' }, captures: { dist: '50' } })
    expect(parseCommand('.focus viper11 30')).toMatchObject({ command: { id: 'FOCUS_OPEN_RANGE' }, captures: { callsign: 'viper11', dist: '30' } })
    expect(parseCommand('.focus viper11')).toMatchObject({ command: { id: 'FOCUS_OPEN' }, captures: { callsign: 'viper11' } })
  })

  test('.focus: a one-word coordinate parses like a callsign, with or without a range', () => {
    expect(parseCommand('.focus N24.43E54.66')).toMatchObject({ command: { id: 'FOCUS_OPEN' }, captures: { callsign: 'n24.43e54.66' } })
    expect(parseCommand('.focus 24.43N54.66E 30')).toMatchObject({ command: { id: 'FOCUS_OPEN_RANGE' }, captures: { callsign: '24.43n54.66e', dist: '30' } })
  })

  test('.tdm toggles top-down mode', () => {
    expect(idOf('.tdm')).toBe('TDM_TOGGLE')
    expect(idOf('.TDM')).toBe('TDM_TOGGLE')
    expect(idOf('.tdm on')).toBe(null)
  })

  test('history length and rate', () => {
    expect(idOf('.history')).toBe('HISTORY_TOGGLE')
    expect(idOf('.hist')).toBe('HISTORY_TOGGLE')
    expect(parseCommand('.hist 6 3')).toMatchObject({ command: { id: 'HISTORY_LEN_RATE' }, captures: { len: '6', rate: '3' } })
    expect(parseCommand('.hist 6')).toMatchObject({ command: { id: 'HISTORY_LEN' }, captures: { len: '6' } })
    expect(idOf('.histo')).toBe(null)
    expect(parseCommand('.history 10 2.5')).toMatchObject({ command: { id: 'HISTORY_LEN_RATE' }, captures: { len: '10', rate: '2.5' } })
    expect(parseCommand('.history 10')).toMatchObject({ command: { id: 'HISTORY_LEN' }, captures: { len: '10' } })
  })

  test('volume accepts 0-10 only', () => {
    expect(parseCommand('.vol 10').captures).toEqual({ n: '10' })
    expect(parseCommand('.vol 0').captures).toEqual({ n: '0' })
    expect(idOf('.vol 11')).toBe(null)
  })

  test('airspace categories and airway types', () => {
    expect(parseCommand('.classd').captures).toEqual({ cat: 'classd' })
    expect(idOf('.classh')).toBe(null)
    expect(parseCommand('.airways j').captures).toEqual({ type: 'j' })
  })

  test('.ll takes a length 0-7, .ld a direction 1-9', () => {
    expect(idOf('.ll')).toBe('LDR_LEN_SHOW')
    expect(parseCommand('.ll 3').captures).toEqual({ length: '3' })
    expect(idOf('.ll 8')).toBe(null)
    expect(parseCommand('.ld 9').captures).toEqual({ dir: '9' })
    expect(idOf('.ld 0')).toBe(null)
    expect(idOf('.ldr 3 9')).toBe(null)
  })

  test('aliases', () => {
    expect(idOf('.compass')).toBe('ROSE_TOGGLE')
    expect(idOf('.cust')).toBe('CUSTOM_TOGGLE')
    expect(idOf('.lbl')).toBe('LABELS_TOGGLE')
    expect(idOf('.airports')).toBe('AIRPORTS_TOGGLE')
  })

  test('acquisition and engagement declarations', () => {
    expect(parseCommand('.acq h').captures).toEqual({ letter: 'h' })
    expect(idOf('.eng')).toBe('ENG_TOGGLE')
  })
})
