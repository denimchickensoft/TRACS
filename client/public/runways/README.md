# Runway JSON Files

These files are extracted directly from the DCS World game engine via a custom extraction script.
All geometry (endpoints, headings, lengths, elevations) reflects Eagle Dynamics' source data.

## Runway designator corrections

The geometry is correct. DCS's runway designators (`name`) are often wrong, and the errors come from DCS itself: `Airbase:getRunways()` returns them that way.

### The DCS bug

DCS appears to build `Name` from a flattened list of runway ends, `[r0.endA, r0.endB, r1.endA, r1.endB, ...]`, but indexes that list by runway number instead of by twice the runway number. As a result:

- Runway 0 always gets a correct designator.
- Every later runway `i` gets one of the end designators of runway `floor(i/2)`. For example, Muwaffaq Salti exports `[26, 8]` for a 08/26 strip and a 13/31 strip.

The bug is only visible at airbases whose runways point in different directions. For single-runway and parallel-only airbases, every end they could be handed lies on the same axis, so the names come out right.

DCS also occasionally exports a wrong runway 0, for example Gelendzhik `1` on a 04/22 strip.

### The fix

`npm run fix:runways --workspace=server` (`server/scripts/fixRunwayNames.js`) rewrites `name` in place. Re-run it after every fresh DCS export. Running it on already-corrected files changes nothing.

**Runway 1 and later.** A runway is renamed when all of these hold:
- its name is not on its own axis
- its name is on the axis of runway `floor(i/2)`
- the two runways point in different directions

The new designator is computed from the runway's own geometry plus runway 0's offset (designator minus true axis). That offset carries the airbase's magnetic variation, and whatever era DCS numbered it for.

**Runway 0.** Each theatre gets an era year fitted from its own runway 0s:
1. For each year from 1900 to 2030, count the runway 0s that fall within 5° of (true axis minus IGRF magnetic variation for that year).
2. Take the middle of the years tied for the best count.
3. Exclude runway 0s more than 20° off at that year, and refit until the year settles.

Any runway 0 still more than 20° off is renamed from its true axis minus the magnetic variation at the era year.

**Recording changes.** Renamed runways keep DCS's original value in `name_dcs`. The script prints each change and the era year for each theatre.

L/R/C suffixes for parallel runways are not stored here. The client derives them from the perpendicular offset between parallel strips.

### Earlier hand corrections

These were made before the script existed and have no `name_dcs`. They are the same DCS bug, and the script leaves them unchanged:

- **Syria Ben Gurion:** 03/21 was exported as `30` and 08/26 as `21`.
- **Syria Hatzor:** one 11/29 strip was exported as `5`.
- **SinaiMap Hatzor:** one 11/29 strip was exported as `23`.
