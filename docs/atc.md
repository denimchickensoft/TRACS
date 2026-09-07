# ATC (Air Traffic Controller)

Approach/departure radar display with a STARS-style command line, plus three sub-tools: **ASDE-X** (ground radar), **PAR** (precision approach radar), and **Strip Bay**.

## Command line basics

Commands are typed into the preview buffer, then resolved one of two ways:

- **ENTER** — the buffer is evaluated as typed; no target needed.
- **SLEW** — the buffer is evaluated against whatever contact you click. Type the command, then left-click a target to complete it.

Each command below reads as `COMMAND + ENTER` or `COMMAND + SLEW`. A bare click with an empty buffer is context-sensitive: it accepts/recalls a pending handoff or point-out involving that track if one exists, or toggles the contact's datablock between partial and full otherwise.

## Track ownership

| Command | Shortcut | Effect |
|---|---|---|
| `IC` + SLEW | `F3` | Initiate Control — claim the clicked track |
| `TC` + SLEW | `F4` | Terminate Control — drop the clicked track (must be yours) |
| `TC ALL` + ENTER | — | Drop every track you own |

**Ctrl+Shift+Click** a contact is a direct shortcut for `IC` — claims it without typing anything.

`IC` fails with `ILL TRK` on a track that's genuinely unassociated (see Transponder/IFF correlation below) or on a simulated wingman rendered "primary only" (see Simulated wingmen below) — claim the flight lead or wait for association instead.

## Handoffs

| Command | Shortcut | Effect |
|---|---|---|
| `HO` + ENTER | — | Accept an incoming handoff |
| `HO <tcp>` + SLEW | `F5` | Hand off the clicked (owned) track to position `<tcp>` |
| `HO` + SLEW | — | Context-sensitive on the clicked track: recall if it's an outgoing handoff from you, accept if it's incoming to you |
| `<tcp>` (e.g. `1D`) + SLEW | — | Shorthand for `HO <tcp>` — no prefix needed |

`F5` inserts the `HO ` prefix into the buffer — type the position id, then click a track.

## Point outs

| Command | Shortcut | Effect |
|---|---|---|
| `<tcp>*` + SLEW | — | Point out the clicked track to position `<tcp>` |
| `**` + SLEW | — | Convert an incoming point-out into a claimed handoff |
| `UN` + SLEW | — | Reject an incoming point-out |

Bare-click (empty buffer) also resolves pending point-outs/handoffs automatically, same as it does for handoffs above. No function key is mapped to point outs.

## Scratchpads

| Command | Shortcut | Effect |
|---|---|---|
| `MF Y<text>` + SLEW | `F7` | Set scratchpad 1 (SP1) |
| `MF Y` + SLEW | `F7` | Clear SP1 |
| `MF Y+<text>` + SLEW | `F7` | Set scratchpad 2 (SP2) |
| `MF Y+` + SLEW | `F7` | Clear SP2 |
| `<text>` (3–4 chars) + SLEW | — | Shorthand — set SP1 directly, no `MF Y` prefix |
| `+<text>` (1–4 chars) + SLEW | — | Shorthand — set SP2 |
| `.` + SLEW | — | Clear SP1 |
| `+` + SLEW | — | Clear SP2 |

`F7` inserts the `MF ` prefix — follow it with `Y<text>` etc. You must own a track to edit its scratchpads.

## Leader lines

| Command | Shortcut | Effect |
|---|---|---|
| `MF L<d><d>` (same digit twice, e.g. `MF L33`) + SLEW | `F7` | Set the facility-wide default leader direction; digit `5` clears it |
| `MF L<d>` + SLEW | `F7` | Set direction for one track |
| `<d>` (single digit 1–9) + SLEW | — | Shorthand for `MF L<d>` |
| `LD (0-7)` + ENTER | — | Leader length, via the DCB LDR key |

`F7` inserts the `MF ` prefix. Direction digits follow a numpad layout: `7`=NW `8`=N `9`=NE `4`=W `5`=clear/default `6`=E `1`=SW `2`=S `3`=SE.

## Range/bearing line & minimum separation

