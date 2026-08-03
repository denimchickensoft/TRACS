# TRACS — Tactical Radar And Control Suite

A browser-based control suite for DCS World multiplayer servers running the [Olympus](https://github.com/Pax1601/DCSOlympus) mod, providing ATC, CATCC, AIC, and ABM displays.

Each controller runs a local Node.js server that polls the Olympus REST API and pushes data to their browser. Controllers connect to each other peer-to-peer via WebRTC — no port forwarding or shared server required.

**Status:** pre-beta, under active development. No automated test suite yet — treat scope behavior as verified only insofar as it's been run in a live session.

**Documentation:** in-depth operator guides live in [`docs/`](docs/index.md) — start there for how to actually run a position.

---

## Requirements

- Node.js 18+
- A Chromium-based browser (Chrome, Edge, Brave, etc.) — the only officially supported target. Firefox has known WebRTC issues and is not supported; Safari is not supported.
- A DCS World server running Olympus and its front-end server application

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
Approach/departure radar display. STARS-style command set: track ownership, handoffs, point outs, flight plan management, scratchpads, PTLs, datablock collision avoidance.

- **ASDE-X** — ground radar sub-scope for surface movement (taxiways, ramps).
- **PAR** — precision approach radar panel, available from both ATC and CATCC.

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
- Custom airspace/drawing import (GeoJSON), manual flight entry, airfield/ground-unit hover readout.

### Strip Bay
Flight progress strip management. Dockable alongside a scope or undocked to a separate window.

### Pilot Flight Plan Filing
Standalone page (`pilot.html`) pilots can use to file flight plans directly into a session over WebRTC, without going through Olympus.

---

## Architecture

```
[DCS + Olympus] ──REST──▶ [Local Node.js server] ──WebSocket──▶ [Browser]
                                                                      │
                                                               WebRTC (Trystero/Nostr)
                                                                      │
                                                              [Other controllers]
```

- Each controller runs their own local server — nothing extra is installed on the DCS/Olympus machine
- Peer discovery and WebRTC signaling uses the public Nostr relay network by default, falling back to a self-hosted ws-relay if no Nostr relay connects within ~8s — no account or infrastructure required
- Session identity is derived from the Olympus server address and an optional password — no coordination needed to join the same session

---

## Mock Olympus Server

For development without a live DCS server:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4514` with any password.
