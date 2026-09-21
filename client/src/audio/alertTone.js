// Generic, channel-keyed repeating alert tone. Any module can call
// startAlertTone/stopAlertTone with its own channel name — channels never
// collide, so e.g. STARS' 'stars-ca' and a future 'catcc-emergency' can run
// independently (and simultaneously) without one clobbering the other.
//
// Not sample-accurate — pulse timing is driven by setTimeout, matching the
// precision level of the app's existing blink timers (200/500ms intervals
// elsewhere). That's fine for a UI alert; it's not a music synthesizer.

import { getAudioContext } from './audioEngine.js'
import { useSessionStore } from '../store/session.js'

const active = new Map() // channel -> { osc, gain, timeoutId, on }

const DEFAULTS = {
  frequency: 950,   // Hz
  onMs:      150,
  offMs:     150,
  getVolume: () => 1, // 0-1, re-sampled every pulse so live volume changes apply immediately
}

/**
 * Start a repeating tone on `channel`. If that channel is already playing,
 * live-updates its volume getter/pattern in place instead of restarting the
 * oscillator (a restart would glitch the audio) — this is what lets a
 * caller's volume control take effect immediately on an already-sounding
 * tone rather than only applying the next time the tone (re)starts.
 * @param {string} channel  unique key for this alert source, e.g. 'stars-ca'
 * @param {{ frequency?: number, onMs?: number, offMs?: number, getVolume?: () => number }} opts
 */
export function startAlertTone(channel, opts = {}) {
  const { frequency, onMs, offMs, getVolume } = { ...DEFAULTS, ...opts }

  const existing = active.get(channel)
  if (existing) {
    existing.getVolume = getVolume
    existing.onMs      = onMs
    existing.offMs     = offMs
    existing.osc.frequency.setValueAtTime(frequency, getAudioContext().currentTime)
    return
  }

  const ctx = getAudioContext()

  const gain = ctx.createGain()
  gain.gain.value = 0
  gain.connect(ctx.destination)

  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = frequency
  osc.connect(gain)
  osc.start()

  const entry = { osc, gain, timeoutId: null, on: false, getVolume, onMs, offMs }
  active.set(channel, entry)

  const pulse = () => {
    entry.on = !entry.on
    // Global "Sounds" checkbox (App.jsx settings panel) is a hard gate here
    // rather than each caller's own concern — re-sampled every pulse, same as
    // getVolume(), so toggling it mutes/unmutes an already-sounding tone
    // within one pulse instead of only on the next start.
    const soundsEnabled = useSessionStore.getState().soundsEnabled
    const target = (entry.on && soundsEnabled) ? Math.max(0, Math.min(1, entry.getVolume())) : 0
    const now = ctx.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(gain.gain.value, now)
    gain.gain.linearRampToValueAtTime(target, now + 0.01)
    entry.timeoutId = setTimeout(pulse, entry.on ? entry.onMs : entry.offMs)
  }
  pulse()
}

/** Stop the tone on `channel`. No-op if nothing is playing on it. */
export function stopAlertTone(channel) {
  const entry = active.get(channel)
  if (!entry) return
  active.delete(channel)

  clearTimeout(entry.timeoutId)
  const ctx = getAudioContext()
  const now = ctx.currentTime
  entry.gain.gain.cancelScheduledValues(now)
  entry.gain.gain.setValueAtTime(entry.gain.gain.value, now)
  entry.gain.gain.linearRampToValueAtTime(0, now + 0.01)
  setTimeout(() => {
    entry.osc.stop()
    entry.osc.disconnect()
    entry.gain.disconnect()
  }, 20)
}
