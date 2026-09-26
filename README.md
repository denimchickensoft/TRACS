# TRACS — Tactical Radar And Control Suite

[![Discord](https://img.shields.io/discord/1521314576409559100?style=flat-square&label=Discord&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/5W6cuezyPD)

A desktop control suite for DCS World multiplayer servers, providing ATC, CATCC, AIC, and ABM positions.

Each controller runs TRACS on their own machine. TRACS reads unit data from one of three sources:
- the [DCS Olympus](https://github.com/Pax1601/DCSOlympus) mod's REST API
- a direct connection to Tacview's Real-Time Telemetry export
- a **TRACS Relay** running on or near the DCS server, which also supplies SRS transponder/IFF data

Controllers sync with each other through the relay when one is available, and peer-to-peer over WebRTC otherwise. The peer-to-peer mode needs no port forwarding and no shared server.

**Operator guides** live in [`docs/`](docs/index.md): connecting, signing in, and every module's commands.

| Module | What it is |
|---|---|
| [ATC](docs/atc.md) | STARS-style approach/departure radar, plus ASDE-X ground radar, PAR, and Strip Bay |
| [CATCC](docs/catcc.md) | Carrier air traffic control scope, synchronized Status Board, and Deck view |
| [AIC](docs/aic.md) | AWACS/GCI intercept scope: declarations, BRAA list, ROE, PICTURE |
| [ABM](docs/abm.md) | Mission-wide battle management: ATO/FRAG from `.miz` imports, IFF correlation, scope drawing, MGRS grid |

---

## Installing TRACS (controllers)

Download the installer for your platform from the latest `tracs-v*` release on the [Releases page](https://github.com/denimchickensoft/TRACS/releases):

| Platform | Package |
|---|---|
| Windows | NSIS installer (`.exe`) |
| macOS | `.dmg` |
| Linux | `.AppImage` |

The builds are not code-signed. Windows SmartScreen and macOS Gatekeeper will warn on first launch.

**Updates:** TRACS checks GitHub Releases at launch.
- On Windows and Linux it asks before downloading an update, then offers to restart and install it.
- On macOS it shows a notice with a link to the release page, and you install the new `.dmg` yourself.

**Local server and port:** the app runs its own local server in-process, on port 3000 or the next free port. The first port that works is remembered for later launches, because saved preferences are tied to it. If that port becomes unavailable, TRACS picks another and tells you that saved preferences won't carry over for that session.

**Menu:**
- **File → New Window** opens another TRACS window.
- **File → Open Logs Folder** shows the log file.
- **File → Open Config Folder** shows the config files described below.

**Navigation data (LittleNavMap):**
- The installer bundles theatre geography, terrain, elevation, and airport data.
- Fixes, navaids, airways, and procedures come from your own LittleNavMap Navigraph database (a `.sqlite` file).
- On launch, if no database is configured, TRACS asks you to pick one. It extracts the data, and at each later launch re-extracts automatically if the file has changed.
- Without a database, those layers are unavailable and everything else works.
- There is no in-app setting to change the database once it's configured.

**Config files:**
- TRACS stores a few hand-editable config files in `%APPDATA%\TRACS\config\` (Windows) — seeded from bundled defaults on first launch, and never overwritten once present, so your edits survive every update.
- `rateConfig.json` — radar scan-rate cadence (unit position/detection refresh intervals) for direct-mode Olympus/Tacview connections.
- `tacviewDetectionConfig.json` — synthetic radar-detection model tuning for Tacview-sourced connections (sensor ranges, RWR behavior, scan cone).
- `airspace_colors.json` / `asdex_colors.json` — STARS/ASDE-X display color palettes.
- Edits take effect immediately, no restart needed.
- There is no in-app editor for these — edit the JSON files directly. Use **File → Open Config Folder** to find them.

Then follow [Getting Started](docs/getting-started.md) to connect and sign in.

---

## Data sources

- **Olympus** — requires the Olympus mod and its server application on the DCS server. TRACS polls its REST API with your coalition's Olympus password.
- **Tacview** — requires Tacview Real-Time Telemetry enabled on the DCS server. TRACS connects straight to it with the Tacview RTT password.
- **Relay** — a TRACS Relay connects to Tacview for you, and adds SRS transponder data and relay-hosted sync.

A Relay can also be used alongside Olympus or Tacview, only for SRS data and sync. See [Getting Started](docs/getting-started.md#1-connect) for the connection fields.

---

## Running a TRACS Relay (server operators)

The relay is a standalone executable, usually run on the DCS server machine next to SRS. It is optional. When present, it:

- listens to **SRS's LotATC export** (UDP) and serves transponder data (Mode 1/2/3/4, status) to every connected controller at `/transponders`;
- hosts **centralized sync** between controllers at `/sync`;
- optionally connects to **Tacview Real-Time Telemetry** once and fans it out to controllers at `/tacview` (Relay mode on the connect screen).

All three are served on one WebSocket port.

### Setup

1. From the latest `relay-v*` release, download `TracsRelay.exe` (Windows) or `TracsRelay` (Linux), plus `config.example.json`.
2. Put them in one folder, and copy `config.example.json` to `config.json` in that folder.
3. In SRS's server settings, enable the LotATC export and point it at the relay machine, on the port set as `srsLotatcPort` (10712 by default).
4. Open `wsPort` (8765 by default) to controllers.
5. Run the executable.

Controllers enter the relay's port as **Relay Port**. The relay must be reachable at the same host as the **Server URL** they connect with.

### `config.json`

Each key falls back to the environment variable listed, then to the default.

| Key | Env var | Default | Meaning |
|---|---|---|---|
| `srsLotatcPort` | `SRS_LOTATC_PORT` | `10712` | UDP port the relay listens on for SRS's LotATC export |
| `wsPort` | `RELAY_WS_PORT` | `8765` | WebSocket port controllers connect to |
| `tacviewHost` | `TACVIEW_HOST` | `''` | Tacview RTT host. Leave empty to disable the Tacview capability |
| `tacviewPort` | `TACVIEW_PORT` | `42674` | Tacview RTT port |
| `tacviewPassword` | `TACVIEW_PASSWORD` | `''` | Tacview's own RTT password |
| `passwords` | — | `{}` | Per-coalition passwords, e.g. `{ "blue": "…", "red": "…" }`. A client must supply the password for the coalition it connects as. Empty means no password is required |
| `unitUpdateMs` | `UNIT_UPDATE_MS` | `1000` | Radar update interval pushed to controllers in Relay mode (`config.example.json` uses `4000`) |
| `detectionMs` | `DETECTION_MS` | `1000` | Detection update interval (example: `4000`) |
| `missileDetectionMs` | `MISSILE_DETECTION_MS` | `1000` | Missile detection update interval (example: `4000`) |
| `autoUpdate.mode` | — | `window` | `notify`, `immediate`, or `window` (see below) |
| `autoUpdate.window` | — | `04:00`–`05:00` America/New_York | `{ start, end, timezone }` daily maintenance window for `window` mode |

### Relay updates

The executable checks GitHub Releases for newer `relay-v*` versions at startup and every 15 minutes:

| `autoUpdate.mode` | When a new version is found |
|---|---|
| `notify` | Logs that an update is available and does nothing else |
| `immediate` | Downloads it, swaps the executable in place, and exits |
| `window` | Does the same as `immediate`, but only inside the daily maintenance window |

The relay exits after swapping, so run it under a supervisor that restarts it: a Windows service wrapper, systemd, or similar.

### Version compatibility

TRACS and the relay exchange a protocol version when they connect. If they don't match, the relay closes the connection with a message naming both versions. TRACS then shows "Relay protocol mismatch … — using peer-to-peer." and doesn't retry. Update whichever side is older. The Settings panel in TRACS shows the connected relay's version and protocol number.

---

## Running from source (developers)

Requirements: Node.js 20+ and Git.

```bash
npm install          # once, and after pulling dependency changes
npm run dev          # local server on :3000 + Vite dev server on :5173 (proxies /api and /ws)
```

Open `http://localhost:5173` in a Chromium-based browser (Chrome, Edge, Brave). Firefox and Safari are not supported.

| Command | What it does |
|---|---|
| `npm run build` then `npm start` | Build the client and serve it from the local server on `http://localhost:3000` |
| `npm run electron:dev` | Build the client and run it inside Electron, as the desktop app does |
| `npm run dist:electron` | Build an installer for the current platform into `dist-electron/` (stages bundled navdata first) |
| `npm run lint` | ESLint, plus a check that `relay/tacviewCore.js` matches its generated source |
| `npm run knip` | Unused files/exports/dependencies report |
| `npm run sync:tacview-core` | Regenerate `relay/tacviewCore.js` from the server's Tacview parser |

**LittleNavMap database in dev:** set the `LNM_DB_PATH` environment variable to your `.sqlite` file before starting the server. The Electron file picker doesn't exist in a browser.

**Relay from source:**

```bash
cd relay
npm install
npm start            # node index.js, reads relay/config.json
npm run build        # produce relay/dist/TracsRelay(.exe) + config.example.json
```

A relay run from source never updates itself.

**Mock Olympus server** for working without DCS:

```bash
node mock-olympus/server.js
```

Connect TRACS to `http://localhost:4001` in Olympus mode, with any password.

---

## Releasing (maintainers)

Releases are built by GitHub Actions when a version tag is pushed. The tag is the only source of the version number; the workflows write it into `package.json` at build time, so never edit `version` by hand.

| Tag | Workflow | Produces |
|---|---|---|
| `tracs-vX.Y.Z` | `.github/workflows/release-tracs.yml` | Windows NSIS, macOS dmg, and Linux AppImage installers, built on windows-latest / macos-latest / ubuntu-20.04 and published to one GitHub Release by electron-builder. This release is what installed apps update from |
| `relay-vX.Y.Z` | `.github/workflows/release-relay.yml` | `TracsRelay.exe` (Windows), `TracsRelay` (Linux), and `config.example.json`, attached to one GitHub Release. This release is what running relays update from |

```bash
git tag tracs-v0.2.0 && git push origin tracs-v0.2.0
git tag relay-v0.2.0 && git push origin relay-v0.2.0
```

TRACS and the relay are versioned independently.

**Protocol changes:** when the TRACS ↔ relay wire protocol changes, bump the integer in all three copies of `protocolVersion.js`: `server/src/`, `client/src/webrtc/`, and `relay/`. Then release both TRACS and the relay.

No code-signing certificate is used for any platform.

---

## Architecture

```
[DCS server] ──REST/TCP──▶ [TRACS local server] ──WebSocket──▶ [TRACS window]
      │                                                               │
      │  (optional, DCS-server-side)                        WebRTC peer-to-peer
      ▼                                                    (when no relay sync)
[TRACS Relay] ───────────────────────────WS──────────────▶ [Other controllers]
      │                                                  (relay sync, when available)
      └── SRS transponder data + Tacview telemetry to any number of controllers
```

- Each controller runs their own local server; in the desktop app it runs inside the app. The only component installed on the DCS server side is the optional TRACS Relay. Controllers' local servers are never reachable from other controllers.
- Controller-to-controller sync uses the relay when one is reachable. Otherwise it uses peer-to-peer WebRTC.
  - Peer discovery uses the public Nostr relay network.
  - If no Nostr relay connects within ~8 s, it uses a self-hosted ws-relay instead.
- Sync rooms are coalition-scoped. A relay-hosted room is keyed on coalition, since each relay serves one mission. A peer-to-peer room is derived from the server address, the coalition, and the optional session password.
