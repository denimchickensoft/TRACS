import { describe, it, expect, beforeEach } from 'vitest'
import { recordRemoval, undoGroup, undoRemoval, _resetRemovalUndo } from '../../client/src/utils/removalUndo.js'

describe('removalUndo', () => {
  beforeEach(() => _resetRemovalUndo())

  it('restores the latest removal for the module, newest first', () => {
    const log = []
    recordRemoval('ABM', 'A', () => log.push('A'))
    recordRemoval('AIC', 'X', () => log.push('X'))
    recordRemoval('ABM', 'B', () => log.push('B'))
    expect(undoRemoval('ABM')).toBe('B')
    expect(undoRemoval('ABM')).toBe('A')
    expect(undoRemoval('ABM')).toBe(null)
    expect(undoRemoval('AIC')).toBe('X')
    expect(log).toEqual(['B', 'A', 'X'])
  })

  it('gathers a group into one entry, restored in reverse order', () => {
    const log = []
    undoGroup('ABM', 'ALL', () => {
      recordRemoval('ABM', 'one', () => log.push(1))
      recordRemoval('ABM', 'two', () => log.push(2))
    })
    expect(undoRemoval('ABM')).toBe('ALL')
    expect(log).toEqual([2, 1])
    expect(undoRemoval('ABM')).toBe(null)
  })

  it('records nothing for a group that removed nothing', () => {
    undoGroup('ABM', 'EMPTY', () => {})
    expect(undoRemoval('ABM')).toBe(null)
  })

  it('keeps only the last 20 removals', () => {
    for (let i = 0; i < 25; i++) recordRemoval('ABM', String(i), () => {})
    let n = 0
    while (undoRemoval('ABM')) n++
    expect(n).toBe(20)
  })
})
