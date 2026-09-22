# ATC (Air Traffic Controller)

[← All docs](index.md)

Approach/departure radar display with a STARS-style command line, plus three sub-tools: **ASDE-X** (ground radar), **PAR** (precision approach radar), and **Strip Bay**.

## Command line basics

Commands are typed into the preview buffer, then resolved one of two ways:

- **ENTER** — the buffer is evaluated as typed; no target needed.
- **SLEW** — the buffer is evaluated against the contact you click. Type the command, then left-click a target to complete it.

Each command below reads as `COMMAND + ENTER` or `COMMAND + SLEW`.

A bare click with an empty buffer depends on the track's state:
1. If the track has an unacknowledged conflict alert, the click acknowledges it (see Conflict Alert below).
2. Otherwise, if a handoff or point-out involving that track is pending, the click accepts or recalls it.
3. Otherwise, the click toggles the track's datablock between partial and full.

## Track ownership

| Command | Shortcut | Effect |
|---|---|---|
| `IC` + SLEW | `F3` | Initiate Control — claim the clicked track |
| `TC` + SLEW | `F4` | Terminate Control — drop the clicked track (must be yours) |
| `TC ALL` / `.DROPALL` + ENTER | — | Drop every track you own |

**Ctrl+Shift+Click** a contact is a direct shortcut for `IC`.

`IC` fails with `ILL TRK` on a track that's unassociated (see Transponder/IFF correlation below).

## Handoffs

| Command | Shortcut | Effect |
|---|---|---|
| `HO` + ENTER | — | Accept the first incoming handoff |
| `HO <tcp>` + SLEW | `F5` | Hand off the clicked (owned) track to position `<tcp>` |
| `HO` + SLEW | — | On the clicked track: recall it if it's your outgoing handoff, accept it if it's incoming to you |
| `<tcp>` (e.g. `1D`) + SLEW | — | Shorthand for `HO <tcp>` |

`F5` inserts the `HO ` prefix into the buffer — type the position id, then click a track.

## Point outs

| Command | Shortcut | Effect |
|---|---|---|
| `<tcp>*` + SLEW | — | Point out the clicked track to position `<tcp>` |
| `**` + SLEW | — | Convert an incoming point-out into a claimed handoff |
| `UN` + SLEW | — | Reject an incoming point-out |

A bare click (empty buffer) also resolves pending point-outs. No function key is mapped to point outs.

## Scratchpads and altitudes

You must own a track to edit its scratchpads or temporary altitude.

| Command | Shortcut | Effect |
|---|---|---|
| `MF Y<text>` + SLEW | `F7` | Set scratchpad 1 (SP1) |
| `MF Y` + SLEW | `F7` | Clear SP1 |
| `<text>` (3–4 characters) + SLEW | — | Set SP1. A bare 3-digit entry (e.g. `070`) also sets SP1 |
| `+<text>` (1–4 characters, not 3 digits) + SLEW | — | Set scratchpad 2 (SP2) |
| `.` + SLEW | — | Clear SP1 |
| `+` + SLEW | — | Clear SP2 |
| `+###` + SLEW | — | Set the temporary assigned altitude, shown as `A###` on FDB line 3. `+000` clears it |
| `++###` + SLEW | — | Amend the flight plan's requested (filed) altitude |

`F7` inserts the `MF ` prefix.

A requested altitude amended with `++###` shows as `R###` on the right side of FDB line 2. That slot rotates groundspeed → aircraft type → groundspeed → `R###`, skipping any entry that's empty. Editing the altitude in the Flight Plan Editor removes the `R###`. The temporary assigned altitude stays on line 3, right-aligned and not time-shared, until it's cleared.

## Leader lines

