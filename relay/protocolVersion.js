'use strict'

// Wire-protocol version for the TRACS <-> Relay WebSocket handshake
// (relay/auth.js's gateConnection checks this against every connecting
// client's declared version before checking its password). Bumped only when
// the actual message shapes exchanged over /transponders, /sync, or /tacview
// change in an incompatible way — independent of, and far less frequent
// than, either app's own release version.
//
// Hand-synced with the client-side copies of this same constant, since
// relay/ is deliberately excluded from the npm workspace and has no
// shared-code mechanism with server/ or client/ today — mirrors the existing
// THEATRE_UTC_OFFSETS hand-synced-constant pattern (server/navdata/index.js).
// Keep in lockstep with:
//   - server/src/protocolVersion.js
//   - client/src/webrtc/protocolVersion.js
const PROTOCOL_VERSION = 1

module.exports = { PROTOCOL_VERSION }
