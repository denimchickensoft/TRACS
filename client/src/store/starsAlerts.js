import { create } from 'zustand'

// Per-scope STARS alert and display state. Deliberately not synced to other
// controllers or windows: acknowledging an alert, a duplicate-beacon
// indicator, or opening a full LDB only affects this scope.
//
// All maps are keyed by unit id (string).
//   spc        { code, acked, soundEnd } — first time the track squawked a
//              special condition code. Stays until the track goes away, like
//              the real system (squawking off an SPC doesn't re-arm it).
//   msaw       { active, acked, start, soundEnd, inhibit } — low altitude
//              alert. `inhibit` (MULTI FUNC Q) lasts until the alert clears.
//   duplicates  code -> true for every live code squawked by 2+ visible tracks
//   dupAck     the beacon code whose duplicate-beacon (DB) indicator was
//              acknowledged; a different duplicate code shows DB again.
//   fullLdbUntil  epoch ms — unassociated track slewed for a full LDB
//   ldbBeacon  true — MULTI FUNC B + slew: this LDB always shows its code
//   selectedBeacon  { code, until } — ** + code display, or null
//   trackMsawDisabled  true — MULTI FUNC V on a track with no flight plan
//              (a plan carries its own, shared setting instead)
//   trackMciSuppressed  beacon code — CA M on a track with no flight plan
//   msawDisabled  MULTI FUNC VMI/VME for the whole scope
//   ldbBeacons    MULTI FUNC B/BE/BI for every LDB on the scope
export const ALERT_AUDIO_MS = 5000
const FULL_LDB_MS    = 5000
const SELECTED_BEACON_MS = 15000

export const useStarsAlertsStore = create((set) => ({
  spc:            {},
  msaw:           {},
  duplicates:     {},
  dupAck:         {},
  fullLdbUntil:   {},
  ldbBeacon:      {},
  selectedBeacon: null,
  trackMsawDisabled: {},
  trackMciSuppressed: {},
  msawDisabled:   false,
  ldbBeacons:     false,

  // Replace the computed alert maps in one set() (from the alerts tick).
  setComputed: (patch) => set(patch),

  ackSpc: (uid) => set((s) => s.spc[uid]
    ? { spc: { ...s.spc, [uid]: { ...s.spc[uid], acked: true } } }
    : {}),

  ackMsaw: (uid) => set((s) => s.msaw[uid]
    ? { msaw: { ...s.msaw, [uid]: { ...s.msaw[uid], acked: true } } }
    : {}),

  inhibitMsaw: (uid) => set((s) => s.msaw[uid]
    ? { msaw: { ...s.msaw, [uid]: { ...s.msaw[uid], inhibit: true, acked: true } } }
    : {}),

  ackDuplicate: (uid, code) => set((s) => ({ dupAck: { ...s.dupAck, [uid]: code } })),

  openFullLdb: (uid, now = Date.now()) =>
    set((s) => ({ fullLdbUntil: { ...s.fullLdbUntil, [uid]: now + FULL_LDB_MS } })),

  toggleLdbBeacon: (uid) => set((s) => {
    const next = { ...s.ldbBeacon }
    if (next[uid]) delete next[uid]
    else next[uid] = true
    return { ldbBeacon: next }
  }),

  selectBeacon: (code, now = Date.now()) =>
    set({ selectedBeacon: { code, until: now + SELECTED_BEACON_MS } }),

  clearTrackMsaw: (uid) => set((s) => {
    if (!s.trackMsawDisabled[uid]) return {}
    const next = { ...s.trackMsawDisabled }
    delete next[uid]
    return { trackMsawDisabled: next }
  }),

  toggleTrackMsaw: (uid) => set((s) => {
    const next = { ...s.trackMsawDisabled }
    if (next[uid]) delete next[uid]
    else next[uid] = true
    return { trackMsawDisabled: next }
  }),

  setTrackMciSuppressed: (uid, code) => set((s) => {
    const next = { ...s.trackMciSuppressed }
    if (code) next[uid] = code
    else delete next[uid]
    return { trackMciSuppressed: next }
  }),

  setMsawDisabled: (v) => set({ msawDisabled: !!v }),
  setLdbBeacons:   (v) => set({ ldbBeacons: !!v }),

  reset: () => set({
    spc: {}, msaw: {}, duplicates: {}, dupAck: {}, fullLdbUntil: {}, ldbBeacon: {},
    selectedBeacon: null, trackMsawDisabled: {}, trackMciSuppressed: {}, msawDisabled: false, ldbBeacons: false,
  }),
}))
