// Lightweight WebRTC join for the standalone pilot flight-plan-filing page.
// See resources/specs/pilot-filed-flight-plans.md for the design this implements.
//
// Unlike client.js's initWebrtc(), this never joins the session room and never
// sends HANDSHAKE -- a pilot is not a controller position, never appears in
// clientList, and is never host-eligible. It only joins the ATC module room
// directly to send PILOT_FLIGHT_PLAN_REQUEST and to observe the host's
// response (see resolvePilotFlightPlanRequest in client.js).
//
// Pilots may only create a new plan, never amend an existing one -- a request
// for an AID that already has a plan comes back as an explicit
// PILOT_FLIGHT_PLAN_REJECTED rather than a silent drop.
//
// No ws-relay fallback: a standalone page has no self-hosted relay of its own
// to fall back to, so if the public Nostr network is unreachable this simply
// fails rather than attempting a meaningless same-origin fallback URL.
import * as nostrStrategy from '@trystero-p2p/nostr'
import { deriveRoomId } from './client.js'

const NOSTR_REDUNDANCY   = 5
// Per-attempt timeout, and total attempts before giving up -- Nostr-relay-
// mediated WebRTC negotiation is higher-latency than direct signaling (the
// request has to round-trip through a public relay before the ICE/SDP
// exchange even starts), so a single 8s attempt was surfacing "No controller
// responded" for connections that just needed more time. A silent resend on
// the same already-joined room is cheap and safe -- the host-side aid-exists
// check already makes duplicate creates idempotent.
const REQUEST_TIMEOUT_MS   = 15_000
const MAX_REQUEST_ATTEMPTS = 3

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

let moduleRoom = null
let sendModule = null
let selfId     = null
let outSeq     = 0

// aid -> { resolve, reject, timer, msg, acked } -- requests currently awaiting
// resolution. `acked` becomes true on the first PILOT_FLIGHT_PLAN_ACK from any
// connected ATC peer (proof the request reached someone) -- once true, the
// peer-join resend loop below leaves it alone and only the host's actual
// FLIGHT_PLAN_CREATE/PILOT_FLIGHT_PLAN_REJECTED can resolve it. Without this,
// resending the raw request after a peer already forwarded it to the host
// risks the host seeing its own just-created plan as "already exists" and
// firing back a stray rejection that could arrive after a genuine success.
const pending = new Map()

function envelope(type, payload) {
  return {
    version:      1,
    module:       'ATC',
    type,
    fromPeerId:   selfId,
    fromPosition: 'PILOT',
    sequence:     ++outSeq,
    timestamp:    Date.now(),
    payload:      payload ?? {},
  }
}

function logMsg(direction, msg, targetPeerId) {
  const target = targetPeerId ? ` → ${targetPeerId.slice(0, 6)}` : ''
  console.debug(`[pilot-webrtc] ${direction}${target} [${msg.type}] seq=${msg.sequence}`, msg.payload)
}

function onModuleMessage(msg) {
  if (!msg?.type) return
  logMsg('← module', msg)

  if (msg.type === 'PILOT_FLIGHT_PLAN_ACK') {
    const aid = msg.payload?.aid?.toUpperCase()
    const waiter = aid && pending.get(aid)
    if (waiter) waiter.acked = true
    return
  }

  if (msg.type !== 'FLIGHT_PLAN_CREATE' && msg.type !== 'PILOT_FLIGHT_PLAN_REJECTED') return
  const aid = msg.payload?.aid?.toUpperCase()
  const waiter = aid && pending.get(aid)
  if (!waiter) return
  clearTimeout(waiter.timer)
  pending.delete(aid)

  if (msg.type === 'FLIGHT_PLAN_CREATE') {
    waiter.resolve(msg.payload)
  } else {
    waiter.reject(new Error(
      msg.payload?.reason === 'ALREADY_EXISTS'
        ? 'A flight plan already exists for this callsign.'
        : 'Rejected by the session host.'
    ))
  }
}

export function isPilotSessionConnected() {
  return !!sendModule
}

