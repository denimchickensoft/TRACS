import { create } from 'zustand'
import { syncStore } from '../utils/storeSync.js'
import { IMPERIAL, METRIC } from '../utils/units.js'

// Per-module display unit system — 'imperial' (NM/ft/kt) or 'metric'
// (km/m/km/h), set by each module's .metric/.imperial command. One value
// per module, not per window: every ABM focus window, the AIC BraaList,
// the ABM Drawings/FRAG popups and PAR (under whichever module hosts it)
// follow their parent module's setting. Persisted to localStorage and
// synced across pop-out windows.

const KEY = 'tracs.units'
const MODULES = ['abm', 'aic', 'atc', 'catcc']

const DEFAULTS = Object.fromEntries(MODULES.map(m => [m, IMPERIAL]))

function loadPersisted() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY))
    const merged = { ...DEFAULTS, ...saved }
    for (const m of MODULES) if (merged[m] !== METRIC) merged[m] = IMPERIAL
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

const pick = (s) => Object.fromEntries(MODULES.map(m => [m, s[m]]))

export const useUnitSystemStore = create((set) => ({
  ...loadPersisted(),
  setUnitSystem: (module, sys) => set({ [module]: sys === METRIC ? METRIC : IMPERIAL }),
}))

useUnitSystemStore.subscribe((state, prev) => {
  if (MODULES.every(m => state[m] === prev[m])) return
  try {
    localStorage.setItem(KEY, JSON.stringify(pick(state)))
  } catch {
    // ignore (e.g. private browsing quota)
  }
})

if (typeof window !== 'undefined') {
  syncStore(useUnitSystemStore, 'tracs-unit-system', pick)
}

export function useUnitSystem(module) {
  return useUnitSystemStore((s) => s[module])
}

export function getUnitSystem(module) {
  return useUnitSystemStore.getState()[module]
}

export function setUnitSystem(module, sys) {
  useUnitSystemStore.getState().setUnitSystem(module, sys)
}
