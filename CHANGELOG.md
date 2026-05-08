# Changelog

All notable changes to TRACS are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Fixed
- `BARE_SLEW` (slew-to-track gesture) now broadcasts `HANDOFF_ACCEPTED`, `HANDOFF_RECALLED`, and `POINT_OUT_ACCEPTED` events to peers — previously only updated local state
- `HND_OFF_ACCEPT_NEAR` now broadcasts `HANDOFF_ACCEPTED` to peers
- Position collision suffix format corrected: `KLAS_APP` → `KLAS_1_APP` (was `KLAS_APP_1`)

### Added
- Browser refresh reconnect: peer ID persisted to localStorage so a page refresh rejoins with the same identity and cancels the 10-second disconnect timer instead of creating a new peer
- `peerSequences` included in `STATE_DUMP` so recipients can detect missed messages
- `HANDSHAKE_REJECT` handler sets WebRTC status to `rejected`
- `CONTROLLER_MESSAGE` send/receive infrastructure: `sendControllerMessage()` exported, incoming messages stored in session store. UI not yet implemented.

---

## [0.2.0] — CATCC, WebRTC, Extended Scope Features

### Added
- WebRTC peer-to-peer sync via Trystero (Nostr relay signaling)
  - Full session establishment: handshake, state dump, client list sync
  - 10-second disconnect timeout with track drop and handoff return
  - Intentional reset (Change Position) vs browser refresh handled separately
  - State persistence: `atc.json`, `catcc.json`, `session.json` written atomically
- CATCC Scope and Status Board (event header, recovery status, sortie entries)
- CATCC Status Board WebRTC sync (`STATUS_BOARD_UPDATE`)
- Status Board window: dockable/undockable, resizable
- Extended centerlines canvas layer
- Obstructions rendering (Caucasus obstruction data included)
- Sun times utility (for day/night awareness)
- Server-side state file API (`GET/POST/PATCH /api/state/:key`)
- Runway store with extended runway data
- Strip bay dock/undock and resize
- Login screen position/facility selection
- Correlation store

### Changed
- Mock Olympus server rewritten to match current Olympus API shape

---

## [0.1.0] — Initial Commit

### Added
- Local Node.js/Express server with Olympus REST API polling (units, mission, airbases)
- WebSocket push to browser for unit deltas, mission data, airbase data
- ATC Scope: canvas-based radar display with layered rendering
  - Contacts, datablocks, PTLs, history trails
  - Range rings, compass rose
  - Runways
- DCB (Display Control Bar)
- Datablock overlay
- STARS-style command set: track claim/drop, handoffs (full flow), point outs (full flow), flight plan create/amend/delete, scratchpads, leader lines
- Strip bay with strip passing
- ODS profile system (Simple and STARS profiles)
- Zustand state slices: units, session, atc, display, strips, flightPlans, preview, fpe
- Vite + React client, npm workspaces
