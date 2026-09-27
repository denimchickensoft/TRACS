import { describe, test, expect } from 'vitest'
import { parseCommand, looksLikeKnownCommand } from '../../client/src/modules/atc/stars/input/commandParser.js'

const idOf = (buffer, trigger, hasToken) => parseCommand(buffer, trigger, hasToken)?.command.id ?? null

describe('STARS parseCommand', () => {
  test('trims and uppercases the buffer', () => {
    expect(idOf('  rg 40 ', 'ENTER')).toBe('SET_RANGE')
    expect(parseCommand('rg 40', 'ENTER').captures).toEqual({ range: '40' })
  })

  test('trigger decides between commands that share a pattern', () => {
    expect(idOf('MF TS', 'ENTER')).toBe('TOGGLE_SIGNON')
    expect(idOf('MF TS', 'SLEW')).toBe('RELOCATE_SIGNON')
    expect(idOf('MIN', 'SLEW')).toBe('MIN_INIT')
    expect(idOf('MIN', 'ENTER')).toBe('MIN_CLEAR')
  })

  test('resize patterns win over the bare toggles they extend', () => {
    expect(parseCommand('MF T5', 'ENTER')).toMatchObject({ command: { id: 'RESIZE_TAB' }, captures: { lines: '5' } })
    expect(idOf('MF T', 'ENTER')).toBe('TOGGLE_TAB')
    expect(parseCommand('MF TC12', 'ENTER').captures).toEqual({ lines: '12' })
  })

  test('SSA ATIS/GI variants resolve in the documented order', () => {
    expect(parseCommand('MF S2 RWY 27 CLOSED', 'ENTER')).toMatchObject({ command: { id: 'SET_GI_AUX' }, captures: { line: '2', text: 'RWY 27 CLOSED' } })
    expect(idOf('MF S2', 'ENTER')).toBe('CLEAR_GI_AUX')
    expect(idOf('MF S*', 'ENTER')).toBe('CLEAR_ATIS')
    expect(idOf('MF SA*', 'ENTER')).toBe('SET_ATIS_CLEAR_GI')
    expect(parseCommand('MF SB WIND 270', 'ENTER').captures).toEqual({ atis: 'B', giText: 'WIND 270' })
    expect(idOf('MF SC', 'ENTER')).toBe('SET_ATIS')
  })

  test('MF M: temp altitude, scratchpads, beacon and requested altitude', () => {
    expect(parseCommand('MF MΔ120', 'SLEW')).toMatchObject({ command: { id: 'MF_M_TEMP_ALT' }, captures: { alt: '120' } })
    expect(parseCommand('MF MΔAB', 'SLEW')).toMatchObject({ command: { id: 'MF_M_SP1' }, captures: { sp: 'AB' } })
    expect(parseCommand('MF M+XY', 'SLEW')).toMatchObject({ command: { id: 'MF_M_SP2' }, captures: { sp: 'XY' } })
    expect(parseCommand('MF M1234', 'SLEW')).toMatchObject({ command: { id: 'SET_BEACON' }, captures: { bcn: '1234' } })
    // 8 isn't an octal digit, so a 4-digit code with an 8 isn't a beacon.
    expect(idOf('MF M1238', 'SLEW')).toBe(null)
    expect(parseCommand('MF M120', 'SLEW')).toMatchObject({ command: { id: 'MF_M_REQ_ALT' }, captures: { alt: '120' } })
    expect(parseCommand('MF MAAL1 4321', 'ENTER').captures).toEqual({ flid: 'AAL1', bcn: '4321' })
  })

  test('leader direction: global, MF and context-free shorthand', () => {
    expect(parseCommand('MF L33', 'SLEW')).toMatchObject({ command: { id: 'SET_LEADER_GLOBAL' }, captures: { dir: '3' } })
    expect(idOf('MF L3', 'SLEW')).toBe('SET_LEADER_MF')
    expect(idOf('MF L34', 'SLEW')).toBe(null)
    expect(idOf('7', 'SLEW')).toBe('SET_LEADER_SHORT')
    expect(idOf('LD 3', 'ENTER')).toBe('SET_LEADER_LEN')
    // A known verb with a bad argument falls through to the implied flight
    // plan, whose action rejects verbs as names and answers FORMAT.
    expect(parseCommand('LD 8', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_IMPLIED' }, captures: { aid: 'LD' } })
  })

  test('handoffs', () => {
    expect(idOf('HO', 'ENTER')).toBe('HND_OFF_ACCEPT_NEAR')
    expect(idOf('HO', 'SLEW')).toBe('HND_OFF_BARE')
    expect(parseCommand('HO 2A', 'SLEW').captures).toEqual({ tcp: '2A' })
    expect(parseCommand('HO 2A AAL1', 'ENTER')).toMatchObject({ command: { id: 'HND_OFF_BY_ID' }, captures: { tcp: '2A', flid: 'AAL1' } })
    expect(idOf('2A', 'SLEW')).toBe('HND_OFF_SHORT')
  })

  test('context-free shorthand is disabled once a function-key token is in the buffer', () => {
    expect(idOf('2A', 'SLEW', true)).toBe(null)
    expect(idOf('7', 'SLEW', true)).toBe(null)
    expect(idOf('AAL1 B738', 'ENTER', true)).toBe(null)
    // Non-shorthand commands are unaffected.
    expect(idOf('HO 2A', 'SLEW', true)).toBe('HND_OFF')
  })

  test('point-outs and quick look', () => {
    expect(parseCommand('2A*', 'SLEW')).toMatchObject({ command: { id: 'POINT_OUT' }, captures: { tcp: '2A' } })
    expect(idOf('**', 'SLEW')).toBe('CONVERT_POINT_OUT')
    expect(idOf('UN', 'SLEW')).toBe('REJECT_POINT_OUT')
    expect(idOf('**2A', 'SLEW')).toBe('QUICK_LOOK_TCP')
  })

  test('track control', () => {
    expect(idOf('IC', 'SLEW')).toBe('INIT_CNTL')
    expect(parseCommand('IC AAL1', 'ENTER').captures).toEqual({ flid: 'AAL1' })
    expect(idOf('TC ALL', 'ENTER')).toBe('TERM_CNTL_ALL')
    expect(idOf('.DROPALL', 'ENTER')).toBe('TERM_CNTL_ALL')
    expect(idOf('TC AAL1', 'ENTER')).toBe('TERM_CNTL_BY_ID')
    expect(idOf('TC', 'SLEW')).toBe('TERM_CNTL')
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
    expect(parseCommand('DA AAL1 B738', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_ABBREV' }, captures: { aid: 'AAL1', rest: 'B738' } })
    expect(parseCommand('VP N123 C172', 'ENTER')).toMatchObject({ command: { id: 'CREATE_VFR_FP' }, captures: { aid: 'N123', rest: 'C172' } })
    expect(parseCommand('AAL1 B738', 'ENTER')).toMatchObject({ command: { id: 'CREATE_FP_IMPLIED' }, captures: { aid: 'AAL1', rest: 'B738' } })
  })

  test('an empty slew is a bare slew; an empty enter matches nothing', () => {
    expect(idOf('', 'SLEW')).toBe('BARE_SLEW')
    expect(idOf('', 'ENTER')).toBe(null)
  })
})

describe('STARS looksLikeKnownCommand', () => {
  test('recognizes word verbs, dot verbs and *T', () => {
    expect(looksLikeKnownCommand('MF X')).toBe(true)
    expect(looksLikeKnownCommand('HO')).toBe(true)
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
})
