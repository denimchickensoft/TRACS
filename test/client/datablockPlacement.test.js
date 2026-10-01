import { describe, test, expect } from 'vitest'
import { placeDatablocks } from '../../client/src/utils/datablockPlacement.js'

const OPTS = { symbolRadius: 5, lineHeight: 13, ascent: 11, descent: 2, padding: 2, avoid: false }
const DIRS = { N: -90, NE: -45, E: 0, SE: 45, S: 90, SW: 135, W: 180, NW: -135 }

function place(angleDeg, opts = {}, lineWidths = [20, 50]) {
  const contact = { id: 'a', x: 0, y: 0, lineWidths, unitAngleDeg: null, generalAngleDeg: angleDeg }
  return placeDatablocks([contact], { ...OPTS, leaderLen: 20, ...opts }).a
}

// Strict interior with a little slack: the leader may run along the box's edge.
const EPS = 1e-6
const inside = (p, b) => p.x > b.x1 + EPS && p.x < b.x2 - EPS && p.y > b.y1 + EPS && p.y < b.y2 - EPS

describe('placeDatablocks geometry', () => {
  test('leader runs from the symbol edge to leaderLen from the contact', () => {
    for (const len of [0, 10, 20, 70]) {
      for (const angle of Object.values(DIRS)) {
        const { leaderStart, leaderEnd } = place(angle, { leaderLen: len })
        expect(Math.hypot(leaderStart.x, leaderStart.y)).toBeCloseTo(5)
        expect(Math.hypot(leaderEnd.x, leaderEnd.y)).toBeCloseTo(Math.max(len, 5))
      }
    }
  })

  test('the leader never enters its own datablock', () => {
    for (const len of [0, 10, 20]) {
      for (const angle of Object.values(DIRS)) {
        for (const textAnchor of ['baseline', 'center']) {
          const { bbox, leaderStart, leaderEnd } = place(angle, { leaderLen: len, textAnchor })
          for (let t = 0; t <= 1; t += 0.05) {
            const p = { x: leaderStart.x + (leaderEnd.x - leaderStart.x) * t, y: leaderStart.y + (leaderEnd.y - leaderStart.y) * t }
            expect(inside(p, bbox)).toBe(false)
          }
        }
      }
    }
  })

  test('S/SW/W/NW right-align, everything else left-aligns', () => {
    for (const [name, angle] of Object.entries(DIRS)) {
      const expected = ['S', 'SW', 'W', 'NW'].includes(name) ? 'right' : 'left'
      expect(place(angle).bbox.align).toBe(expected)
    }
  })

  test("'center' raises a multi-line block half a line, single lines stay on the tip", () => {
    const tipY = place(0).leaderEnd.y
    expect(place(0).bbox.ly1).toBeCloseTo(tipY)
    expect(place(0, { textAnchor: 'center' }).bbox.ly1).toBeCloseTo(tipY - 7)
    expect(place(0, { textAnchor: 'center' }, [50]).bbox.ly1).toBeCloseTo(tipY)
  })
})
