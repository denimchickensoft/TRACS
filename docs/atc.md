# ATC (Air Traffic Controller)

Approach/departure radar display with a STARS-style command line, plus three sub-tools: **ASDE-X** (ground radar), **PAR** (precision approach radar), and **Strip Bay**.

## Command line basics

Commands are typed into the preview buffer, then resolved one of two ways:

- **ENTER** — the buffer is evaluated as typed; no target needed.
- **SLEW** — the buffer is evaluated against whatever contact you click. Type the command, then left-click a target to complete it.

Each command below is marked `(ENTER)` or `(SLEW)`. A bare click with an empty buffer is context-sensitive: it accepts/recalls a pending handoff or point-out involving that track if one exists, or toggles the contact's datablock between partial and full otherwise.

## Track ownership

| Command | Trigger | Effect |
|---|---|---|
| `IC` | SLEW | Initiate Control — claim the clicked track |
| `TC` | SLEW | Terminate Control — drop the clicked track (must be yours) |
| `TC ALL` | ENTER | Drop every track you own |

**Ctrl+Shift+Click** a contact is a direct shortcut for `IC` — claims it without typing anything.

## Handoffs

| Command | Trigger | Effect |
|---|---|---|
| `HO` | ENTER | Accept an incoming handoff |
| `HO <tcp>` | SLEW | Hand off the clicked (owned) track to position `<tcp>` |
| `HO` | SLEW | Context-sensitive on the clicked track: recall if it's an outgoing handoff from you, accept if it's incoming to you |
| `<tcp>` (e.g. `1D`) | SLEW | Shorthand for `HO <tcp>` — no prefix needed |

**F5** inserts `HO ` into the buffer for you.

## Point outs

| Command | Trigger | Effect |
|---|---|---|
| `<tcp>*` | SLEW | Point out the clicked track to position `<tcp>` |
| `**` | SLEW | Convert an incoming point-out into a claimed handoff |
| `UN` | SLEW | Reject an incoming point-out |

Bare-click (empty buffer) also resolves pending point-outs/handoffs automatically, same as it does for handoffs above.

## Scratchpads

| Command | Trigger | Effect |
|---|---|---|
| `MF Y<text>` | SLEW | Set scratchpad 1 (SP1) |
| `MF Y` | SLEW | Clear SP1 |
| `MF Y+<text>` | SLEW | Set scratchpad 2 (SP2) |
| `MF Y+` | SLEW | Clear SP2 |
| `<text>` (3–4 chars) | SLEW | Shorthand — set SP1 directly, no `MF Y` prefix |
| `+<text>` (1–4 chars) | SLEW | Shorthand — set SP2 |
| `.` | SLEW | Clear SP1 |
| `+` | SLEW | Clear SP2 |

You must own a track to edit its scratchpads.

## Leader lines

| Command | Trigger | Effect |
|---|---|---|
| `MF L<d><d>` (same digit twice, e.g. `MF L33`) | SLEW | Set the facility-wide default leader direction; digit `5` clears it |
| `MF L<d>` | SLEW | Set direction for one track |
| `<d>` (single digit 1–9) | SLEW | Shorthand for `MF L<d>` |
| `LD (0-7)` | ENTER | Leader length, via the DCB LDR key |

Direction digits follow a numpad layout: `7`=NW `8`=N `9`=NE `4`=W `5`=clear/default `6`=E `1`=SW `2`=S `3`=SE.

## Range/bearing line & minimum separation

| Command | Trigger | Effect |
|---|---|---|
| `*T` | SLEW | Start an RBL from the clicked track; click again (or type a fix + Enter) for the second point |
| `*T <fix>` | ENTER | Start an RBL from a named fix |
| `*T` | ENTER | Clear all RBLs |
| `*T<n>` | ENTER | Clear RBL number `n` |
| `MIN` | SLEW | Pick the clicked track as the first aircraft of a minimum-separation pair; click a second track to complete it |
| `MIN` | ENTER | Clear the min-sep display |

`Escape` cancels a pending RBL/MIN second point.

## Display, range, and reference commands

