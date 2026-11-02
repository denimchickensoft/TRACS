// Turn-taking for loading mission data into a store the whole room shares
// (the CATCC status board, flight plans). Those stores sync by broadcasting:
// the status board sends the whole board, a flight plan its own CID and
// beacon code. If two controllers load the same mission at the same moment,
// each one's broadcast crosses the other's: the boards end up swapped, and
// each side keeps its own codes for the same flight. So one controller
// loads at a time, and the next one in line re-checks what is still missing
// before loading (the area's own diff, inside `load`), which by then is
// usually nothing.
//
// Whose turn it is:
//   relay sync    the relay grants a short lease per room + area
//                 (relay/leases.js) - the one authority in the room.
//   P2P (Nostr)   each loader announces MISSION_LOAD_INTENT and waits a
//                 moment; the oldest member of the room among those that
//                 announced goes first, then sends MISSION_LOAD_DONE. Each
//                 peer works this out from its own view, so two can
//                 occasionally both go at once - the same as without the
//                 guard, never worse.
//   no room       (signed out, or alone without a connection) load at once.
// A pop-out window has no room of its own; it asks its main window to take
// the turn for it.

import { missionLoadLink, onModuleLease, sendWebrtcEvent } from '../webrtc/client.js'
import { useSessionStore } from '../store/session.js'
import { intentWinner } from './merge.js'

const LEASE_ANSWER_MS = 5_000    // a relay that doesn't know leases never answers
const LEASE_WAIT_MS   = 20_000   // longest wait for a busy lease to free
const SETTLE_MS       = 1_500    // how long P2P intents are collected
const INTENT_TTL_MS   = 30_000   // an intent whose peer vanished stops counting
const DONE_WAIT_MS    = 15_000
const MAX_ROUNDS      = 5
// A pop-out's changes reach the main window over BroadcastChannel and only
// then go out to the room; the turn is held this much longer to cover that.
const POPUP_FLUSH_MS  = 300

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// area -> Map(peerId -> { joinedAt, at })
const intents = new Map()
const intentWaiters = new Set()

function intentsFor(area) {
  let m = intents.get(area)
  if (!m) { m = new Map(); intents.set(area, m) }
  return m
}

function notifyIntentWaiters() {
  for (const cb of [...intentWaiters]) cb()
}

// MISSION_LOAD_INTENT / MISSION_LOAD_DONE from another member of the room
// (webrtc/handlers.js).
export function handleMissionLoadMessage(type, payload, fromPeerId) {
  if (!fromPeerId || typeof payload?.area !== 'string') return
  const m = intentsFor(payload.area)
  if (type === 'MISSION_LOAD_INTENT') m.set(fromPeerId, { joinedAt: Number(payload.joinedAt) || Date.now(), at: Date.now() })
  else m.delete(fromPeerId)
  notifyIntentWaiters()
}

function waitForIntentChange(test, timeoutMs) {
  return new Promise((resolve) => {
    const check = () => {
      if (!test()) return
      done(true)
    }
    const done = (ok) => {
      clearTimeout(timer)
      intentWaiters.delete(check)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    intentWaiters.add(check)
    check()
  })
}

async function p2pTurn(area, link, load) {
  const m = intentsFor(area)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    m.set(link.selfId, { joinedAt: link.joinedAt, at: Date.now() })
    sendWebrtcEvent('MISSION_LOAD_INTENT', { area, joinedAt: link.joinedAt })
    await sleep(SETTLE_MS)
    const winner = intentWinner(m, Date.now(), INTENT_TTL_MS)
    if (winner === link.selfId || winner === null) {
      try {
        return await load()
      } finally {
        m.delete(link.selfId)
        sendWebrtcEvent('MISSION_LOAD_DONE', { area })
      }
    }
    // Someone older goes first; once it's done (or gone quiet), check again.
    m.delete(link.selfId)
    await waitForIntentChange(() => !m.has(winner), DONE_WAIT_MS)
    m.delete(winner)
  }
  return load()
}