export async function connectPilotSession({ olympusUrl, password = '' }) {
  const sessionRoomId = await deriveRoomId(olympusUrl, password)
  const moduleRoomId  = `${sessionRoomId}-atc`
  console.info(`[pilot-webrtc] joining module room ${moduleRoomId}`)

  const cfg = {
    appId:      'tracs',
    rtcConfig:  { iceServers: DEFAULT_ICE_SERVERS },
    // Same mDNS/loopback fix used everywhere else -- see client.js for why.
    _test_only_mdnsHostFallbackToLoopback: true,
    relayConfig: { redundancy: NOSTR_REDUNDANCY },
    ...(password ? { password } : {}),
  }

  moduleRoom = nostrStrategy.joinRoom(cfg, moduleRoomId)
  selfId     = nostrStrategy.selfId
  console.info(`[pilot-webrtc] selfId ${selfId}`)

  // Joining a Trystero room resolves as soon as joinRoom() is called -- it does
  // NOT wait for an actual peer connection to exist. If fileFlightPlan() sends
  // immediately after connecting, the message can go out into an empty room
  // before the real WebRTC connection to any controller has finished
  // establishing, and is lost (Trystero does not buffer actions sent before a
  // peer exists). Resending every still-unacked request on each peer join
  // covers this race -- mirrors how client.js resends HANDSHAKE from its own
  // onPeerJoin, gated by `handshakeAcked`, rather than at connect time.
  moduleRoom.onPeerJoin((peerId) => {
    console.info(`[pilot-webrtc] peer joined ${peerId.slice(0, 6)}`)
    for (const waiter of pending.values()) {
      if (waiter.acked) continue
      logMsg('→ module (resend)', waiter.msg)
      sendModule(waiter.msg)
    }
  })
  moduleRoom.onPeerLeave((peerId) => console.info(`[pilot-webrtc] peer left ${peerId.slice(0, 6)}`))

  const [_sendModule, getModule] = moduleRoom.makeAction('msg')
  sendModule = _sendModule
  getModule(onModuleMessage)
}

export function disconnectPilotSession() {
  for (const { timer, reject } of pending.values()) {
    clearTimeout(timer)
    reject(new Error('Disconnected'))
  }
  pending.clear()
  moduleRoom?.leave()
  moduleRoom = null
  sendModule = null
  selfId     = null
  outSeq     = 0
}

// Fires when a single attempt's timer expires. Retries in place (same room,
// same request) up to MAX_REQUEST_ATTEMPTS before finally giving up -- see
// the constants above for why.
function onAttemptTimeout(aid) {
  const waiter = pending.get(aid)
  if (!waiter) return
  if (waiter.attemptsLeft > 0) {
    waiter.attemptsLeft -= 1
    logMsg('→ module (retry)', waiter.msg)
    sendModule(waiter.msg)
    waiter.timer = setTimeout(() => onAttemptTimeout(aid), REQUEST_TIMEOUT_MS)
    return
  }
  pending.delete(aid)
  waiter.reject(new Error('No controller responded — is anyone signed in to ATC?'))
}

// Sends a create request and resolves with the host-assigned plan (including
// its CID/BCN) once the resulting FLIGHT_PLAN_CREATE for this AID is observed.
// Rejects immediately if the host reports the AID already has a plan
// (PILOT_FLIGHT_PLAN_REJECTED), or after MAX_REQUEST_ATTEMPTS timeouts if
// nothing responds at all -- the most likely cause is that no ATC controller
// is currently connected to resolve the request (see
// resources/specs/pilot-filed-flight-plans.md §6/§9 -- there is no fallback
// for this without a central server).
export function fileFlightPlan(fields) {
  return new Promise((resolve, reject) => {
    if (!sendModule) { reject(new Error('Not connected')); return }
    const aid = fields.aid?.trim().toUpperCase()
    if (!aid) { reject(new Error('AID is required')); return }
    if (pending.has(aid)) { reject(new Error('A request for this AID is already in flight')); return }

    const msg = envelope('PILOT_FLIGHT_PLAN_REQUEST', { ...fields, aid })
    const waiter = { resolve, reject, msg, acked: false, attemptsLeft: MAX_REQUEST_ATTEMPTS - 1 }
    waiter.timer = setTimeout(() => onAttemptTimeout(aid), REQUEST_TIMEOUT_MS)
    pending.set(aid, waiter)

    logMsg('→ module', msg)
    sendModule(msg)
  })
}
