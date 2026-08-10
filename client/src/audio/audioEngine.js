// Shared AudioContext singleton — used by any module that needs to play a
// tone (alertTone.js today; CATCC/AIC/ABM can build on the same context
// later). Chromium-only target, so no vendor-prefixed constructor fallback.

let ctx = null

export function getAudioContext() {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

// Chromium suspends new AudioContexts until a user gesture occurs on the
// page. Call this from any gesture handler — it's a cheap no-op once the
// context is already running. App.jsx wires one app-wide listener so
// individual modules don't each need their own gesture plumbing.
export function resumeAudioContext() {
  const c = getAudioContext()
  if (c.state === 'suspended') c.resume().catch(() => {})
}
