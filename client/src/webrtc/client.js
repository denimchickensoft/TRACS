import * as nostrStrategy    from '@trystero-p2p/nostr'
import * as wsRelayStrategy  from '@trystero-p2p/ws-relay'
import * as syncClient       from './syncClient.js'
import { useSessionStore }    from '../store/session.js'
import { useAtcStore }        from '../store/atc.js'
import { useFlightPlansStore } from '../store/flightPlans.js'
import { useStatusBoardStore, applyStatusBoardUpdate, registerStatusBoardBroadcast } from '../store/statusBoard.js'
import { useAicStore, registerAicBroadcast, applyAicStateDump } from '../store/aic.js'
import { useAbmStore, registerAbmBroadcast, applyAbmStateDump } from '../store/abm.js'
import { registerAbmMissionBroadcast } from '../store/abmMission.js'
import { useRoeStore, registerRoeBroadcast, applyRoe } from '../store/roe.js'
import { useControllersStore } from '../store/controllers.js'
import { handleModuleMessage } from './handlers.js'
import { applyCallsignRenameRemote } from '../utils/callsignRename.js'

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

const DISCONNECT_TIMEOUT_MS    = 30_000
const PEER_ID_STORAGE_KEY      = 'tracs.previousPeerId'
const CONNECTED_AT_STORAGE_KEY = 'tracs.connectedAt'
const CLIENT_ID_STORAGE_KEY    = 'tracs.clientId'

// Durable per-browser/device identity, stored in localStorage (unlike
// PEER_ID_STORAGE_KEY above, which is sessionStorage and only survives a
// same-tab refresh). Lets the HANDSHAKE handler recognize "this is the same
// device re-signing in under the same name" even after the tab/app was
// fully closed and reopened, so it can evict a stale slot immediately
// instead of waiting on relay-side dead-connection reaping.
function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_STORAGE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, id)
  }
  return id
}

// ── Signaling strategy selection ───────────────────────────────────────────────
// Primary: public Nostr relay network (serverless, no port forwarding needed).
// Fallback: this deployment's own self-hosted ws-relay (server/src/index.js
// `/signal`), for LAN/offline deployments the public internet can't reach.
// See resources/specs/webrtc-spec.md for the full rationale.
const NOSTR_REDUNDANCY       = 5     // how many public relays to use simultaneously
const RELAY_PROBE_TIMEOUT_MS = 8_000 // how long to wait for a Nostr relay to open before falling back
const RELAY_PROBE_POLL_MS    = 250

// True once any of the strategy's relay sockets reaches OPEN. This is a
// transport-level signal (are we talking to a relay at all), independent of
// whether any peer has joined the room yet -- so it can't be confused with
// "signaling worked, I'm just the first one here."
function relayIsOpen(getRelaySockets) {
  return Object.values(getRelaySockets?.() ?? {}).some((ws) => ws?.readyState === WebSocket.OPEN)
}

