import { useEffect } from 'react'
import { startAlertTone, stopAlertTone } from '../audio/alertTone.js'
import { trackSpcAlerts, spcSounding } from './spc.js'

const TICK_MS = 1000

function sameEntries(a, b) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

/**
 * Special condition (emergency squawk) detection and its alert tone for one
 * scope: re-arms from the visible units once a second and sounds the same
 * tone as STARS for 5 seconds from each new alert, or until it's
 * acknowledged. Always called, but does nothing unless `isOwner` (only one
 * window per module drives the tick and the audio).
 *
 * @param {object} store       a store from store/spcAlerts.js
 * @param {{ current: object }} unitsRef  this scope's visible units
 * @param {string} channel     alert tone channel
 * @param {number} vol         0-10
 */
export function useSpcAlerts({ store, unitsRef, channel, vol, isOwner }) {
  useEffect(() => {
    if (!isOwner) return
    const tick = () => {
      const now = Date.now()
      const s = store.getState()
      let next = trackSpcAlerts(s.spc, unitsRef.current, now)
      // Unchanged entries keep their identity, so only a real change is set
      // (and broadcast to other windows)
      if (sameEntries(next, s.spc)) next = s.spc
      else s.setSpc(next)
      if (spcSounding(next, now)) startAlertTone(channel, { frequency: 1250, onMs: 300, offMs: 200, getVolume: () => (vol ?? 10) / 10 })
      else                        stopAlertTone(channel)
    }
    tick()
    const id = setInterval(tick, TICK_MS)
    return () => clearInterval(id)
  }, [store, unitsRef, channel, vol, isOwner])

  // An acknowledgement silences the tone at once rather than on the next tick
  const spc = store((s) => s.spc)
  useEffect(() => {
    if (isOwner && !spcSounding(spc, Date.now())) stopAlertTone(channel)
  }, [spc, channel, isOwner])

  useEffect(() => {
    if (!isOwner) return
    return () => stopAlertTone(channel)
  }, [channel, isOwner])
}
