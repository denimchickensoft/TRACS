import { describe, test, expect } from 'vitest'
import { parseCommand } from '../../client/src/modules/abm/input/commandParser.js'

const idOf = (buffer) => parseCommand(buffer)?.command.id ?? null

describe('ABM parseCommand', () => {
  test('range rings: toggle, set, set with anchor', () => {
    expect(idOf('.rr')).toBe('RR_TOGGLE')
    expect(parseCommand('.rr 10').captures).toEqual({ nm: '10' })
    expect(parseCommand('.RR 10 BATUMI')).toMatchObject({ command: { id: 'RR_SET_ANCHOR' }, captures: { nm: '10', anchor: 'batumi' } })
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
    expect(parseCommand('.focus 50')).toMatchObject({ command: { id: 'FOCUS_DEFAULT_RANGE' }, captures: { nm: '50' } })
    expect(parseCommand('.focus viper11 30')).toMatchObject({ command: { id: 'FOCUS_OPEN_RANGE' }, captures: { callsign: 'viper11', nm: '30' } })
    expect(parseCommand('.focus viper11')).toMatchObject({ command: { id: 'FOCUS_OPEN' }, captures: { callsign: 'viper11' } })
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

  test('.ldr takes a length 0-7 and a direction 1-9', () => {
    expect(parseCommand('.ldr 3 9').captures).toEqual({ length: '3', dir: '9' })
    expect(idOf('.ldr 8 9')).toBe(null)
  })

  test('aliases', () => {
    expect(idOf('.compass')).toBe('ROSE_TOGGLE')
    expect(idOf('.cust')).toBe('CUSTOM_TOGGLE')
    expect(idOf('.lbl')).toBe('LABELS_TOGGLE')
  })

  test('acquisition and engagement declarations', () => {
    expect(parseCommand('.acq h').captures).toEqual({ letter: 'h' })
    expect(idOf('.eng')).toBe('ENG_TOGGLE')
  })
})
