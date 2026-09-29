# TRACS — Tactical Radar And Control Suite

[![Discord](https://img.shields.io/discord/1521314576409559100?style=flat-square&label=Discord&logo=discord&logoColor=white&color=5865F2)](https://discord.gg/5W6cuezyPD)
[![Release](https://img.shields.io/github/v/release/denimchickensoft/TRACS?filter=v*&style=flat-square&label=release)](https://github.com/denimchickensoft/TRACS/releases/latest)
[![Build](https://github.com/denimchickensoft/TRACS/actions/workflows/release-tracs.yml/badge.svg)](https://github.com/denimchickensoft/TRACS/actions/workflows/release-tracs.yml)
[![Downloads](https://img.shields.io/github/downloads/denimchickensoft/TRACS/total?style=flat-square)](https://github.com/denimchickensoft/TRACS/releases)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](LICENSE)

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

Download the installer for your platform from the latest `v*` release on the [Releases page](https://github.com/denimchickensoft/TRACS/releases):

| Platform | Package |
|---|---|
| Windows | NSIS installer (`.exe`) |
| macOS | `.dmg` (universal: Apple Silicon and Intel) |
| Linux | `.AppImage` |

The builds are not code-signed. Windows SmartScreen and macOS Gatekeeper will warn on first launch.

**macOS:** because the app isn't signed, macOS may say "TRACS is damaged and can't be opened" instead of offering to open it. After dragging TRACS into Applications, clear the download quarantine flag once from Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/TRACS.app
```

**Updates:** TRACS checks GitHub Releases at launch.
- On Windows and Linux it asks before downloading an update, then offers to restart and install it.
- On macOS it shows a notice with a link to the release page, and you install the new `.dmg` yourself.

**Local server and port:** the app runs its own local server in-process, on port 8722 or the next free port. The first port that works is remembered for later launches, because saved preferences are tied to it. If another program is using that port at launch, TRACS names the program and lets you retry after closing it, use a nearby port for that session only (without your saved preferences), or quit.

**Menu:**
- **File → New Window** opens another TRACS window.
- **File → Open Logs Folder** shows the log file.
- **File → Open Config Folder** shows the config files described below.

**Navigation data (LittleNavMap):**
- The installer bundles theatre geography, terrain, elevation, and airport data.
- Fixes, navaids, airways, and procedures come from your own LittleNavMap Navigraph database (a `.sqlite` file).
- On launch, if no database is configured, TRACS explains what it needs and lets you pick the file, skip for now, or stop being asked. It extracts the data, and at each later launch re-extracts automatically if the file has changed.
- Without a database, those layers are unavailable (fix and procedure commands reply `NO NAVDATA`) and everything else works.
- To set or change the database later, open **Settings → Navigation data → Change…**. The new data takes effect the next time you sign in to a position.

**Config files:**
- TRACS stores a few hand-editable config files in `%APPDATA%\TRACS\config\` (Windows) — seeded from bundled defaults on first launch, and never overwritten once present, so your edits survive every update.
- `rateConfig.json` — radar scan-rate cadence (unit position/detection refresh intervals) for direct-mode Olympus/Tacview connections.
- `tacviewDetectionConfig.json` — synthetic radar-detection model tuning for Tacview-sourced connections (sensor ranges, RWR behavior, scan cone).
- `airspace_colors.json` / `asdex_colors.json` — STARS/ASDE-X display color palettes.
- Edits take effect immediately, no restart needed.
- There is no in-app editor for these — edit the JSON files directly. Use **File → Open Config Folder** to find them.

Then follow [Getting Started](docs/getting-started.md) to connect and sign in.

---

## Known limitations

- **Peer-to-peer sync depends on public Nostr relays.**
  - Without a TRACS Relay, controllers find each other through public Nostr relays; TRACS uses five at once.
  - Some of them reject TRACS's messages, and each rejection is logged to the developer console as a relay failure (for example `pow: insufficient leading-zero bits` or `blocked: kind not accepted here`). Others are sometimes unreachable. These errors are harmless while at least one relay works.
  - If none connects within about 8 seconds, TRACS falls back to its own local server. That only connects windows on the same machine, so controllers on different machines won't see each other.
  - **If sync is unreliable, run a [TRACS Relay](#running-a-tracs-relay-server-operators).** With a relay configured, TRACS doesn't use Nostr at all.
- **No TURN server.** Peer-to-peer connections can fail between two strict-NAT networks (for example, two cellular hotspots) and between machines behind the same router. A TRACS Relay avoids this.
- **Privacy of peer-to-peer signaling.** Without a TRACS Relay, connection setup messages pass through public Nostr relays, and Google's STUN servers see your public IP address. The connection details are encrypted only when you set a session password, so set one if that matters to you.
- **Unsigned builds.** Windows SmartScreen and macOS Gatekeeper warn on first launch. On macOS, updates are installed by hand from the Releases page.
- **Navigation data needs your own LittleNavMap Navigraph database.** Without it, fixes, navaids, airways and procedures aren't available.
- **Not every STARS command is implemented.** See [ATC known limitations](docs/atc.md#known-limitations) for the list.
- **Tacview detection is simulated.** In Tacview mode, radar and RWR fog-of-war is TRACS's own approximation, not DCS's detection data.
- **One coalition per running TRACS.** All windows share one data feed, so every window uses the coalition and password of the first login. To switch coalitions, close and reopen TRACS.

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

All three are served on one WebSocket port. The same port answers `GET /health` with the relay's version, protocol version, uptime and which capabilities are active, for monitoring.

### Setup

1. From the latest `relay-v*` release, download `TRACS-Relay.exe` (Windows) or `TRACS-Relay` (Linux), plus `config.example.json`.
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

The relay exits after swapping, so run it under a supervisor that restarts it (see [Running as a service](#running-as-a-service)).

### Running as a service

Run the relay under a service manager, so it starts with the machine and restarts after it exits. It exits after each self-update, so without a supervisor it stays down until someone restarts it. Always set the working directory to the executable's folder; `config.json` and the relay's state files live there.

**Windows (NSSM).** With [NSSM](https://nssm.cc/), from an administrator prompt (adjust the paths):

```bat
nssm install TRACS-Relay "C:\TRACS-Relay\TRACS-Relay.exe"
nssm set TRACS-Relay AppDirectory "C:\TRACS-Relay"
nssm set TRACS-Relay AppStdout "C:\TRACS-Relay\relay.log"
nssm set TRACS-Relay AppStderr "C:\TRACS-Relay\relay.log"
nssm set TRACS-Relay AppRotateFiles 1
nssm set TRACS-Relay AppRotateBytes 10485760
nssm start TRACS-Relay
```

**Linux (systemd).** Save as `/etc/systemd/system/tracs-relay.service`, then run `sudo systemctl enable --now tracs-relay`:

```ini
[Unit]
Description=TRACS Relay
After=network-online.target
Wants=network-online.target

[Service]
User=tracs
WorkingDirectory=/opt/tracs-relay
ExecStart=/opt/tracs-relay/TRACS-Relay
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The service user needs write access to the folder, since self-updates replace the executable in place.

### Firewall

- **Inbound TCP `wsPort`** (8765 by default) from controllers.
- **Inbound UDP `srsLotatcPort`** (10712 by default) **only from the SRS server's address.** The relay trusts whatever arrives on this port.
- **Outbound** to Tacview's RTT port (if `tacviewHost` is set), and to `github.com` over HTTPS for self-updates.

### Security

- **Always set `passwords`.** An empty `passwords` object lets anyone who can reach the relay connect as any coalition. The relay logs a warning at startup when no passwords are set.
- **Keep `config.json` private.** It holds the passwords in plain text, so make it readable only by the account that runs the relay.
- **Password guessing is rate-limited.** Ten wrong passwords from one address within a minute block that address for 30 seconds, doubling with each repeat up to 10 minutes.
- **Coalition passwords control who can connect, not what they receive.** The relay forwards every unit (Tacview telemetry and transponders) to every authenticated client, and each controller's own TRACS applies fog of war. A player with a valid password and a modified client could see the other side's full picture, so only give passwords to players you trust.
- **Traffic isn't encrypted by default.** Controllers connect over plain `ws://`, so passwords and data can be read by anyone who can watch the network between them and the relay. For an internet-facing relay, put it behind TLS (below), or use a trusted network or a VPN.

### TLS (`wss://`)

The relay itself speaks plain WebSocket. To encrypt it, put a TLS reverse proxy in front of it on the same machine. [Caddy](https://caddyserver.com/) is the simplest, because it gets and renews certificates automatically. With a DNS name pointing at the relay machine, this `Caddyfile` serves the relay as `wss://relay.example.com:8766`:

```
relay.example.com:8766 {
    reverse_proxy 127.0.0.1:8765
}
```

- **Firewall:** open TCP 8766 to controllers, and 80/443 for Caddy's certificate checks. **Close `wsPort` (8765) to everything outside the machine**, so no one can bypass TLS.
- **Controllers** enter the **Server URL** with `https://` (e.g. `https://relay.example.com`) and **8766** as the Relay Port; TRACS then connects to the relay over `wss://`. The `https://` applies to everything at that host, so in Olympus mode Olympus must be served over HTTPS too (for example behind the same Caddy). Relay mode and direct Tacview mode are unaffected.
- **Password limits keep working per controller:** Caddy passes each controller's address in `X-Forwarded-For`, which the relay uses for connections arriving from the proxy on the same machine.

### Logs

The relay writes its log to the console only. Keep it with your service manager: NSSM's `AppStdout`/`AppStderr` settings above, or `journalctl -u tracs-relay` on Linux.

### Version compatibility

TRACS and the relay exchange a protocol version when they connect. If they don't match, the relay closes the connection with a message naming both versions. TRACS then shows "Relay protocol mismatch … — using peer-to-peer." and doesn't retry. Update whichever side is older. The Settings panel in TRACS shows the connected relay's version and protocol number.

---

## Running from source (developers)

Requirements: Node.js 22+ and Git.

```bash
npm install          # once, and after pulling dependency changes
npm run dev          # local server on :8721 + Vite dev server on :5173 (proxies /api and /ws)
```

Open `http://localhost:5173` in a Chromium-based browser (Chrome, Edge, Brave). Firefox and Safari are not supported.

| Command | What it does |
|---|---|
| `npm run build` then `npm start` | Build the client and serve it from the local server on `http://localhost:8722` |
| `npm run electron:dev` | Build the client and run it inside Electron, as the desktop app does |
| `npm run dist:electron` | Build an installer for the current platform into `dist-electron/` (stages bundled navdata first) |
| `npm run lint` | ESLint, plus a check that the generated copies of shared server files are in sync |
| `npm test` | Unit tests (Vitest; tests live in `test/`) |
| `npm run knip` | Unused files/exports/dependencies report |
| `npm run sync:tacview-core` | Regenerate the relay's and client's copies of shared server files (Tacview parser, protocol version, detection-config example) |

**LittleNavMap database in dev:** set the `LNM_DB_PATH` environment variable to your `.sqlite` file before starting the server. The Electron file picker doesn't exist in a browser.

**Relay from source:**

```bash
cd relay
npm install
npm start            # node index.js, reads relay/config.json
npm run build        # produce relay/dist/TRACS-Relay(.exe) + config.example.json
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
| `vX.Y.Z` | `.github/workflows/release-tracs.yml` | Windows NSIS, macOS universal dmg (plus the zip that macOS update checks read), and Linux AppImage installers, built on windows-latest / macos-latest / ubuntu-22.04 and published directly (not as a draft) to one GitHub Release by electron-builder. This release is what installed apps update from |
| `relay-vX.Y.Z` | `.github/workflows/release-relay.yml` | `TRACS-Relay.exe` (Windows), `TRACS-Relay` (Linux), and `config.example.json`, attached to one GitHub Release. This release is what running relays update from. Relay releases are never marked as the repo's "latest" release, because installed TRACS apps find their updates through that pointer |

```bash
git tag v0.2.0 && git push origin v0.2.0
git tag relay-v0.2.0 && git push origin relay-v0.2.0
```

TRACS and the relay are versioned independently.

**Protocol changes:** when the TRACS ↔ relay wire protocol changes, bump the integer in `server/src/protocolVersion.js` and run `npm run sync:tacview-core` to regenerate the `client/src/webrtc/` and `relay/` copies. Then release both TRACS and the relay.

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

- Each controller runs their own local server; in the desktop app it runs inside the app. The only component installed on the DCS server side is the optional TRACS Relay. Each controller's local server listens only on this machine (127.0.0.1), so other machines can't reach it. Setting the `TRACS_HOST` environment variable (e.g. `0.0.0.0`) opts in to LAN access; the server has no authentication, so only do that on a trusted network.
- Controller-to-controller sync uses the relay when one is reachable. Otherwise it uses peer-to-peer WebRTC.
  - Peer discovery uses the public Nostr relay network.
  - If no Nostr relay connects within ~8 s, it falls back to the controller's own local server, which only connects windows on the same machine (see [Known limitations](#known-limitations)).
- Sync rooms are coalition-scoped. A relay-hosted room is keyed on coalition, since each relay serves one mission. A peer-to-peer room is derived from the server address, the coalition, and the optional session password.

---

## License

Copyright (C) 2026 denimchickensoft.

TRACS is licensed under the GNU General Public License v3.0 or later — see [LICENSE](LICENSE). It comes with ABSOLUTELY NO WARRANTY.

TRACS includes third-party data, including OpenStreetMap data (© OpenStreetMap contributors, ODbL), terrain data from the USGS and others, data derived from DCS World, and unit databases from DCS Olympus. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for sources, licenses and required attributions.

TRACS is an independent community project. It is not affiliated with or endorsed by Eagle Dynamics SA, the DCS Olympus team, Tacview, the DCS-SRS or LotATC developers, LittleNavMap, Navigraph, or any other organization or product it mentions. All trademarks belong to their respective owners.