| Command | Shortcut | Effect |
|---|---|---|
| `MF L<d><d>` (same digit twice, e.g. `MF L33`) + SLEW | `F7` | Set the facility-wide default leader direction; digit `5` clears it |
| `MF L<d>` + SLEW | `F7` | Set direction for one track |
| `<d>` (single digit 1–9) + SLEW | — | Shorthand for `MF L<d>` |
| `LD <0-7>` + ENTER | — | Set leader length (same setting as the DCB's LDR LEN) |

Direction digits follow a numpad layout: `7`=NW `8`=N `9`=NE `4`=W `5`=clear/default `6`=E `1`=SW `2`=S `3`=SE.

## Range/bearing line & minimum separation

| Command | Shortcut | Effect |
|---|---|---|
| `*T` + SLEW | — | Start an RBL from the clicked track (or clicked point on empty scope); click again, or type a fix + Enter, for the second point |
| `*T <fix>` + ENTER | — | Start an RBL from a named fix |
| `*T` + ENTER | — | Clear all RBLs |
| `*T<n>` + ENTER | — | Clear RBL number `n` |
| `MIN` + SLEW | `End` | Pick the clicked track as the first aircraft of a minimum-separation pair; click a second track to complete it |
| `MIN` + ENTER | `End` | Clear the min-sep display |

`End` inserts `MIN` into the buffer.

`MF R` + SLEW toggles a predicted track line (PTL) for the clicked track. It draws regardless of the DCB's facility-wide **PTL OWN**/**PTL ALL** settings, using the **PTL LNTH** length.

## Display, range, and reference commands

| Command | Shortcut | Effect |
|---|---|---|
| `RG <n>` + ENTER | — | Set range, 6–256 NM |
| `RR (2\|5\|10\|20)` + ENTER | — | Set range-ring spacing |
| `.CENTER` + ENTER | `Ctrl+F1` | Return the scope to its original center (same as the DCB's OFF CNTR) |
| `MF P` + SLEW | `F7` | Relocate the command-line/response readout to the clicked point |
| `MF S` + SLEW | `F7` | Relocate the SSA overlay |
| `MF S<atis>` + ENTER | — | Set the SSA overlay's ATIS code letter |
| `MF S<atis> <giText>` + ENTER | — | Set the SSA overlay's ATIS code letter and general-info text |
| `.ALTIM <val>` / `.QNH <val>` + ENTER | — | Set altimeter (inHg or hPa, auto-detected by range) |
| `.ASPCOLORS <name>` + ENTER | — | Switch the airspace color palette |
| `.REFRESH` + ENTER | — | Reload airspace color palettes from the server |
| `.DBCA` + ENTER | — | Toggle datablock collision-avoidance placement |
| `.LABELSIZE <0-5>` + ENTER | — | Set map/airspace label size (same as the DCB's CHAR SIZE > MAP); bare `.LABELSIZE` reports the current value |
| `.LABELS` (or `.LBL` / `.LABEL`) + ENTER | — | Toggle the LBL map button (map/airspace name labels) |
| `.FIXES` + ENTER | — | Toggle the FIXES map button (theatre fix points) |
| `.ASP` + ENTER | — | Bulk-toggle every airspace category map button |
| `.TMA` `.CTR` `.CTA` `.FIR` `.UIR` `.SUA` `.MIL` `.TRSA` `.CLASSA`–`.CLASSG` + ENTER | — | Toggle every map button (main + overflow) for that airspace category |
| `.MSA` + ENTER | — | Toggle the MSA map button |
| `.HOLDS` + ENTER | — | Toggle the HOLDS map button |
| `.RELIEF` + ENTER | — | Toggle the RELIEF map button |
| `.MVA` + ENTER | — | Toggle the MVA map button |
| `.SAT <label>` + ENTER | — | Toggle a satellite flow bucket map button (label varies by facility, e.g. `.SAT W`, `.SAT E`) |
| `.FILL` + ENTER | — | Toggle airspace polygon fill |
| `.FILL <1-100>` + ENTER | — | Set fill transparency % and turn it on |
| `.COORDS` + ENTER | — | Toggle a cursor lat/lng readout |
| `.FIND <query>` + ENTER | — | Drop a marker at a named fix/navaid/airport |
| `.FIX <name...>` + ENTER | — | Force-show one or more fixes regardless of the FIXES toggle; each name toggles independently. Bare `.FIX` clears them all |
| `.PROC <name>` + ENTER | — | Toggle display of a named SID/STAR/approach procedure |
| `.PROC` + ENTER | — | Clear all shown procedures |
| `.RCLEAR` + ENTER | — | Clear every flight-plan route line currently displayed (see Ctrl+Right-click below) |
| `.FP <callsign>` + ENTER | — | Open the Flight Plan Editor prefilled for that callsign |
| `.FP` + ENTER | `Ctrl+F` | Open a blank Flight Plan Editor |
| `.RENAME <newCallsign>` + SLEW | — | Rename the clicked track's displayed callsign |
| `.RENAME` + SLEW | — | Reset callsign to the DCS-assigned one |

**Ctrl+Click** a contact opens its Flight Plan Editor (read-only if another controller owns it).

## Multi-function (MF) lists

These lists appear only if your ODS profile enables coordination lists. `+ ENTER` toggles a list, `+ SLEW` relocates it to the clicked point, and the resize forms set its line count.

| List | Toggle | Relocate | Resize |
|---|---|---|---|
| SSA | always shown | `MF S` + SLEW | — |
| Sign-on list | `MF TS` + ENTER | `MF TS` + SLEW | — |
| Flight-Plan (TAB) list | `MF T` + ENTER | `MF T` + SLEW | `MF T<n>` + ENTER |
| Tower lists 1–3 | `MF P1`/`P2`/`P3` + ENTER | `MF P<n>` + SLEW | `MF P<n> <lines>` + ENTER |
| Coast/Suspend list | `MF TC` + ENTER | `MF TC` + SLEW | `MF TC<n>` + ENTER |
| Alert list | `MF TM` + ENTER | `MF TM` + SLEW | — |
| VFR list | `MF TV` + ENTER | `MF TV` + SLEW | `MF TV<n>` + ENTER |

## Transponder/IFF correlation

When SRS transponder data reaches TRACS through a relay (in Tacview or Olympus sessions), tracks that report SRS data ("SRS-fielded") use squawk-based association:

| Item | Effect |
|---|---|
| **Association** | An SRS-fielded track is *associated* when its squawk matches a filed flight plan's callsign and code, and *unassociated* otherwise. Once associated, it stays associated if the code later drifts (see the mismatch line). Unassociated tracks can't be claimed |
| **Primary-only** | An SRS-fielded track with no live squawk draws as a primary target with no datablock |
| **Unassociated LDB** | Line 1 shows the 4-digit beacon code, line 2 the altitude (altitude and groundspeed while slewed) |
| **Position symbols** | An owned, associated track shows its owner's position letter. An unassociated track squawking 1200 shows `V`. Every other track shows `*` |
| **FDB mismatch line** | If an associated track's live squawk differs from its flight plan's assigned code, FDB line 3 shows `<reported> <assigned>` |
| **IDENT** | A pilot's IDENT press appends a blinking "ID" to the datablock (only the suffix blinks), latched until you acknowledge it with a slew on that track. A PDB that IDENTs displays as an LDB (beacon code + ID, then altitude) until acknowledged |
| **Beaconator** | Press and hold `F1`. Every squawking SRS-fielded track shows its beacon code: PDBs switch to FDB layout with the callsign replaced by the code, and LDBs switch to the code-and-altitude layout. Tracks the altitude filter would hide are shown too. Release to return to normal |

## Conflict Alert / MCI (STCA)

`.CA` + ENTER toggles automated conflict detection (Short-Term Conflict Alert). When on:

- A track in an unacknowledged conflict gets a blinking red `CA`/`MCI` line above line 1 of its FDB or PDB. LDBs don't show it.
- A bare left-click on a track with an active, unacknowledged conflict acknowledges it, and the indicator turns solid red.
- An alert tone plays while any unacknowledged conflict involves a track you own. Its volume follows the DCB's **VOL**, and the app-wide **Sounds** checkbox in Settings (see [Getting Started](getting-started.md)) mutes it.
- Suppression zones along final approach courses prevent alerts between aircraft established on approach.

The DCB aux bar (SHIFT) has a **CA** toggle button next to **WNG**.

## Simulated wingmen

`.WNG` + ENTER toggles simplified rendering for AI wingmen (tracks without SRS data) that share a DCS group with a flight lead:

- Only the flight lead gets a full datablock; the rest of the group renders as a small hollow diamond with no datablock.
- `.WNG` + SLEW, then click a second track, manually pairs two aircraft that don't share a DCS group (same two-click flow as `MIN`/RBL).
- A primary-only (wingman) track can't be claimed with `IC`.

SRS-fielded tracks aren't grouped this way. Their primary-only state depends only on whether they're squawking (see above).

The DCB aux bar (SHIFT) has a **WNG** toggle button next to **CA**.

## Altitude filters

`MF F` + ENTER shows your current altitude filter. Two ways to set one:

| Command | Effect |
|---|---|
| `MF FC<loAssigned><hiAssigned>` + ENTER | Set the filter for tracks shown with an owner letter |
| `MF F<loUnassoc><hiUnassoc> <loAssigned><hiAssigned>` + ENTER | Set both the filter for `*`/`V` tracks and the filter for tracks with an owner letter |

Tracks outside the active filter range don't draw. Tracks with no altitude data are never filtered.

## Mouse gestures

| Gesture | Effect |
|---|---|
| Left-click, empty buffer | Acknowledge an unacknowledged conflict on that track; otherwise accept/recall a pending handoff or point-out; otherwise toggle partial/full datablock |
| Right-click + drag | Pan the scope |
| Middle-click a contact | Toggle a local highlight (not synced, not persisted) |
| Ctrl+Click a contact | Open its Flight Plan Editor |
| Ctrl+Shift+Click a contact | Initiate Control |
| Ctrl+Right-click a contact | Toggle that track's flight-plan route line |
| Mouse wheel | Zoom range (±1 NM per notch, ±3 with Ctrl), 6–256 NM; inactive while a DCB value button is selected |

## Display Control Bar (DCB)

Click a value button, then use the **mouse wheel** to adjust it. Click a submenu button to open it; **DONE** exits back to the main bar.

**Main bar:**

| Button | Effect |
|---|---|
| **RANGE** | Scope range |
| **PLACE CNTR** | Click the button, then click the scope: that point becomes the scope center |
| **OFF CNTR** | Lit while the scope is off its original center; click to return to it |
| **RR** | Ring spacing |
| **PLACE RR** | Click the button, then click the scope to set an off-center ring origin |
| **RR CNTR** | Reset the ring origin |
| **MAPS** | Map submenu (see below) |
| Map buttons (6) | Facility airspace-category toggles, plus **LBL** (name labels). When the facility has an MVA layer, one of these slots is the **MVA** toggle |
| **BRITE** | Brightness submenu: Map A, Map B, background, FDB, LDB, lists, position symbols, rings, compass, history, and the DCB itself |
| **LDR DIR** | Leader line direction |
| **LDR LEN** | Leader line length |
| **CHAR SIZE** | Submenu: datablocks/lists/DCB/tools/position/map |
| **PREF** | 12 preset slots: save/save-as/delete/default |
| **SHIFT** | Switch to the aux bar |

**MAPS submenu:** HOLDS, MSA, airways (V, J, B), GRID/MORA, RELIEF, GEO, FIXES, any further airspace categories that don't fit on the main bar, OBST (obstacles, when the facility has any), one button per facility runway centerline, satellite flow buckets (see `.SAT` above), and one button per SID/STAR/approach procedure group.

**Aux bar (via SHIFT):**

| Button | Effect |
|---|---|
| **VOL** | Alert volume |
| **CA** / **WNG** | Conflict Alert / simulated wingmen toggles |
| **HISTORY** / **H_RATE** | Trail dot count / capture interval |
| **DCB TOP/LEFT/RIGHT/BOTTOM** | Reposition the bar |
| **PTL LNTH** | Predicted track line length |
| **PTL OWN** / **PTL ALL** | Predicted track lines for your tracks only / all tracks |

## Keyboard shortcuts

These keys insert text into the buffer; you still complete the command with a click (SLEW) or Enter.

| Key | Inserts | Effect |
|---|---|---|
| `F3` (also `Shift+F3`) | `IC` | Init Control — click a track to claim it |
| `F4` | `TC` | Term Control — click a track to drop it |
| `F5` | `HO ` | Hand Off — type a position id, then click a track |
| `F7` | `MF ` | Multi-Function prefix — follow with a list/scratchpad/leader command |
| `End` | `MIN` | Minimum-separation tool |
| `` ` `` (backquote) | `Δ` | Inserts the delta glyph |

`F2`, `F6`, `F9`, `F11`, and `F13` insert `TR `, `FD `, `FP `, `CA `, and `F13 `. No command uses these prefixes.

These act immediately, without the buffer:

| Key | Effect |
|---|---|
| `Ctrl+F` | Open a blank Flight Plan Editor |
| `F1` (press and hold) | Beaconator (see Transponder/IFF correlation above) |
| `Ctrl+F1` | Return the scope to its original center (same as `.CENTER`) |
| `Ctrl+F8` | Show/hide the DCB |
| `Alt+T` | Toggle top-down display mode |
| `Ctrl+Alt+0`–`9` | Save current view (center/range/overlays) to bookmark slot 0–9 |
| `Ctrl+0`–`9` | Load view bookmark 0–9 |
| `Escape` | Clears the buffer. Each press also clears one pending item, in this order: displayed route lines, then a `.FIND` marker, then a pending RBL/MIN/WNG second point or PLACE CNTR/PLACE RR click |
| `Backspace` | Delete the last buffer character |
| `Enter` | Run the current buffer as an ENTER-triggered command |

---

## ASDE-X (ground radar)

A ground-movement sub-scope showing surface traffic (aircraft/helicopters below ~200 ft AGL) on taxiways and ramps.

**Commands:**

| Command | Effect |
|---|---|
| `.FP <callsign>` / `.FP` + ENTER | Open Flight Plan Editor (prefilled or blank) |
| `.CENTERLINE` + ENTER | Toggle runway centerline overlay |
| `.COORDS` + ENTER | Toggle cursor lat/lng readout |
| `.COLORS <name>` + ENTER | Switch color profile (e.g. Day/Night) |
| `<d>` (1–9) + SLEW | Set/clear a contact's leader-line direction (`5` clears) |
| `.TAG <id>` + SLEW | Manually tag a target: type the aircraft ID, then click the target. The ID must match the callsign TRACS displays for that aircraft; a mismatch returns `ILL TRK` |

**Unknown Targets:** an SRS-fielded target with no live squawk renders as a **teal** triangle with no datablock or leader line. It stops being an Unknown Target when it squawks or is tagged with `.TAG`.

**Datablock content:** a target that's associated, tagged, or has no SRS data shows its aircraft ID, with type and destination from its flight plan on line 2. A squawking target that's neither associated nor tagged shows its beacon code.

**Mouse:** Ctrl+Click opens a contact's FPE; right-click+drag pans; mouse wheel zooms (0.1–2.0 NM range, in 0.1 steps).

**DCB:** a single bar — RANGE, LDR DIR, LDR LEN, PTL LNTH, HISTORY, H_RATE — with the same click-then-wheel interaction as the main ATC DCB.

ASDE-X has no function-key mappings.

## PAR (precision approach radar)

A form-driven panel with no command line.

- **AIRFIELD / CARRIER** buttons switch mode. CARRIER is enabled only when a carrier is known (docked under CATCC, or via URL parameter).
- Pick a **runway** (airfield mode) to auto-fill lat/lng/heading/elevation, or enter them manually.
- **GS** (glideslope angle, 1–7°, default 3.0° airfield / 3.5° carrier) and **RNG** (displayed range, default 10 NM) are editable and remembered per mode.
- Two plots:
  - **Elevation** (side view): glideslope, ±0.7° tolerance corridor, 8° service-volume ceiling, and in carrier mode a 1200 ft Case III minimum line.
  - **Azimuth** (top-down): centerline, ±2.5° tolerance corridor, ±10° service-volume cone.
- Contacts inside tolerance are gold (carrier) or blue (airfield); outside tolerance, orange.

## Strip Bay

Flight progress strips, handled by direct manipulation (no command line).

**Adding strips:** type a callsign into the footer input and press Enter or click **Add Strip**.

**Auto-add triggers** (the **⚙** settings button). Each one adds a strip for the aircraft's flight plan when enabled:

| Setting | Adds a strip when |
|---|---|
| On track initiation | You claim a track (`IC`, Ctrl+Shift+Click) |
| On handoff acceptance | You accept an incoming handoff |
| On strip pass acceptance | Another controller sends you a strip |
| On DEP airport match | A flight plan is created, or its DEP changes, and its DEP is your facility or in the listed airports |
| On DEST airport match | Same, for DEST |

Other settings:
- **Ignore all incoming strip passes** — drops strips sent to you.
- **Delete strip on drop track** — removes a strip when you drop its track.
- **Annotation conflict** — Overwrite, Merge, or Ignore, for when a received strip's annotations differ from yours.

**Bulk flight-plan import:**
- The footer's **⬆ Load Mission** button accepts a `.miz` mission file, a CSV, or a DCS Data Transfer Cartridge (`.dtc`, F-16C/F/A-18C). Each produces flight plans to review, with per-row collision handling, before committing.
- **✕ Clear Mission** appears once imported flight plans exist. It deletes them session-wide, for every controller, after a confirmation.
- **✕ Clear Strip Bay** appears when the bay has strips. It clears only your own strips, after a confirmation, and leaves the flight plans in place.

**Per-strip mouse actions:**

| Gesture | Effect |
|---|---|
| Click | Acknowledge a highlight (e.g. auto-added flag) |
| Shift+Click | Delete immediately, no confirmation |
| Ctrl+Click or double-click | Open the strip's Flight Plan Editor |
| Right-click | Context menu: Delete, or "Send to `<position>`" for any known controller |
| Drag | Reorder strips (switches sort mode to Manual) |

**Annotation cells:** each strip has a 3×3 grid of editable cells (up to 3 characters each). Click to edit; Enter or clicking away saves; Escape restores the previous value.

**Header controls:** sort by Time/AID/DEP/DEST/Manual; mouse wheel over the header zooms strip scale (50–200%).

---

## Known limitations

These ATC commands are recognized but not functional:

- `IC <flightid>` + ENTER returns `NOT YET SUPPORTED`. `TC <flightid>` + ENTER and `HO <tcp> <flightid>` + ENTER return `UNIMPLEMENTED`. Use the SLEW forms.
- `MF M` (Mode C toggle), `MF B` (beacon toggle), and `MF E` (FDB overflight toggle) return `UNIMPLEMENTED`.
- Quicklook (`**<tcp>`, `**ALL`) has no effect.
- Ctrl+F2–F5, Ctrl+F7, Ctrl+F9, Ctrl+F10, and Insert have no effect.