| Command | Shortcut | Effect |
|---|---|---|
| `*T` + SLEW | — | Start an RBL from the clicked track; click again (or type a fix + Enter) for the second point |
| `*T <fix>` + ENTER | — | Start an RBL from a named fix |
| `*T` + ENTER | — | Clear all RBLs |
| `*T<n>` + ENTER | — | Clear RBL number `n` |
| `MIN` + SLEW | `End` | Pick the clicked track as the first aircraft of a minimum-separation pair; click a second track to complete it |
| `MIN` + ENTER | `End` | Clear the min-sep display |

`End` inserts `MIN` into the buffer. `Escape` cancels a pending RBL/MIN second point.

## Display, range, and reference commands

| Command | Shortcut | Effect |
|---|---|---|
| `RG <n>` + ENTER | — | Set range, 6–256 NM |
| `RR (2\|5\|10\|20)` + ENTER | — | Set range-ring spacing |
| `MF P` + SLEW | `F7` | Relocate the command-line/response readout to the clicked point |
| `MF S` + SLEW | `F7` | Relocate the SSA overlay |
| `.ALTIM <val>` / `.QNH <val>` + ENTER | — | Set altimeter (inHg or hPa, auto-detected by range) |
| `.ASPCOLORS <name>` + ENTER | — | Switch the airspace color palette |
| `.REFRESH` + ENTER | — | Reload airspace color palettes from the server |
| `.DBCA` + ENTER | — | Toggle datablock collision-avoidance placement |
| `.LABELS` + ENTER | — | Toggle the LBL DCB MAP button (map/airspace name labels) |
| `.FIXES` + ENTER | — | Toggle the FIXES DCB MAP button (theatre fix points) |
| `.ASP` + ENTER | — | Bulk-toggle every airspace category MAP button |
| `.TMA` `.CTR` `.CTA` `.FIR` `.UIR` `.SUA` `.MIL` `.TRSA` `.CLASSA`–`.CLASSG` + ENTER | — | Toggle every MAP button (main + overflow) for that airspace category |
| `.MSA` + ENTER | — | Toggle the MSA MAP button |
| `.HOLDS` + ENTER | — | Toggle the HOLDS MAP button |
| `.RELIEF` + ENTER | — | Toggle the RELIEF MAP button |
| `.MVA` + ENTER | — | Toggle the MVA MAP button |
| `.SAT <label>` + ENTER | — | Toggle a satellite flow bucket MAP button (label varies by facility, e.g. `.SAT W`, `.SAT E`) |
| `.FILL` + ENTER | — | Toggle airspace polygon fill |
| `.FILL <1-100>` + ENTER | — | Set fill transparency % and turn it on |
| `.COORDS` + ENTER | — | Toggle a cursor lat/lng debug readout |
| `.FIND <query>` + ENTER | — | Drop a marker at a named fix/navaid/airport |
| `.FIX <name...>` + ENTER | — | Force-show one or more fixes regardless of the FIXES DCB toggle; each name toggles independently |
| `.PROC <name>` + ENTER | — | Toggle display of a named SID/STAR/approach procedure |
| `.PROC` + ENTER | — | Clear all shown procedures |
| `.FP <callsign>` + ENTER | — | Open the Flight Plan Editor prefilled for that callsign |
| `.FP` + ENTER | `Ctrl+F` | Open a blank Flight Plan Editor |
| `.RENAME <newCallsign>` + SLEW | — | Rename the clicked track's displayed callsign |
| `.RENAME` + SLEW | — | Reset callsign to the DCS-assigned one |

`Ctrl+F` opens a blank Flight Plan Editor directly, bypassing the command line. **Ctrl+Click** a contact opens its FPE (read-only if another controller owns it).

## Multi-function (MF) lists

The SSA, Sign-On List, Flight-Plan (TAB) list, up to 3 Tower lists, Coast/Suspend list, Alert list, and VFR list can each be toggled, relocated (SLEW to reposition), and — except SSA/Alert — resized:

`MF TS` (sign-on) · `MF T` (TAB, `MF T<n>` to resize 1–100 lines) · `MF P1`/`MF P2`/`MF P3` (tower lists) · `MF TC` (coast/suspend) · `MF TM` (alert) · `MF TV` (VFR).

