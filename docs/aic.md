# AIC (Air Intercept Controller)

[← All docs](index.md)

Tactical display for airborne intercept control — AWACS/GCI style: bullseye-centered scope, hostile/friendly classification, BRAA pairing, ROE tracking, and a doctrinal PICTURE readout (formation/group detection modeled on AWACS brevity doctrine).

Sign-in requires a Callsign and Frequency — see [Getting Started](getting-started.md). AIC does not use SRS transponder data (unlike ATC's association/IDENT features) — that's undecided/not planned for this module.

## Command line

Click the scope to focus it, type, then **Enter** to run most commands. A few commands work differently: type them, then **click a contact on the scope** instead of pressing Enter — that pattern is called out explicitly below, since pressing Enter on those alone does nothing useful.

`ArrowUp`/`ArrowDown` cycle through your last 50 commands. `Backspace` deletes a character. `Escape` cancels pending state (see Keyboard, below).

### Display / scope settings

| Command | Effect |
|---|---|
| `.center` | Re-center on bullseye |
| `.center <brg> <rng>` | Center at a magnetic bearing/range (NM) from bullseye |
| `.center <fixname>` | Center on a named nav fix |
| `.find <fixname>` | Drop a marker at a named fix (cleared by Escape) |
| `.define <term>` (or `.def <term>`) | Look up a tactical brevity term (ATP 1-02.1, April 2025) and show its full definition above the command line, e.g. `.define bogey dope`. Stays up until dismissed (Escape, another `.define`, or clicking it) |
| `.be` | Reset bullseye to the mission bullseye (clears any override) |
| `.be` + click | Type `.be`, then click the map to override bullseye at that point |
| `.be <fixname>` | Override bullseye to a named fix/navaid/runway |
| `.be <lat> <lon>` | Override bullseye to explicit decimal-degree coordinates |
| `.rr` | Toggle range rings |
| `.rr <nm>` | Set range ring spacing (`0` = off) |
| `.ptl <seconds>` | Predicted Track Line length, 0–300s |
| `.sym <n>` | Symbol size, 1–5 |
| `.faded <seconds>` | How long a contact keeps showing (faded) after dropping out |
| `.geo` | Toggle coastline/boundary overlay |
| `.relief` | Toggle terrain relief shading |
| `.aspcolors <name>` | Set the map color palette by name |
| `.centroid` | Debug aid — marks the hostile-picture centroid |
| `.axis` | Debug aid — draws the computed threat axis |
| `.bec` | Toggle bullseye-on-cursor — bearing/range readout that follows the mouse (off by default) |
| `.clear` | Clears threat rings, RBL, sector, PICTURE-ack state, and **all** BRAA pairs |

### Classification

| Command | Effect |
|---|---|
| `.class` | Reset all declarations to default (fog-of-war), turns off autoclass |
| `.class <old> <new>` | Bulk-reclassify every contact currently `<old>` to `<new>` — letters `f`/`n`/`b`/`h` for friendly/neutral/bogey/hostile, e.g. `.class b h` |
| `.autoclass` | Toggle auto-classification — undeclared contacts adopt their true coalition (friendly/neutral/hostile, never bogey) as soon as they're visible |

Or use the F-keys (below) to declare contacts by clicking them.

### ROE

`.roe free` / `.roe tight` / `.roe hold` — sets weapons status, shown top-left. Bare `.roe` toggles visibility of the ROE readout itself (visible by default).

### Threat rings

| Command | Effect |
|---|---|
| `.threat` (Enter) | Clears all threat rings |
| `.threat`, then click a contact | Toggles that contact's ring |
| `.threat <nm>` (Enter) | Sets the ring radius used by manual/auto rings |
| `.threat <nm>`, then click a contact | Sets radius and toggles that contact's ring |
| `.autothreat` | Toggle automatic lighting — any friendly within radius of a hostile/bogey lights up automatically |

### PICTURE panel

`.picture` toggles the PICTURE readout — off by default, so turn it on explicitly. It groups hostile contacts into formations (single, azimuth, range, wall, vic, champagne, ladder, box, leading edge) with doctrine-style naming and amplifiers (opening/closing, weighted, follow-on, echelon), computed from a sector you define. The panel header also shows the group's dimensions (e.g. "12 WIDE 8 DEEP") alongside the formation label.

| Command | Effect |
|---|---|
| `.sector` | Re-shows a hidden sector, or reports `NO SECTOR` if none is defined |
| `.sector clear` / `.sector off` | Clears the sector |
| `.sector <fromBrg> <toBrg> <rngNm>` (Enter) | Defines a sector wedge centered at the bullseye |
| `.sector <fromBrg> <toBrg> <rngNm>`, then click on the scope | Same, but places the origin at the clicked point |
| `.sector` (bare, sector already exists), then click | Moves the existing sector's origin without retyping the arc |

Click the PICTURE panel itself to acknowledge the current picture — this clears its alert-flash styling until the group composition changes again.

### Type-then-click-only commands

- `.rename` / `.rename <newcallsign>`, then click a contact — renames it (blank name resets to default), synced to other controllers
- `.dope`, then click a fighter — pairs it in the BRAA list with the nearest bogey (same as Alt+click, below)

## BRAA List

Bearing/Range/Altitude/Aspect pairs, shown in a dockable/undockable side panel. **Not synced between controllers** — each AIC position keeps its own list.

**Adding a pair:**
- **Ctrl+click** a contact to mark it as the fighter, then click a second contact to complete the pair (or Ctrl+click the same one again to cancel).
- **Alt+click** a fighter — auto-pairs it with the nearest hostile/bogey contact (bogey dope).

**Removing a pair:**
- **Shift+click** a contact on the scope — removes every pair involving that unit.
- Shift+click a row, or its **×** button, in the BRAA panel.
- **Clear All** button (confirms first), or the `.clear` command.

**Per-row display:** fighter → bogey, colored by declaration. When both units are live: bearing/range (magnetic), altitude, aspect (Hot/Flank/Beam/Cold), and speed/altitude flags (High/Fast/Very Fast) where applicable. A computed intercept heading and time-to-intercept, or "NO INTERCEPT" if no valid geometry exists. If either unit drops off radar, the row shows "NO DATA" rather than disappearing — it comes back automatically if the unit reappears.

Rows are unsorted (insertion order). Mouse wheel on the panel's title bar zooms its display scale.

## Mouse

| Gesture | Action |
|---|---|
| Left-drag | Draw a range/bearing line (RBL) |
| Shift+click a contact | Remove all BRAA pairs for that unit |
| Ctrl+Alt+click a contact | Toggle a manual threat ring |
| Ctrl+click a contact | Start/complete a BRAA pair |
| Alt+click a contact | Bogey-dope: auto-pair nearest bogey |
| Mouse wheel | Zoom range (±5nm/step, ±10nm with Ctrl) |
| Click the mission clock | Toggle Zulu / theatre-local time |
| Right-click | No context menu |

## Keyboard

| Key | Effect |
|---|---|
| `F1` / `F2` / `F3` / `F4` | Arm a pending declaration — Hostile / Bogey / Neutral / Friendly — then click a contact to apply it. Press the same key again to cancel. |
| `Escape` | Clears whatever's active, in order: a `.find` marker, then a `.define` readout, then preview-only state (RBL/sector), then any pending declaration, BRAA pairing, or typed command |
| `Enter` | Runs the current command |
| `Ctrl+M` | Opens Messages — a general chat window shared across all modules (DM another position with `.chat <POSITION>`, broadcast to everyone with `/ <text>`), not AIC-specific |

Typing a command clears any pending F-key declaration or BRAA pairing in progress, and vice versa — the two interaction modes don't mix.