| Command | Trigger | Effect |
|---|---|---|
| `RG <n>` | ENTER | Set range, 6–256 NM |
| `RR (2\|5\|10\|20)` | ENTER | Set range-ring spacing |
| `MF P` | SLEW | Relocate the command-line/response readout to the clicked point |
| `MF S` | SLEW | Relocate the SSA overlay |
| `.ALTIM <val>` / `.QNH <val>` | ENTER | Set altimeter (inHg or hPa, auto-detected by range) |
| `.ASPCOLORS <name>` | ENTER | Switch the airspace color palette |
| `.REFRESH` | ENTER | Reload airspace color palettes from the server |
| `.DBCA` | ENTER | Toggle datablock collision-avoidance placement |
| `.COORDS` | ENTER | Toggle a cursor lat/lng debug readout |
| `.FIND <query>` | ENTER | Drop a marker at a named fix/navaid/airport |
| `.PROC <name>` | ENTER | Toggle display of a named SID/STAR/approach procedure |
| `.PROC` | ENTER | Clear all shown procedures |
| `.FP <callsign>` | ENTER | Open the Flight Plan Editor prefilled for that callsign |
| `.FP` | ENTER | Open a blank Flight Plan Editor |
| `.RENAME <newCallsign>` | SLEW | Rename the clicked track's displayed callsign |
| `.RENAME` | SLEW | Reset callsign to the DCS-assigned one |

**Ctrl+F** opens a blank Flight Plan Editor directly, bypassing the command line. **Ctrl+Click** a contact opens its FPE (read-only if another controller owns it).

## Multi-function (MF) lists

The SSA, Sign-On List, Flight-Plan (TAB) list, up to 3 Tower lists, Coast/Suspend list, Alert list, and VFR list can each be toggled, relocated (SLEW to reposition), and — except SSA/Alert — resized:

`MF TS` (sign-on) · `MF T` (TAB, `MF T<n>` to resize 1–100 lines) · `MF P1`/`MF P2`/`MF P3` (tower lists) · `MF TC` (coast/suspend) · `MF TM` (alert) · `MF TV` (VFR).

These only appear if your ODS profile enables coordination lists.

## Mouse gestures

| Gesture | Effect |
|---|---|
| Left-click, empty buffer | Toggle partial/full datablock, or dismiss a leftover post-handoff display |
| Right-click + drag | Pan the scope |
| Middle-click a contact | Toggle a local highlight (not synced, not persisted) |
| Ctrl+Click a contact | Open its Flight Plan Editor |
| Ctrl+Shift+Click a contact | Initiate Control |
| Alt+Click a contact | Toggle that track's flight-plan route line |
| Mouse wheel | Zoom range (±1/notch, ±3 with Ctrl); inhibited while adjusting a DCB spinner |

## Display Control Bar (DCB)

Click a value button, then use the **mouse wheel** to adjust it. Click a submenu button to open it; **DONE** exits back to the main bar.

**Main bar:** RANGE · OFF CNTR (recenter) · RR (ring spacing) · PLACE RR (click scope to set an off-center ring origin) · RR CNTR (reset) · MAPS (layer toggles: holds, MSA, airways, MORA/grid, relief, geo, obstacles, centerlines, procedures) · BRITE (brightness submenu for DCB/background/maps/datablocks/lists/symbols/rings/compass/history) · LDR DIR · LDR LEN · CHAR SIZE (submenu: datablocks/lists/DCB/tools/position/map) · PREF (12 preset slots — save/save-as/delete/default) · SHIFT (switch to the aux bar).

**Aux bar (via SHIFT):** VOL · HISTORY (trail dot count) · H_RATE (capture interval) · DCB TOP/LEFT/RIGHT/BOTTOM (reposition the bar) · PTL LNTH · PTL OWN (predicted track lines, your tracks only) · PTL ALL.

## Keyboard shortcuts

F5 (Hand Off), Ctrl+F (blank FPE), Ctrl+F8 (show/hide DCB), Alt+T (toggle top-down mode), Ctrl+Alt+0–9 (save view bookmark), Ctrl+0–9 (load view bookmark) all work as described above. A few other function keys (F2, F6, F9, F11, F13) currently insert text into the command buffer with no matching command behind them yet — don't rely on them.

---

## ASDE-X (ground radar)