function waitForRelayConnection(getRelaySockets, timeoutMs) {
  return new Promise((resolve) => {
    if (relayIsOpen(getRelaySockets)) { resolve(true); return }
    const start = Date.now()
    const poll = setInterval(() => {
      if (relayIsOpen(getRelaySockets)) {
        clearInterval(poll)
        resolve(true)
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(poll)
        resolve(false)
      }
    }, RELAY_PROBE_POLL_MS)
  })
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let sessionRoom = null
let moduleRoom  = null
let sendSession = null
let sendModule  = null
let selfId      = null

let activePosition = ''
let activeModule   = ''

// True when this session is using the relay's centralized /sync transport
// instead of Trystero P2P -- drives the 'relay' vs 'webrtc' transportStatus
// distinction so the status dot stays an always-visible indicator of which
// transport is active, not just a one-time Login warning.
let usingSyncRelay = false
function activeTransportStatus() { return usingSyncRelay ? 'relay' : 'webrtc' }

let clientList = []   // { peerId, clientId, position, module, frequency, connectedAt }[]
let outSeq     = 0    // outgoing sequence counter
let peerSeqs   = {}   // peerId → last received sequence (for STATE_DUMP peerSequences)

const disconnectTimers = {}  // peerId → timeoutId

// True while applying incoming data — suppresses re-broadcast in store subscriptions
let _applying = false

// Set true once we receive HANDSHAKE_ACK from the host. Until then, we re-send
// HANDSHAKE on every new peer join so the host receives it even if our first
// connection landed on a non-host peer.
let handshakeAcked = false
export function isApplying() { return _applying }

// ── Room ID derivation (P2P/Trystero fallback only — relay-hosted sync uses
// relayTopicFor() below instead, see webrtc-centralized-sync-spec.md) ─────────
// `coalition` is a new, optional trailing param (added after `password`, not
// before it) specifically so pilotClient.js's existing two-arg call
// (`deriveRoomId(olympusUrl, password)`) keeps working unchanged — pilots
// have no coalition concept and stay out of scope for this.
export async function deriveRoomId(olympusAddress, password = '', coalition = '') {
  // Hostnames are case-insensitive; lowercase before hashing so two peers who
  // typed the same address with different casing still land in the same room.
  const stripped = olympusAddress
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
  // Split host from port on the last colon (bare host, no colon at all, is
  // also handled) so the localhost alias below only ever touches the host
  // portion, never accidentally the port. Doesn't handle bracketed IPv6
  // literals -- DCS server addresses are essentially never raw IPv6.
  const lastColon = stripped.lastIndexOf(':')
  let host = lastColon === -1 ? stripped : stripped.slice(0, lastColon)
  const port = lastColon === -1 ? '' : stripped.slice(lastColon + 1)
  // The one address-ambiguity case worth actually fixing: independent local
  // testers overwhelmingly default to one of these two for the same machine,
  // with nothing else to tell their rooms apart. Domain vs. its raw IP stays
  // an accepted, documented limitation (webrtc-centralized-sync-spec.md) --
  // no DNS lookup here (see that doc for why it was rejected).
  if (host === 'localhost' || host === '::1') host = '127.0.0.1'
  const normalized = port ? `${host}:${port}` : host
  const input = [normalized, coalition, password].filter(Boolean).join(':')
  const hash  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const hex   = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
  const roomId = 'tracs-' + hex.substring(0, 16)
  console.info(`[webrtc] derived room id ${roomId} from "${normalized}"`)
  return roomId
}

// ── Relay-hosted sync topic (coalition only, no address/password) ─────────────
// A relay is structurally pinned to exactly one DCS mission (relay/config.json
// has one tacviewHost/tacviewPort, one srsLotatcPort) -- its own connection is
// already the isolation boundary, so unlike deriveRoomId() above there's no
// need for a hash or any address-collision defense here. Plain and
// deterministic on purpose: this is also what will let GM/Admin trivially
// derive every other coalition's topic name too, once initWebrtc() joins
// multiple rooms for that role (not yet implemented -- see
// resources/specs/data-sources/webrtc-centralized-sync-spec.md) -- no secret
// is needed to compute a topic name, only the relay's own connection-level
// auth (coalition-scoped password) gates who gets in at all.
function relayTopicFor(coalition) {
  return `tracs-relay-${coalition}`
}

// ── Dev logging ───────────────────────────────────────────────────────────────
function logMsg(direction, msg, targetPeerId) {
  const target = targetPeerId ? ` → ${targetPeerId.slice(0, 6)}` : ''
  const from   = msg.fromPosition || msg.fromPeerId?.slice(0, 6) || '?'
  // Reflects the actual active transport, not just this module's name — a
  // relay-hosted sync session never opens a real RTCPeerConnection, and the
  // '[webrtc]' label was confusingly claiming otherwise.
  const tag = usingSyncRelay ? '[sync]' : '[webrtc]'
  console.debug(`${tag} ${direction}${target} [${msg.type}] seq=${msg.sequence} from=${from}`, msg.payload)
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
  const taken = new Set(effectiveClientList().map(c => c.position))
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

// Additively merge an incoming client list into ours: update/add entries from
// the incoming view, but never drop a peer we already track (in particular,
// never drop our own selfId entry) — an incoming list can be a stale snapshot
// (e.g. a STATE_DUMP built before the sender added the peer this is being
// sent to) and must never be able to regress what we already know. Only
// PEER_DISCONNECTED and the disconnect timer remove peers.
function mergeClientList(incoming) {
  const incomingById = Object.fromEntries(incoming.map(c => [c.peerId, c]))
  const merged = clientList
    .map(c => incomingById[c.peerId] ?? c)   // update existing entries
    .concat(incoming.filter(c => !clientList.some(e => e.peerId === c.peerId))) // add new
  return merged.sort((a, b) => a.connectedAt - b.connectedAt)
}

// Peers inside disconnectTimers have fired onPeerLeave — they may be gone.
// The effective list excludes them so host duties transfer immediately on leave,
// without waiting for the full DISCONNECT_TIMEOUT_MS reconnect window to expire.
function effectiveClientList() {
  return clientList.filter(c => !disconnectTimers[c.peerId])
}

// True when we are the globally oldest effective peer (by roomJoinedAt).
// Matches the host-election logic in the HANDSHAKE handler.
function amHost() {
  const effective = effectiveClientList()
  if (effective.length === 0) return true
  const sorted = [...effective].sort(
    (a, b) => (a.roomJoinedAt ?? a.connectedAt) - (b.roomJoinedAt ?? b.connectedAt)
  )
  return sorted[0]?.peerId === selfId
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
// Reads from in-memory stores (localStorage-backed) — not from server files.
// This ensures the host always sends its current truth regardless of server state.
function buildDump(mod) {
  const ctrl = useControllersStore.getState()
  const base = {
    clientList,
    peerSequences:     { ...peerSeqs, [selfId]: outSeq },
    registry:          ctrl.registry,
    groupAssignments:  ctrl.groupAssignments,
    nextGroupNumber:   ctrl.nextGroupNumber,
    // Callsign overrides are session-wide (set via .RENAME/.rename in any
    // module), not module-scoped state — included in every dump so a peer
    // joining ANY module sees renames applied before they connected.
    callsignOverrides: { ...useAtcStore.getState().callsignOverrides },
    // ROE is shared cross-module state (AIC and ABM), not module-scoped —
    // included in every dump so a peer joining ANY module sees it.
    roe: useRoeStore.getState().roe,
  }
  if (mod === 'AIC') {
    const aic = useAicStore.getState()
    return { ...base, declarations: { ...aic.declarations }, autoDeclareMode: aic.autoDeclareMode }
  }
  if (mod === 'ABM') {
    const abm = useAbmStore.getState()
    return { ...base, declarations: { ...abm.declarations }, autoDeclareMode: abm.autoDeclareMode }
  }
  if (mod === 'ATC') {
    const fps = useFlightPlansStore.getState()
    const atc = useAtcStore.getState()
    return {
      ...base,
      flightPlans:    fps.plans,
      trackOwnership: atc.ownership,
      handoffs:       atc.handoffs,
      pointOuts:      atc.pointOuts,
    }
  }
  if (mod === 'CATCC') {
    const s   = useStatusBoardStore.getState()
    const atc = useAtcStore.getState()
    return {
      ...base,
      statusBoard: {
        eventHeader:    { event: s.event, launch: s.launch, recovery: s.recovery },
        recoveryStatus: { caseLaunch: s.caseLaunch, caseRecovery: s.caseRecovery, app: s.app, marBtn: s.marBtn, twrBtn: s.twrBtn, depBtn: s.depBtn, rad: s.rad },
        entries:        s.entries,
      },
      trackOwnership: atc.ownership,
      handoffs:       atc.handoffs,
      pointOuts:      atc.pointOuts,
    }
  }
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

function applyDump(mod, payload) {
  _applying = true
  try {
    // Seed registry before syncPeers so rebuildFromClientList treats every
    // peer as "already registered" (no local ID derivation) and so that the
    // activeIds filter in applyAtcDump/applyCatccDump sees correct IDs.
    //
    // Merge rather than replace: the dump can be a stale snapshot captured
    // by the sender before it registered the very peer this is being sent
    // to (STATE_DUMP is now sent to a joiner before the host finishes
    // upserting/minting their ID -- see the HANDSHAKE handler above), so it
    // must never be able to erase an entry we already have (especially our
    // own). The authoritative CLIENT_LIST_UPDATE that always follows applies
    // the host's registry wholesale once it's actually complete.
    if (payload.registry) {
      const ctrl = useControllersStore.getState()
      useControllersStore.getState().setRegistry(
        { ...ctrl.registry, ...payload.registry },
        { ...ctrl.groupAssignments, ...(payload.groupAssignments ?? {}) },
        Math.max(ctrl.nextGroupNumber, payload.nextGroupNumber ?? 1),
      )
    }
    if (payload.clientList) { clientList = mergeClientList(payload.clientList); syncPeers() }
    if (payload.peerSequences) Object.assign(peerSeqs, payload.peerSequences)
    if (mod === 'ATC')   applyAtcDump(payload)
    if (mod === 'CATCC') applyCatccDump(payload)
    if (mod === 'AIC')   applyAicStateDump(payload)
    if (mod === 'ABM')   applyAbmStateDump(payload)
    // Applied after the per-module dump above, since applyAtcDump/applyCatccDump
    // call atc.reset() (which clears callsignOverrides) before this point.
    if (payload.callsignOverrides) {
      useAtcStore.setState({ callsignOverrides: payload.callsignOverrides })
    }
    if (payload.roe !== undefined) applyRoe(payload.roe)
  } finally {
    _applying = false
  }
}

// ── Disconnect cleanup ────────────────────────────────────────────────────────
// Drop tracks/handoffs/pointOuts owned by a departed controller, then persist.
// Only acts if no remaining controller shares the same controllerId (covers the
// case where UGKO_1_TWR leaves but UGKO_TWR is still connected with the same ID).
// Must be called AFTER removeClient + syncPeers so the registry reflects reality.
function dropControllerTracks(lostControllerId) {
  if (!lostControllerId) return
  const newRegistry = useControllersStore.getState().registry
  const stillActive = Object.values(newRegistry).some(e => e.controllerId === lostControllerId)
  if (stillActive) return

  const atc = useAtcStore.getState()
  for (const [uid, owner] of Object.entries(atc.ownership)) {
    if (owner === lostControllerId) atc.dropTrack(uid)
  }
  for (const [uid, ho] of Object.entries(atc.handoffs)) {
    if (ho.from === lostControllerId || ho.to === lostControllerId) atc.clearHandoff(uid)
  }
  for (const [uid, po] of Object.entries(atc.pointOuts)) {
    if (po.from === lostControllerId || po.to === lostControllerId) atc.clearPointOut(uid)
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
    dropControllerTracks(lostControllerId)

    const ctrl = useControllersStore.getState()
    const pdMsg  = envelope('PEER_DISCONNECTED', {
      position: entry.position,
      module:   entry.module,
      peerId,
    })
    const cluMsg = envelope('CLIENT_LIST_UPDATE', {
      clients:          clientList,
      registry:         ctrl.registry,
      groupAssignments: ctrl.groupAssignments,
      nextGroupNumber:  ctrl.nextGroupNumber,
    })
    logMsg('→ session', pdMsg)
    logMsg('→ session', cluMsg)
    sendSession?.(pdMsg)
    sendSession?.(cluMsg)
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
      const senderConnectedAt  = msg.payload.connectedAt  ?? Date.now()
      // roomJoinedAt = actual wall-clock time the sender entered the WebRTC room in
      // this session. Unlike connectedAt it is never preserved across refreshes, so
      // it reliably reflects who has been in the room longest right now.
      const senderRoomJoinedAt = msg.payload.roomJoinedAt ?? senderConnectedAt
      const myEntry            = clientList.find(c => c.peerId === selfId)
      const myRoomJoinedAt     = myEntry?.roomJoinedAt ?? myEntry?.connectedAt ?? Date.now()

      // The global host is the single authority for session coordination. It is
      // whichever effective peer entered the current room session earliest
      // (smallest roomJoinedAt). We determine this BEFORE adding the sender so
      // resolvePosition() sees only existing entries.
      //
      // A peer acts as host when:
      //   (a) the sender's roomJoinedAt is later than ours — we joined first, AND
      //   (b) we are the oldest-by-roomJoinedAt in the effective list
      //
      // Using roomJoinedAt (not connectedAt) fixes the refresh scenario: a refreshing
      // peer preserves its original connectedAt (for group-number stability), which
      // makes it appear older than established peers and would prevent any peer from
      // taking the host role if we used connectedAt for this check.
      const effective = effectiveClientList()
      const effectiveSortedByJoin = [...effective].sort(
        (a, b) => (a.roomJoinedAt ?? a.connectedAt) - (b.roomJoinedAt ?? b.connectedAt)
      )
      const senderIsNewer = senderRoomJoinedAt > myRoomJoinedAt
      const amGlobalHost  = senderIsNewer && (effectiveSortedByJoin[0]?.peerId === selfId || effective.length === 0)

      // All peers: cancel the reconnect timer and free the old slot so the host's
      // resolvePosition() sees an accurate picture of taken positions.
      if (msg.payload.previousPeerId) {
        clearTimeout(disconnectTimers[msg.payload.previousPeerId])
        delete disconnectTimers[msg.payload.previousPeerId]
        removeClient(msg.payload.previousPeerId)
      }

      // Same device re-signing in under the same name (e.g. the app was fully
      // closed and reopened, so sessionStorage's previousPeerId above is gone,
      // but localStorage's clientId survives). Evict the stale slot the same
      // way. Matched on clientId AND position together, not clientId alone --
      // localStorage is shared across every tab/window on the same browser
      // profile, so a controller legitimately running two TRACS windows for
      // two different positions on one machine must not have one evict the
      // other.
      if (msg.payload.clientId) {
        const stale = clientList.find(c => c.clientId === msg.payload.clientId && c.position === msg.payload.position)
        if (stale) {
          clearTimeout(disconnectTimers[stale.peerId])
          delete disconnectTimers[stale.peerId]
          removeClient(stale.peerId)
        }
      }

      // Whichever connected peer is the oldest member of the JOINER'S module
      // sends the STATE_DUMP for it -- independent of who the overall session
      // host is. Cross-module state (roe, callsignOverrides, registry) rides
      // along in every module's dump via buildDump()'s `base`, so the peer
      // who actually holds a module's data must answer, not necessarily the
      // global host, who may belong to an entirely different module and
      // never have touched it. (oldestPeerOfModule() is deterministic and
      // gives the same single peerId to everyone computing it, so this can't
      // double-send.) Every peer evaluates this off the broadcast HANDSHAKE,
      // not just the host, and it must run before the host-only section
      // below so a non-host oldest-module-peer still gets to send it.
      if (oldestPeerOfModule(msg.payload.module) === selfId) {
        const dump = await buildDump(msg.payload.module)
        const dumpMsg = envelope('STATE_DUMP', dump)
        logMsg('→ session', dumpMsg, fromPeerId)
        sendSession?.(dumpMsg, fromPeerId)
      }

      // Non-hosts must not upsert the raw requested position — if it collides with
      // an existing peer's position string, rebuildFromClientList would overwrite that
      // peer's registry entry (wiping their controllerId) until the host's CLU arrives.
      // Non-hosts wait for the authoritative CLU instead.
      if (!amGlobalHost) break

      const resolved = resolvePosition(msg.payload.position)

      // Host: frequency deconfliction — reject before upserting.
      // A frequency is blocked if another position with a different facility+suffix
      // is already using it. Same facility+suffix = same controllerId = allowed to share.
      if (msg.payload.frequency) {
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
        peerId:        fromPeerId,
        clientId:      msg.payload.clientId,
        position:      resolved,
        module:        msg.payload.module,
        frequency:     msg.payload.frequency  ?? '',
        facility:      msg.payload.facility   ?? '',
        suffix:        msg.payload.suffix     ?? '',
        connectedAt:   senderConnectedAt,
        roomJoinedAt:  senderRoomJoinedAt,
      })
      syncPeers()
      persistSession()

      // Host: send ACK (with resolved position if changed) and authoritative CLU.
      // CLU carries the full registry so non-hosts apply host-assigned IDs directly
      // rather than deriving them locally.
      const ctrl   = useControllersStore.getState()
      const ack    = resolved !== msg.payload.position ? { resolvedPosition: resolved } : {}
      const ackMsg = envelope('HANDSHAKE_ACK', ack)
      const cluMsg = envelope('CLIENT_LIST_UPDATE', {
        clients:          clientList,
        registry:         ctrl.registry,
        groupAssignments: ctrl.groupAssignments,
        nextGroupNumber:  ctrl.nextGroupNumber,
      })
      logMsg('→ session', ackMsg, fromPeerId)
      logMsg('→ session', cluMsg)
      sendSession?.(ackMsg, fromPeerId)
      sendSession?.(cluMsg)
      break
    }

    case 'HANDSHAKE_ACK': {
      handshakeAcked = true
      if (msg.payload?.resolvedPosition) {
        activePosition = msg.payload.resolvedPosition
        useSessionStore.setState({ positionName: activePosition })
      }
      useSessionStore.getState().setWebrtcStatus(activeTransportStatus())
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
      useSessionStore.getState().setWebrtcStatus(activeTransportStatus())
      break
    }

    case 'CLIENT_LIST_UPDATE': {
      // Merge the incoming list with ours: update/add entries from the host's view,
      // but never remove peers we already track — only PEER_DISCONNECTED and the
      // disconnect timer remove peers. This prevents a stale CLU from resurrecting
      // a disconnected peer or erasing a peer the host hasn't heard about yet.
      clientList = mergeClientList(msg.payload.clients ?? [])
      // Non-hosts apply the host's registry before syncPeers so that
      // rebuildFromClientList treats every peer as already-registered and
      // never derives IDs locally. The host never receives its own CLU.
      if (!amHost() && msg.payload.registry) {
        useControllersStore.getState().setRegistry(
          msg.payload.registry,
          msg.payload.groupAssignments ?? {},
          msg.payload.nextGroupNumber  ?? 1,
        )
      }
      syncPeers()
      break
    }

    case 'PEER_DISCONNECTED': {
      // Never remove self — a remote peer can't authoritatively declare us gone.
      if (msg.payload.peerId !== selfId) {
        // Cancel our local disconnect timer — the sender already did the cleanup.
        clearTimeout(disconnectTimers[msg.payload.peerId])
        delete disconnectTimers[msg.payload.peerId]
        const entry = clientList.find(c => c.peerId === msg.payload.peerId)
        const lostControllerId = entry
          ? useControllersStore.getState().registry[entry.position]?.controllerId ?? null
          : null
        removeClient(msg.payload.peerId)
        syncPeers()
        dropControllerTracks(lostControllerId)
      }
      break
    }

    case 'CALLSIGN_RENAME': {
      applyCallsignRenameRemote(msg.payload)
      break
    }

    case 'ROE_SET': {
      applyRoe(msg.payload.roe)
      break
    }

    case 'CONTROLLER_MESSAGE': {
      const { toPosition, text, broadcast } = msg.payload
      if (broadcast || toPosition === activePosition) {
        useSessionStore.getState().addControllerMessage({
          from:         msg.fromPosition,
          fromPosition: msg.fromPosition,
          text,
          broadcast:    !!broadcast,
          toPosition:   broadcast ? null : (toPosition ?? null),
          timestamp:    msg.timestamp ?? Date.now(),
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

  if (msg.type === 'PILOT_FLIGHT_PLAN_REQUEST') {
    // Any connected ATC peer acks receipt immediately, regardless of host status.
    // This decouples "did my request reach anyone" (fast, from whoever's peer
    // connection happens to be up) from "has the host resolved it" (potentially
    // slower) -- the pilot page stops resending once acked, and only the actual
    // host goes on to resolve it below.
    if (activeModule === 'ATC') {
      const ackMsg = envelope('PILOT_FLIGHT_PLAN_ACK', { aid: msg.payload?.aid }, 'ATC')
      logMsg('→ module', ackMsg, msg.fromPeerId)
      sendModule?.(ackMsg, msg.fromPeerId)
    }
    resolvePilotFlightPlanRequest(msg.payload, msg.fromPeerId)
    return
  }

  _applying = true
  try {
    handleModuleMessage(msg)
  } finally {
    _applying = false
  }
}

// A standalone pilot-filing page (see resources/specs/pilot-filed-flight-plans.md) joins the
// ATC module room directly but never joins the session room, so it never appears in clientList
// and is never host-eligible. Only the current global host acts on its request -- otherwise
// every connected controller would independently mint a different CID/BCN for the same AID via
// useFlightPlansStore.add()'s local generation. The host resolves it once, locally, then
// re-broadcasts an ordinary FLIGHT_PLAN_CREATE that every peer (pilot included) applies through
// the normal handleModuleMessage path.
//
// Pilots may only CREATE a new plan, never amend an existing one. If a plan already exists for
// the AID, the host rejects the request explicitly (rather than silently dropping it) so the
// pilot page can distinguish "already exists" from "no controller online." A controller frees the
// AID via the FPE's Delete flow (broadcasts FLIGHT_PLAN_DELETE) so the pilot can refile.
function resolvePilotFlightPlanRequest(payload, fromPeerId) {
  if (activeModule !== 'ATC' || !amHost()) return
  const aid = payload?.aid?.toUpperCase()
  if (!aid) return

  const fps = useFlightPlansStore.getState()
  if (fps.plans[aid]) {
    const rejectMsg = envelope('PILOT_FLIGHT_PLAN_REJECTED', { aid, reason: 'ALREADY_EXISTS' }, 'ATC')
    logMsg('→ module', rejectMsg, fromPeerId)
    sendModule?.(rejectMsg, fromPeerId)
    return
  }

  fps.add(payload)
  const resolved = useFlightPlansStore.getState().plans[aid]
  const outMsg    = envelope('FLIGHT_PLAN_CREATE', resolved, 'ATC')
  logMsg('→ module', outMsg)
  sendModule?.(outMsg)
}

// ── Public API ────────────────────────────────────────────────────────────────

// Send a module-room event (called from actions/store subscriptions)
export function sendWebrtcEvent(type, payload) {
  if (!sendModule || _applying) return
  const msg = envelope(type, payload)
  logMsg('→ module', msg)
  sendModule(msg)
}

// Send a session-room event visible to all peers regardless of module
export function sendWebrtcSessionEvent(type, payload) {
  if (!sendSession) return
  const msg = envelope(type, payload, activeModule)
  logMsg('→ session', msg)
  sendSession(msg)
}

// Send a CONTROLLER_MESSAGE on the session room
export function sendControllerMessage({ toPosition, toModule, text, broadcast = false }) {
  if (!sendSession) return
  const msg = envelope('CONTROLLER_MESSAGE', { toPosition, toModule, text, broadcast }, activeModule)
  logMsg('→ session', msg)
  sendSession(msg)
}

// High-level chat send — routes to correct room and echoes to local store.
// text: message body; toPosition: DM target or null; broadcast: cross-module all.
export function sendChatMessage({ text, toPosition = null, broadcast = false }) {
  const myPosition = activePosition
  const timestamp  = Date.now()

  if (toPosition) {
    sendControllerMessage({ text, toPosition, broadcast: false })
  } else if (broadcast) {
    sendControllerMessage({ text, broadcast: true })
  } else {
    sendWebrtcEvent('CONTROLLER_MESSAGE', { text, broadcast: false })
  }

  useSessionStore.getState().addControllerMessage({
    from:         myPosition,
    fromPosition: myPosition,
    text,
    broadcast,
    toPosition:   toPosition ?? null,
    timestamp,
  })
}

export async function initWebrtc({ olympusUrl, password, relayPassword, coalition, position, module: mod, frequency, facility = '', suffix = '' }) {
  activePosition = position
  activeModule   = mod
  outSeq         = 0
  clientList     = []
  peerSeqs       = {}
  handshakeAcked = false

  // Recover the peer ID and original sign-on time from the previous session for
  // browser-refresh reconnect. sessionStorage is per-tab — survives reloads but
  // is not shared between windows, so a second position signing in on the same
  // machine never sees another tab's peerId.
  const previousPeerId    = sessionStorage.getItem(PEER_ID_STORAGE_KEY) ?? undefined
  // Durable device identity (localStorage, survives closing the tab/app
  // entirely) -- lets other peers' HANDSHAKE handlers recognize a reconnect
  // from this same device even when previousPeerId above is gone. See
  // getClientId() above.
  const myClientId        = getClientId()
  // Preserve the original connectedAt across refreshes so group number ordering
  // (1T, 2A, …) remains stable. Without this, each refresh resets connectedAt to
  // Date.now(), which re-sorts the peer among its siblings and causes group numbers
  // to flip. An intentional disconnect clears this key, so re-login gets a fresh time.
  const storedConnectedAt = previousPeerId
    ? (parseInt(sessionStorage.getItem(CONNECTED_AT_STORAGE_KEY) ?? '', 10) || null)
    : null
  const myConnectedAt  = storedConnectedAt ?? Date.now()
  // roomJoinedAt is the actual wall-clock time this tab entered the WebRTC room in
  // this session. It is NEVER preserved across refreshes, unlike connectedAt. It is
  // used exclusively for host determination: whoever joined the room most recently
  // is newer, and the oldest-by-roomJoinedAt peer acts as host for their HANDSHAKE.
  // Using connectedAt for this purpose breaks on refresh because a refreshing peer
  // preserves an old timestamp that makes them appear older than established peers,
  // causing senderIsNewer to be false and no peer to take the host role.
  const myRoomJoinedAt = Date.now()

  sessionStorage.setItem(CONNECTED_AT_STORAGE_KEY, String(myConnectedAt))

  // usingSyncRelay decided up front (not inside the branch below) because it
  // also determines how the room/topic identity itself is computed: relay-
  // hosted sync uses a plain per-coalition topic (relayTopicFor), P2P/Trystero
  // keeps the address+password+coalition hash (deriveRoomId) -- see
  // resources/specs/data-sources/webrtc-centralized-sync-spec.md.
  usingSyncRelay = useSessionStore.getState().syncCapable
  const sessionRoomId = usingSyncRelay
    ? relayTopicFor(coalition)
    : await deriveRoomId(olympusUrl, password, coalition)
  const moduleRoomId  = `${sessionRoomId}-${mod.toLowerCase()}`
  // Same [sync]/[webrtc] convention logMsg() already uses below, for the
  // same reason -- this always said [webrtc] regardless of which transport
  // actually carried it.
  console.info(`${usingSyncRelay ? '[sync]' : '[webrtc]'} joining module room ${moduleRoomId}`)
  const iceServers = await fetchIceServers()
  const baseCfg = {
    appId: 'tracs',
    rtcConfig: { iceServers },
    // Chrome obfuscates local IPs as random .local mDNS hostnames. Same-machine
    // peers can't resolve these (they're synthetic, not real mDNS records), so the
    // host candidates are dead. Rewriting to 127.0.0.1 makes same-machine connections
    // work. For cross-machine LAN, these host candidates simply fail first; STUN
    // reflexive candidates (real LAN IPs) still succeed.
    _test_only_mdnsHostFallbackToLoopback: true,
    // AES-GCM encrypts SDP payloads so public relay operators can't read session
    // descriptors in plaintext. Every peer already knows this password out-of-band
    // (it's the same input used to derive sessionRoomId above), so this only hides
    // signaling contents in transit -- it doesn't change who can find the room.
    ...(password ? { password } : {}),
  }

  let strategy, cfg
  if (usingSyncRelay) {
    // Login's ConnectPhase already proved the relay's /sync is reachable and
    // authenticated (checkSyncCapable) before sign-in completed, so no
    // runtime probing is needed here -- go straight to it. See
    // resources/specs/data-sources/webrtc-centralized-sync-spec.md §1/§3.
    // The relay's own auth gate (relay/config.json's `passwords`) is
    // coalition-scoped access control, same credential srs.js/tacviewRelayClient.js
    // already authenticate with -- unrelated to the optional Session Password
    // below, which only ever isolates/encrypts the room, never gates the relay
    // itself. Login's ConnectPhase capability-check already validated this
    // exact value. See resources/specs/data-sources/webrtc-centralized-sync-spec.md.
    strategy    = syncClient
    cfg         = { relayUrl: useSessionStore.getState().relayUrl, coalition, password: relayPassword }
    sessionRoom = strategy.joinRoom(cfg, sessionRoomId)
  } else {
    // Try the public Nostr relay network first (no port forwarding needed).
    // Fall back to this deployment's self-hosted ws-relay if no relay socket
    // opens within the timeout -- e.g. an air-gapped LAN with no internet route.
    // Relay selection is left entirely to Trystero's own appId-seeded shuffle
    // (no TRACS-side relay list to curate) -- every install still lands on the
    // identical deterministic subset since `appId: 'tracs'` is a fixed seed.
    strategy    = nostrStrategy
    cfg         = { ...baseCfg, relayConfig: { redundancy: NOSTR_REDUNDANCY } }
    sessionRoom = strategy.joinRoom(cfg, sessionRoomId)

    const nostrReachable = await waitForRelayConnection(strategy.getRelaySockets, RELAY_PROBE_TIMEOUT_MS)
    if (!nostrReachable) {
      console.warn('[webrtc] Public Nostr relays unreachable within timeout; falling back to self-hosted relay')
      await sessionRoom.leave()
      strategy    = wsRelayStrategy
      cfg         = { ...baseCfg, relayConfig: { urls: [getSignalUrl()] } }
      sessionRoom = strategy.joinRoom(cfg, sessionRoomId)
    }
  }
  moduleRoom = strategy.joinRoom(cfg, moduleRoomId)
  selfId     = strategy.selfId
  sessionStorage.setItem(PEER_ID_STORAGE_KEY, selfId)

  const [_sendSession, getSession] = sessionRoom.makeAction('msg')
  const [_sendModule,  getModule]  = moduleRoom.makeAction('msg')
  sendSession = _sendSession
  sendModule  = _sendModule

  getSession(onSessionMessage)
  getModule(onModuleMessage)

  if (mod === 'CATCC') {
    registerStatusBoardBroadcast((payload) => sendWebrtcEvent('STATUS_BOARD_UPDATE', payload))
  }
  if (mod === 'AIC') {
    registerAicBroadcast((type, payload) => sendWebrtcEvent(type, payload))
  }
  if (mod === 'ABM') {
    registerAbmBroadcast((type, payload) => sendWebrtcEvent(type, payload))
    registerAbmMissionBroadcast((type, payload) => sendWebrtcEvent(type, payload))
  }
  // ROE is cross-module (session-room) state, registered regardless of
  // active module — see store/roe.js.
  registerRoeBroadcast((type, payload) => sendWebrtcSessionEvent(type, payload))

  // Add self immediately — if first peer, we're already "connected"
  upsertClient({ peerId: selfId, clientId: myClientId, position, module: mod, frequency, facility, suffix, connectedAt: myConnectedAt, roomJoinedAt: myRoomJoinedAt })
  syncPeers()
  useSessionStore.getState().setWebrtcStatus(activeTransportStatus())
  persistSession()

  // onPeerJoin fires on BOTH sides when a connection is established. We send
  // HANDSHAKE on every new peer join until we receive HANDSHAKE_ACK. This ensures
  // the host receives our HANDSHAKE even if our first connection landed on a
  // non-host peer (which cannot process the HANDSHAKE itself).
  sessionRoom.onPeerJoin((peerId) => {
    // Reconnect: cancel the pending disconnect timer so the peer isn't evicted.
    if (disconnectTimers[peerId]) {
      clearTimeout(disconnectTimers[peerId])
      delete disconnectTimers[peerId]
    }
    if (handshakeAcked) return
    const hsMsg = envelope('HANDSHAKE', { position, module: mod, frequency, facility, suffix, connectedAt: myConnectedAt, roomJoinedAt: myRoomJoinedAt, previousPeerId, clientId: myClientId })
    logMsg('→ session', hsMsg)
    sendSession(hsMsg)
  })

  // Never start a disconnect timer against ourselves — a relay/transport-level
  // leave event for our own peerId is always spurious (e.g. a duplicate-membership
  // artifact from a reconnect racing the relay's stale-connection reaping), unlike
  // PEER_DISCONNECTED (client.js's selfId guard there) this has no other peer
  // vouching for the departure at all.
  sessionRoom.onPeerLeave((peerId) => {
    if (peerId !== selfId) startDisconnectTimer(peerId)
  })
}

export async function disconnectWebrtc() {
  registerStatusBoardBroadcast(null)
  await fetch('/api/state/intentional-reset', { method: 'POST' }).catch(() => {})

  // Clear stored peer ID and sign-on time so next initWebrtc (new position) starts fresh
  sessionStorage.removeItem(PEER_ID_STORAGE_KEY)
  sessionStorage.removeItem(CONNECTED_AT_STORAGE_KEY)

  sessionRoom?.leave()
  moduleRoom?.leave()
  sessionRoom    = null
  moduleRoom     = null
  sendSession    = null
  sendModule     = null
  clientList     = []
  outSeq         = 0
  peerSeqs       = {}
  handshakeAcked = false
  usingSyncRelay = false

  for (const t of Object.values(disconnectTimers)) clearTimeout(t)
  for (const k of Object.keys(disconnectTimers))   delete disconnectTimers[k]

  useSessionStore.getState().setWebrtcStatus('disconnected')
  useSessionStore.getState().setPeers([])
}

export { selfId }