These only appear if your ODS profile enables coordination lists.

## Transponder/IFF correlation

When SRS transponder data is reaching TRACS (via a relay, in either Tacview or Olympus sessions), tracks gain real squawk-based association on top of ownership:

- **Association gating**: a track with live transponder data (`srsCapable`) is either *associated* (its squawk matches a filed flight plan's callsign+code) or *unassociated*. This changes what the datablock shows, separately from whether you own the track.
- **LDB content changes**: an unassociated `srsCapable` track's LDB shows the real 4-digit beacon code on its first line, instead of the usual altitude/groundspeed line.
- **Position symbols**: `*` marks a genuinely unassociated track; `V` marks a VFR squawk (code 1200).
- **FDB mismatch line**: if a track's live squawk drifts from its flight plan's assigned code, the FDB (not the PDB) gains a third line showing `<reported> <assigned>` side by side. This is FDB-only by design — PDBs don't show it.
- **IDENT**: a pilot's IDENT press appends a blinking "ID" suffix to the datablock (only the suffix blinks, not the whole datablock), latched until you acknowledge it with a slew on that track. A PDB that IDENTs temporarily displays as an FDB while the IDENT is active.
- **Beaconator**: press and hold `F1` to force *every* squawking track's PDB into FDB-style layout with the callsign swapped for its beacon code — release to return to normal. Useful for a quick beacon-code sweep across the whole scope.

## Conflict Alert / MCI (STCA)

`.CA` + ENTER toggles automated conflict detection (Short-Term Conflict Alert). When on:

- A track in an unacknowledged conflict gets a `CA`/`MCI` indicator line above line 1 of its datablock, blinking red.
- **A bare left-click on a track with an active, unacknowledged conflict acknowledges it** — this takes priority over the usual "toggle partial/full datablock" click behavior described under Mouse gestures below. Once acknowledged, the indicator turns solid red instead of blinking.
- An audible alert tone plays while any conflict is unacknowledged.
- Suppression zones near final approach courses prevent false alerts between aircraft that are supposed to be close together on approach.

The DCB aux bar (SHIFT) has a **CA** toggle button alongside **WNG** for this.

## Simulated wingmen

`.WNG` + ENTER toggles simplified rendering for AI wingmen that share a DCS group with a flight lead:

- Only the flight lead gets a full datablock; the rest of the group renders as a small hollow diamond with no datablock at all, reducing scope clutter for large AI flights.
- `.WNG` + SLEW, then click a second track, manually pairs two aircraft that *don't* share a DCS group (same two-click flow as `MIN`/RBL) — useful for treating an escort or wingman as a simplified pair even when the sim doesn't group them together.
- A primary-only (wingman) track can't be claimed with `IC` — see Track ownership above.

The DCB aux bar (SHIFT) has a **WNG** toggle button next to **CA**.

## Altitude filters

`MF F` + ENTER shows your current altitude filter. Two ways to set one:

- `MF FC<loAssigned><hiAssigned>` + ENTER — filter by assigned altitude only, for associated tracks.
- `MF F<loUnassoc><hiUnassoc> <loAssigned><hiAssigned>` + ENTER — set both the unassociated-track filter and the associated-track filter in one command.

Tracks outside the active filter range don't draw at all — useful for decluttering a busy scope down to a specific altitude band.

## Mouse gestures

| Gesture | Effect |
|---|---|
| Left-click, empty buffer | Acknowledge an active unacknowledged conflict (see Conflict Alert above) if the track has one; otherwise toggle partial/full datablock, or dismiss a leftover post-handoff display |
| Right-click + drag | Pan the scope |
| Middle-click a contact | Toggle a local highlight (not synced, not persisted) |
| Ctrl+Click a contact | Open its Flight Plan Editor |
| Ctrl+Shift+Click a contact | Initiate Control |
| Alt+Click a contact | Toggle that track's flight-plan route line |
| Mouse wheel | Zoom range (±1/notch, ±3 with Ctrl); inhibited while adjusting a DCB spinner |

## Display Control Bar (DCB)

Click a value button, then use the **mouse wheel** to adjust it. Click a submenu button to open it; **DONE** exits back to the main bar.

**Main bar:** RANGE · OFF CNTR (recenter) · RR (ring spacing) · PLACE RR (click scope to set an off-center ring origin) · RR CNTR (reset) · MAPS (layer toggles: holds, MSA, airways, MORA/grid, relief, geo, fixes, obstacles, centerlines, procedures) · BRITE (brightness submenu — separate controls for Map A, Map B, background, FDB, LDB, lists, symbols, rings, compass, history) · LDR DIR · LDR LEN · CHAR SIZE (submenu: datablocks/lists/DCB/tools/position/map) · PREF (12 preset slots — save/save-as/delete/default) · SHIFT (switch to the aux bar).

**Aux bar (via SHIFT):** VOL · HISTORY (trail dot count) · H_RATE (capture interval) · DCB TOP/LEFT/RIGHT/BOTTOM (reposition the bar) · PTL LNTH · PTL OWN (predicted track lines, your tracks only) · PTL ALL · CA (Conflict Alert toggle) · WNG (simulated wingmen toggle).

## Keyboard shortcuts

Function keys insert the corresponding command into the buffer for you — you still complete it with a click (SLEW) or Enter as usual.

| Key | Inserts | Effect |
|---|---|---|
| `F3` | `IC` | Init Control — click a track to claim it |
| `F4` | `TC` | Term Control — click a track to drop it |
| `F5` | `HO ` | Hand Off — type a position id, then click a track |
| `F7` | `MF ` | Multi-Function prefix — follow with a list/scratchpad/leader command |
| `End` | `MIN` | Minimum-separation tool |
| `` ` `` (backquote) | `Δ` | Inserts the delta glyph |

Other shortcuts that act immediately, no buffer involved:

| Key | Effect |
|---|---|
| `Ctrl+F` | Open a blank Flight Plan Editor |
| `F1` (press and hold) | Beaconator — forces every squawking track's PDB to FDB layout with the callsign swapped for its beacon code, for as long as it's held (see Transponder/IFF correlation above) |
| `Ctrl+F8` | Show/hide the DCB |
| `Alt+T` | Toggle top-down display mode |
| `Ctrl+Alt+0`–`9` | Save current view (center/range/overlays) to bookmark slot 0–9 |
| `Ctrl+0`–`9` | Load view bookmark 0–9 |
| `Escape` | Cancel a pending RBL/MIN second point, clear a `.FIND` marker and route overlays, then clear the buffer |
| `Backspace` | Delete the last buffer character |
| `Enter` | Run the current buffer as an ENTER-triggered command |

`F2`, `F6`, `F9`, `F11`, and `F13`/`Shift+F3` also insert text into the buffer, but nothing currently consumes it — treat them as not yet functional. Most `Ctrl+F1`–`F10`/`Insert` display shortcuts other than `Ctrl+F8` are likewise no-ops for now.

---

## ASDE-X (ground radar)

A smaller, ground-movement-focused sub-scope showing surface traffic (aircraft/helicopters below ~200 ft AGL) on taxiways and ramps.

**Commands:**

| Command | Effect |
|---|---|
| `.FP <callsign>` / `.FP` + ENTER | Open Flight Plan Editor (prefilled or blank) |
| `.CENTERLINE` + ENTER | Toggle runway centerline overlay |
| `.COORDS` + ENTER | Toggle cursor lat/lng readout |
| `.COLORS <name>` + ENTER | Switch color profile (e.g. Day/Night) |
| `<d>` (1–9) + SLEW | Set/clear a contact's leader-line direction (`5` clears) |
| `.TAG <id>` + SLEW | Manually tag a target: type an aircraft ID, then click an Unknown Target to assign it. Validated against the real ground-truth callsign — a mismatched ID is rejected outright. |

**Unknown Targets**: when SRS transponder data is available, a track with no live squawk renders as a **teal** triangle with no datablock or leader line — an "Unknown Target" until it either squawks or is manually tagged with `.TAG`.

**Datablock content**: once a target is tagged or associated, its datablock shows the aircraft ID; otherwise it shows the raw beacon code, when one is available.

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