A smaller, ground-movement-focused sub-scope showing surface traffic (aircraft/helicopters below ~200 ft AGL) on taxiways and ramps.

**Commands:**

| Command | Trigger | Effect |
|---|---|---|
| `.FP <callsign>` / `.FP` | ENTER | Open Flight Plan Editor (prefilled or blank) |
| `.CENTERLINE` | ENTER | Toggle runway centerline overlay |
| `.COORDS` | ENTER | Toggle cursor lat/lng readout |
| `.COLORS <name>` | ENTER | Switch color profile (e.g. Day/Night) |
| `<d>` (1–9) | SLEW | Set/clear a contact's leader-line direction (`5` clears) |

**Mouse:** Ctrl+Click opens a contact's FPE; right-click+drag pans; mouse wheel zooms (0.1–2.0 NM range, in 0.1 steps).

**DCB:** a single flat bar — RANGE, LDR DIR, LDR LEN, PTL LNTH, HISTORY, H_RATE — same click-then-wheel interaction as the main ATC DCB.

There's no dedicated ASDE-X function-key map — only the commands above are reachable.

## PAR (precision approach radar)

A form-driven panel — no command line.

- **AIRFIELD / CARRIER** buttons switch mode (CARRIER only enabled when a carrier is known — docked under CATCC, or via URL param).
- Pick a **runway** (airfield mode) to auto-fill lat/lng/heading/elevation, or enter them manually.
- **GS** (glideslope angle, 1–7°, default 3.0°/3.5° carrier) and **RNG** (displayed range, default 10 NM) are editable and remembered per mode.
- Two read-only plots: **Elevation** (side view — glideslope, ±0.7° tolerance corridor, 8° service-volume ceiling, and a 1200 ft Case III minimum line in carrier mode) and **Azimuth** (top-down — centerline, ±2.5° tolerance corridor, ±10° service-volume cone). Contacts inside tolerance are colored gold (carrier)/blue (airfield); outside tolerance, orange.

## Strip Bay

Flight progress strips — no command line; direct manipulation only. `IC` on the main ATC scope auto-adds a strip if enabled in settings.

**Adding strips:** type a callsign into the footer input and press Enter/click **Add Strip**. Auto-add can also trigger on track initiation, handoff acceptance, strip-pass acceptance, or a DEP/DEST airport match — configurable behind the **⚙** settings button.

**Per-strip mouse actions:**

| Gesture | Effect |
|---|---|
| Click | Acknowledge a highlight (e.g. auto-added flag) |
| Shift+Click | Delete immediately, no confirmation |
| Ctrl+Click or double-click | Open the strip's Flight Plan Editor |
| Right-click | Context menu: Delete, or "Send to `<position>`" for any known peer (passes the strip via WebRTC) |
| Drag | Reorder strips (switches sort mode to Manual) |

**Annotation cells:** each strip has a 3×3 grid of editable cells (up to 3 characters each) — click to edit, Enter/blur to commit, Escape to cancel.

**Header controls:** sort by Time/AID/DEP/DEST/Manual; mouse wheel over the header zooms strip scale (50–200%); **⚙** opens auto-add triggers and annotation-conflict handling (Overwrite/Merge/Ignore).

---

## Known limitations

A handful of ATC command patterns parse but currently do nothing — reported here so you don't file bugs against them or rely on them:

- `IC <flightid>` and `TC <flightid> ` (ENTER forms, addressing by ID instead of slewing) — not yet implemented.
- `HO <tcp> <flightid>` (ENTER form) — not yet implemented.
- Reported/assigned altitude scratchpad via a bare 3-digit slew (`070`) or `+070` — recognized syntax, no handler yet.
- `MF M` (Mode C toggle), `MF B` (beacon toggle), `MF E` (FDB overflight toggle), `MF R` (per-track PTL toggle) — not wired up. Use the DCB's **PTL OWN**/**PTL ALL** for predicted track lines instead.
- Quicklook (`**<tcp>`, `**ALL`) — parses but has no visible effect yet.
- Most Ctrl+F-key display shortcuts (Ctrl+F1–F5, F7, F9, F10, Insert) are currently no-ops; only Ctrl+F8 (DCB show/hide) and the bookmark combos (Ctrl+Alt+0–9, Ctrl+0–9) work.
