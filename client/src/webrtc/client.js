import { joinRoom, selfId }   from 'trystero/nostr'
import { useSessionStore }    from '../store/session.js'
import { useAtcStore }        from '../store/atc.js'
import { useFlightPlansStore } from '../store/flightPlans.js'
import { useStatusBoardStore, applyStatusBoardUpdate, registerStatusBoardBroadcast } from '../store/statusBoard.js'
import { handleModuleMessage } from './handlers.js'

// ── Nostr relays ──────────────────────────────────────────────────────────────
const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
]

const DISCONNECT_TIMEOUT_MS = 10_000

// ── Runtime state ─────────────────────────────────────────────────────────────
let sessionRoom = null
let moduleRoom  = null
let sendSession = null
let sendModule  = null

let activePosition = ''
let activeModule   = ''
let activeFreq     = ''

let clientList = []   // { peerId, position, module, frequency, connectedAt }[]
let outSeq     = 0    // outgoing sequence counter

const disconnectTimers = {}  // peerId → timeoutId

// True while applying incoming data — suppresses re-broadcast in store subscriptions
let _applying = false
export function isApplying() { return _applying }

// ── Room ID derivation ────────────────────────────────────────────────────────
async function deriveRoomId(olympusAddress, password = '') {
  const normalized = olympusAddress
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
  const input = password ? `${normalized}:${password}` : normalized
  const hash  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const hex   = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
  return 'tracs-' + hex.substring(0, 16)
}

// ── Message envelope ──────────────────────────────────────────────────────────
function envelope(type, payload, mod) {
  return {
    version:      1,
    module:       mod ?? activeModule,
    type,
    fromPeerId:   selfId,
    fromPosition: activePosition,
    sequence:     ++outSeq,
    timestamp:    Date.now(),
    payload:      payload ?? {},
  }
}

// ── Client list helpers ───────────────────────────────────────────────────────
function resolvePosition(requested) {
  const taken = new Set(clientList.map(c => c.position))
  if (!taken.has(requested)) return requested
  let i = 1
  while (taken.has(`${requested}_${i}`)) i++
  return `${requested}_${i}`
}

function upsertClient(entry) {
  clientList = [...clientList.filter(c => c.peerId !== entry.peerId), entry]
    .sort((a, b) => a.connectedAt - b.connectedAt)
}

function removeClient(peerId) {
  clientList = clientList.filter(c => c.peerId !== peerId)
}

function oldestPeerOfModule(mod) {
  return clientList.filter(c => c.module === mod)[0]?.peerId ?? null
}

function syncPeers() {
  useSessionStore.getState().setPeers([...clientList])
}

