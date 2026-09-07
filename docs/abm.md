# ABM (Air Battle Manager)

Mission-wide package tracking: a radar scope with map/reference layers, an ATO summary of every tasked flight, a FRAG drawer for per-package detail, and custom drawing overlays.

Sign-in requires a Callsign and Frequency, same as AIC — see [Getting Started](getting-started.md). ABM does not yet use SRS transponder data on its datablocks (unlike ATC's association/IDENT/Beaconator features) — that's planned but not yet built.

## Command line

Type into the buffer, press **Enter**. A number of commands (`.threat`, `.db`, `.dope`, `.rename`, `.be`, `.frag`, `.route`, and the free-hand drawing commands below) work by typing without pressing Enter, then clicking the map instead — noted below. `Escape` clears state in this priority order: a pending drawing-clear click → a pending "clear all drawings" confirm → a pending free-hand drawing in progress → find marker → a flight's route line (toggled via `.route`/FRAG) → pending F-key declaration → pending BRAA fighter → open RBL → brevity definition readout → command buffer. `ArrowUp`/`ArrowDown` cycle your last 50 commands.

### Bullseye

- `.be` — bare, Enter with no click: reset to the mission bullseye (clears any override)
- `.be` typed then click the map: place an override bullseye at that point
- `.be <fix>` — override to a named fix/navaid/runway
- `.be <lat> <lon>` — override to explicit decimal-degree coordinates

### Range rings

- `.rr` — toggle on/off
- `.rr <nm>` — set spacing (≤0 turns off)
- `.rr <nm> <anchor>` — set spacing and anchor to `bullseye`/`bs` or a named fix

### Map & reference layers (bare toggles unless noted)

`.time` (mission clock) · `.unitro` (cursor unit-proximity readout, on by default) · `.geo` (coastlines/boundaries) · `.relief` (terrain shading) · `.holds` · `.mora` · `.airways` (all) / `.airways v`/`j`/`b` (one class) · `.asp` (all airspace) or per-category: `.tma .ctr .cta .fir .uir .sua .mil .trsa .classa .classb .classc .classd .classe .classf .classg` · `.aspcolors <name>` (palette) · `.refresh` (reload palettes) · `.labels` (name labels for airspace *and* custom drawings) · `.fill` (toggle polygon fill for airspace *and* custom drawings; `.fill <1-100>` sets transparency % and turns it on) · `.custom`/`.cust` (all custom drawing layers) or `.custom <name>`/`.cust <name>` (toggles just the drawing(s) with that name) · `.fixes` · `.fix <name...>` (force-show one or more fixes regardless of `.fixes`; each name toggles independently) · `.navaids` · `.find <fix>` (drop a marker) · `.runways` · `.polygons` (airport polygons) · `.mgrs` (theatre-aware UTM/MGRS grid — see below) · `.towns` · `.base`/`.terrain`/`.water`/`.roads` (terrain raster layers; `.map` toggles all four together)

**MGRS grid detail**: `.mgrs` isn't a flat overlay — it auto-detects how many real UTM zones the current view actually spans and draws a correct zone-boundary seam, with reprojected 100 km grid-square labels on each side of the seam, a grid-zone designator (e.g. "38S"), and finer 1 km/10 km subdivision lines as you zoom in.

Note: SID/STAR/approach procedures are deliberately display-only here — there's no `.proc`-style command in ABM.

### Brevity glossary

`.define <term>` (or the shorter `.def <term>`) — look up a tactical brevity term (ATP 1-02.1, April 2025) and show its full definition in a dedicated readout above the command line. Multi-word terms work as typed, e.g. `.define bogey dope`. The readout stays up until you dismiss it (Escape, another `.define`, or clicking it) rather than disappearing on the next command ack.

### Cursor readout

`.coords` (toggle) · `.ddm` / `.dms` (coordinate format) · `.meters` / `.feet` (elevation units) · `.bec` (bullseye-on-cursor — bearing/range readout that follows the mouse)

### Contacts

- `.ptl <0-5>` — predicted track line minutes
- `.faded <seconds>` — coast/fade duration
- `.history` — toggle trails; `.history <len>` — set length (0=off, max 10); `.history <len> <rate>` — length + capture rate
- `.db` — toggle global datablock visibility; typed (no Enter) + click a contact toggles just that one
- `.dbreset` — clear all per-contact `.db` overrides
- `.dbca` — datablock collision-avoidance placement (off by default)
- `.dbs` — formation datablock suppression: only the flight lead's datablock shows when 2+ same-flight aircraft are within 3 NM (on by default)
- `.ldr <length 0-7> <dir 1-9>` — leader line length/direction

### BRAA, bogey dope, threat rings

- `.threat` (Enter) — clear all rings; `.threat <nm>` (Enter) — set default radius
- `.threat` / `.threat <nm>`, then click a contact — toggle that contact's ring (optionally set radius)
- `.tclear` — clears RBL, all BRAA pairs, and all threat rings at once (renamed from `.clear` — that name is now used by the drawing-clear command below, `.dclear`)
- `.dope`, then click — bogey-dope the clicked contact to its nearest hostile/bogey air contact
- `.rename` / `.rename <newcallsign>`, then click — rename or reset a contact's callsign (synced to other controllers)

### Classification

- `.class` — reset all declarations to default
- `.class <old> <new>` — bulk reclassify, letters `f`/`n`/`b`/`h` (friendly/neutral/bogey/hostile), e.g. `.class b h`
- `.autoclass` — toggle auto-classification (true-coalition-based). Turning it **off** does not revert contacts it already classified — only a bare `.class` reset does that.
- `.autothreat` — auto-light threat rings on friendlies near hostiles/bogeys

### Ground/naval acquisition & engagement rings

`.acq` / `.eng` (all) or `.acq <f|n|b|h>` / `.eng <f|n|b|h>` (one class)

### Free-hand scope drawing

Draw directly on the scope by typing a command and clicking, the same type-then-click pattern as `.threat`/`.dope`/`.rename`/`.be`:

- `.line`, `.rect`, `.circ` — line, rectangle, circle.
- `.poly` — polygon; keep clicking to add vertices, `Escape` or re-typing the command finishes it.
- `.sect <id> <brg1>...<brgN> <radius>` — a sector (or multiple sectors sharing one id) defined by a list of bearings and a radius.
- `.race` — a racetrack shape.
- `.text` — a text label.

While a shape is pending, magnetic-heading snapping and whole-NM distance snapping apply automatically, and the scroll wheel rotates the shape before you commit it with a click.

Clearing: `.dclear` (bare, then click a drawing) removes one shape; `.dclear all` removes every hand-drawn shape (confirm-gated — you'll be asked to type `y`/`n`); `.dclear <name>` removes by name.

All hand-drawn shapes show up in the Drawings panel alongside imported layers — see Drawings panel management below.

### Callsign/route lookup by name

Alternatives to clicking a contact directly, useful when you know the callsign but the contact is hard to click precisely:

- `.where <callsign>` — drop a marker on that contact.
- `.frag <callsign>` — open FRAG for that contact's flight.
- `.route <callsign>` — toggle that flight's route line on the scope.

All three accept a partial/prefix match and will tell you if it's ambiguous between multiple live callsigns. `.rclear` clears every currently-shown route line at once (both ones toggled via `.route`/FRAG's own ROUTE header).

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
| **Mouse wheel** | Zoom (1 NM/step inside 10 NM range, else 10 NM — 25 NM with Ctrl) |

**F1–F4** arm a pending declaration (Hostile/Bogey/Neutral/Friendly); the next click classifies every contact within a small radius of the click point, so dense clusters aren't unreachable one-at-a-time.

FRAG also drives the scope indirectly: clicking a flight's Base or a route waypoint in FRAG drops a marker on the scope; clicking a roster row makes that contact's datablock blink.

## ATO drawer

A sortable table of every tasked flight: Flight name, Task, Type/Num, Callsign (resolved once live), **TASKUNIT** (airfield ICAO, carrier hull abbreviation, or "Air Start" — labeled "Base" in FRAG's own Tasking view, but shown as the TASKUNIT column here), Frequency, and Status (**RESERVE** / **ACTIVE** / **AIR** / **TAXI** / **GROUND** — the most-advanced state across all live-matched aircraft in the flight; RESERVE just means the flight hasn't spawned yet and clears the instant any of its aircraft appears).

Base/taskunit resolution: departure wins if the mission recorded one; air-start flights fall back to their recorded recovery/landing point if known.

Click a column header to sort (click again to reverse); click a row to select that flight and open it in FRAG. Coalition-restricted like everywhere else in ABM. Mouse wheel over the title bar zooms the panel (50–200%).

**Footer:** ⬆ Load Mission · + Add Flight · ✕ Clear Mission (imported flights only) · ✕ Clear ALL (confirm-gated, wipes manual flights too).

## FRAG drawer

Detail view for the flight selected in ATO or via Ctrl+Shift+Click on the scope.

- **Tasking** — editable Task field, full Base name, Status (same rollup as ATO). Click Base to drop a scope marker.
- **Roster** — one row per aircraft. For imported flights: callsign, type, live-resolved callsign, onboard number, skill, air/ground state, ordnance summary, a collapsible comms/radio list, and Link16 station if present. For manually-added flights: just callsign, type, and state — there's no mission data behind them for ordnance/radios/Link16.
- **Route** — each waypoint's name, altitude, and speed; click one to drop a marker on the scope. Click the ROUTE header (yellow, green when active) to toggle the flight's route as a dashed line on the scope; Escape also clears it. Hidden by default each time a flight is (re)selected.

Mouse wheel over the title bar zooms the panel independently of ATO.

Unlike AIC, ABM has no BRAA-list side panel — BRAA pairs are drawn only as an on-scope dashed line with an inline bearing/range label.

## Mission Import

**⬆ Load Mission** in ATO's footer.

- Drop a `.miz` file or a raw mission text file, or click to browse.
- Blue/red sessions only ever see their own coalition's tasked flights — the other side's tasking is filtered out before you even see a preview, not just hidden after import.
- Preview shows a count-by-task summary and the list of flights found (with a RESERVE badge for late-activation flights). **Import** replaces the previously-imported set but keeps any manually-added flights.
- ABM's mission parsing deliberately reads only structural mission data (groups, units, routes, payloads, radios, Link16) — it never touches trigger scripts, trigger rules, or the mission's localization dictionary, so nothing an author scripted as a hidden narrative or timing surprise leaks through.

## Custom Drawing Import

**⬆ Load Drawing** in the Drawings panel, or drag a file directly onto the panel.

- Accepts `.geojson`, `.json`, `.ndgeojson`, `.ndjson` (multiple files at once — both single-document and newline-delimited GeoJSON are supported, and a few bad lines in an ndjson file won't sink the whole import), a `.zip` bundle (e.g. re-importing something previously exported from the Drawings panel — see below), and **`.miz` mission files** — pulling in DCS's own F10-map trigger-zone geometry and Drawing layers as importable custom layers. A `.miz` or zip import that contains multiple shapes/layers shows a per-row **Split** button to explode a group (e.g. a mission's whole trigger-zone table) into one layer per shape, preserving each shape's own DCS-authored color.
- Preview lets you rename each layer (defaults to the filename) before importing; a failed file shows its error inline without blocking the others.
- Each imported layer defaults to the current airspace palette's CUSTOM color (Drawings panel swatch to override per-layer). Polygon fill is gated by `.fill` (same toggle as airspace): a feature's own GeoJSON `fill`, or an overridden stroke color (source `stroke` or the swatch), fills with that color; an unstyled shape only fills if the palette's CUSTOM entry itself defines a `fill`.
- Feature labels come from the GeoJSON's `title`/`name` properties, gated by the same `.labels` toggle used for airspace names.
- Drawings are stored per-theatre locally and shared across your own open windows, but are **not** broadcast to other controllers — they're your own reference overlays.

### Drawings panel management

Beyond importing, the Drawings panel lets you manage every layer (imported or hand-drawn via the scope commands above):

- Click a layer's name to rename it inline.
- A per-layer color swatch with an **Override** checkbox — pick a custom color, or leave it inheriting the airspace palette's CUSTOM color.
- A per-layer "always show label" checkbox, independent of the global `.labels` toggle.
- Drag a layer's grip handle to manually reorder it (draw/z-order) — only available while the list isn't otherwise sorted.
- Three sortable columns (visibility / color / name+label), each with a third "off" sort state.
- Command-drawn shapes get a disclosure-arrow parameter editor (rotation, radius, start/end bearing, leg length, turn radius/direction, text label — whichever fields apply to that shape type) for fine adjustment after drawing.
- **⬇ Export** bundles the panel's drawings into a zip you can re-import later (including into someone else's TRACS instance, since drawings aren't otherwise shared).

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

- Manually-added flights (via Add Flight) never get route, ordnance, radio, or Link16 data — only imported mission flights have that detail.
- Turning `.autoclass` off doesn't revert contacts it already classified; only `.class` (bare reset) does.
- Bogey-dope (`.dope` / Alt+click) only ever targets air contacts, even though BRAA pairs themselves can include ground/naval units.
- Pylon station numbers shown in FRAG are a best-effort index, not necessarily the true DCS station number, for aircraft with non-contiguous pylon tables.
