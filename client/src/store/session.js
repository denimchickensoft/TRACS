import { create } from 'zustand'

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
  webrtcStatus: 'disconnected',  // 'connected' | 'relay' | 'disconnected'
  sessionCode: null,
  isHost: false,
  peers: [],

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

  setSessionCode: (code) => set({ sessionCode: code }),

  setIsHost: (isHost) => set({ isHost }),

  setPeers: (peers) => set({ peers }),

  // Clears position fields only — keeps Olympus connection alive.
  // Used by Change Position in the top bar.
  resetPosition: () =>
    set({
      positionMode:     POSITION_MODE.FREEFORM,
      positionName:     '',
      positionConfig:   null,
      positionSet:      false,
      signOnTime:       null,
      facilityType:     null,
      facilityId:       '',
      facilityDcsName:  '',
      facilityName:     '',
      positionTypeName: '',
      positionSuffix:   '',
      carrierUnitId:    null,
      activeModule:     null,
      aicCallsign:      '',
      aicUnitId:        null,
      aicUnitName:      '',
      webrtcStatus:     'disconnected',
      sessionCode:      null,
      isHost:           false,
      peers:            [],
    }),

  // Full reset — drops Olympus connection and returns to Step 1.
  reset: () =>
    set({
      olympusUrl:       '',
      coalition:        '',
      connected:        false,
      positionMode:     POSITION_MODE.FREEFORM,
      positionName:     '',
      positionConfig:   null,
      positionSet:      false,
      signOnTime:       null,
      facilityType:     null,
      facilityId:       '',
      facilityDcsName:  '',
      facilityName:     '',
      positionTypeName: '',
      positionSuffix:   '',
      carrierUnitId:    null,
      activeModule:     null,
      aicCallsign:      '',
      aicUnitId:        null,
      aicUnitName:      '',
      webrtcStatus:     'disconnected',
      sessionCode:      null,
      isHost:           false,
      peers:            [],
      mission:          null,
      airbases:         [],
    }),
}))
