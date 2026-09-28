# Getting Started

[← All docs](index.md)

## 1. Connect

When you launch TRACS, it asks you to connect. Pick a **Primary Data Source** first, because it determines which of the fields below apply:

| Mode | What it is |
|---|---|
| **Olympus** | Polls the DCS Olympus mod's REST API directly. |
| **Tacview** | Connects straight to a DCS server's Tacview Real-Time Telemetry export. |
| **Relay** | Connects to a TRACS Relay instead of DCS directly. The relay connects to Tacview and to SRS on your behalf, and fans that data out to any number of controllers. |

Which fields are shown and required depends on the mode:

- **Server Name** — optional label.
  - Clicking the save icon saves the connection as a profile.
  - Connecting with a Server Name filled in also saves it.
  - Saved profiles appear in a dropdown and remember which mode they were saved under. Click a profile's **★** to mark it as a favorite.
- **Server URL** — the DCS server's address, e.g. `1.2.3.4`. `http://` is added automatically if omitted.
- **Source Port** — the Olympus or Tacview port. Optional in **Olympus**/**Tacview** modes; leave it blank to use the URL's own scheme default (e.g. a reverse-proxied `https://host` with no port exposed). Hidden in **Relay** mode.
- **Relay Port** — the TRACS Relay's port. The relay is always reached at the Server URL's host on this port: `ws://<host>:<Relay Port>`, or `wss://` when the Server URL starts with `https://` (a relay behind TLS; see the README's relay TLS section).
  - In **Olympus**/**Tacview** modes this is optional. Fill it in to get SRS transponder/IFF data merged onto tracks, and to sync with other controllers through the relay rather than peer-to-peer.
  - In **Relay** mode it's required.
- **Coalition Role** — Blue Commander, Red Commander, Game Master, or Admin. Determines which units you can see and control.
- **Password field(s)** — the label and meaning depend on mode:
  - **Olympus**: "Coalition Password" — the Olympus password for your role, set on the DCS server.
  - **Tacview**: "Tacview RTT Password" — Tacview's own export password. It's set once in DCS's options and is the same for every coalition. If you also fill in a Relay Port, a second "Coalition Password" field appears for the relay itself.
  - **Relay**: "Coalition Password" — your coalition's password for the relay, set by whoever runs it. The relay uses it to authenticate the coalition you're connecting as.
  - TRACS remembers the passwords you enter (with saved profiles and your last connection, plus the Session Password) so it can fill them in next time. They're stored **unencrypted** on this computer, in the app's local storage, so don't use TRACS to hold a password you reuse elsewhere.

Click **Connect to Network**. TRACS authenticates against your chosen source and starts polling. If you see "Cannot reach TRACS server — is it running?", TRACS's local server isn't responding. In the desktop app, check **File → Open Logs Folder**. When running from source, start it with `npm run dev` or `npm start`.

If a Relay Port is set, TRACS checks in parallel whether relay sync is available. This never blocks connecting. If the relay can't be used, you'll see one of these warnings with a **Continue** button, and TRACS falls back to peer-to-peer sync (see Session Password below):
- "Relay password rejected — using peer-to-peer."
- "Relay is refusing this computer after too many wrong passwords — try again in a few minutes. Using peer-to-peer." — ten wrong passwords within a minute block your address for a while.
- "Relay unreachable — using peer-to-peer."
- "Relay protocol mismatch: relay=N client=M — update whichever side is behind — using peer-to-peer." — the relay and TRACS versions are incompatible.

**Theatre** (Tacview and Relay modes): Tacview doesn't report which DCS theatre a mission runs on, so TRACS detects it from unit positions and shows "Theatre (detected: X)" on the sign-in screen. **▸ Override** lets you pick the theatre manually, and **⟲ Reset to auto-detect** undoes that.

## 2. Sign in to a position

Once connected, pick a **Module** — ATC, CATCC, AIC, or ABM — and fill in that module's position fields:

