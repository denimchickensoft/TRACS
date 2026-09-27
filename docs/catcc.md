# CATCC (Carrier Air Traffic Control Center)

[← All docs](index.md)

Carrier air traffic control: a radar scope with a text command line, a synchronized Status Board, and a Deck view for visual traffic on and around the carrier.

## Side numbers and correlation

A track's side number comes from the Status Board. TRACS matches each Status Board row to a live unit, either by the unit the row was created from (rows added with Ctrl+Click) or by callsign. What the datablock's first line shows depends on whether the unit is SRS-fielded (has reported SRS transponder data through a relay):

| Unit | Datablock line 1 |
|---|---|
| No SRS data, on the Status Board | The row's side number |
| No SRS data, not on the Status Board | `XXX` |
| SRS-fielded, not squawking | `XXX` |
| SRS-fielded, squawking the row's **BCN** code and flying the row's callsign | The row's side number |
| SRS-fielded, squawking but not matching a row | The live 4-digit squawk |

Line 2 is altitude and groundspeed. Only a track that shows a side number (a *correlated* track) can be taken under control with `IT`, `IC`, or Ctrl+Shift+Click. For SRS-fielded aircraft, that means entering the assigned code in the Status Board's BCN column. There's no command to assign a side number to a track directly.

## Scope commands

Type into the command line, then press **Enter**, or click a target to complete a slew command (see below). Commands are case-insensitive; the scope uppercases as you type. Aircraft are addressed by side number or callsign.

| Command | Effect |
|---|---|
| `IT <callsign\|side>` | Initiate Track — claim ownership of a correlated, unowned contact |
| `DT <callsign\|side>` | Drop Track |
| `.DROPALL` | Drop every track you own |
| `HO` | Accept the first incoming handoff |
| `HO <callsign\|side> <tcp>` | Hand off to another controller position (`tcp` = their position id, e.g. `1D`) |
| `PO <callsign\|side> <tcp>` | Point out a track to another controller |
| `RN <callsign\|side> [newCallsign]` | Rename a track's callsign, or omit the second argument to reset to default |
| `.HISTORY` | Toggle history-trail display |
| `.LL [0-99]` | Set leader-line length (pixels); bare `.LL` queries the current value |
| `.LD [N\|NE\|E\|SE\|S\|SW\|W\|NW\|1-9\|OFF]` | Set the default leader-line direction |
| `.LABELSIZE [0-5]` | Set airspace/fix label size; bare `.LABELSIZE` queries the current value |
| `.DBSIZE [0-5]` | Set aircraft datablock size; bare `.DBSIZE` queries the current value |
| `.DBCA` | Toggle datablock collision avoidance (on by default) |
| `.ASP` | Bulk-toggle all airspace categories |
| `.TMA` `.CTR` `.CTA` `.FIR` `.UIR` `.SUA` `.MIL` `.TRSA` `.CLASSA`–`.CLASSG` | Toggle one airspace category |
| `.LABELS` (aliases `.LBL`, `.LABEL`) | Toggle airspace/fix name labels |
| `.FILL` | Toggle airspace polygon fill; `.FILL <1-100>` sets transparency % and turns it on |
| `.FIXES` | Toggle theatre fix points |
| `.FIX <name...>` | Force-show one or more fixes regardless of `.FIXES`; each name toggles independently |
| `.FIX` (no argument) | Clear every pinned fix for the current theatre |
| `.GEO` | Toggle coastlines/boundaries |
| `.ASPCOLORS <name>` | Select an airspace color palette (e.g. `CATCC` — the default, all-yellow) |
| `.REFRESH` | Re-fetch airspace color palettes without reloading |

Errors appear in the ODS response area:
- `NO TRACK: <id>` — unit not found.
- `ILL TRK` — the track isn't yours to drop or hand off, or you tried to take control of a track that is uncorrelated or already owned.
- `ILL POS` / `ILL POS: <tcp>` — invalid handoff target.

**Slew commands** (type the command, then left-click the target):

| Command | Effect |
|---|---|
| `IC` | Initiate control on the clicked contact (must be correlated and unowned) |
| `TC` | Terminate control |
| `HO <tcp>` | Hand off the clicked track to a position |
| `<tcp>*` / `**` / `UN` | Point out / accept an incoming point-out as a handoff / reject a point-out |
| `<text>` (3–4 characters) | Set scratchpad 1 on a track you own; `+<text>` (1–4 characters) sets scratchpad 2; `.` / `+` clear them. Scratchpads are stored but not drawn on CATCC datablocks |
| `MF L<n><n>` (e.g. `MF L33`) | Set leader-line direction globally; `MF L<n>` sets it for the clicked track |
| `MF S`, then click anywhere on the scope | Relocate the status-text overlay |

## Mouse & keyboard

