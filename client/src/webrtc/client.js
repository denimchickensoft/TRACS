import { joinRoom, selfId }   from '@trystero-p2p/ws-relay'
import { useSessionStore }    from '../store/session.js'
import { useAtcStore }        from '../store/atc.js'
import { useFlightPlansStore } from '../store/flightPlans.js'
import { useStatusBoardStore, applyStatusBoardUpdate, registerStatusBoardBroadcast } from '../store/statusBoard.js'
import { useControllersStore } from '../store/controllers.js'
import { handleModuleMessage } from './handlers.js'

// ── Signal relay URL (same server the browser loaded from) ────────────────────
function getSignalUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/signal`
}

// ── ICE server list — STUN always, optional TURN from server env ──────────────
async function fetchIceServers() {
  const defaults = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
  try {
    const res = await fetch('/api/turn-credentials')
    if (!res.ok) return defaults
    const { iceServers } = await res.json()
    return iceServers ?? defaults
  } catch {
    return defaults
  }
}

const DISCONNECT_TIMEOUT_MS = 10_000
const PEER_ID_STORAGE_KEY   = 'tracs.previousPeerId'

// ── Runtime state ─────────────────────────────────────────────────────────────
let sessionRoom = null
let moduleRoom  = null
let sendSession = null
let sendModule  = null

let activePosition = ''
let activeModule   = ''
let activeFreq     = ''
let activeFacility = ''
let activeSuffix   = ''

let clientList = []   // { peerId, position, module, frequency, connectedAt }[]
let outSeq     = 0    // outgoing sequence counter
let peerSeqs   = {}   // peerId → last received sequence (for STATE_DUMP peerSequences)

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

// ── Dev logging ───────────────────────────────────────────────────────────────
function logMsg(direction, msg, targetPeerId) {
  const target = targetPeerId ? ` → ${targetPeerId.slice(0, 6)}` : ''
  const from   = msg.fromPosition || msg.fromPeerId?.slice(0, 6) || '?'
  console.debug(`[webrtc] ${direction}${target} [${msg.type}] seq=${msg.sequence} from=${from}`, msg.payload)
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
  // Insert collision index before the last underscore-delimited segment.
  // e.g. KLAS_APP → KLAS_1_APP, KLAS_2_APP, …
  const lastUnderscore = requested.lastIndexOf('_')
  const prefix = lastUnderscore >= 0 ? requested.slice(0, lastUnderscore) : requested
  const suffix = lastUnderscore >= 0 ? `_${requested.slice(lastUnderscore + 1)}` : ''
  let i = 1
  while (true) {
    const candidate = `${prefix}_${i}${suffix}`
    if (!taken.has(candidate)) return candidate
    i++
  }
}

function upsertClient(entry) {
  clientList = [...clientList.filter(c => c.peerId !== entry.peerId), entry]
    .sort((a, b) => a.connectedAt - b.connectedAt)
}

function removeClient(peerId) {
  clientList = clientList.filter(c => c.peerId !== peerId)
}

// Peers inside disconnectTimers have fired onPeerLeave — they may be gone.
// The effective list excludes them so host duties transfer immediately on leave,
// without waiting for the full DISCONNECT_TIMEOUT_MS reconnect window to expire.
function effectiveClientList() {
  return clientList.filter(c => !disconnectTimers[c.peerId])
}

function oldestPeerOfModule(mod) {
  return effectiveClientList().filter(c => c.module === mod)[0]?.peerId ?? null
}

function syncPeers() {
  useSessionStore.getState().setPeers([...clientList])
  useControllersStore.getState().rebuildFromClientList(clientList)
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
  const base = {
    clientList,
    peerSequences: { ...peerSeqs, [selfId]: outSeq },
  }
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

  // Build the set of controller IDs that are actually present in the dumped
  // session. syncPeers() has already run, so the registry reflects the dump's
  // clientList. Any ownership/handoff referencing an absent ID is stale and
  // must not be restored — it would show phantom ownership with no way to clear.
  const activeIds = new Set(
    Object.values(useControllersStore.getState().registry)
      .map((e) => e.controllerId)
      .filter(Boolean)
  )

  const atc = useAtcStore.getState()
  atc.reset()
  for (const [uid, cid] of Object.entries(payload.trackOwnership ?? {})) {
    if (activeIds.has(cid)) atc.claimTrack(uid, cid)
  }
  for (const [uid, ho] of Object.entries(payload.handoffs ?? {})) {
    if (activeIds.has(ho.from) && activeIds.has(ho.to)) atc.setHandoff(uid, ho)
  }
  for (const [uid, po] of Object.entries(payload.pointOuts ?? {})) {
    if (activeIds.has(po.from) && activeIds.has(po.to)) atc.setPointOut(uid, po)
  }
}

function applyCatccDump(payload) {
  if (payload.statusBoard) applyStatusBoardUpdate(payload.statusBoard)
}

function applyDump(mod, payload) {
  _applying = true
  try {
    if (payload.clientList) { clientList = payload.clientList; syncPeers() }
    if (payload.peerSequences) Object.assign(peerSeqs, payload.peerSequences)
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

    // Capture controllerId before removing — needed to check if still active after sync
    const lostControllerId = useControllersStore.getState().registry[entry.position]?.controllerId ?? null

    removeClient(peerId)
    syncPeers()
    persistSession()

    // Drop tracks and clear handoffs/pointOuts only if no remaining controller
    // shares the same controllerId. If UGKO_1_TWR leaves but UGKO_TWR is still
    // connected (same 1T), ownership stays.
    if (lostControllerId) {
      const newRegistry = useControllersStore.getState().registry
      const stillActive = Object.values(newRegistry).some(e => e.controllerId === lostControllerId)
      if (!stillActive) {
        const atc = useAtcStore.getState()
        for (const [uid, owner] of Object.entries(atc.ownership)) {
          if (owner === lostControllerId) atc.dropTrack(uid)
        }
        // Clear any pending handoffs or point-outs involving the lost controller.
        // Leaving them would produce phantom "receiving" states that can never resolve.
        for (const [uid, ho] of Object.entries(atc.handoffs)) {
          if (ho.from === lostControllerId || ho.to === lostControllerId) atc.clearHandoff(uid)
        }
        for (const [uid, po] of Object.entries(atc.pointOuts)) {
          if (po.from === lostControllerId || po.to === lostControllerId) atc.clearPointOut(uid)
        }

        // Persist the cleaned-up state so future joiners don't receive stale
        // ownership from the server. Without this, the server retains the
        // departed controller's tracks indefinitely.
        const atcClean = useAtcStore.getState()
        persistState('atc', {
          flightPlans:    useFlightPlansStore.getState().plans,
          trackOwnership: atcClean.ownership,
          handoffs:       atcClean.handoffs,
          pointOuts:      atcClean.pointOuts,
        })
      }
    }

    sendSession?.(envelope('PEER_DISCONNECTED', {
      position: entry.position,
      module:   entry.module,
      peerId,
    }))
    sendSession?.(envelope('CLIENT_LIST_UPDATE', { clients: clientList }))
  }, DISCONNECT_TIMEOUT_MS)
}

// ── Track received sequence per peer ─────────────────────────────────────────
function trackSeq(msg) {
  if (msg?.fromPeerId && msg?.sequence) peerSeqs[msg.fromPeerId] = msg.sequence
}

// ── Incoming session-room message handler ─────────────────────────────────────
async function onSessionMessage(msg, fromPeerId) {
  if (!msg?.type) return
  logMsg('← session', msg)
  trackSeq(msg)

  switch (msg.type) {
    case 'HANDSHAKE': {
      const senderConnectedAt = msg.payload.connectedAt ?? Date.now()
      const myConnectedAt     = clientList.find(c => c.peerId === selfId)?.connectedAt ?? Date.now()

      // The global host is the single authority for session coordination: position
      // resolution, ACK, and CLIENT_LIST_UPDATE. It is whichever currently-connected
      // peer has the earliest connectedAt. We determine this BEFORE adding the sender
      // so that resolvePosition() sees only existing entries.
      //
      // A peer is the host when:
      //   (a) the sender is newer than us — we were here first, AND
      //   (b) we are currently the oldest in the room (first in sorted clientList)
      //
      // Non-hosts record the sender's requested position and will be corrected by
      // the host's CLIENT_LIST_UPDATE.
      // Use the effective list (excludes peers in the disconnect window) so that
      // host duties transfer immediately when the current host fires onPeerLeave,
      // rather than waiting for the full reconnect timeout to expire.
      const effective      = effectiveClientList()
      const senderIsNewer  = senderConnectedAt > myConnectedAt
      const amGlobalHost   = senderIsNewer && (effective[0]?.peerId === selfId || effective.length === 0)

      // Only the host resolves position conflicts.
      const resolved = amGlobalHost
        ? resolvePosition(msg.payload.position)
        : msg.payload.position

      // Reconnect: cancel the pending timer and remap the old peer ID
      if (msg.payload.previousPeerId) {
        clearTimeout(disconnectTimers[msg.payload.previousPeerId])
        delete disconnectTimers[msg.payload.previousPeerId]
        removeClient(msg.payload.previousPeerId)
      }

      // Host: frequency deconfliction — reject before upserting.
      // A frequency is blocked if another position with a different facility+suffix
      // is already using it. Same facility+suffix = same controllerId = allowed to share.
      if (amGlobalHost && msg.payload.frequency) {
        const incomingFreq = parseFloat(msg.payload.frequency).toFixed(3)
        const incomingFac  = msg.payload.facility ?? ''
        const incomingSuf  = msg.payload.suffix   ?? ''
        const conflict = clientList.find(c => {
          if (!c.frequency) return false
          if (parseFloat(c.frequency).toFixed(3) !== incomingFreq) return false
          return c.facility !== incomingFac || c.suffix !== incomingSuf
        })
        if (conflict) {
          const rejectMsg = envelope('HANDSHAKE_REJECT', {
            reason:          'DUPLICATE_FREQUENCY',
            conflictPosition: conflict.position,
            frequency:       incomingFreq,
          })
          logMsg('→ session', rejectMsg, fromPeerId)
          sendSession?.(rejectMsg, fromPeerId)
          break
        }
      }

      upsertClient({
        peerId:      fromPeerId,
        position:    resolved,
        module:      msg.payload.module,
        frequency:   msg.payload.frequency  ?? '',
        facility:    msg.payload.facility   ?? '',
        suffix:      msg.payload.suffix     ?? '',
        connectedAt: senderConnectedAt,
      })
      syncPeers()
      persistSession()

      // Non-hosts stop here — the host's ACK and CLU will correct all peers.
      if (!amGlobalHost) break

      // Host: oldest module peer sends STATE_DUMP
      if (oldestPeerOfModule(msg.payload.module) === selfId) {
        const dump = await buildDump(msg.payload.module)
        const dumpMsg = envelope('STATE_DUMP', dump)
        logMsg('→ session', dumpMsg, fromPeerId)
        sendSession?.(dumpMsg, fromPeerId)
      }

      // Host: send ACK (with resolved position if changed) and authoritative CLU
      const ack    = resolved !== msg.payload.position ? { resolvedPosition: resolved } : {}
      const ackMsg = envelope('HANDSHAKE_ACK', ack)
      const cluMsg = envelope('CLIENT_LIST_UPDATE', { clients: clientList })
      logMsg('→ session', ackMsg, fromPeerId)
      logMsg('→ session', cluMsg)
      sendSession?.(ackMsg, fromPeerId)
      sendSession?.(cluMsg)
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

    case 'HANDSHAKE_REJECT': {
      const reason      = msg.payload?.reason ?? 'REJECTED'
      const freq        = msg.payload?.frequency ?? ''
      const conflictPos = msg.payload?.conflictPosition ?? ''
      const message = reason === 'DUPLICATE_FREQUENCY'
        ? `Frequency ${freq} MHz is already in use by ${conflictPos}.`
        : 'Sign-on rejected by the session host.'
      useSessionStore.getState().setWebrtcRejection(message)
      await disconnectWebrtc()
      useSessionStore.getState().resetPosition()
      break
    }

    case 'STATE_DUMP': {
      applyDump(activeModule, msg.payload)
      useSessionStore.getState().setWebrtcStatus('connected')
      break
    }

    case 'CLIENT_LIST_UPDATE': {
      // Merge the incoming list with ours: update/add entries from the host's view,
      // but never remove peers we already track — only PEER_DISCONNECTED and the
      // disconnect timer remove peers. This prevents a stale CLU from resurrecting
      // a disconnected peer or erasing a peer the host hasn't heard about yet.
      const incoming = msg.payload.clients ?? []
      const incomingById = Object.fromEntries(incoming.map(c => [c.peerId, c]))
      const merged = clientList
        .map(c => incomingById[c.peerId] ?? c)   // update existing entries
        .concat(incoming.filter(c => !clientList.some(e => e.peerId === c.peerId))) // add new
      clientList = merged.sort((a, b) => a.connectedAt - b.connectedAt)
      syncPeers()
      break
    }

    case 'PEER_DISCONNECTED': {
      // Never remove self — a remote peer can't authoritatively declare us gone.
      if (msg.payload.peerId !== selfId) {
        removeClient(msg.payload.peerId)
        syncPeers()
      }
      break
    }

    case 'CONTROLLER_MESSAGE': {
      const { toPosition, toModule, text, broadcast } = msg.payload
      if (broadcast || toPosition === activePosition) {
        useSessionStore.getState().addControllerMessage({
          from:      msg.fromPosition,
          text,
          broadcast: !!broadcast,
          timestamp: msg.timestamp ?? Date.now(),
        })
      }
      break
    }
  }
}

// ── Incoming module-room message handler ──────────────────────────────────────
function onModuleMessage(msg) {
  if (!msg?.type || _applying) return
  logMsg('← module', msg)
  trackSeq(msg)
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
  const msg = envelope(type, payload)
  logMsg('→ module', msg)
  sendModule(msg)
}

// Send a CONTROLLER_MESSAGE on the session room
export function sendControllerMessage({ toPosition, toModule, text, broadcast = false }) {
  if (!sendSession) return
  const msg = envelope('CONTROLLER_MESSAGE', { toPosition, toModule, text, broadcast }, activeModule)
  logMsg('→ session', msg)
  sendSession(msg)
}

export async function initWebrtc({ olympusUrl, password, position, module: mod, frequency, facility = '', suffix = '' }) {
  activePosition = position
  activeModule   = mod
  activeFreq     = frequency
  activeFacility = facility
  activeSuffix   = suffix
  outSeq         = 0
  clientList     = []
  peerSeqs       = {}

  // Recover the peer ID from the previous session for browser-refresh reconnect.
  // sessionStorage is per-tab — survives reloads but is not shared between windows,
  // so a second position signing in on the same machine never sees another tab's peerId.
  const previousPeerId = sessionStorage.getItem(PEER_ID_STORAGE_KEY) ?? undefined
  sessionStorage.setItem(PEER_ID_STORAGE_KEY, selfId)

  const sessionRoomId = await deriveRoomId(olympusUrl, password)
  const moduleRoomId  = `${sessionRoomId}-${mod.toLowerCase()}`
  const iceServers = await fetchIceServers()
  const cfg = {
    appId: 'tracs',
    relayConfig: { urls: [getSignalUrl()] },
    rtcConfig: { iceServers },
  }

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
  const myConnectedAt = Date.now()
  upsertClient({ peerId: selfId, position, module: mod, frequency, facility, suffix, connectedAt: myConnectedAt })
  syncPeers()
  useSessionStore.getState().setWebrtcStatus('connected')
  persistSession()

  // onPeerJoin fires on BOTH sides when a connection is established, so both peers
  // send HANDSHAKE. The receiver must use the sender's actual sign-on time (myConnectedAt)
  // rather than Date.now() so that ordinal IDs (1T, 2T, …) reflect true sign-in order.
  let handshakeSent = false
  sessionRoom.onPeerJoin((peerId) => {
    // Reconnect: cancel the pending disconnect timer so the peer isn't evicted.
    // This covers the case where a brief network blip triggers onPeerLeave then
    // onPeerJoin without a new HANDSHAKE (handshakeSent is already true).
    if (disconnectTimers[peerId]) {
      clearTimeout(disconnectTimers[peerId])
      delete disconnectTimers[peerId]
    }
    if (handshakeSent) return
    handshakeSent = true
    const hsMsg = envelope('HANDSHAKE', { position, module: mod, frequency, facility, suffix, connectedAt: myConnectedAt, previousPeerId })
    logMsg('→ session', hsMsg)
    sendSession(hsMsg)
  })

  sessionRoom.onPeerLeave(startDisconnectTimer)
}

export async function disconnectWebrtc() {
  registerStatusBoardBroadcast(null)
  await fetch('/api/state/intentional-reset', { method: 'POST' }).catch(() => {})

  // Clear stored peer ID so next initWebrtc (new position) has no previousPeerId
  sessionStorage.removeItem(PEER_ID_STORAGE_KEY)

  sessionRoom?.leave()
  moduleRoom?.leave()
  sessionRoom    = null
  moduleRoom     = null
  sendSession    = null
  sendModule     = null
  clientList     = []
  outSeq         = 0
  peerSeqs       = {}
  activeFacility = ''
  activeSuffix   = ''

  for (const t of Object.values(disconnectTimers)) clearTimeout(t)
  for (const k of Object.keys(disconnectTimers))   delete disconnectTimers[k]

  useSessionStore.getState().setWebrtcStatus('disconnected')
  useSessionStore.getState().setPeers([])
}

export { selfId }
