import { describe, test, expect } from 'vitest'
import { parseCommand, looksLikeKnownCommand } from '../../client/src/modules/atc/stars/input/commandParser.js'

const idOf = (buffer, trigger, hasToken) => parseCommand(buffer, trigger, hasToken)?.command.id ?? null

// A buffer whose first word was entered by its function key (HO, MF, ...),
// as the preview store records it.
const keyed = (buffer, trigger) => parseCommand(buffer, trigger, true, buffer.trim().split(' ')[0].toUpperCase())
const keyedId = (buffer, trigger) => keyed(buffer, trigger)?.command.id ?? null

describe('STARS parseCommand', () => {
  test('trims and uppercases the buffer', () => {
    expect(idOf('  rg 40 ', 'ENTER')).toBe('SET_RANGE')
    expect(parseCommand('rg 40', 'ENTER').captures).toEqual({ range: '40' })
  })

  test('unit system commands', () => {
    expect(idOf('.metric', 'ENTER')).toBe('METRIC_UNITS')
    expect(idOf('.IMPERIAL', 'ENTER')).toBe('IMPERIAL_UNITS')
  })

  test('trigger decides between commands that share a pattern', () => {
    expect(keyedId('MF TS', 'ENTER')).toBe('TOGGLE_SIGNON')
    expect(keyedId('MF TS', 'SLEW')).toBe('RELOCATE_SIGNON')
    expect(keyedId('MIN', 'SLEW')).toBe('MIN_INIT')
    expect(keyedId('MIN', 'ENTER')).toBe('MIN_CLEAR')
  })

  test('resize patterns win over the bare toggles they extend', () => {
    expect(keyed('MF T5', 'ENTER')).toMatchObject({ command: { id: 'RESIZE_TAB' }, captures: { lines: '5' } })
    expect(keyedId('MF T', 'ENTER')).toBe('TOGGLE_TAB')
    expect(keyed('MF TC12', 'ENTER').captures).toEqual({ lines: '12' })
  })

  test('SSA ATIS/GI variants resolve in the documented order', () => {
    expect(keyed('MF S2 RWY 27 CLOSED', 'ENTER')).toMatchObject({ command: { id: 'SET_GI_AUX' }, captures: { line: '2', text: 'RWY 27 CLOSED' } })
    expect(keyedId('MF S2', 'ENTER')).toBe('CLEAR_GI_AUX')
    expect(keyedId('MF S*', 'ENTER')).toBe('CLEAR_ATIS')
    expect(keyedId('MF SA*', 'ENTER')).toBe('SET_ATIS_CLEAR_GI')
    expect(keyed('MF SB WIND 270', 'ENTER').captures).toEqual({ atis: 'B', giText: 'WIND 270' })
    expect(keyedId('MF SC', 'ENTER')).toBe('SET_ATIS')
  })

  test('MF M: temp altitude, scratchpads, beacon and requested altitude', () => {
    expect(keyed('MF MΔ120', 'SLEW')).toMatchObject({ command: { id: 'MF_M_TEMP_ALT' }, captures: { alt: '120' } })
    expect(keyed('MF MΔAB', 'SLEW')).toMatchObject({ command: { id: 'MF_M_SP1' }, captures: { sp: 'AB' } })
    expect(keyed('MF M+XY', 'SLEW')).toMatchObject({ command: { id: 'MF_M_SP2' }, captures: { sp: 'XY' } })
    expect(keyed('MF M1234', 'SLEW')).toMatchObject({ command: { id: 'SET_BEACON' }, captures: { bcn: '1234' } })
    // 8 isn't an octal digit, so a 4-digit code with an 8 isn't a beacon.
    expect(keyedId('MF M1238', 'SLEW')).toBe(null)
    expect(keyed('MF M120', 'SLEW')).toMatchObject({ command: { id: 'MF_M_REQ_ALT' }, captures: { alt: '120' } })
    expect(keyed('MF MAAL1 4321', 'ENTER').captures).toEqual({ flid: 'AAL1', bcn: '4321' })
  })

  test('leader direction: global, MF and context-free shorthand', () => {
    expect(keyed('MF L33', 'SLEW')).toMatchObject({ command: { id: 'SET_LEADER_GLOBAL' }, captures: { dir: '3' } })
    expect(keyedId('MF L3', 'SLEW')).toBe('SET_LEADER_MF')
    expect(keyedId('MF L34', 'SLEW')).toBe(null)
    expect(idOf('7', 'SLEW')).toBe('SET_LEADER_SHORT')
    expect(idOf('LD 3', 'ENTER')).toBe('SET_LEADER_LEN')
    // A known verb with a bad argument falls through to the implied flight
    // plan, whose action rejects verbs as names and answers FORMAT.
    expect(parseCommand('LD 8', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_IMPLIED' }, captures: { aid: 'LD' } })
  })

  test('handoffs', () => {
    expect(keyedId('HO', 'ENTER')).toBe('HND_OFF_ACCEPT_NEAR')
    expect(keyedId('HO', 'SLEW')).toBe('HND_OFF_BARE')
    expect(keyed('HO 2A', 'SLEW').captures).toEqual({ tcp: '2A' })
    expect(keyed('HO 2A AAL1', 'ENTER')).toMatchObject({ command: { id: 'HND_OFF_BY_ID' }, captures: { tcp: '2A', flid: 'AAL1' } })
    expect(idOf('2A', 'SLEW')).toBe('HND_OFF_SHORT')
  })

  test('context-free shorthand is disabled once a function-key token is in the buffer', () => {
    expect(idOf('2A', 'SLEW', true)).toBe(null)
    expect(idOf('7', 'SLEW', true)).toBe(null)
    expect(idOf('AAL1 B738', 'ENTER', true)).toBe(null)
    // Non-shorthand commands are unaffected.
    expect(keyedId('HO 2A', 'SLEW')).toBe('HND_OFF')
  })

  test('point-outs and quick look', () => {
    expect(parseCommand('2A*', 'SLEW')).toMatchObject({ command: { id: 'POINT_OUT' }, captures: { tcp: '2A' } })
    expect(idOf('**', 'SLEW')).toBe('CONVERT_POINT_OUT')
    expect(idOf('UN', 'SLEW')).toBe('REJECT_POINT_OUT')
    expect(idOf('**2A', 'SLEW')).toBe('QUICK_LOOK_TCP')
  })

  test('track control', () => {
    expect(keyedId('IC', 'SLEW')).toBe('INIT_CNTL')
    expect(keyed('IC AAL1', 'ENTER').captures).toEqual({ flid: 'AAL1' })
    expect(keyedId('TC ALL', 'ENTER')).toBe('TERM_CNTL_ALL')
    expect(idOf('.DROPALL', 'ENTER')).toBe('TERM_CNTL_ALL')
    expect(keyedId('TC AAL1', 'ENTER')).toBe('TERM_CNTL_BY_ID')
    expect(keyedId('TC', 'SLEW')).toBe('TERM_CNTL')
    expect(idOf('.FORCEDROP', 'SLEW')).toBe('FORCE_DROP')
    expect(idOf('.FORCEDROP ALL', 'ENTER')).toBe('FORCE_DROP_ALL')
  })

  test('scratchpad and altitude shorthand', () => {
    expect(parseCommand('ABC', 'SLEW')).toMatchObject({ command: { id: 'SET_SP1' }, captures: { sp: 'ABC' } })
    expect(parseCommand('+120', 'SLEW')).toMatchObject({ command: { id: 'SET_ALT_ASSIGNED' }, captures: { alt: '120' } })
    expect(parseCommand('++120', 'SLEW')).toMatchObject({ command: { id: 'SET_ALT_REQUESTED' }, captures: { alt: '120' } })
    expect(parseCommand('+AB', 'SLEW')).toMatchObject({ command: { id: 'SET_SP2' }, captures: { sp: 'AB' } })
    expect(idOf('.', 'SLEW')).toBe('CLEAR_SP1')
    expect(idOf('+', 'SLEW')).toBe('CLEAR_SP2')
  })

  test('dot commands', () => {
    expect(parseCommand('.qnh 29.92', 'ENTER')).toMatchObject({ command: { id: 'SET_ALTIM' }, captures: { value: '29.92' } })
    expect(idOf('.LBL', 'ENTER')).toBe('TOGGLE_LABELS')
    expect(idOf('.FILL', 'ENTER')).toBe('TOGGLE_FILL')
    expect(parseCommand('.FILL 40', 'ENTER').captures).toEqual({ pct: '40' })
    expect(idOf('.CLASSB', 'ENTER')).toBe('TOGGLE_AIRSPACE_CAT')
    expect(idOf('.FIX', 'ENTER')).toBe('CLEAR_FIX')
    expect(parseCommand('.FIX ALPHA BRAVO', 'ENTER').captures).toEqual({ names: 'ALPHA BRAVO' })
    expect(idOf('.AIRWAY', 'ENTER')).toBe('CLEAR_AIRWAY')
    expect(idOf('.AIRWAYS', 'ENTER')).toBe('TOGGLE_AIRWAYS')
    expect(parseCommand('.airways j', 'ENTER')).toMatchObject({ command: { id: 'TOGGLE_AIRWAYS_TYPE' }, captures: { type: 'J' } })
    expect(idOf('.AIRWAYS X', 'ENTER')).toBe(null)
    expect(parseCommand('.airway J V66', 'ENTER')).toMatchObject({ command: { id: 'TOGGLE_AIRWAY' }, captures: { names: 'J V66' } })
    expect(idOf('.FP', 'ENTER')).toBe('OPEN_FPE')
    expect(idOf('.COORDS', 'ENTER')).toBe('TOGGLE_COORDS')
  })

  test('range rings only accept the supported spacings', () => {
    expect(idOf('RR 10', 'ENTER')).toBe('SET_RNG_RING')
    expect(parseCommand('RR 15', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_IMPLIED' }, captures: { aid: 'RR' } })
  })

  test('RBL commands', () => {
    expect(idOf('*T', 'ENTER')).toBe('RBL_CLEAR_ALL')
    expect(parseCommand('*T3', 'ENTER').captures).toEqual({ n: '3' })
    expect(parseCommand('*T KLAX', 'ENTER')).toMatchObject({ command: { id: 'RBL_INIT_FIX' }, captures: { query: 'KLAX' } })
    expect(idOf('*T', 'SLEW')).toBe('RBL_INIT')
  })

  test('flight plan creation', () => {
    expect(keyed('DA AAL1 B738', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_ABBREV' }, captures: { aid: 'AAL1', rest: 'B738' } })
    expect(keyed('VP N123 C172', 'ENTER')).toMatchObject({ command: { id: 'CREATE_VFR_FP' }, captures: { aid: 'N123', rest: 'C172' } })
    expect(parseCommand('AAL1 B738', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_IMPLIED' }, captures: { aid: 'AAL1', rest: 'B738' } })
  })

  test('key verb commands need their key at the start of the buffer', () => {
    for (const [buffer, trigger, id] of [['HO 2A', 'SLEW', 'HND_OFF'], ['IC', 'SLEW', 'INIT_CNTL'], ['MF TS', 'ENTER', 'TOGGLE_SIGNON'], ['MIN', 'ENTER', 'MIN_CLEAR']]) {
      expect(idOf(buffer, trigger)).not.toBe(id)
      expect(parseCommand(buffer, trigger, true, 'TC')?.command.id ?? null).not.toBe(id)
    }
  })

  test('an empty slew is a bare slew; an empty enter matches nothing', () => {
    expect(idOf('', 'SLEW')).toBe('BARE_SLEW')
    expect(idOf('', 'ENTER')).toBe(null)
  })
})

describe('STARS looksLikeKnownCommand', () => {
  test('recognizes word verbs, dot verbs and *T', () => {
    expect(looksLikeKnownCommand('MF X', 'MF')).toBe(true)
    expect(looksLikeKnownCommand('HO', 'HO')).toBe(true)
    expect(looksLikeKnownCommand('.FILL ABC')).toBe(true)
    expect(looksLikeKnownCommand('*TXYZ')).toBe(true)
  })

  test('rejects unknown verbs and shorthand', () => {
    expect(looksLikeKnownCommand('XYZ 1')).toBe(false)
    expect(looksLikeKnownCommand('.BOGUS')).toBe(false)
    expect(looksLikeKnownCommand('123')).toBe(false)
    // The verb must be a whole word.
    expect(looksLikeKnownCommand('HOX')).toBe(false)
  })

  test('typed key verbs are plain text', () => {
    expect(looksLikeKnownCommand('MF X')).toBe(false)
    expect(looksLikeKnownCommand('HO')).toBe(false)
    expect(looksLikeKnownCommand('HO', 'MF')).toBe(false)
  })
})
