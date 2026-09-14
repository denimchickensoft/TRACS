# CATCC (Carrier Air Traffic Control Center)

[← All docs](index.md)

Carrier air traffic control: a radar scope with a text command line, a synchronized Status Board, and a Deck view for visual traffic on/around the carrier.

## Scope commands

Type into the command line, then press **Enter** to execute or click a target on the scope to complete a "slew" command (see below). Commands are case-insensitive; the scope uppercases as you type.

Aircraft are addressed by side number or callsign. A track's side number comes from the Status Board: TRACS auto-correlates a live unit's callsign against the Status Board's callsign/side-number entries, so an aircraft shows its real side number on the scope only once it's on the board (via the Status Board itself, or by adding it directly with Ctrl+Click below). An uncorrelated contact's datablock shows `XXX` instead of a side number. There's no manual "assign side number to this track" command — correlation is always driven by the Status Board.

CATCC does not yet use SRS transponder data (unlike ATC's association/IDENT features) — its datablock is always the fixed side-number-or-`XXX` / altitude-groundspeed format described above, regardless of squawk. Transponder-aware CATCC datablocks are planned but not yet built.

| Command | Effect |
|---|---|
| `IT <callsign\|side>` | Initiate Track — claim ownership of a contact |
| `DT <callsign\|side>` | Drop Track |
| `HO <callsign\|side> <tcp>` | Hand off to another controller position (`tcp` = their position id, e.g. `1D`) |
| `PO <callsign\|side> <tcp>` | Point out a track to another controller |
| `RN <callsign\|side> [newCallsign]` | Rename a track's callsign, or omit the second argument to reset to default |
| `.HISTORY` | Toggle history-trail display |
| `.LL [0-99]` | Set leader-line length (pixels); bare `.LL` queries the current value |
| `.LD [N\|NE\|E\|SE\|S\|SW\|W\|NW\|1-9\|OFF]` | Set the default leader-line direction |
| `.DBCA` | Toggle datablock collision avoidance (on by default) |
| `.ASP` | Bulk-toggle all airspace categories |
| `.TMA` `.CTR` `.CTA` `.FIR` `.UIR` `.SUA` `.MIL` `.TRSA` `.CLASSA`–`.CLASSG` | Toggle one airspace category |
| `.LABELS` (aliases `.LBL`, `.LABEL`) | Toggle airspace/fix name labels |
| `.FILL` | Toggle airspace polygon fill; `.FILL <1-100>` sets transparency % and turns it on |
| `.FIXES` | Toggle theatre fix points |
| `.FIX <name...>` | Force-show one or more fixes regardless of `.FIXES`; each name toggles independently |
| `.GEO` | Toggle coastlines/boundaries |
| `.ASPCOLORS <name>` | Select an airspace color palette (e.g. `CATCC` — the default, all-yellow) |
| `.REFRESH` | Re-fetch airspace color palettes without reloading |

Errors appear in the ODS response area: `NO TRACK: <id>` (unit not found), `ILL TRK` (you don't own that track), `ILL POS` / `ILL POS: <tcp>` (invalid handoff target).

**Slew commands** (type the command, then left-click the target to complete it) — CATCC has its own local implementation of these (mirrors the ATC/STARS scope's bindings, but targets CATCC's own state independently — no shared dispatcher):

| Command | Effect |
|---|---|
| `IC` | Initiate control on the clicked contact |
| `TC` | Terminate control |
| `HO` (bare) | Accept the nearest incoming handoff; `HO <tcp>` then slew hands off to a position |
| `<id>*` / `**` / `UN`, then slew | Point out / accept an incoming point-out as a handoff / reject a point-out |
| A 3–4 character alphanumeric, then slew | Set scratchpad 1; prefix with `+` for scratchpad 2 |
| `MF L<n><n>` (e.g. `MF L33`), then slew | Set leader-line direction globally; `MF L<n>` sets it for a single track |
| `MF S`, then click anywhere on the scope | Relocate the status-text overlay |

## Mouse & keyboard

| Gesture / Key | Effect |
|---|---|
| **Ctrl+Shift+Click** a contact | Initiate Control |
| **Shift+Click** a contact | Terminate Control |
| **Ctrl+Click** a contact | Add it to the Status Board directly (CATCC-only shortcut, no command-line equivalent) |
| **Mouse wheel** over the scope | Zoom range (hold Ctrl for larger steps) |
| Moving the mouse | Shows a live bearing/range readout from the carrier to the cursor |
| **Alt+T** | Toggle top-down display mode |
| **Ctrl+Alt+0**–**9** | Save current range to bookmark slot 0–9 |
| **Ctrl+0**–**9** | Load range bookmark 0–9 |
| `F2`–`F13` and other function keys | Map to STARS-style command prefixes (`F3`=IC, `F4`=TC, `F5`=HO, `F7`=MF, `F9`=FP, etc.) — same key-to-token mapping table as the ATC scope (purely a keyboard convenience, no shared command dispatch) |
| `Escape` / `Backspace` | Clears the command line / deletes the last character |

## Status Board

A synchronized event/recovery board, visible to and editable by every CATCC position via WebRTC.

**Header fields:** Event, Launch/Recovery time (4-digit clock), Ceiling, Visibility, QNH, Case (Launch/Recovery — the NATOPS recovery case letter/number), MAR/APP/TWR/DEP button frequencies, RAD (radial). Sunrise/sunset, magnetic variation, timezone, BRC, FB, and speed are computed automatically and read-only. **Case Recovery** matters beyond display: setting it to `3` switches the status overlay to show RAD+FB (instrument recovery) instead of BRC.

The on-scope status overlay also shows a context-sensitive next-handoff line — `<label> BTN <freq>` — based on your own position: Marshal sees Approach's frequency, Approach sees Tower's, Tower sees Departure's.

BRC/FB/speed flash if they drift more than 5° and haven't restabilized for 20 seconds — a heads-up that the boat is maneuvering.

**Aircraft table** — 14 columns: EVT, side number, callsign, pilot (auto-filled from the unit name if left blank), type, mission, ATD (actual departure time), radial, bingo fuel, a read-only side-number mirror, EAT (estimated arrival), Angels (altitude in thousands), fuel state, ATA (actual arrival time).

**Adding entries:**

| Action | Effect |
|---|---|
| **+ Add** | Blank row |
| **Ctrl+Click** a contact on the scope | Adds it with callsign pre-filled |
| **⬆ Load Mission** | Import from a mission file (see below) |

**Editing:** click a cell to edit it. `Tab`/`Shift+Tab` moves between fields, `Enter` commits, **`Shift+Enter` commits and inserts a new blank row directly below**, `Escape` cancels without saving. Invalid time (`HHMM`, 0000–2359 or 2400) or fuel (`X.X`/`XX.X`) values are highlighted red. Click a column header to sort (display only — doesn't reorder the underlying data).

**Row controls:** ▲/▼ reorder, × deletes.

**Clearing:** **✕ Clear Mission** removes only rows imported from a mission file and blanks the weather fields (only shown once mission data exists). **✕ Clear ALL** (two-step confirm) wipes everything and resets RAD to the current reciprocal of FB.

**Board scale:** mouse wheel over the title bar zooms the whole board 50–200%. Click the title-bar clock to toggle Zulu/Local time.

**Undocking:** the popped-out Status Board window's "dock" button just closes the popup — state stays synced regardless via the same WebRTC/cross-window channel.

## Deck

A top-down carrier deck view for visual traffic near the boat.

- **Mouse wheel** — zoom (1x–4x; 1x is a hard floor equal to fit-to-panel)
- **Right-click + drag** — pan
- Aircraft near deck altitude and within the hull footprint are plotted as small triangles, labeled with side number or callsign, oriented to heading relative to the carrier
- Zoom resets when you switch carrier class

**Lat/lon calibration tool (debug aid):** **Ctrl+Alt+Click** on the deck copies a text string to the clipboard with the clicked point's real-world lat/lon, its pixel position in the source deck image, and the carrier's own lat/lon. There's no on-screen confirmation — check your clipboard or the browser console. This exists to help calibrate deck art against real carrier geometry; it's not an operator feature and has no button or menu entry.

## Mission Import

Available from the Status Board's **⬆ Load Mission** button, or the equivalent ABM/general mission-import flow.

- Drop a `.miz` file (parsed directly as a zip) or a raw mission text file onto the dropzone, or click to browse.
- The importer extracts:
  - **Weather** — QNH, visibility, and ceiling (with a warning note if the cloud preset can't be mapped confidently — verify manually in that case).
  - **Carriers and their launching aircraft** — only aircraft whose first waypoint is a carrier departure (parking/hot-start/runway) count as "launching from" that carrier; overflights and land-based aircraft that later recover aboard are not included.
- If multiple carriers are found, pick one from the selector — it re-scopes the aircraft list to that carrier's launches. Aircraft flown by a human (`Client` skill) are highlighted.
- Select which aircraft to import (checkboxes; header checkbox selects all visible), then **Import**. Weather is imported independently — partial data (e.g. QNH only) is fine. Duplicate callsigns are skipped.
