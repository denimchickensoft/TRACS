# TRACS — Tactical Radar And Control Suite

A browser-based ATC and carrier air traffic control (CATCC) display for DCS World multiplayer servers running the [Olympus](https://github.com/Pax1601/DCSOlympus) mod.

Each controller runs a local Node.js server that polls the Olympus REST API and pushes data to their browser. Controllers connect to each other peer-to-peer via WebRTC — no port forwarding or shared server required.

---

## Requirements

- Node.js 18+
- Chrome, Firefox, or Edge (Safari not supported)
- A DCS World server running Olympus

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

### ATC Scope
Full approach/departure radar display. STARS-style command set: track ownership, handoffs, point outs, flight plan management, scratchpads, PTLs.

### CATCC Scope
Carrier air traffic control display. Includes a Status Board for event/recovery tracking, synchronized across all CATCC positions via WebRTC.

### Strip Bay
Flight progress strip management. Can be docked alongside the ATC scope or undocked to a separate window.

### AIC Scope *(not yet implemented)*
Tactical display for airborne intercept control (AWACS/GCI role). Deferred.

---

## Architecture

```
[DCS + Olympus] ──REST──▶ [Local Node.js server] ──WebSocket──▶ [Browser]
                                                                      │
                                                               WebRTC (Trystero/Nostr)
                                                                      │
                                                              [Other controllers]
```

- Each controller runs their own local server — nothing is installed on the DCS/Olympus machine
- Peer discovery and WebRTC signaling uses the public Nostr relay network — no account or infrastructure required
- Session identity is derived from the Olympus server address and an optional password — no coordination needed to join the same session

---

## Mock Olympus Server

For development without a live DCS server:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4514` with any password.
