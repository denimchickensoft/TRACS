# ABM (Air Battle Manager)

[← All docs](index.md)

Mission-wide package tracking: a radar scope with map/reference layers, an ATO summary of every tasked flight, a FRAG drawer for per-package detail, and custom drawing overlays.

Sign-in requires a Callsign and Frequency, same as AIC — see [Getting Started](getting-started.md). ABM does not yet use SRS transponder data on its datablocks (unlike ATC's association/IDENT/Beaconator features) — that's planned but not yet built.

## Command line

Type into the buffer, press **Enter**. A number of commands (`.threat`, `.db`, `.dope`, `.rename`, `.be`, `.frag`, `.route`, and the free-hand drawing commands below) work by typing without pressing Enter, then clicking the map instead — noted below. `Escape` clears state in this priority order: a pending drawing-clear click → a pending "clear all drawings" confirm → a pending free-hand drawing in progress → find marker → a flight's route line (toggled via `.route`/FRAG) → pending F-key declaration → pending BRAA fighter → open RBL → brevity definition readout → command buffer. `ArrowUp`/`ArrowDown` cycle your last 50 commands.

### Bullseye

| Command | Effect |
|---|---|
| `.be` (Enter, no click) | Reset to the mission bullseye (clears any override) |
| `.be` typed then click the map | Place an override bullseye at that point |
| `.be <fix>` | Override to a named fix/navaid/runway |
| `.be <lat> <lon>` | Override to explicit decimal-degree coordinates |

### Range rings

| Command | Effect |
|---|---|
| `.rr` | Toggle on/off |
| `.rr <nm>` | Set spacing (≤0 turns off) |
| `.rr <nm> <anchor>` | Set spacing and anchor to `bullseye`/`bs` or a named fix |

### Map & reference layers (bare toggles unless noted)

| Command | Effect |
|---|---|
| `.time` | Toggle the mission clock |
| `.unitro` | Toggle the cursor unit-proximity readout (on by default) |
| `.rose` / `.compass` | Toggle the compass rose (on by default) |
| `.geo` | Toggle coastlines/boundaries |
| `.relief` | Toggle terrain relief shading |
| `.holds` | Toggle holding patterns |
| `.mora` | Toggle the MORA/grid overlay |
| `.airways` | Toggle all airways; `.airways v`/`j`/`b` toggles just one class |
| `.asp` | Bulk-toggle every airspace category |
| `.tma` `.ctr` `.cta` `.fir` `.uir` `.sua` `.mil` `.trsa` `.classa`–`.classg` | Toggle one airspace category |
| `.aspcolors <name>` | Select an airspace color palette |
| `.refresh` | Reload airspace color palettes from the server |
| `.labels` | Toggle name labels for airspace *and* custom drawings |
| `.fill` | Toggle polygon fill for airspace *and* custom drawings; `.fill <1-100>` sets transparency % and turns it on |
| `.custom` / `.cust` | Toggle all custom drawing layers |
| `.custom <name>` / `.cust <name>` | Toggle just the drawing(s) with that name |
| `.fixes` | Toggle theatre fix points |
| `.fix <name...>` | Force-show one or more fixes regardless of `.fixes`; each name toggles independently |
| `.navaids` | Toggle navaids |
| `.find <fix>` | Drop a marker at a named fix |
| `.runways` | Toggle runways |
| `.polygons` | Toggle airport polygons |
| `.mgrs` | Toggle the theatre-aware UTM/MGRS grid — see below |
| `.towns` | Toggle towns |
| `.base` / `.terrain` / `.water` / `.roads` | Toggle individual terrain raster layers; `.map` toggles all four together plus `.geo` |

**MGRS grid detail**: `.mgrs` isn't a flat overlay — it auto-detects how many real UTM zones the current view actually spans and draws a correct zone-boundary seam, with reprojected 100 km grid-square labels on each side of the seam, a grid-zone designator (e.g. "38S"), and finer 1 km/10 km subdivision lines as you zoom in.

Note: SID/STAR/approach procedures are deliberately display-only here — there's no `.proc`-style command in ABM.

### Brevity glossary

`.define <term>` (or the shorter `.def <term>`) — look up a tactical brevity term (ATP 1-02.1, April 2025) and show its full definition in a dedicated readout above the command line. Multi-word terms work as typed, e.g. `.define bogey dope`. The readout stays up until you dismiss it (Escape, another `.define`, or clicking it) rather than disappearing on the next command ack.

### Cursor readout

| Command | Effect |
|---|---|
| `.coords` | Toggle the cursor lat/lng readout |
| `.ddm` / `.dms` | Set coordinate format |
| `.meters` / `.feet` | Set elevation units |
| `.bec` | Toggle bullseye-on-cursor — bearing/range readout that follows the mouse |

### Contacts

| Command | Effect |
|---|---|
| `.ptl <0-5>` | Predicted track line minutes |
| `.faded <seconds>` | Coast/fade duration |
| `.history` | Toggle trails; `.history <len>` sets length (0=off, max 10); `.history <len> <rate>` sets length + capture rate |
| `.db` | Toggle global datablock visibility; typed (no Enter) + click a contact toggles just that one |
| `.dbreset` | Clear all per-contact `.db` overrides |
| `.dbca` | Datablock collision-avoidance placement (off by default) |
| `.dbs` | Formation datablock suppression: only the flight lead's datablock shows when 2+ same-flight aircraft are within 3 NM (on by default) |
| `.ldr <length 0-7> <dir 1-9>` | Leader line length/direction |

### BRAA, bogey dope, threat rings

| Command | Effect |
|---|---|
| `.threat` (Enter) | Clear all rings; `.threat <nm>` (Enter) sets the default radius instead |
| `.threat` / `.threat <nm>`, then click a contact | Toggle that contact's ring (optionally set radius) |
| `.tclear` | Clears RBL, all BRAA pairs, and all threat rings at once |
| `.dope`, then click | Bogey-dope the clicked contact to its nearest hostile/bogey air contact |
| `.rename` / `.rename <newcallsign>`, then click | Rename or reset a contact's callsign (synced to other controllers) |

### Declaration

| Command | Effect |
|---|---|
| `.dec` | Reset all declarations to default |
| `.dec <old> <new>` | Bulk redeclare, letters `f`/`n`/`b`/`h` (friendly/neutral/bogey/hostile), e.g. `.dec b h` |
| `.autodec` | Toggle auto-declare (true-coalition-based, unconditional — Mode 4 never consulted). Turning it **off** does not revert contacts it already declared — only a bare `.dec` reset does that |
| `.autodec iff` | Toggle IFF-gated auto-declare — FRIENDLY only. A non-SRS-fielded same-coalition contact declares unconditionally; an SRS-fielded one only when correlated to a FRAG-assigned aircraft (see FRAG's IFF section below). Never touches hostile/neutral/bogey. Mutually exclusive with `.autodec` |
| `.autothreat` | Auto-light threat rings on friendlies near hostiles/bogeys |

### ROE

`.roe free` / `.roe tight` / `.roe hold` — sets weapons status, shown top-left (state is shared with AIC). Bare `.roe` toggles visibility of the ROE readout itself (visible by default).

### Ground/naval acquisition & engagement rings

`.acq` / `.eng` (all) or `.acq <f|n|b|h>` / `.eng <f|n|b|h>` (one class)

### Free-hand scope drawing

Draw directly on the scope by typing a command and clicking, the same type-then-click pattern as `.threat`/`.dope`/`.rename`/`.be`:

| Command | Effect |
|---|---|
| `.line` `.rect` `.circ` | Line, rectangle, circle |
| `.poly` | Polygon; keep clicking to add vertices, `Escape` or re-typing the command finishes it |
| `.sect <id> <brg1>...<brgN> <radius>` | A sector (or multiple sectors sharing one id) defined by a list of bearings and a radius |
| `.race` | A racetrack shape |
| `.text` | A text label |

While a shape is pending, magnetic-heading snapping and whole-NM distance snapping apply automatically, and the scroll wheel rotates the shape before you commit it with a click.

Clearing: `.dclear` (bare, then click a drawing) removes one shape; `.dclear all` removes every hand-drawn shape (confirm-gated — you'll be asked to type `y`/`n`); `.dclear <name>` removes by name.

All hand-drawn shapes show up in the Drawings panel alongside imported layers — see Drawings panel management below.

### Callsign/route lookup by name

Alternatives to clicking a contact directly, useful when you know the callsign but the contact is hard to click precisely:

| Command | Effect |
|---|---|
| `.where <callsign>` | Drop a marker on that contact |
| `.frag <callsign>` | Open FRAG for that contact's flight |
| `.route <callsign>` | Toggle that flight's route line on the scope |

All three accept a partial/prefix match and will tell you if it's ambiguous between multiple live callsigns. `.rclear` clears every currently-shown route line at once (both ones toggled via `.route`/FRAG's own ROUTE header).

### Focus windows

A floating mini-scope locked onto one contact, for tracking it without losing your place on the main scope.

| Command | Effect |
|---|---|
| `.focus <callsign>` | Open (or bring to front) a focus window on that contact, at your saved default range |
| `.focus <callsign> <range>` | Same, with an explicit range in NM |
| `.focus <range>` | Sets the default range used by future opens, without opening a window |
| Double-click a contact on the main scope | Shortcut for `.focus <callsign>` |

All three accept the same partial/prefix matching (and ambiguity reporting) as `.where`/`.frag`/`.route`.

The focus window itself is a real independent scope: drag to move it, drag an edge/corner to resize, and use the mouse wheel over its title bar to adjust its opacity. Its **⬡** button pops it out into a separate OS window (popping out the same callsign twice refocuses the existing popup instead of opening a duplicate); its **×** button closes it.

## Mouse gestures

| Gesture | Effect |
|---|---|
| **Ctrl+Shift+Click** a contact | Opens **FRAG** for that contact's flight (coalition-restricted — you can only open your own side's packages unless you're GM/admin) |
| **Ctrl+Right-click** a contact | Toggle that flight's route line on the scope, without opening FRAG |
| **Shift+Click** | Remove BRAA pairs involving that contact |
| **Ctrl+Alt+Click** | Toggle a threat ring on that contact |
| **Ctrl+Click** | Start/complete a BRAA pair (first click arms a pending fighter, second click pairs it) |
| **Alt+Click** | Bogey-dope — auto-pair with nearest hostile/bogey air contact |
| **Middle-click** | Toggle a persistent highlight; for ground/naval units this pins their last known position on screen even after they drop out of visibility |
| **Right-click + drag** | Pan the scope |
| **Left-click + drag** | Draw a range/bearing line |
| **Digit 1–9, then click** | Set that contact's leader-line direction |
| **Double-click** a contact | Open a Focus window on it (see Focus windows above) |
| **Mouse wheel** | Zoom (1 NM/step inside 10 NM range, else 10 NM — 25 NM with Ctrl) |

**F1–F4** arm a pending declaration (Hostile/Bogey/Neutral/Friendly); the next click declares every contact within a small radius of the click point, so dense clusters aren't unreachable one-at-a-time.

FRAG also drives the scope indirectly: clicking a flight's Base or a route waypoint in FRAG drops a marker on the scope; clicking a roster row makes that contact's datablock blink.

## ATO drawer

A sortable table of every tasked flight: Flight name, Task, Type/Num, Callsign (resolved once live), **TASKUNIT** (airfield ICAO, carrier hull abbreviation, or "Air Start" — labeled "Base" in FRAG's own Tasking view, but shown as the TASKUNIT column here), Frequency, and Status (**RESERVE** / **ACTIVE** / **AIR** / **TAXI** / **GROUND** — the most-advanced state across all live-matched aircraft in the flight; RESERVE just means the flight hasn't spawned yet and clears the instant any of its aircraft appears).

Base/taskunit resolution: departure wins if the mission recorded one; air-start flights fall back to their recorded recovery/landing point if known.

Click a column header to sort (click again to reverse); click a row to select that flight and open it in FRAG. Coalition-restricted like everywhere else in ABM. Mouse wheel over the title bar zooms the panel (50–200%).

**Footer:**

| Button | Effect |
|---|---|
| **⬆ Load Mission** | Import flights from a mission file (see Mission Import below) |
| **+ Add Flight** | Manually add a flight (see Add Flight below) |
| **✕ Clear Mission** | Clears imported flights only |
| **✕ Clear ALL** | Confirm-gated, wipes manual flights too |

## FRAG drawer

Detail view for the flight selected in ATO or via Ctrl+Shift+Click on the scope.

- **Tasking** — editable Task field, full Base name, Status (same rollup as ATO). Click Base to drop a scope marker.
- **Roster** — one row per aircraft. For imported flights: callsign, type, live-resolved callsign, onboard number, skill, air/ground state, ordnance summary, a collapsible comms/radio list, and Link16 station if present. For manually-added flights: callsign, type, and state, live-matched against whoever's currently flying that callsign — there's no mission data behind them for ordnance/radios/Link16. A **+ Add Aircraft** field at the bottom of a manual flight's roster lets you type a callsign in directly, before that aircraft is even live — it shows as **PENDING** until a live match appears. A **×** on any manually-added row removes it (a live-matched row with nothing added to it has nothing to remove).
- **IFF** — Mode 1/2/3 fields under each roster row (imported and manual alike). This is the assigned code the correlation engine matches a live contact's transponder against (any of Mode 1/2/3/4 matching, plus a callsign check) to reveal its real callsign on the scope in place of the cycling code readout — see "Declaration" above for `.autodec iff`. Synced live to every ABM controller (the rest of FRAG isn't).
- **Route** — each waypoint's name, altitude, and speed; click one to drop a marker on the scope. Click the ROUTE header (yellow, green when active) to toggle the flight's route as a dashed line on the scope; Escape also clears it. Hidden by default each time a flight is (re)selected.

Mouse wheel over the title bar zooms the panel independently of ATO.

Unlike AIC, ABM has no BRAA-list side panel — BRAA pairs are drawn only as an on-scope dashed line with an inline bearing/range label.

**Ctrl+Shift+Click** on a friendly contact opens its FRAG flight, creating one if it doesn't exist yet (grouped by callsign, e.g. every "ENFIELD1x" aircraft together) and adding that exact aircraft to its roster if it isn't already there. Safe to repeat — an already-tracked aircraft just opens its existing flight, never duplicates it. New roster rows start with blank IFF fields.

## Mission Import

**⬆ Load Mission** in ATO's footer.

- Drop a `.miz` file or a raw mission text file, or click to browse.
- Blue/red sessions only ever see their own coalition's tasked flights — the other side's tasking is filtered out before you even see a preview, not just hidden after import.
- Preview shows a count-by-task summary and the list of flights found (with a RESERVE badge for late-activation flights). **Import** replaces the previously-imported set but keeps any manually-added flights.
- ABM's mission parsing deliberately reads only structural mission data (groups, units, routes, payloads, radios, Link16) — it never touches trigger scripts, trigger rules, or the mission's localization dictionary, so nothing an author scripted as a hidden narrative or timing surprise leaks through.
- **Dropping a `.csv` here instead** bulk-assigns IFF codes: a `callsign,mode1,mode2,mode3` header row, one row per aircraft. This is assign-only — it fills in Mode 1/2/3 on roster rows that already exist (from a prior mission import, or from Ctrl+Shift+Click/manual typing), matched by callsign, and never creates a new flight. A callsign with no matching roster row anywhere is skipped and reported, not silently dropped.

## Custom Drawing Import

**⬆ Load Drawing** in the Drawings panel, or drag a file directly onto the panel.

- Accepts `.geojson`, `.json`, `.ndgeojson`, `.ndjson` (multiple files at once — both single-document and newline-delimited GeoJSON are supported, and a few bad lines in an ndjson file won't sink the whole import), a `.zip` bundle (e.g. re-importing something previously exported from the Drawings panel — see below), and **`.miz` mission files** — pulling in DCS's own F10-map trigger-zone geometry and Drawing layers as importable custom layers. A `.miz` or zip import that contains multiple shapes/layers shows a per-row **Split** button to explode a group (e.g. a mission's whole trigger-zone table) into one layer per shape, preserving each shape's own DCS-authored color.
- Preview lets you rename each layer (defaults to the filename) before importing; a failed file shows its error inline without blocking the others.
- Each imported layer defaults to the current airspace palette's CUSTOM color (Drawings panel swatch to override per-layer). Polygon fill is gated by `.fill` (same toggle as airspace): a feature's own GeoJSON `fill`, or an overridden stroke color (source `stroke` or the swatch), fills with that color; an unstyled shape only fills if the palette's CUSTOM entry itself defines a `fill`.
- Feature labels come from the GeoJSON's `title`/`name` properties, gated by the same `.labels` toggle used for airspace names.
- Drawings are stored per-theatre locally and shared across your own open windows, but are **not** broadcast to other controllers — they're your own reference overlays.

### Drawings panel management

Beyond importing, the Drawings panel lets you manage every layer (imported or hand-drawn via the scope commands above):

| Item | Effect |
|---|---|
| Layer name | Click to rename it inline |
| Color swatch + **Override** checkbox | Pick a custom color, or leave it inheriting the airspace palette's CUSTOM color |
| "Always show label" checkbox | Per-layer, independent of the global `.labels` toggle |
| Grip handle | Drag to manually reorder the layer (draw/z-order) — only available while the list isn't otherwise sorted |
| Sortable columns (visibility / color / name+label) | Each has a third "off" sort state |
| Disclosure-arrow parameter editor | Command-drawn shapes only — rotation, radius, start/end bearing, leg length, turn radius/direction, text label, whichever fields apply to that shape type, for fine adjustment after drawing |
| **⬇ Export** | Bundles the panel's drawings into a zip you can re-import later (including into someone else's TRACS instance, since drawings aren't otherwise shared) |

## Add Flight (manual entry)

**+ Add Flight** in ATO's footer, for flights that don't come from a mission file.

Fields: Flight Name, Task, Type, Num (aircraft count), **Callsign Prefix** (required — flight name + flight number, e.g. `SHELL1`, no element digit), Base/Taskunit (dropdown of theatre airbases and live carriers), Frequency, and Coalition (GM/admin only — blue/red sessions get their own coalition automatically).

**Live-callsign matching:** the Callsign Prefix is how TRACS finds real aircraft for this flight, since a manual entry has no mission-file unit to match. DCS concatenates flight and element numbers with no separator (flight 1's aircraft are `SHELL11`/`SHELL12`), so the prefix must include the flight number but *not* the element digit — `SHELL1` matches both elements of flight 1 but won't also sweep in `SHELL21`. Manual flights have no route, ordnance, radio, or Link16 data — there's no mission file behind them to provide it.

## Keyboard shortcuts

| Key | Effect |
|---|---|
| `F1`–`F4` | Arm a pending declaration (Hostile/Bogey/Neutral/Friendly) |
| `Escape` | Clear pending state, in the priority order listed above |
| `Enter` | Run the buffered command |
| `ArrowUp`/`ArrowDown` | Cycle command history |
| `1`–`9`, then click | Set a contact's leader-line direction |
| `Ctrl+M` | Open Messages (app-wide, not ABM-specific) |

---

## Known limitations

- Manually-added flights (via Add Flight or Ctrl+Shift+Click) never get route, ordnance, radio, or Link16 data — only imported mission flights have that detail.
- Turning `.autodec`/`.autodec iff` off doesn't revert contacts already declared; only `.dec` (bare reset) does.
- Bogey-dope (`.dope` / Alt+click) only ever targets air contacts, even though BRAA pairs themselves can include ground/naval units.
- Pylon station numbers shown in FRAG are a best-effort index, not necessarily the true DCS station number, for aircraft with non-contiguous pylon tables.
