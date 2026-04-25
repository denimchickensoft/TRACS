import { create } from 'zustand'

export const useAicStore = create((set) => ({
  // Group labels: groupId → { label, unitIds, positionName }
  // Groups are ad-hoc collections of contacts assigned a tactical label by a controller
  groups: {},

  // Contact ownership: unitId → positionName (which controller is working this contact)
  ownership: {},

  // Fighter assignments: fighterId (Olympus unit ID) → { groupId, controller }
  assignments: {},

  // Whether datalink (detection method 32) contacts are displayed
  datalinkVisible: false,

  // Platform for this scope instance
  // { type: 'AWACS', unitId: '...' } | { type: 'GCI', lat: ..., lon: ... }
  platform: null,

  setGroup: (groupId, group) =>
    set((state) => ({
      groups: { ...state.groups, [groupId]: group },
    })),

  deleteGroup: (groupId) =>
    set((state) => {
      const next = { ...state.groups }
      delete next[groupId]
      return { groups: next }
    }),

  claimContact: (unitId, positionName) =>
    set((state) => ({
      ownership: { ...state.ownership, [unitId]: positionName },
    })),

  dropContact: (unitId) =>
    set((state) => {
      const next = { ...state.ownership }
      delete next[unitId]
      return { ownership: next }
    }),

  setAssignment: (fighterId, assignment) =>
    set((state) => ({
      assignments: { ...state.assignments, [fighterId]: assignment },
    })),

  clearAssignment: (fighterId) =>
    set((state) => {
      const next = { ...state.assignments }
      delete next[fighterId]
      return { assignments: next }
    }),

  toggleDatalink: () => set((state) => ({ datalinkVisible: !state.datalinkVisible })),

  setPlatform: (platform) => set({ platform }),

  reset: () =>
    set({ groups: {}, ownership: {}, assignments: {}, datalinkVisible: false, platform: null }),
}))
