// Wire-protocol version for the TRACS <-> Relay WebSocket handshake.
// Sent as `protocolVersion` on every {type:'auth', ...} message this browser
// sends directly to a standalone relay/ instance for relay-hosted sync
// (client/src/webrtc/syncClient.js). See relay/protocolVersion.js for the
// authoritative comment on the hand-sync requirement across all three copies
// (this file, relay/protocolVersion.js, server/src/protocolVersion.js).
export const PROTOCOL_VERSION = 1