| Module | Fields |
|---|---|
| [ATC](atc.md) | Facility (an airbase from the current source's airbase list, or a CTR/FIR identifier), position type (TWR/APP/DEP/GND/CTR, plus RDR/CONTROL/DEL), frequency |
| [CATCC](catcc.md) | Carrier (detected from live unit data — must be present in the mission), position (Marshal/Approach/Departure/Tower), frequency |
| [AIC](aic.md) | Callsign, frequency |
| [ABM](abm.md) | Callsign, frequency |

Frequency must fall in VHF (118.000–136.975) or UHF (225.000–399.975).

TRACS checks the frequency against other controllers already in the session. If another controller with a different facility/callsign or position is already on it, sign-in fails with "Frequency X MHz is already in use by <position>." If that check can't reach the session list, sign-in proceeds and the check happens during the handshake with other controllers instead.

For ATC, selecting a facility auto-fills its ICAO/LID from local navdata when available; otherwise type it manually (4 characters max). Frequency is also suggested from navdata when a facility+position match is found, and you can override it.

**Session Password** scopes the peer-to-peer room. Leave it blank for an open session, or set one so only controllers who know it can join. The field only appears when TRACS is using peer-to-peer sync. It's hidden when relay sync is active, where the relay's coalition password governs who can join.

Click **Sign In**. This establishes your position, registers you with other controllers, and joins the sync transport chosen in step 1 (relay sync if available, otherwise peer-to-peer).

## Screen layout and common controls

**Top bar** (once signed in):
- **Change Position** asks you to confirm, then returns you to the position sign-in screen, still connected to the same data source.
- **STARS / ASDE-X** (ATC only) switch the radar display between the approach radar and the ASDE-X ground display. **Shift+click ASDE-X** opens ASDE-X in its own window instead.
- **Messages** opens the chat window (same as `Ctrl+M`).
- **⚙** opens [Settings](#settings).

**Keyboard shortcuts** (work in every module):

| Shortcut | Effect |
|---|---|
| `Ctrl+L` | Show or hide the Controller List (every signed-in controller and position) |
| `Ctrl+M` | Show or hide Messages, a chat window shared across all modules. Type to message your own module's controllers; `.chat <POSITION>` sends a direct message; `/ <text>` broadcasts to everyone |

**Side panels:** a thin tab strip runs down the right edge of the screen. Each module has its own tabs:

| Module | Tabs |
|---|---|
| ATC | STRIPS (Strip Bay), PAR |
| CATCC | STATUS (Status Board), PAR, DECK |
| AIC | BRAA |
| ABM | ATO, FRAG, DRAW (Drawings) |

- Click a tab to show or hide its panel.
- A panel's **⬡** button pops it out into its own window. You can move that window to another monitor.
- While a panel is popped out, its tab shows **↗** (e.g. `STRIPS ↗`). Clicking the tab brings that window to the front.

## Reconnecting / refreshing

Reloading the window rejoins the same session automatically. Your peer identity is stored locally, so other controllers see you reconnect rather than drop. **Disconnect** (bottom of the position sign-in screen) clears this and returns you to the connect screen.

## Settings

The **⚙** icon (top right, once signed in) opens the settings panel:

- **Use DCS Multiplayer Names** — callsigns/labels use DCS multiplayer names instead of the in-mission unit names.
- **Sounds** — master mute for every audible alert TRACS plays, on by default: STARS Conflict Alert (STCA) tones and the [ABM missile-launch alert](abm.md#missile-tracking--launch-alert). Unchecking it silences both regardless of any per-module volume setting (e.g. ABM's `.vol`).
- **Navigation data** — the LittleNavMap database TRACS is using, and (desktop app) a **Change…** button. See [Navigation data](#navigation-data-littlenavmap).
- **Version line** — the TRACS version (`TRACS (dev)` when running from source), plus the relay's version and protocol number when connected to one.
- **Help / Docs** — opens the documentation page for the module you're signed into, in a new tab. In the desktop app, Ctrl+F there opens a find box: Enter / Shift+Enter step through matches, Esc closes it.
- **About** — copyright, license (GPL v3.0 or later, no warranty), data attributions, and links to the full **License** and **Third-party notices**.

## Navigation data (LittleNavMap)

Fixes, navaids, airways and procedures come from your own **LittleNavMap Navigraph database**, a `.sqlite` file that LittleNavMap usually keeps at:

```
%APPDATA%\ABarthel\little_navmap_db\little_navmap_navigraph.sqlite
```

Everything else (theatre geography, terrain, airports and runways) is bundled with TRACS.

- **First launch (desktop app):** if no database is set, TRACS explains this and offers **Choose file…**, **Not now**, or **Don't ask again**. After you choose a file, TRACS extracts the data; this can take a minute, and any error is shown in the dialog.
- **Changing it later:** open **⚙ → Navigation data → Change…**. The new data takes effect the next time you sign in to a position.
- **Updates:** at each launch, TRACS re-extracts automatically if the database file has changed (e.g. after a new AIRAC cycle).
- **Without a database:** those layers are empty, and commands that look up a fix or procedure reply `NO NAVDATA`. Everything else works normally.
- **Running from source:** you can set the `LNM_DB_PATH` environment variable instead.

## Local testing without a live DCS server

A source checkout includes a mock Olympus server:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4001` in Olympus mode, with any password.
