# ABM (Air Battle Manager)

Mission-wide package tracking: a radar scope with map/reference layers, an ATO summary of every tasked flight, a FRAG drawer for per-package detail, and custom drawing overlays.

## Command line

Type into the buffer, press **Enter**. A few commands (`.threat`, `.db`, `.dope`, `.rename`) work by typing without pressing Enter, then clicking a contact instead — noted below. `Escape` clears state in order: find marker → pending F-key declaration → pending BRAA fighter → open RBL → command buffer. `ArrowUp`/`ArrowDown` cycle your last 50 commands.

### Range rings

- `.rr` — toggle on/off
- `.rr <nm>` — set spacing (≤0 turns off)
- `.rr <nm> <anchor>` — set spacing and anchor to `bullseye`/`bs` or a named fix

### Map & reference layers (bare toggles unless noted)

`.time` (mission clock) · `.unitro` (cursor unit-proximity readout, on by default) · `.geo` (coastlines/boundaries) · `.relief` (terrain shading) · `.holds` · `.mora` · `.airways` (all) / `.airways v`/`j`/`b` (one class) · `.asp` (all airspace) or per-category: `.tma .ctr .cta .fir .uir .sua .mil .trsa .classa .classb .classc .classd .classe .classf .classg` · `.aspcolors <name>` (palette) · `.refresh` (reload palettes) · `.labels` (name labels for airspace *and* custom drawings) · `.fill` (toggle airspace polygon fill; `.fill <1-100>` sets transparency % and turns it on) · `.custom`/`.cust` (all custom drawing layers) or `.custom <name>`/`.cust <name>` (toggles just the drawing(s) with that name) · `.fixes` · `.navaids` · `.find <fix>` (drop a marker) · `.runways` · `.polygons` (airport polygons) · `.mgrs` (grid overlay) · `.towns` · `.base`/`.water`/`.roads` (terrain raster layers; `.map` toggles all three together)

Note: SID/STAR/approach procedures are deliberately display-only here — there's no `.proc`-style command in ABM.

### Cursor readout

`.coords` (toggle) · `.ddm` / `.dms` (coordinate format) · `.meters` / `.feet` (elevation units)

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
- `.clear` — clears RBL, all BRAA pairs, and all threat rings at once
- `.dope`, then click — bogey-dope the clicked contact to its nearest hostile/bogey air contact
- `.rename` / `.rename <newcallsign>`, then click — rename or reset a contact's callsign (synced to other controllers)

### Classification

- `.class` — reset all declarations to default
- `.class <old> <new>` — bulk reclassify, letters `f`/`n`/`b`/`h` (friendly/neutral/bogey/hostile), e.g. `.class b h`
- `.autoclass` — toggle auto-classification (true-coalition-based). Turning it **off** does not revert contacts it already classified — only a bare `.class` reset does that.
- `.autothreat` — auto-light threat rings on friendlies near hostiles/bogeys

### Ground/naval acquisition & engagement rings

`.acq` / `.eng` (all) or `.acq <f|n|b|h>` / `.eng <f|n|b|h>` (one class)

## Mouse gestures

| Gesture | Effect |
|---|---|
| **Ctrl+Shift+Click** a contact | Opens **FRAG** for that contact's flight (coalition-restricted — you can only open your own side's packages unless you're GM/admin) |
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

A sortable table of every tasked flight: Flight name, Task, Type/Num, Callsign (resolved once live), Base (airfield ICAO, carrier hull abbreviation, or "Air Start"), Frequency, and Status (**RESERVE** / **ACTIVE** / **AIR** / **TAXI** / **GROUND** — the most-advanced state across all live-matched aircraft in the flight; RESERVE just means the flight hasn't spawned yet and clears the instant any of its aircraft appears).

"Base" resolution: departure wins if the mission recorded one; air-start flights fall back to their recorded recovery/landing point if known.

Click a column header to sort (click again to reverse); click a row to select that flight and open it in FRAG. Coalition-restricted like everywhere else in ABM. Mouse wheel over the title bar zooms the panel (50–200%).

**Footer:** ⬆ Load Mission · + Add Flight · ✕ Clear Mission (imported flights only) · ✕ Clear ALL (confirm-gated, wipes manual flights too).

## FRAG drawer

Detail view for the flight selected in ATO or via Ctrl+Shift+Click on the scope.

- **Tasking** — editable Task field, full Base name, Status (same rollup as ATO). Click Base to drop a scope marker.
- **Roster** — one row per aircraft. For imported flights: callsign, type, live-resolved callsign, onboard number, skill, air/ground state, ordnance summary, a collapsible comms/radio list, and Link16 station if present. For manually-added flights: just callsign, type, and state — there's no mission data behind them for ordnance/radios/Link16.
- **Route** — each waypoint's name, altitude, and speed; click one to drop a marker on the scope. The route is also drawn on the scope itself as a dashed line while the flight is selected.

Mouse wheel over the title bar zooms the panel independently of ATO.

## Mission Import

**⬆ Load Mission** in ATO's footer.

- Drop a `.miz` file or a raw mission text file, or click to browse.
- Blue/red sessions only ever see their own coalition's tasked flights — the other side's tasking is filtered out before you even see a preview, not just hidden after import.
- Preview shows a count-by-task summary and the list of flights found (with a RESERVE badge for late-activation flights). **Import** replaces the previously-imported set but keeps any manually-added flights.
- ABM's mission parsing deliberately reads only structural mission data (groups, units, routes, payloads, radios, Link16) — it never touches trigger scripts, trigger rules, or the mission's localization dictionary, so nothing an author scripted as a hidden narrative or timing surprise leaks through.

## Custom Drawing Import (GeoJSON)

**⬆ Load Drawing** in the Drawings panel, or drag a file directly onto the panel.

- Accepts `.geojson`, `.json`, `.ndgeojson`, `.ndjson` — multiple files at once. Both single-document and newline-delimited GeoJSON are supported; a few bad lines in an ndjson file won't sink the whole import.
- Preview lets you rename each layer (defaults to the filename) before importing; a failed file shows its error inline without blocking the others.
- Each imported layer defaults to the current airspace palette's CUSTOM color (Drawings panel swatch to override per-layer); a feature is only filled if the source GeoJSON explicitly sets a fill — plain outlines are the default, since most hand-drawn boundaries are meant as boundaries, not shaded areas.
- Feature labels come from the GeoJSON's `title`/`name` properties, gated by the same `.labels` toggle used for airspace names.
- Drawings are stored per-theatre locally and shared across your own open windows, but are **not** broadcast to other controllers — they're your own reference overlays.

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

---

## Known limitations

- Manually-added flights (via Add Flight) never get route, ordnance, radio, or Link16 data — only imported mission flights have that detail.
- Turning `.autoclass` off doesn't revert contacts it already classified; only `.class` (bare reset) does.
- Bogey-dope (`.dope` / Alt+click) only ever targets air contacts, even though BRAA pairs themselves can include ground/naval units.
- Pylon station numbers shown in FRAG are a best-effort index, not necessarily the true DCS station number, for aircraft with non-contiguous pylon tables.
