import { create }    from 'zustand'
import { syncStore } from '../utils/storeSync.js'

export const MODULE = {
  ATC:   'ATC',
  CATCC: 'CATCC',
  AIC:   'AIC',
}

export const POSITION_MODE = {
  FREEFORM:   'FREEFORM',
  CONFIGURED: 'CONFIGURED',
}

export const useSessionStore = create((set) => ({
  // Olympus connection
  olympusUrl: '',
  coalition: '',
  connected: false,

  // Position identity
  positionMode: POSITION_MODE.FREEFORM,
  positionName: '',
  positionConfig: null,
  positionSet: false,
  signOnTime: null,

  // Facility
  facilityType: null,      // 'land' | 'carrier' | 'fir' | 'aic'
  facilityId: '',
  facilityDcsName: '',
  facilityName: '',
  positionTypeName: '',
  positionSuffix: '',      // raw suffix: 'TWR' | 'APP' | 'DEP' | 'CTR' etc.
  carrierUnitId: null,

  // Display preferences
  showPilotCallsigns: true,

  // Active module (single paradigm per window)
  activeModule: null,

  // AIC config
  aicCallsign: '',
  aicUnitId:   null,
  aicUnitName: '',

  // WebRTC / session
  webrtcStatus: 'disconnected',  // 'connected' | 'relay' | 'disconnected' | 'rejected'
  sessionCode: null,
  isHost: false,
  peers: [],
  controllerMessages: [],  // { from, text, timestamp, broadcast }[]
  webrtcRejection: null,   // string | null — survives resetPosition so Login can show it

  // Mission data (from Olympus)
  mission: null,
  airbases: [],

  setConnection: ({ olympusUrl, coalition }) =>
    set({ olympusUrl, coalition }),

  setConnected: (connected) => set({ connected }),

  setPosition: ({ mode, name, config = null }) =>
    set({ positionMode: mode, positionName: name, positionConfig: config }),

  setFacility: ({ facilityType, facilityId, facilityDcsName = '', facilityName = '', positionTypeName = '', positionSuffix = '', carrierUnitId = null }) =>
    set({ facilityType, facilityId, facilityDcsName, facilityName, positionTypeName, positionSuffix, carrierUnitId }),

  setPositionSet: (val) => set({ positionSet: val, signOnTime: val ? Date.now() : null }),

  togglePilotCallsigns: () => set((s) => ({ showPilotCallsigns: !s.showPilotCallsigns })),

  setActiveModule: (module) => set({ activeModule: module }),

  setAicConfig: ({ callsign, unitId = null, unitName = '' }) =>
    set({ aicCallsign: callsign, aicUnitId: unitId, aicUnitName: unitName }),

  setMission: (mission) => set({ mission }),

  setAirbases: (airbases) => set({ airbases }),

  setWebrtcStatus: (webrtcStatus) => set({ webrtcStatus }),

  setWebrtcRejection: (msg) => set({ webrtcRejection: msg }),
  clearWebrtcRejection: () => set({ webrtcRejection: null }),

  setSessionCode: (code) => set({ sessionCode: code }),

  setIsHost: (isHost) => set({ isHost }),

  setPeers: (peers) => set({ peers }),

  addControllerMessage: (msg) =>
    set((s) => ({ controllerMessages: [...s.controllerMessages, msg] })),

  clearControllerMessages: () => set({ controllerMessages: [] }),

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
      // webrtcRejection intentionally preserved — Login reads it after redirect
    }),

  // Full reset — drops Olympus connection and returns to Step 1.
  reset: () =>
    set({
      olympusUrl:          '',
      coalition:           '',
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
      mission:             null,
      airbases:            [],
    }),
}))

// Sync the subset of session state used by the ControllerList popup window.
// Only these fields are broadcast — positionSet, webrtcStatus, etc. are local.
// Syncs only session-wide data (shared across all windows in the same session).
// facilityId and facilityName are per-scope and must NOT be synced here — doing so
// causes scope windows to overwrite each other's facility identity when multiple
// scopes are open simultaneously.
syncStore(useSessionStore, 'tracs-session-cl', (s) => ({
  airbases: s.airbases,
  mission:  s.mission,
  peers:    s.peers,
}))
