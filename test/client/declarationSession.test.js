import { describe, test, expect, beforeEach } from 'vitest'
import { saveDeclarations, loadDeclarations, clearSavedDeclarations } from '../../client/src/utils/declarationSession.js'

const mem = new Map()
globalThis.sessionStorage ??= {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

describe('declarationSession', () => {
  beforeEach(() => clearSavedDeclarations())

  test('comes back only for the same room and mission', () => {
    saveDeclarations('room-blue', 'hash1', { 42: 'HOSTILE' })
    expect(loadDeclarations('room-blue', 'hash1')).toEqual({ 42: 'HOSTILE' })
    expect(loadDeclarations('room-red', 'hash1')).toBe(null)
    expect(loadDeclarations('room-blue', 'hash2')).toBe(null)
  })

  test('clearing drops them', () => {
    saveDeclarations('room-blue', null, { 1: 'FRIENDLY' })
    clearSavedDeclarations()
    expect(loadDeclarations('room-blue', null)).toBe(null)
  })
})
