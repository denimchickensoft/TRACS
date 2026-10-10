import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'

// Special condition (emergency squawk) alerts for ABM and CATCC, keyed by
// unit id: { code, acked, soundEnd } (see utils/spc.js trackSpcAlerts).
// Written by the module's alert tick (utils/useSpcAlerts.js); acknowledging
// one only affects that module on this client, like STARS.
function createSpcAlertStore() {
  return create((set) => ({
    spc: {},
    setSpc: (spc) => set({ spc }),
    ack: (uid) => set((s) => s.spc[uid] && !s.spc[uid].acked
      ? { spc: { ...s.spc, [uid]: { ...s.spc[uid], acked: true } } }
      : {}),
  }))
}

// Shared with ABM's pop-out focus windows, which are separate renderers: the
// main window runs the tick and the tone, every window shows and can
// acknowledge the same alerts.
export const useAbmSpcStore = createSpcAlertStore()

export const useCatccSpcStore = createSpcAlertStore()

if (typeof window !== 'undefined') {
  syncStore(useAbmSpcStore, 'tracs-abm-spc', (s) => ({ spc: s.spc }))
}
