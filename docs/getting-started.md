# Getting Started

[← All docs](index.md)

## 1. Connect

On first launch you're prompted to connect. Pick a **Primary Data Source** first — this changes which of the fields below actually apply:

| Mode | What it is |
|---|---|
| **Olympus** | Polls the DCS Olympus mod's REST API directly. |
| **Tacview** | Connects straight to a DCS server's Tacview Real-Time Telemetry export. |
| **Relay** | Connects to a standalone TRACS Relay app instead of DCS directly — the relay is what actually talks to Tacview (or, in the future, another TRACS-authored source) on your behalf, and fans the data out to any number of controllers. |

Fields shown/required depend on the mode:

- **Server Name** — optional label; click the save icon to store this connection as a favorite for next time. Saved servers appear in a dropdown as you type, and remember which mode they were saved under.
- **Server URL** — the DCS server's address, e.g. `1.2.3.4`. `http://` is added automatically if omitted.
- **Source Port** — the Olympus or Tacview port. Shown and required in **Olympus**/**Tacview** modes; hidden entirely in **Relay** mode (the relay is the connection, there's no separate source port to give).
- **Relay Port** — the TRACS Relay app's port.
  - In **Olympus**/**Tacview** modes this is optional — fill it in to also get SRS transponder/IFF data merged onto tracks, and centralized sync with other controllers (see below) instead of the peer-to-peer fallback.
  - In **Relay** mode this is required — it's your entire connection.
- **Coalition Role** — Blue Commander, Red Commander, Game Master, or Admin. Determines which units you can see and control.
- **Password field(s)** — the label and meaning depend on mode:
  - **Olympus**: "Coalition Password" — the Olympus password for your role, set on the DCS server.
  - **Tacview**: "Tacview RTT Password" — Tacview's own export password, set once in DCS's own options and shared by every coalition (it is *not* a per-coalition secret). If you also fill in a Relay Port, a *second*, separate "Coalition Password" field appears above it — this one is your coalition's password for the relay itself, and is genuinely different from Tacview's own password.
  - **Relay**: "Coalition Password" — your coalition's password for the relay, set by whoever runs it. This single field both authenticates you to the relay and drives which contacts you're allowed to see if the relay is filtering by coalition.

Click **Connect to Network**. This calls the local TRACS server's `/api/connect`, which authenticates against your chosen source and starts polling. If you see "Cannot reach TRACS server — is it running?", the local Node server (`npm run dev` / `npm start`) isn't up.

If a Relay Port is set, TRACS also checks whether centralized sync is available in parallel. This never blocks connecting — if the relay's password is wrong or it's unreachable, you'll see a non-blocking warning ("Relay password rejected — using peer-to-peer" / "Relay unreachable — using peer-to-peer") and a **Continue** button; everything still works over the peer-to-peer fallback described under Session Password below.

**Theatre override** (Tacview/Relay modes only): Tacview has no reliable built-in way to report which DCS theatre a mission is running on, so TRACS guesses from unit positions. If it guesses wrong, a "Theatre override" control appears on the sign-in screen (step 2 below) letting you pick the correct theatre manually.

## 2. Sign in to a position

Once connected, pick a **Module** — ATC, CATCC, AIC, or ABM — and fill in that module's position fields:

| Module | Fields |
|---|---|
| [ATC](atc.md) | Facility (an airbase from the current source's airbase list, or a CTR/FIR identifier), position type (TWR/APP/DEP/GND/CTR), frequency |
| [CATCC](catcc.md) | Carrier (detected from live unit data — must be present in the mission), position (Marshal/Approach/Departure/Tower), frequency |
| [AIC](aic.md) | Callsign, frequency |
| [ABM](abm.md) | Callsign, frequency |

Frequency must fall in VHF (118.000–136.975) or UHF (225.000–399.975). If two controllers try to sign in on the same frequency without sharing a facility/position, TRACS blocks the second sign-in as a conflict — this is a pre-flight check against other clients already in the session, not a hard source-side restriction.

For ATC, selecting a facility auto-fills its ICAO/LID from local navdata when available; if nothing resolves, type it manually (4 characters max). Frequency is similarly suggested from navdata when a facility+position match is found, but you can override it.

**Session Password** scopes the peer-to-peer WebRTC room used when centralized sync (see step 1) isn't active. Leave it blank for an open session, or set it so only controllers who know the password can join your session's mesh. **This field only appears when you're on the peer-to-peer fallback** — if centralized sync via a relay is active, it's hidden entirely, since it has no effect there (the relay's own coalition password already governs who can join).

Click **Sign In**. This establishes your position, registers you with other controllers, and joins the sync transport that was actually negotiated in step 1 (centralized relay sync if available, otherwise the peer-to-peer WebRTC mesh).

## Reconnecting / refreshing

A browser refresh rejoins the same session automatically — your peer identity is persisted locally, so other controllers see you reconnect rather than see you as dropped. A full **Disconnect** (bottom of the position sign-in screen) clears this and returns you to the connect screen.

## Local testing without a live DCS server

Run the bundled mock Olympus server:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4001` with any password, Olympus mode. This is useful for exercising the UI or reproducing a bug without a running mission.
