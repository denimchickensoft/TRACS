import { describe, test, expect } from 'vitest'
import { trackSpcAlerts, shownSpcAlerts, spcSounding, ALERT_AUDIO_MS } from '../../client/src/utils/spc.js'

const squawking = (mode3) => ({ srsCapable: true, transponder: { status: 1, mode3 } })

describe('special condition alerts', () => {
  test('arms on the first SPC squawk, sounding until acked or timed out', () => {
    const spc = trackSpcAlerts({}, { 1: squawking(7700), 2: squawking(4321) }, 1000)
    expect(spc).toEqual({ 1: { code: 'EM', acked: false, soundEnd: 1000 + ALERT_AUDIO_MS } })
    expect(spcSounding(spc, 1000)).toBe(true)
    expect(spcSounding(spc, 1000 + ALERT_AUDIO_MS)).toBe(false)
    expect(spcSounding({ 1: { ...spc[1], acked: true } }, 1000)).toBe(false)
  })

  test('ignores AI aircraft and transponders in standby', () => {
    const units = {
      1: { srsCapable: false, transponder: { status: 1, mode3: 7700 } },
      2: { srsCapable: true,  transponder: { status: 0, mode3: 7700 } },
    }
    expect(trackSpcAlerts({}, units, 0)).toEqual({})
  })

  test('keeps the entry while the track exists, re-arms on a new code', () => {
    const armed = trackSpcAlerts({}, { 1: squawking(7600) }, 0)
    const acked = { 1: { ...armed[1], acked: true } }

    // Squawking off keeps the acknowledged entry but hides the tag
    const off = trackSpcAlerts(acked, { 1: squawking(4321) }, 2000)
    expect(off[1]).toBe(acked[1])
    expect(shownSpcAlerts(off, { 1: squawking(4321) })).toEqual({})

    // Back on the same code: shown again, still acknowledged, no new tone
    const back = trackSpcAlerts(off, { 1: squawking(7600) }, 3000)
    expect(back[1]).toBe(acked[1])
    expect(shownSpcAlerts(back, { 1: squawking(7600) })).toEqual({ 1: acked[1] })

    // 7600 -> 7700 re-arms with the new tag
    const changed = trackSpcAlerts(back, { 1: squawking(7700) }, 4000)
    expect(changed[1]).toEqual({ code: 'EM', acked: false, soundEnd: 4000 + ALERT_AUDIO_MS })

    // Track gone: entry dropped
    expect(trackSpcAlerts(changed, {}, 5000)).toEqual({})
  })
})
