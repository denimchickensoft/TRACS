import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'
import { trueBearingRangeNm } from '../utils/bearing.js'

// Minimum real displacement between two position samples before trusting the
// bearing between them. Deliberately checked against actual distance moved,
// not reported speed/horizontalVelocity: those can stay stale (still showing
// the aircraft's last pre-pause value) even when the sim is paused and
// position has genuinely stopped changing, which — if gated on speed alone —
// left atan2() computing a bearing from a near-zero, jitter-sized
// displacement, producing wildly unstable results tick to tick.
const MIN_TRACK_DIST_M = 1
const M_PER_NM = 1852

export const useUnitsStore = create((set) => ({
  // Keyed by Olympus unit ID
  units: {},
  lastUpdateTime: 0,

  applyDelta: (delta) =>
    set((state) => {
      const next = { ...state.units }
      if (delta.updated) {
        for (const [id, unit] of Object.entries(delta.updated)) {
          const prev = next[id]

          // unit.track (Olympus's own field) is unreliable — empirically it
          // sits at raw grid heading instead of the real-geographic-true
          // bearing its own source says it computes (see utils/bearing.js's
          // header). Never let it through untouched; TRACS computes its own
          // from consecutive real position samples below, which is data
          // this app has already validated extensively.
          const rest = { ...unit }
          delete rest.track
          const merged = { ...prev, ...rest }

          if (unit.position) {
            if (prev?.position) {
              const { trueBearingDeg, rangeNm } = trueBearingRangeNm(
                prev.position.lat, prev.position.lng,
                unit.position.lat, unit.position.lng,
              )
              if (rangeNm * M_PER_NM > MIN_TRACK_DIST_M) {
                merged.track = trueBearingDeg * Math.PI / 180
              }
              // else: displacement too small/noisy to trust — leave track as
              // prev's (already carried through by the spread above); don't
              // recompute from a near-zero displacement (stationary, or the
              // sim is paused — see MIN_TRACK_DIST_M's comment).
            }
            // else: first-ever position sample for this unit — no baseline
            // to compute from yet. Leave track unset; every consumer already
            // null-guards this (PTL skips, aspect-angle calcs default to 0).
            // Populates for real on the next update, ~1s later.
          }

          next[id] = merged
        }
      }
      if (delta.removed) {
        for (const id of delta.removed) {
          delete next[id]
        }
      }
      return { units: next, lastUpdateTime: delta.time ?? Date.now() }
    }),

  clearUnits: () => set({ units: {}, lastUpdateTime: 0 }),
}))

if (typeof window !== 'undefined') {
  syncStore(useUnitsStore, 'tracs-units', (s) => ({ units: s.units, lastUpdateTime: s.lastUpdateTime }), { onlyWithPeers: true })
}