function waitForLease(area, statuses, timeoutMs) {
  return new Promise((resolve) => {
    const off = onModuleLease((e) => {
      if (e.area !== area || !statuses.includes(e.status)) return
      clearTimeout(timer)
      off()
      resolve(e)
    })
    const timer = setTimeout(() => { off(); resolve(null) }, timeoutMs)
  })
}

async function relayTurn(area, link, load) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const answer = waitForLease(area, ['granted', 'busy'], LEASE_ANSWER_MS)
    link.lease(area, 'acquire')
    const e = await answer
    if (!e) return load() // a relay without leases: load as before
    if (e.status === 'granted') {
      try {
        return await load()
      } finally {
        link.lease(area, 'release')
      }
    }
    await waitForLease(area, ['free'], LEASE_WAIT_MS)
  }
  return load()
}

// One turn per area at a time from this window, even when the prompt and a
// manual import overlap.
const chains = new Map()

/**
 * Runs `load` when it's this controller's turn to load into the shared
 * store `area` ('statusboard', 'flightplans'). `load` must work out what's
 * missing itself, at the time it runs. Resolves to its result.
 */
export function runSharedLoad(area, load) {
  const prev = chains.get(area) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => takeTurn(area, load))
  chains.set(area, next)
  return next
}

async function takeTurn(area, load) {
  if (IS_POPUP) return popupTurn(area, load)
  const link = missionLoadLink()
  if (!link) return load()
  return link.relay ? relayTurn(area, link, load) : p2pTurn(area, link, load)
}

// ── Pop-out windows ───────────────────────────────────────────────────────────
// The main window takes the turn and holds it until the pop-out says it has
// loaded. Scoped to the position, as webrtc/client.js's outbound channel is.
const _params  = new URLSearchParams(window.location.search)
const IS_POPUP = !!_params.get('window')
const channel  = new BroadcastChannel('tracs-mission-guard')
let reqSeq = 0

function popupTurn(area, load) {
  const reqId = `${Date.now()}-${++reqSeq}`
  const identity = { facilityId: _params.get('facilityId') ?? '', positionName: _params.get('positionName') ?? '' }
  return new Promise((resolve, reject) => {
    // No main window answering (closed meanwhile): load anyway, as before.
    const fallback = setTimeout(() => {
      channel.removeEventListener('message', onMsg)
      Promise.resolve().then(load).then(resolve, reject)
    }, LEASE_WAIT_MS + LEASE_ANSWER_MS)
    const onMsg = async ({ data }) => {
      if (data?.reqId !== reqId || data.type !== 'granted') return
      clearTimeout(fallback)
      channel.removeEventListener('message', onMsg)
      try {
        resolve(await load())
      } catch (err) {
        reject(err)
      } finally {
        channel.postMessage({ type: 'done', reqId })
      }
    }
    channel.addEventListener('message', onMsg)
    channel.postMessage({ type: 'acquire', reqId, area, ...identity })
  })
}

if (!IS_POPUP) {
  const pending = new Map() // reqId -> resolve
  channel.addEventListener('message', ({ data }) => {
    if (data?.type === 'done') {
      pending.get(data.reqId)?.()
      pending.delete(data.reqId)
      return
    }
    if (data?.type !== 'acquire') return
    const { facilityId, positionName } = useSessionStore.getState()
    if (data.facilityId !== facilityId || data.positionName !== positionName) return
    runSharedLoad(data.area, () => new Promise((resolve) => {
      // A pop-out closed mid-load must not hold the turn for good.
      const giveUp = setTimeout(() => { pending.delete(data.reqId); resolve() }, LEASE_WAIT_MS)
      pending.set(data.reqId, () => { clearTimeout(giveUp); setTimeout(resolve, POPUP_FLUSH_MS) })
      channel.postMessage({ type: 'granted', reqId: data.reqId })
    }))
  })
}
