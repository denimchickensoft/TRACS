// AUTO-GENERATED -- DO NOT EDIT DIRECTLY.
// Generated from server/src/protocolVersion.js by scripts/sync-tacview-core.js
// (see that file's header for why this copy exists). To change it, edit
// server/src/protocolVersion.js and run:
//   npm run sync:tacview-core

'use strict'

// Wire-protocol version for the TRACS <-> Relay WebSocket handshake. Sent as
// `protocolVersion` on every {type:'auth', ...} message to a standalone relay
// (server/src/srs.js, server/src/tacviewRelayClient.js, and the browser's
// relay-hosted sync in client/src/webrtc/syncClient.js); relay/auth.js's
// gateConnection checks it before the password. Bumped only when the message
// shapes exchanged over /transponders, /sync, or /tacview change in an
// incompatible way -- independent of, and far less frequent than, either
// app's own release version.
//
// This file is canonical. relay/protocolVersion.js and
// client/src/webrtc/protocolVersion.js are generated from it by
// `npm run sync:tacview-core` (see scripts/sync-tacview-core.js).
const PROTOCOL_VERSION = 1

module.exports = { PROTOCOL_VERSION }
