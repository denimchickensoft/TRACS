# Getting Started

## 1. Connect to Olympus

On first launch you're prompted to connect:

- **Server Name** — optional label; click the save icon to store this connection (URL, coalition, password) as a favorite for next time. Saved servers appear in a dropdown as you type.
- **Olympus Server URL & Port** — the DCS server's Olympus address, e.g. `http://1.2.3.4:4513`. `http://` is added automatically if omitted.
- **Coalition Role** — Blue Commander, Red Commander, Game Master, or Admin. This determines which units and which Olympus PUT permissions you have.
- **Coalition Password** — the Olympus password for that role, set on the DCS server.

Click **Connect to Network**. This calls the local TRACS server's `/api/connect`, which authenticates against Olympus and starts polling. If you see "Cannot reach TRACS server — is it running?", the local Node server (`npm run dev` / `npm start`) isn't up.

## 2. Sign in to a position

Once connected, pick a **Module** — ATC, CATCC, AIC, or ABM — and fill in that module's position fields:

| Module | Fields |
|---|---|
| ATC | Facility (an airbase from the Olympus airbase list, or a CTR/FIR identifier), position type (TWR/APP/DEP/GND/CTR), frequency |
| CATCC | Carrier (detected from live Olympus unit data — must be present in the mission), position (Marshal/Approach/Departure/Tower), frequency |
| AIC | Callsign, frequency |
| ABM | Callsign, frequency |

Frequency must fall in VHF (118.000–136.975) or UHF (225.000–399.975). If two controllers try to sign in on the same frequency without sharing a facility/position, TRACS blocks the second sign-in as a conflict — this is a pre-flight check against other clients already in the session, not a hard Olympus restriction.

For ATC, selecting a facility auto-fills its ICAO/LID from local navdata when available; if nothing resolves, type it manually (4 characters max). Frequency is similarly suggested from navdata when a facility+position match is found, but you can override it.

**Session Password** is separate from the Olympus coalition password — it scopes the peer-to-peer WebRTC room. Leave it blank for an open session, or set it so only controllers who know the password can join your session's mesh.

Click **Sign In**. This establishes your position, registers you with other controllers via WebSocket, and opens the WebRTC connection to peers already in the session.

## Reconnecting / refreshing

A browser refresh rejoins the same session automatically — your peer identity is persisted locally, so other controllers see you reconnect rather than see you as dropped. A full **Disconnect** (bottom of the position sign-in screen) clears this and returns you to the connect screen.

## Local testing without a live DCS server

Run the bundled mock Olympus server:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4514` with any password. This is useful for exercising the UI or reproducing a bug without a running mission.