// ── State persistence ─────────────────────────────────────────────────────────
function persistState(key, data) {
  fetch(`/api/state/${key}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data),
  }).catch(() => {})
}

function persistSession() {
  persistState('session', {
    clientList,
    olympusAddress:   useSessionStore.getState().olympusUrl,
    intentionalReset: false,
  })
}

// ── Build STATE_DUMP payload ──────────────────────────────────────────────────
async function buildDump(mod) {
  const base = { clientList }
  try {
    const data = await fetch(`/api/state/${mod.toLowerCase()}`).then(r => r.json())
    if (mod === 'ATC') {
      return {
        ...base,
        flightPlans:    data.flightPlans    ?? {},
        trackOwnership: data.trackOwnership ?? {},
        handoffs:       data.handoffs       ?? {},
        pointOuts:      data.pointOuts      ?? {},
      }
    }
    if (mod === 'CATCC') {
      return { ...base, statusBoard: data.statusBoard ?? {} }
    }
  } catch {}
  return base
}

// ── Apply STATE_DUMP payload ──────────────────────────────────────────────────
function applyAtcDump(payload) {
  const fps = useFlightPlansStore.getState()
  fps.reset()
  for (const plan of Object.values(payload.flightPlans ?? {})) fps.add(plan)

  const atc = useAtcStore.getState()
  atc.reset()
  for (const [uid, pos] of Object.entries(payload.trackOwnership ?? {})) atc.claimTrack(uid, pos)
  for (const [uid, ho]  of Object.entries(payload.handoffs       ?? {})) atc.setHandoff(uid, ho)
  for (const [uid, po]  of Object.entries(payload.pointOuts      ?? {})) atc.setPointOut(uid, po)
}

function applyCatccDump(payload) {
  if (payload.statusBoard) applyStatusBoardUpdate(payload.statusBoard)
}

function applyDump(mod, payload) {
  _applying = true
  try {
    if (payload.clientList) { clientList = payload.clientList; syncPeers() }
    if (mod === 'ATC')   applyAtcDump(payload)
    if (mod === 'CATCC') applyCatccDump(payload)
  } finally {
    _applying = false
  }
}

// ── Disconnect timeout ────────────────────────────────────────────────────────
function startDisconnectTimer(peerId) {
  clearTimeout(disconnectTimers[peerId])
  disconnectTimers[peerId] = setTimeout(() => {
    delete disconnectTimers[peerId]
    const entry = clientList.find(c => c.peerId === peerId)
    if (!entry) return

    removeClient(peerId)
    syncPeers()
    persistSession()

    // Drop all tracks owned by the lost position
    const { ownership, dropTrack } = useAtcStore.getState()
    for (const [uid, owner] of Object.entries(ownership)) {
      if (owner === entry.position) dropTrack(uid)
    }

    sendSession?.(envelope('PEER_DISCONNECTED', {
      position: entry.position,
      module:   entry.module,
      peerId,
    }))
    sendSession?.(envelope('CLIENT_LIST_UPDATE', { clients: clientList }))
  }, DISCONNECT_TIMEOUT_MS)
}

// ── Incoming session-room message handler ─────────────────────────────────────
async function onSessionMessage(msg, fromPeerId) {
  if (!msg?.type) return

  switch (msg.type) {
    case 'HANDSHAKE': {
      const resolved = resolvePosition(msg.payload.position)

      // Reconnect: cancel the pending timer and remap the old peer ID
      if (msg.payload.previousPeerId) {
        clearTimeout(disconnectTimers[msg.payload.previousPeerId])
        delete disconnectTimers[msg.payload.previousPeerId]
        removeClient(msg.payload.previousPeerId)
      }

      upsertClient({
        peerId:      fromPeerId,
        position:    resolved,
        module:      msg.payload.module,
        frequency:   msg.payload.frequency ?? '',
        connectedAt: Date.now(),
      })
      syncPeers()
      persistSession()

      // Oldest peer of their module sends STATE_DUMP
      if (oldestPeerOfModule(msg.payload.module) === selfId) {
        const dump = await buildDump(msg.payload.module)
        sendSession?.(envelope('STATE_DUMP', dump), fromPeerId)
      }

      const ack = resolved !== msg.payload.position ? { resolvedPosition: resolved } : {}
      sendSession?.(envelope('HANDSHAKE_ACK', ack), fromPeerId)
      sendSession?.(envelope('CLIENT_LIST_UPDATE', { clients: clientList }))
      break
    }

    case 'HANDSHAKE_ACK': {
      if (msg.payload?.resolvedPosition) {
        activePosition = msg.payload.resolvedPosition
        useSessionStore.setState({ positionName: activePosition })
      }
      useSessionStore.getState().setWebrtcStatus('connected')
      break
    }

    case 'STATE_DUMP': {
      applyDump(activeModule, msg.payload)
      useSessionStore.getState().setWebrtcStatus('connected')
      break
    }

    case 'CLIENT_LIST_UPDATE': {
      clientList = msg.payload.clients ?? []
      syncPeers()
      break
    }

    case 'PEER_DISCONNECTED': {
      removeClient(msg.payload.peerId)
      syncPeers()
      break
    }
  }
}

// ── Incoming module-room message handler ──────────────────────────────────────
function onModuleMessage(msg) {
  if (!msg?.type || _applying) return
  _applying = true
  try {
    handleModuleMessage(msg)
  } finally {
    _applying = false
  }
  // Persist state after applying remote event
  if (activeModule === 'ATC') {
    const atc = useAtcStore.getState()
    const fps = useFlightPlansStore.getState()
    persistState('atc', {
      flightPlans:    fps.plans,
      trackOwnership: atc.ownership,
      handoffs:       atc.handoffs,
      pointOuts:      atc.pointOuts,
    })
  }
  if (activeModule === 'CATCC') {
    const s = useStatusBoardStore.getState()
    persistState('catcc', {
      statusBoard: {
        eventHeader:    { event: s.event, launch: s.launch, recovery: s.recovery, tz: s.tz },
        recoveryStatus: { caseLaunch: s.caseLaunch, caseRecovery: s.caseRecovery, app: s.app, marBtn: s.marBtn, twrBtn: s.twrBtn, depBtn: s.depBtn },
        entries:        s.entries,
      },
    })
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Send a module-room event (called from actions/store subscriptions)
export function sendWebrtcEvent(type, payload) {
  if (!sendModule || _applying) return
  sendModule(envelope(type, payload))
}

export async function initWebrtc({ olympusUrl, password, position, module: mod, frequency }) {
  activePosition = position
  activeModule   = mod
  activeFreq     = frequency
  outSeq         = 0
  clientList     = []

  const sessionRoomId = await deriveRoomId(olympusUrl, password)
  const moduleRoomId  = `${sessionRoomId}-${mod.toLowerCase()}`
  const cfg = { appId: 'tracs', relayUrls: NOSTR_RELAYS }

  sessionRoom = joinRoom(cfg, sessionRoomId)
  moduleRoom  = joinRoom(cfg, moduleRoomId)

  const [_sendSession, getSession] = sessionRoom.makeAction('msg')
  const [_sendModule,  getModule]  = moduleRoom.makeAction('msg')
  sendSession = _sendSession
  sendModule  = _sendModule

  getSession(onSessionMessage)
  getModule(onModuleMessage)

  if (mod === 'CATCC') {
    registerStatusBoardBroadcast((payload) => sendWebrtcEvent('STATUS_BOARD_UPDATE', payload))
  }

  // Add self immediately — if first peer, we're already "connected"
  upsertClient({ peerId: selfId, position, module: mod, frequency, connectedAt: Date.now() })
  syncPeers()
  useSessionStore.getState().setWebrtcStatus('connected')
  persistSession()

  // Send HANDSHAKE once when the first existing peer is discovered
  let handshakeSent = false
  sessionRoom.onPeerJoin(() => {
    if (handshakeSent) return
    handshakeSent = true
    sendSession(envelope('HANDSHAKE', { position, module: mod, frequency }))
  })

  sessionRoom.onPeerLeave(startDisconnectTimer)
}

export async function disconnectWebrtc() {
  registerStatusBoardBroadcast(null)
  await fetch('/api/state/intentional-reset', { method: 'POST' }).catch(() => {})

  sessionRoom?.leave()
  moduleRoom?.leave()
  sessionRoom = null
  moduleRoom  = null
  sendSession = null
  sendModule  = null
  clientList  = []
  outSeq      = 0

  for (const t of Object.values(disconnectTimers)) clearTimeout(t)
  for (const k of Object.keys(disconnectTimers))   delete disconnectTimers[k]

  useSessionStore.getState().setWebrtcStatus('disconnected')
  useSessionStore.getState().setPeers([])
}

export { selfId }
