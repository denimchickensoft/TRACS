import { describe, it, expect } from 'vitest'
import exporterContacts from '../../server/src/exporterContacts.js'

const { createRealContactsFilter, createRealAllSidesDetector, applyContactsMessage } = exporterContacts

const units = {
  '1': { coalition: 2, category: 'Aircraft', position: { lat: 0, lng: 0 } },
  '2': { coalition: 2, category: 'GroundUnit', position: { lat: 0, lng: 0 } },
  '10': { coalition: 1, category: 'Aircraft', position: { lat: 0, lng: 0 } },
  '11': { coalition: 1, category: 'GroundUnit', position: { lat: 0, lng: 0 } },
}

describe('applyContactsMessage', () => {
  it('replaces on full and merges a delta, null removing', () => {
    const full = applyContactsMessage(null, 'full', { '2:10': 4, '2:11': 1 })
    expect(full).toEqual({ '2:10': 4, '2:11': 1 })
    expect(applyContactsMessage(full, 'delta', { '2:10': 20, '2:11': null, '1:1': 16 }))
      .toEqual({ '2:10': 20, '1:1': 16 })
    expect(applyContactsMessage(full, 'full', { '1:2': 4 })).toEqual({ '1:2': 4 })
  })
})

describe('createRealContactsFilter', () => {
  it('puts every method on the anchor and exposes by the client rules', () => {
    const filter = createRealContactsFilter(2)
    const { contactsUpdate, revealed, hidden } = filter.computeVisibility(units, { '2:10': 20, '2:11': 1, '1:1': 4 })
    expect(Object.keys(contactsUpdate)).toEqual(['1'])
    expect(contactsUpdate['1'].contacts).toEqual([
      { ID: 10, detectionMethod: 4 }, { ID: 10, detectionMethod: 16 }, { ID: 11, detectionMethod: 1 },
    ])
    expect(Object.keys(revealed).sort()).toEqual(['10', '11'])
    expect(hidden).toEqual([])
  })

  it('does not expose an aircraft on RWR alone', () => {
    const filter = createRealContactsFilter(2)
    const { revealed } = filter.computeVisibility(units, { '2:10': 16 })
    expect(revealed).toEqual({})
    expect(filter.filterFrameUpdate({ '10': units['10'], '1': units['1'] })).toEqual({ '1': units['1'] })
  })

  it('hides previously exposed enemies the contacts no longer show', () => {
    const filter = createRealContactsFilter(2, ['10', '11'])
    const { revealed, hidden } = filter.computeVisibility(units, { '2:11': 4 })
    expect(revealed).toEqual({})
    expect(hidden).toEqual(['10'])
  })
})

describe('createRealAllSidesDetector', () => {
  it('gives each side its own contacts on its own anchor', () => {
    const detector = createRealAllSidesDetector()
    const update = detector.computeContacts(units, { '2:10': 4, '1:2': 1 })
    expect(update['1'].contacts).toEqual([{ ID: 10, detectionMethod: 4 }])
    expect(update['10'].contacts).toEqual([{ ID: 2, detectionMethod: 1 }])
  })

  it('clears the old anchor when it goes away', () => {
    const detector = createRealAllSidesDetector()
    detector.computeContacts(units, { '2:10': 4 })
    const withoutFirst = { ...units, '1': { ...units['1'], alive: false } }
    const update = detector.computeContacts(withoutFirst, { '2:10': 4 })
    expect(update['1']).toEqual({ contacts: [] })
    expect(update['2'].contacts).toEqual([{ ID: 10, detectionMethod: 4 }])
  })
})
