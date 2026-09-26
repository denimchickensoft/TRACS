'use strict'

// Shared per-connection password gate, used by every relay capability
// (relay/transponders.js, relay/syncRelay.js, and whatever comes next).

const { PROTOCOL_VERSION } = require('./protocolVersion')
const { version: RELAY_VERSION } = require('./package.json')

const AUTH_TIMEOUT_MS = 5_000

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
function gateConnection(ws, validPasswords, { onAuthenticated, timeoutMs = AUTH_TIMEOUT_MS, label = 'relay' } = {}) {
  const authRequired = Object.keys(validPasswords).length > 0
  let authenticated = false
  const tag = `[relay:${label}]`

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

    if (!authRequired || validPasswords[msg.coalition] === msg.password) {
      authenticated = true
      clearTimeout(authTimeout)
      ws.off('message', authListener)
      ws.send(JSON.stringify({ type: 'auth_ok', relayVersion: RELAY_VERSION, protocolVersion: PROTOCOL_VERSION }))
      onAuthenticated?.(msg)
    } else {
      console.warn(`${tag} client sent an invalid coalition/password - closing connection`)
      ws.close(4001, 'invalid password')
    }
  })

  return { authenticated: false }
}

module.exports = { gateConnection, AUTH_TIMEOUT_MS }
