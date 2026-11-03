import { describe, test, expect } from 'vitest'

// The stores read localStorage at import time; the tests run in Node.
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

const {
  createDeclarationStore, applySharedDeclaration, clearSharedDeclarations, DECLARATION, AUTO_DECLARE_MODE,
} = await import('../../client/src/utils/createDeclarationStore.js')
// statusBoard.js reads the window's query string at import time.
globalThis.window ??= { location: { search: '' } }
const { useStatusBoardStore } = await import('../../client/src/store/statusBoard.js')

describe('clearSharedDeclarations', () => {
  test('clears declarations and BRAA pairs in every store, keeps auto-declare mode', () => {
    const a = createDeclarationStore({ storageKey: 'test.a', channelName: 'test-a' }).useStore
    const b = createDeclarationStore({ storageKey: 'test.b', channelName: 'test-b' }).useStore
    applySharedDeclaration('42', DECLARATION.FRIENDLY)
    a.getState().addBraaPair('1', '2')
    a.getState().setAutoDeclareMode(AUTO_DECLARE_MODE.COALITION)
    expect(b.getState().declarations).toEqual({ 42: DECLARATION.FRIENDLY })

    clearSharedDeclarations()

    for (const s of [a, b]) {
      expect(s.getState().declarations).toEqual({})
      expect(s.getState().braaList).toEqual([])
    }
    expect(a.getState().autoDeclareMode).toBe(AUTO_DECLARE_MODE.COALITION)
  })
})

describe('status board autofill stamps', () => {
  test('ATD and ATA stamps are marked auto; a new launch drops the ATA flag', () => {
    const sb = useStatusBoardStore
    sb.setState({ entries: [{ id: 1, atd: '', ata: '', auto: { eat: true } }] })
    sb.getState().stampDeparture(1, '1200')
    expect(sb.getState().entries[0]).toMatchObject({ atd: '1200', ata: '', auto: { eat: true, atd: true } })
    sb.getState().stampArrival(1, '1300')
    expect(sb.getState().entries[0].auto).toEqual({ eat: true, atd: true, ata: true })
    sb.getState().stampDeparture(1, '1400')
    expect(sb.getState().entries[0].auto).toEqual({ eat: true, atd: true })
  })
})
