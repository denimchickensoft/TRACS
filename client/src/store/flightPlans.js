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
            bcn:         generateBcn(Object.values(state.plans).map((p) => p.bcn)),
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
          [key]: { ...state.plans[key], bcn: generateBcn(Object.values(state.plans).map((p) => p.bcn)) },
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

  // Atomically replace `plans` from an authoritative STATE_DUMP in a single
  // set() — unlike reset() followed by a per-plan add() replay, this never
  // exposes an intermediate "no flight plans" tick to subscribers
  // (associationEngine.js's sticky-while-owned retention bails if
  // flightPlans?.[aid] is momentarily missing, the same class of bug fixed
  // for atc.js's ownership/handoffs/pointOuts — see
  // feedback_webrtc_relay_sync_invariants memory). The dump's plans are
  // already complete records (real cid/bcn from the sender's own fps.plans,
  // not freshly generated), so this bypasses add()'s per-plan defaulting
  // entirely rather than needing a separate filter step.
  applyPlansDump: (plans) => {
    // Advance (never rewind) the CID counter past anything in the dump so a
    // subsequent genuinely-new add() can't collide with a dumped plan's CID —
    // add()'s generateCid() call used to do this implicitly, once per dumped
    // plan, as a side effect of the old per-item reset()+add() replay.
    const maxCid = Math.max(0, ...Object.values(plans).map((p) => parseInt(p.cid, 10) || 0))
    if (maxCid + 1 > _cidCounter) _cidCounter = maxCid + 1
    set({ plans })
  },
    }),
    {
      name: 'tracs.flightPlans',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ plans: state.plans }),
    }
  )
)

syncStore(useFlightPlansStore, 'tracs-plans', (s) => ({ plans: s.plans }))
