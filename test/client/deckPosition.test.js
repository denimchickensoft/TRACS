import { describe, test, expect, beforeAll } from 'vitest'
import { deckPosition, CARRIER_TYPES } from '../../client/src/utils/carriers.js'
import { setProjectionParams } from '../../client/src/utils/magvar.js'
import params from '../../client/public/projection_params.json'

beforeAll(() => setProjectionParams(params))

const FT = 0.3048
const stennis = CARRIER_TYPES.Stennis
const carrier = { name: 'Stennis', heading: 0, position: { lat: 42, lng: 41, alt: 0 } }
const deckAltM = stennis.deckHeightFt * FT
const at = (altAboveDeckFt, lat = 42, lng = 41) =>
  ({ position: { lat, lng, alt: deckAltM + altAboveDeckFt * FT } })

describe('deckPosition', () => {
  test('an aircraft sitting a few feet above the deck is on deck', () => {
    expect(deckPosition(at(5), carrier, stennis, 'Caucasus')).not.toBe(null)
  })
  test('one overflying the deck is not', () => {
    expect(deckPosition(at(200), carrier, stennis, 'Caucasus')).toBe(null)
  })
  test('one well below deck level (hangar bay) is not', () => {
    expect(deckPosition(at(-40), carrier, stennis, 'Caucasus')).toBe(null)
  })
  test('one at deck height but half a mile astern is not', () => {
    expect(deckPosition(at(5, 41.992), carrier, stennis, 'Caucasus')).toBe(null)
  })
  test('the carrier\'s own altitude counts toward deck level', () => {
    const raised = { ...carrier, position: { ...carrier.position, alt: 10 } }
    expect(deckPosition(at(5), raised, stennis, 'Caucasus')).toBe(null)
    expect(deckPosition({ position: { lat: 42, lng: 41, alt: 10 + deckAltM } }, raised, stennis, 'Caucasus')).not.toBe(null)
  })
})
