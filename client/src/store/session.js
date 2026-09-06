import { create }    from 'zustand'
import { syncStore } from '../utils/storeSync.js'

export const MODULE = {
  ATC:   'ATC',
  CATCC: 'CATCC',
  AIC:   'AIC',
  ABM:   'ABM',
}

export const POSITION_MODE = {
  FREEFORM:   'FREEFORM',
  CONFIGURED: 'CONFIGURED',
}

export const useSessionStore = create((set) => ({
  // Olympus connection
  olympusUrl: '',
  coalition: '',
  relayUrl: '',   // SRS relay — optional, empty means none configured/reachable
  syncCapable: false,   // relay's /sync reachable + authenticated (checked in Login's ConnectPhase)
  connected: false,
  sourceType: null,     // 'olympus' | 'tacview' — from the WS status broadcast, see ws/client.js

  // Position identity
  positionMode: POSITION_MODE.FREEFORM,
  positionName: '',
  positionConfig: null,
  positionSet: false,
  signOnTime: null,

  // Facility
  facilityType: null,      // 'land' | 'carrier' | 'fir' | 'aic' | 'abm'
  facilityId: '',
  facilityDcsName: '',
  facilityName: '',
  positionTypeName: '',
  positionSuffix: '',      // raw suffix: 'TWR' | 'APP' | 'DEP' | 'CTR' etc.
  carrierUnitId: null,

  // Display preferences
  useDcsNames: localStorage.getItem('tracs.settings.useDcsNames') !== 'false',

  // Active module (single paradigm per window)
  activeModule: null,

  // AIC config
  aicCallsign: '',
  aicUnitId:   null,
  aicUnitName: '',

  // WebRTC / session
  webrtcStatus: 'disconnected',  // 'webrtc' | 'relay' | 'disconnected' | 'rejected'
  sessionCode: null,
  isHost: false,
  peers: [],
  controllerMessages: [],  // { id, from, fromPosition, text, timestamp, broadcast, toPosition? }[]
  unreadGeneral: 0,
  unreadDm: {},       // { [positionName]: number }
  openDmTabs: [],     // string[] ordered by open time
  activeMsgTab: 'main',
  webrtcRejection: null,   // string | null — survives resetPosition so Login can show it

  // Mission data (from Olympus)
  mission:   null,
  airbases:  null,
  bullseyes: null,

  setConnection: ({ olympusUrl, coalition, relayUrl }) =>
    set({ olympusUrl, coalition, relayUrl: relayUrl ?? '' }),

  setConnected: (connected) => set({ connected }),

  setSourceType: (sourceType) => set({ sourceType }),

  setSyncCapable: (syncCapable) => set({ syncCapable }),

  setPosition: ({ mode, name, config = null }) =>
    set({ positionMode: mode, positionName: name, positionConfig: config }),

  setFacility: ({ facilityType, facilityId, facilityDcsName = '', facilityName = '', positionTypeName = '', positionSuffix = '', carrierUnitId = null }) =>
    set({ facilityType, facilityId, facilityDcsName, facilityName, positionTypeName, positionSuffix, carrierUnitId }),

  setPositionSet: (val) => set({ positionSet: val, signOnTime: val ? Date.now() : null }),

  toggleDcsNames: () => set((s) => {
    const next = !s.useDcsNames
    localStorage.setItem('tracs.settings.useDcsNames', String(next))
    return { useDcsNames: next }
  }),

  setActiveModule: (module) => set({ activeModule: module }),

  setAicConfig: ({ callsign, unitId = null, unitName = '' }) =>
    set({ aicCallsign: callsign, aicUnitId: unitId, aicUnitName: unitName }),

  setMission:    (mission)    => set({ mission }),
  // Manual theatre override — needed regardless of source, since Tacview has
  // no reliable auto-detected theatre signal at all, and even its
  // majority-vote mitigation can never disambiguate MarianaIslands vs.
  // MarianaIslandsWWII (identical bboxes). Patches mission.mission.theatre
  // in place so every consumer that already reads mission?.mission?.theatre
  // sees the override with no other code changes.
  overrideTheatre: (theatre) => set((s) => ({
    mission: { ...s.mission, mission: { ...s.mission?.mission, theatre } },
  })),
  setAirbases:   (airbases)   => set({ airbases }),
  setBullseyes:  (bullseyes)  => set({ bullseyes }),

  setWebrtcStatus: (webrtcStatus) => set({ webrtcStatus }),

  setWebrtcRejection: (msg) => set({ webrtcRejection: msg }),
  clearWebrtcRejection: () => set({ webrtcRejection: null }),

  setSessionCode: (code) => set({ sessionCode: code }),

  setIsHost: (isHost) => set({ isHost }),

  setPeers: (peers) => set({ peers }),

  addControllerMessage: (msg) =>
    set((s) => {
      const id    = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const entry = { id, ...msg }
      const isDm  = !!msg.toPosition
      if (isDm) {
        const dmPartner  = msg.fromPosition === s.positionName ? msg.toPosition : msg.fromPosition
        const openDmTabs = s.openDmTabs.includes(dmPartner) ? s.openDmTabs : [...s.openDmTabs, dmPartner]
        const unreadDm   = { ...s.unreadDm, [dmPartner]: (s.unreadDm[dmPartner] ?? 0) + 1 }
        return { controllerMessages: [...s.controllerMessages, entry], openDmTabs, unreadDm }
      }
      return { controllerMessages: [...s.controllerMessages, entry], unreadGeneral: s.unreadGeneral + 1 }
    }),

  clearControllerMessages: () => set({ controllerMessages: [] }),

  markMessagesRead: (tab) =>
    set((s) => tab === 'main'
      ? { unreadGeneral: 0 }
      : { unreadDm: { ...s.unreadDm, [tab]: 0 } }
    ),

  openDmTab: (position) =>
    set((s) => ({
      openDmTabs:   s.openDmTabs.includes(position) ? s.openDmTabs : [...s.openDmTabs, position],
      activeMsgTab: position,
    })),

  closeDmTab: (position) =>
    set((s) => {
      const tabs   = s.openDmTabs.filter((t) => t !== position)
      const active = s.activeMsgTab === position ? 'main' : s.activeMsgTab
      const dm     = { ...s.unreadDm }
      delete dm[position]
      return { openDmTabs: tabs, activeMsgTab: active, unreadDm: dm }
    }),

  setActiveMsgTab: (tab) => set({ activeMsgTab: tab }),

  // Clears position fields only — keeps Olympus connection alive.
  // Used by Change Position in the top bar.
  resetPosition: () =>
    set({
      positionMode:        POSITION_MODE.FREEFORM,
      positionName:        '',
      positionConfig:      null,
      positionSet:         false,
      signOnTime:          null,
      facilityType:        null,
      facilityId:          '',
      facilityDcsName:     '',
      facilityName:        '',
      positionTypeName:    '',
      positionSuffix:      '',
      carrierUnitId:       null,
      activeModule:        null,
      aicCallsign:         '',
      aicUnitId:           null,
      aicUnitName:         '',
      webrtcStatus:        'disconnected',
      sessionCode:         null,
      isHost:              false,
      peers:               [],
      controllerMessages:  [],
      unreadGeneral:       0,
      unreadDm:            {},
      openDmTabs:          [],
      activeMsgTab:        'main',
      // webrtcRejection intentionally preserved — Login reads it after redirect
    }),

  // Full reset — drops Olympus connection and returns to Step 1.
  reset: () =>
    set({
      olympusUrl:          '',
      coalition:           '',
      relayUrl:            '',
      syncCapable:         false,
      connected:           false,
      positionMode:        POSITION_MODE.FREEFORM,
      positionName:        '',
      positionConfig:      null,
      positionSet:         false,
      signOnTime:          null,
      facilityType:        null,
      facilityId:          '',
      facilityDcsName:     '',
      facilityName:        '',
      positionTypeName:    '',
      positionSuffix:      '',
      carrierUnitId:       null,
      activeModule:        null,
      aicCallsign:         '',
      aicUnitId:           null,
      aicUnitName:         '',
      webrtcStatus:        'disconnected',
      sessionCode:         null,
      isHost:              false,
      peers:               [],
      controllerMessages:  [],
      unreadGeneral:       0,
      unreadDm:            {},
      openDmTabs:          [],
      activeMsgTab:        'main',
      mission:             null,
      airbases:            null,
      bullseyes:           null,
    }),
}))

// Sync the subset of session state used by the ControllerList popup window.
// Only these fields are broadcast — positionSet, webrtcStatus, etc. are local.
// Syncs only session-wide data (shared across all windows in the same session).
// facilityId and facilityName are per-scope and must NOT be synced here — doing so
// causes scope windows to overwrite each other's facility identity when multiple
// scopes are open simultaneously.
syncStore(useSessionStore, 'tracs-session-cl', (s) => ({
  airbases:  s.airbases,
  bullseyes: s.bullseyes,
  mission:   s.mission,
  peers:     s.peers,
}))