| Gesture / Key | Effect |
|---|---|
| **Ctrl+Shift+Click** a contact | Initiate Control |
| **Shift+Click** a contact | Terminate Control |
| **Ctrl+Click** a contact | Add it to the Status Board |
| **Mouse wheel** over the scope | Zoom range, 1 NM per step (3 NM with Ctrl), 6–256 NM |
| Moving the mouse | Shows a live bearing/range readout from the carrier to the cursor |
| **Alt+T** | Toggle top-down display mode |
| **Ctrl+Alt+0**–**9** | Save current range to bookmark slot 0–9 |
| **Ctrl+0**–**9** | Load range bookmark 0–9 |
| `F3` / `F4` / `F5` / `F7` | Insert `IC` / `TC` / `HO ` / `MF ` into the command line. `F2`, `F6`, `F9`, and `F11` insert `TR `, `FD `, `FP `, and `CA `, which CATCC has no commands for |
| `Escape` / `Backspace` | Clears the command line / deletes the last character |

## Status Board

An event/recovery board shared by every CATCC position over the session's sync transport. Anyone can view and edit it.

**Header fields:**
- **Editable:** Event, Launch time and Recovery time (4-digit clocks), Ceiling, Visibility, QNH, Case (separate one-character Launch and Recovery fields), the MAR/APP/TWR/DEP 2-digit radio button numbers, and RAD (radial).
- **Computed and read-only:** sunrise/sunset, magnetic variation, timezone, BRC, FB, and speed.

**Status overlay on the scope:** shows the case lines. When Case Recovery is a number, it adds a line with BRC, or with RAD and FB when Case Recovery is `3`. That same line also shows the next handoff's button number (`<label> BTN <n>`), based on your position: Marshal sees Approach's button, Approach sees Tower's, Tower sees Departure's. Departure gets no handoff entry.

**Drift flash:** BRC and FB flash when they drift more than 5° from their baseline, and speed flashes when it drifts more than 5 kt. The flash stops once the value has held steady for 20 seconds.

**Aircraft table** — 15 columns: EVT, side number, BCN (beacon/squawk code, with a ↻ button per row to recycle it), callsign, pilot (auto-filled from the unit name if left blank), type, mission, ATD (actual departure time), radial, bingo fuel, a read-only side-number mirror, EAT (estimated arrival), Angels (altitude in thousands), fuel state, ATA (actual arrival time). BCN and callsign together drive side-number correlation for SRS-fielded aircraft (see above).

**Adding entries:**

| Action | Effect |
|---|---|
| **+ Add** | Blank row |
| **Ctrl+Click** a contact on the scope | Adds it with callsign pre-filled |
| **⬆ Load Mission** | Import from a mission file (see below) |

**Editing:**
- Click a cell to edit it.
- `Tab`/`Shift+Tab` moves between fields, `Enter` commits, `Shift+Enter` commits and inserts a new blank row directly below, and `Escape` cancels without saving.
- Invalid time (`HHMM`, 0000–2359 or 2400) or fuel (`X.X`/`XX.X`) values are highlighted red.
- Click a column header to sort. This changes the display only and doesn't reorder the underlying data.

**Row controls:** ▲/▼ reorder, × deletes.

**Clearing:**
- **✕ Clear Mission** removes only rows imported from a mission file and blanks the weather fields. It's shown once mission data exists.
- **✕ Clear ALL** (two-step confirm) wipes everything and resets RAD to the reciprocal of FB.

**Board scale:** mouse wheel over the title bar zooms the whole board 50–200%. Click the title-bar clock to toggle Zulu/Local time.

**Undocking:** the popped-out Status Board window's "dock" button closes the popup. The board's state stays in sync between the popup and the main window either way.

## Deck

A top-down carrier deck view for visual traffic near the boat.

- **Mouse wheel** — zoom (1x–4x; 1x is fit-to-panel)
- **Right-click + drag** — pan
- Aircraft near deck altitude and within the hull footprint are plotted as small triangles, labeled with side number or callsign, oriented to heading relative to the carrier
- Zoom resets when you switch carrier class

## Mission Import

Opened from the Status Board's **⬆ Load Mission** button.

- Drop a `.miz` file or a raw mission text file onto the dropzone, or click to browse.
- The importer extracts:
  - **Weather** — QNH, visibility, and ceiling, with a note describing how the cloud preset was mapped to a ceiling.
  - **Carriers and their launching aircraft** — only aircraft whose first waypoint is a carrier departure (parking, hot start, or runway) count as launching from that carrier.
- A mission with no carriers fails with "No carrier ships found in this mission."
- If several carriers are found, pick one from the selector. The carrier matching your signed-in carrier is pre-selected. The list shows that carrier's launches, all pre-checked. Aircraft flown by a human (`Client` skill) are highlighted.
- Select which aircraft to import (checkboxes; the header checkbox selects all visible), then click **Import**.
  - Each imported row gets callsign, side number (from the modex), type, and mission. BCN is left blank.
  - Duplicate callsigns are skipped.
  - Weather is imported independently of the aircraft selection, and partial data (e.g. QNH only) is fine.
