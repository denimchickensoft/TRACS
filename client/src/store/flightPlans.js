import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { generateBcn } from '../utils/bcn.js'
import { syncStore } from '../utils/storeSync.js'

let _cidCounter = 1

function generateCid() {
  return String(_cidCounter++).padStart(3, '0')
}

export function resetCidCounter() { _cidCounter = 1 }

export const useFlightPlansStore = create(
  persist(
    (set, get) => ({
  // Keyed by AID (callsign, uppercase)
  plans: {},

  // Create a new flight plan. CID and BCN are auto-generated if not provided.
  // No-op if a plan for this AID already exists.
  add: (plan) =>
    set((state) => {
      const aid = plan.aid?.toUpperCase()
      if (!aid) return {}
      if (state.plans[aid]) return {}

      return {
        plans: {
          ...state.plans,
          [aid]: {
            aid,
            cid:         generateCid(),
            bcn:         generateBcn(state.plans),
            typ:         '',
            eq:          '',
            dep:         '',
            dest:        '',
            spd:         '',
            alt:         '',
            rte:         '',
            rmk:         '',
            flightRules: 'IFR',
            // 'manual' (FPE/pilot page) vs 'miz'/'csv'/'dtc' (bulk import) --
            // lets the Strip Bay's "Clear Mission" distinguish imported
            // plans from controller/pilot-filed ones. See
            // resources/specs/pilot-flightplan-ingestion-spec.md.
            source:      'manual',
            unitId:      null,
            suspended:   false,
            suspendIndex: null,
            firstSeen:   Date.now(),
            ...plan,
            // AID always normalised; CID/BCN only overridden if explicitly provided
            // eslint-disable-next-line no-dupe-keys -- intentional: this key wins over any `aid` in ...plan
            aid,
          },
        },
      }
    }),

  // Amend an existing flight plan. Merges patch fields.
  // Sets amended: true so listeners can highlight strips.
  amend: (aid, patch) =>
    set((state) => {
      const key = aid?.toUpperCase()
      if (!key || !state.plans[key]) return {}
      return {
        plans: {
          ...state.plans,
          [key]: { ...state.plans[key], ...patch, amended: true },
        },
      }
    }),

  // Clear the amended flag once strips have acknowledged it
  clearAmended: (aid) =>
    set((state) => {
      const key = aid?.toUpperCase()
      if (!key || !state.plans[key]) return {}
      return {
        plans: {
          ...state.plans,
          [key]: { ...state.plans[key], amended: false },
        },
      }
    }),

  // Recycle the BCN for a plan
  recycleBcn: (aid) =>
    set((state) => {
      const key = aid?.toUpperCase()
      if (!key || !state.plans[key]) return {}
      return {
        plans: {
          ...state.plans,
          [key]: { ...state.plans[key], bcn: generateBcn(state.plans) },
        },
      }
    }),

  update: (aid, patch) =>
    set((state) => {
      const key = aid?.toUpperCase()
      if (!key || !state.plans[key]) return {}
      return { plans: { ...state.plans, [key]: { ...state.plans[key], ...patch } } }
    }),

  remove: (aid) =>
    set((state) => {
      const next = { ...state.plans }
      delete next[aid?.toUpperCase()]
      return { plans: next }
    }),

  associate: (aid, unitId) =>
    set((state) => {
      const key = aid?.toUpperCase()
      if (!key || !state.plans[key]) return {}
      return { plans: { ...state.plans, [key]: { ...state.plans[key], unitId } } }
    }),

  renameAid: (unitId, newAid, oldAid) =>
    set((state) => {
      const normalized = newAid?.toUpperCase()
      if (!normalized) return {}
      let oldKey = Object.keys(state.plans).find(
        (key) => String(state.plans[key].unitId) === String(unitId)
      )
      if (!oldKey && oldAid) oldKey = oldAid.toUpperCase()
      if (!oldKey || !state.plans[oldKey] || oldKey === normalized) return {}
      const plan = state.plans[oldKey]
      const next = { ...state.plans }
      delete next[oldKey]
      next[normalized] = { ...plan, aid: normalized }
      return { plans: next }
    }),

  getByUnit: (unitId) =>
    Object.values(get().plans).find((p) => p.unitId === unitId) ?? null,

  reset: () => { _cidCounter = 1; set({ plans: {} }) },
    }),
    {
      name: 'tracs.flightPlans',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ plans: state.plans }),
    }
  )
)

syncStore(useFlightPlansStore, 'tracs-plans', (s) => ({ plans: s.plans }))
