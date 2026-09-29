import { create } from 'zustand'
import { shallowEqual } from '../utils/storeSync.js'

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
  // Coalition Password — stored here (unlike Session Password, which stays
  // local PositionPhase state) specifically so PositionPhase's initWebrtc()
  // call can reach it for relay auth; ConnectPhase and PositionPhase are
  // separate components with no shared closure, same reason olympusUrl/
  // coalition/relayUrl already flow through here instead of props.
  password: '',
  // The password actually used to authenticate to the relay (SRS/sync/relay-
  // primary auth) — usually equal to `password` (Olympus and Relay-mode
  // source-selector modes are both genuinely per-coalition, matching the
  // relay's own per-coalition model), but a distinct value in Tacview-Direct
  // mode with a relay also configured: Tacview's own RTT password is flat/
  // not coalition-scoped, so it can't double as the relay's per-coalition
  // secret there. Set by ConnectPhase's handleConnect, read by PositionPhase's
  // initWebrtc() call — same no-shared-closure reason as `password` above.
  relayPassword: '',
  relayUrl: '',   // SRS relay — optional, empty means none configured/reachable
  syncCapable: false,   // relay's /sync reachable + authenticated (checked in Login's ConnectPhase)
  connected: false,
  // Why the data source is disconnected or being retried, from the server's
  // status reason (e.g. Olympus unreachable and retrying), or null. Shown in
  // the top bar.
  connectionIssue: null,
  // The source is still selected but has stopped responding and is being
  // retried: the top bar shows NO RESPONSE: RECONNECTING.
  connectionRetrying: false,
  // 'olympus' | 'tacview' — set optimistically by ConnectPhase's setConnection
  // (matching the source-selector's mode, collapsing 'tacview-direct'/'relay'
  // both to 'tacview' here since that's the dispatch-level distinction this
  // field represents), then confirmed authoritatively moments later by the WS
  // status broadcast (see ws/client.js). Not the same enum as the selector's
  // 3-way sourceMode — this only ever needs the 2-way dispatch distinction.
  sourceType: null,

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
  // Global audio mute — gates every alertTone.js channel (STARS CA, ABM
  // missile-launch, and any future one) at the single choke point rather
  // than each module's own call site. See audio/alertTone.js's pulse().
  soundsEnabled: localStorage.getItem('tracs.settings.soundsEnabled') !== 'false',

  // Active module (single paradigm per window)
  activeModule: null,

  // AIC config
  aicCallsign: '',
  aicUnitId:   null,
  aicUnitName: '',

  // WebRTC / session
  webrtcStatus: 'disconnected',  // 'webrtc' | 'relay' | 'disconnected' | 'rejected'
  // Relay sync connection trouble, shown in the top bar: null (fine or not
  // in use) | 'retrying' | 'password' | 'protocol'.
  syncIssue: null,
  // Same values for the SRS transponder feed from the relay (server srs.js).
  srsIssue: null,
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

  setConnection: ({ olympusUrl, coalition, password, relayUrl, relayPassword, sourceType }) =>
    set({
      olympusUrl, coalition, password: password ?? '', relayUrl: relayUrl ?? '',
      relayPassword: relayPassword ?? '',
      ...(sourceType ? { sourceType } : {}),
    }),

  setConnected: (connected) => set({ connected }),
  setConnectionIssue: (connectionIssue) => set({ connectionIssue }),
  setConnectionRetrying: (connectionRetrying) => set({ connectionRetrying }),
  setSyncIssue: (syncIssue) => set({ syncIssue }),
  setSrsIssue: (srsIssue) => set({ srsIssue }),

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

  toggleSounds: () => set((s) => {
    const next = !s.soundsEnabled
    localStorage.setItem('tracs.settings.soundsEnabled', String(next))
    return { soundsEnabled: next }
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
  // sees the override with no other code changes. theatreOverridden mirrors
  // the flag the server sends with the theatre; null means back to
  // auto-detect.
  overrideTheatre: (theatre) => set((s) => ({
    mission: { ...s.mission, mission: { ...s.mission?.mission, theatre, theatreOverridden: theatre != null } },
  })),
  setAirbases:   (airbases)   => set({ airbases }),
  setBullseyes:  (bullseyes)  => set({ bullseyes }),

  setWebrtcStatus: (webrtcStatus) => set({ webrtcStatus }),

  setWebrtcRejection: (msg) => set({ webrtcRejection: msg }),
  clearWebrtcRejection: () => set({ webrtcRejection: null }),

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
      syncIssue:           null,
      srsIssue:            null,
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
      password:            '',
      relayPassword:       '',
      relayUrl:            '',
      syncCapable:         false,
      connected:           false,
      connectionIssue:     null,
      connectionRetrying:  false,
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
      syncIssue:           null,
      srsIssue:            null,
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

// Sync the subset of session state every popup window (StatusBoard, BraaList,
// Ato, Frag, AbmScope's focus panel, ControllerList, AsdexScope, ...) may
// depend on. Only these fields are broadcast — positionSet, webrtcStatus,
// etc. are local. facilityId/facilityName/facilityDcsName/carrierUnitId are
// per-scope and must NOT be synced here — those are instead passed as URL
// params by whichever window opens the popup (see App.jsx's undock handlers).
//
// Scoped to "this position's own windows" specifically (facilityId +
// positionName keyed into the channel name), NOT a global broadcast — unlike
// the older assumption behind this code ("coalition/positionName/
// activeModule... never legitimately differ between two windows in the same
// session"), which held for every case before Electron's "New Window"
// feature made a second, genuinely independent, Login-capable window
// possible. A global channel here would let signing into position B in one
// window silently overwrite position A's identity in a completely unrelated
// window. Mirrors store/strips.js's identical scoped-sync structure exactly.
if (typeof window !== 'undefined') {
  const _params  = new URLSearchParams(window.location.search)
  const _isPopup = !!_params.get('window')
  const _pick    = (s) => ({
    airbases:     s.airbases,
    bullseyes:    s.bullseyes,
    mission:      s.mission,
    peers:        s.peers,
    coalition:    s.coalition,
    positionName: s.positionName,
    activeModule: s.activeModule,
  })

  let _ch        = null
  let _isSyncing = false

  const _channelName = (facilityId, positionName) => `tracs-session-cl-${facilityId}-${positionName}`

  function _setupChannel(facilityId, positionName) {
    _ch?.close()
    _ch = new BroadcastChannel(_channelName(facilityId, positionName))
    _ch.onmessage = (e) => {
      if (e.data?.type === 'STATE_UPDATE') {
        _isSyncing = true
        useSessionStore.setState(e.data.state)
        _isSyncing = false
      } else if (e.data?.type === 'REQUEST_STATE') {
        _ch.postMessage({ type: 'STATE_UPDATE', state: _pick(useSessionStore.getState()) })
      }
    }
    _ch.postMessage({ type: 'REQUEST_STATE' })
  }

  useSessionStore.subscribe((state, prev) => {
    if (_isSyncing || !_ch) return
    const slice = _pick(state)
    if (!shallowEqual(slice, _pick(prev))) _ch.postMessage({ type: 'STATE_UPDATE', state: slice })
  })

  if (_isPopup) {
    // A popup already knows its owning position from the URL the moment it
    // opens (see App.jsx's makeUndockHandler / bespoke undock handlers).
    _setupChannel(_params.get('facilityId') ?? '', _params.get('positionName') ?? '')
  } else {
    // Main window (the original one, or any additional one opened via New
    // Window): facilityId/positionName are blank until login completes
    // (setFacility()/setConnection(), which run well after this module's
    // top-level code does) — defer channel setup until they're actually
    // known, and re-key it if they ever change (e.g. signing into a
    // different position later without restarting the window).
    let _lastKey = null
    const _trySetup = () => {
      const { facilityId, positionName } = useSessionStore.getState()
      if (!facilityId || !positionName) return
      const key = _channelName(facilityId, positionName)
      if (key === _lastKey) return
      _lastKey = key
      _setupChannel(facilityId, positionName)
    }
    useSessionStore.subscribe(_trySetup)
    _trySetup()
  }
}
