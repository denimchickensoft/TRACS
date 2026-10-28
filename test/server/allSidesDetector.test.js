import { describe, test, expect } from 'vitest'
import tacviewDetection from '../../server/src/tacviewDetection.js'

const { createAllSidesDetector, DETECTION_RADAR, DETECTION_RWR } = tacviewDetection

// A blue F-15C and a red Su-27 nose to nose, 12 nm apart, well above terrain.
function headOn() {
  return {
    1: { coalition: 2, category: 'Aircraft', name: 'F-15C', position: { lat: 25, lng: 55, alt: 8000 }, heading: 0, pitch: 0, agl: 8000 },
    2: { coalition: 1, category: 'Aircraft', name: 'Su-27', position: { lat: 25.2, lng: 55, alt: 8000 }, heading: Math.PI, pitch: 0, agl: 8000 },
  }
}

describe('createAllSidesDetector', () => {
  test('gives red and blue units their own radar and RWR contacts', () => {
    const contacts = createAllSidesDetector().computeContacts(headOn())
    const methods = (id, target) => contacts[id].contacts.filter((c) => c.ID === target).map((c) => c.detectionMethod)
    expect(methods(1, 2)).toEqual(expect.arrayContaining([DETECTION_RADAR, DETECTION_RWR]))
    expect(methods(2, 1)).toEqual(expect.arrayContaining([DETECTION_RADAR, DETECTION_RWR]))
  })

  test('sends an empty list once a unit loses all its contacts', () => {
    const detector = createAllSidesDetector()
    const units = headOn()
    detector.computeContacts(units)
    units[2].position = { lat: 40, lng: 55, alt: 8000 }
    const contacts = detector.computeContacts(units)
    expect(contacts[1]).toEqual({ contacts: [] })
    expect(contacts[2]).toEqual({ contacts: [] })
    expect(detector.computeContacts(units)).toEqual({})
  })
})
