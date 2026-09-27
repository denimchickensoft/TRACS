'use strict'

// Shared per-connection password gate, used by every relay capability
// (relay/transponders.js, relay/syncRelay.js, and whatever comes next).

const crypto = require('crypto')
const { PROTOCOL_VERSION } = require('./protocolVersion')
const { version: RELAY_VERSION } = require('./package.json')

const AUTH_TIMEOUT_MS = 5_000

// Timing-safe password check: hash both sides to equal-length digests first,
// so neither the comparison time nor timingSafeEqual's length requirement
// leaks anything about the stored password.
// Only the map's own string entries count, never inherited properties: a
// claimed coalition of "constructor" must not match Object.prototype's.
function passwordMatches(validPasswords, coalition, supplied) {
  const expected = typeof coalition === 'string' && Object.hasOwn(validPasswords, coalition)
    ? validPasswords[coalition] : undefined
  const a = crypto.createHash('sha256').update(typeof expected === 'string' ? expected : '').digest()
  const b = crypto.createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest()
  return crypto.timingSafeEqual(a, b) && typeof expected === 'string'
}

// Brute-force limit, per client IP: MAX_FAILURES wrong passwords within
// FAILURE_WINDOW_MS blocks that IP for BLOCK_MIN_MS, doubling for each
// repeat block up to BLOCK_MAX_MS. A successful login, or an hour without
// failures, clears the IP's record. The limit is generous on purpose: one
// login with a wrong password makes several connections (sync check, SRS,
// relay-hosted Tacview), and controllers behind one NAT share a counter.
const MAX_FAILURES      = 10
const FAILURE_WINDOW_MS = 60_000
const BLOCK_MIN_MS      = 30_000
const BLOCK_MAX_MS      = 10 * 60_000
const RECORD_TTL_MS     = 60 * 60_000
const failures = new Map() // ip → { count, windowStart, blockedUntil, blockMs, lastFailure }

// Stale records are pruned so the map can't grow without bound.
setInterval(() => {
  const now = Date.now()
  for (const [ip, rec] of failures) {
    if (now - rec.lastFailure > RECORD_TTL_MS && now > rec.blockedUntil) failures.delete(ip)
  }
}, 10 * 60_000).unref()

function isBlocked(ip) {
  const rec = failures.get(ip)
  return !!rec && Date.now() < rec.blockedUntil
}

function recordFailure(ip, tag) {
  const now = Date.now()
  let rec = failures.get(ip)
  if (!rec || now - rec.lastFailure > RECORD_TTL_MS) {
    rec = { count: 0, windowStart: now, blockedUntil: 0, blockMs: 0, lastFailure: now }
    failures.set(ip, rec)
  }
  if (now - rec.windowStart > FAILURE_WINDOW_MS) { rec.count = 0; rec.windowStart = now }
  rec.count++
  rec.lastFailure = now
  if (rec.count >= MAX_FAILURES) {
    rec.blockMs = rec.blockMs ? Math.min(rec.blockMs * 2, BLOCK_MAX_MS) : BLOCK_MIN_MS
    rec.blockedUntil = now + rec.blockMs
    rec.count = 0
    rec.windowStart = now
    console.warn(`${tag} ${ip} blocked for ${rec.blockMs / 1000}s after ${MAX_FAILURES} wrong passwords`)
  }
}

// The client's IP. A connection from loopback carrying X-Forwarded-For comes
// through a reverse proxy on this machine (the documented TLS setup), so the
// forwarded address is used; without this every client behind the proxy
// would share one IP and one brute-force record. A remote client can't
// spoof it, since its own connection never comes from loopback.
function clientIp(req) {
  const remote = req?.socket?.remoteAddress ?? 'unknown'
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const forwarded = req?.headers?.['x-forwarded-for']
  if (isLoopback && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim()
  return remote
}

// Always waits for the client's {type:'auth', coalition, password, peerId?}
// message — even when validPasswords is empty (no password check performed
// in that case, but the message itself still isn't skipped). This matters
// beyond consistency: onAuthenticated(msg) is a capability's only source of
// whatever the client declared (e.g. syncRelay.js's peerId, or coalition
// itself) — skipping straight to an unconditional ack in the no-auth-
// required case would hand every capability an empty {} instead, silently
// losing that data. Closes the connection if nothing arrives within
// timeoutMs, or if a password is required and doesn't match the *specific*
// coalition claimed — validPasswords is a { coalition: password } map, not
// a flat list, so a Red client can't authenticate by supplying Blue's
// password under a false coalition claim. This only gates the connection
// itself; it does not separately restrict which topics an authenticated
// connection may subscribe to afterward. That's intentional: it lets a
// GM/Admin session subscribe to every coalition's sync topic, and the relay
// is trusted single-mission infrastructure, not a hardened multi-tenant
// boundary.
// `label` identifies which capability's connection this is in the logs
// (e.g. 'transponders', 'sync') — two capabilities rejecting two unrelated
// connections at the same moment (e.g. a bad password tested through both
// Login's sync capability check and srs.js's transponder connection at
// once) would otherwise print identical, indistinguishable lines.
function gateConnection(ws, validPasswords, { onAuthenticated, timeoutMs = AUTH_TIMEOUT_MS, label = 'relay', req } = {}) {
  const authRequired = Object.keys(validPasswords).length > 0
  let authenticated = false
  const tag = `[relay:${label}]`
  const ip = clientIp(req)

  if (authRequired && isBlocked(ip)) {
    ws.close(4003, 'too many failed attempts - try again later')
    return { authenticated: false }
  }

  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      console.warn(`${tag} client did not authenticate in time - closing connection`)
      ws.close(4001, 'auth timeout')
    }
  }, timeoutMs)
  ws.once('close', () => clearTimeout(authTimeout))

  ws.on('message', function authListener(raw) {
    if (authenticated) return // already authenticated — not this gate's concern anymore

    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch (err) {
      console.error(`${tag} failed to parse client message:`, err.message)
      return
    }
    if (msg.type !== 'auth') return

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      console.warn(`${tag} protocol mismatch - relay speaks ${PROTOCOL_VERSION}, client sent ${msg.protocolVersion ?? 'none'} - closing connection`)
      ws.close(4002, `protocol mismatch: relay=${PROTOCOL_VERSION} client=${msg.protocolVersion ?? 'none'} — update whichever side is behind`)
      return
    }

    if (!authRequired || passwordMatches(validPasswords, msg.coalition, msg.password)) {
      if (authRequired) failures.delete(ip)
      authenticated = true
      clearTimeout(authTimeout)
      ws.off('message', authListener)
      ws.send(JSON.stringify({ type: 'auth_ok', relayVersion: RELAY_VERSION, protocolVersion: PROTOCOL_VERSION }))
      onAuthenticated?.(msg)
    } else {
      console.warn(`${tag} client ${ip} sent an invalid coalition/password - closing connection`)
      recordFailure(ip, tag)
      ws.close(4001, 'invalid password')
    }
  })

  return { authenticated: false }
}

module.exports = { gateConnection, AUTH_TIMEOUT_MS, passwordMatches }
