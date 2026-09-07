# TRACS — Tactical Radar And Control Suite

A browser-based control suite for DCS World multiplayer servers, providing ATC, CATCC, AIC, and ABM displays.

Each controller runs a local Node.js server that pulls unit data from one of three interchangeable sources — the [Olympus](https://github.com/Pax1601/DCSOlympus) mod's REST API, a direct connection to Tacview's Real-Time Telemetry export, or a standalone TRACS Relay app that can also supply SRS transponder/IFF data — and pushes it to their browser. Controllers connect to each other peer-to-peer via WebRTC by default — no port forwarding or shared server required — or over a centralized transport hosted by the same optional Relay app when one is reachable.

**Documentation:** in-depth operator guides live in [`docs/`](docs/index.md) — start there for how to actually run a position.

---

## Requirements

- Node.js 18+
- A Chromium-based browser (Chrome, Edge, Brave, etc.) — the only officially supported target. Firefox has known WebRTC issues and is not supported; Safari is not supported.
- A DCS World server running **one** of: the Olympus mod and its front-end server application, or Tacview with Real-Time Telemetry enabled. Neither is required at the app level — pick whichever the mission actually has.
- Optional: [SimpleRadioStandalone (SRS)](https://github.com/ciribob/DCS-SimpleRadioStandalone) for transponder/IFF data, and/or the standalone TRACS Relay app (`relay/` — its own `npm start`, config via `relay/config.example.json`, typically run on/near the DCS server, not part of a controller's own TRACS instance) for SRS support and/or centralized sync. Neither is required to run TRACS itself.

---

## Running in Development

Install dependencies (once, or after pulling new changes):

```bash
npm install
```

Start both the server and client dev server:

```bash
npm run dev
```

Open your browser to `http://localhost:5173`.

The local API server runs on port 3000. The Vite dev server proxies `/api` and `/ws` requests to it automatically.

---

## Running in Production

Build the client:

```bash
npm run build
```

Start the server (serves the built client on port 3000):

```bash
npm start
```

Open your browser to `http://localhost:3000`.

---

## Modules

### ATC (Air Traffic Controller) Scope
Approach/departure radar display. STARS-style command set: track ownership, handoffs, point outs, flight plan management, scratchpads, PTLs, datablock collision avoidance, altitude filters, and Conflict Alert/MCI (STCA). When SRS transponder data is available, tracks gain association-gated datablocks, IDENT, and simulated squawk-standby wingmen.

- **ASDE-X** — ground radar sub-scope for surface movement (taxiways, ramps), with SRS-aware Unknown Target tagging.
- **PAR** — precision approach radar panel, available from both ATC and CATCC.
- **Strip Bay** — flight progress strip management, dockable alongside the scope or undocked to a separate window.

### CATCC (Carrier Air Traffic Control Center) Scope
Carrier air traffic control display.

- **Status Board** — event/recovery tracking (case launch/recovery), synchronized across all CATCC positions via WebRTC.
- **Deck** — carrier deck view with zoom/pan and lat-lon calibration.
- Mission import for carrier/airbase data.

### AIC (Air Intercept Controller) Scope
Tactical display for airborne intercept control (AWACS/GCI role): BRAA list, intercept geometry.

### ABM (Air Battle Manager)
Mission-wide package tracking display.

- **ATO / FRAG** — tasking summary and per-package detail, built from a dragged-in `.miz`/mission file. Deliberately limited to structural mission data (groups/routes/payloads) — trigger scripting and briefing text are excluded by design.
- Free-hand scope drawing (lines, rectangles, circles, polygons, sectors, racetracks, text labels) plus custom airspace/drawing import (GeoJSON, zip, or `.miz`), a theatre-aware MGRS grid overlay, manual flight entry, airfield/ground-unit hover readout.

### Pilot Flight Plan Filing
Standalone page (`pilot.html`) pilots can use to file flight plans directly into a session over WebRTC, without going through any of the primary data sources above.

---

## Architecture

```
[DCS server] ──REST/TCP──▶ [Local Node.js server] ──WebSocket──▶ [Browser]
      │                                                               │
      │  (optional, DCS-server-side)                          WebRTC P2P (default fallback)
      ▼                                                               │
[TRACS Relay] ───────────────────────────WS──────────────▶ [Other controllers]
      │                                    (default, when reachable)
      └── also fans out SRS transponder data + Tacview telemetry to any number of controllers
```

- Each controller runs their own local server — by default, nothing extra is installed on the DCS server machine. The one exception is the optional TRACS Relay (`relay/`) — a separate, standalone app an operator can run on/near the DCS server to add SRS transponder data and/or a faster, centralized alternative to the peer-to-peer mesh. No controller's own local server is ever reachable by another controller directly; the relay is the only thing that is.
- Controller-to-controller sync uses the relay's centralized transport by default whenever one is reachable, falling back to peer-to-peer WebRTC otherwise. Peer discovery/signaling for the P2P fallback uses the public Nostr relay network by default, falling back further to a self-hosted ws-relay if no Nostr relay connects within ~8s — no account or infrastructure required either way.
- Session/room identity is coalition-scoped: a relay-hosted sync room is keyed purely on coalition (the relay itself is already pinned to one mission), while the peer-to-peer fallback derives its room from the server address, coalition, and an optional session password.

---

## Mock Olympus Server

For development without a live DCS server:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4514` with any password.
