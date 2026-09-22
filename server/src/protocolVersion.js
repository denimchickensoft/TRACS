'use strict'

// Wire-protocol version for the TRACS <-> Relay WebSocket handshake.
// Sent as `protocolVersion` on every {type:'auth', ...} message this backend
// sends to a standalone relay/ instance (server/src/srs.js,
// server/src/tacviewRelayClient.js). See relay/protocolVersion.js for the
// authoritative comment on the hand-sync requirement across all three copies
// (this file, relay/protocolVersion.js, client/src/webrtc/protocolVersion.js).
const PROTOCOL_VERSION = 1

module.exports = { PROTOCOL_VERSION }
