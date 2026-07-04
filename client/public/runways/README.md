# Runway JSON Files

These files are extracted directly from the DCS World game engine via a custom extraction script.
All geometry (endpoints, headings, lengths, elevations) reflects Eagle Dynamics' source data.
There are various errors in each of the theatres.
This file is utilized to track that data.

## Manual Corrections

Occasionally DCS exports contain incorrect runway designator (`name`) fields.
The geometry is correct; only the runway number labels are wrong.
These are Eagle Dynamics bugs, corrected here manually.

| File | Airbase | Runway | Issue | Corrected `name` |
|------|---------|--------|-------|-----------------|
| Syria.json | Ben Gurion | heading ~207° (03/21) | exported as `30` | `21` |
| Syria.json | Ben Gurion | heading ~258° (08/26) | exported as `21` | `26` |
| SinaiMap.json | Hatzor | heading ~112°/292° (11/29, parallel pair) | one entry exported as `23` | `11` |
| Syria.json | Hatzor | heading ~112°/292° (11/29, parallel pair) | one entry exported as `5` | `29` |

### Notes on the Ben Gurion correction (Syria)

Ben Gurion (LLBG) has three runways: 03/21, 08/26, and 12/30.
DCS exported the 03/21 runway with `name: 30` and the 08/26 runway with `name: 21`.
The 12/30 runway (`name: 12`) was correct.
Headings were verified by computing magnetic bearing from `course_true_deg` using
Syria's TM central meridian (39°E) and WMM magvar for the region.

### Notes on the Hatzor correction (SinaiMap and Syria)

Hatzor (LLHS) has three runways: 11L/29R, 11R/29L, and 5/23.
Each theatre file exports one of the parallel 11/29 strips under the wrong designator:
- SinaiMap.json exported one 11/29 strip as `23` (the true 5/23 strip is the separate entry already named `5`).
- Syria.json exported one 11/29 strip as `5` (the true 5/23 strip is the separate entry already named `23`).

In both files the geometry and `course_true_deg` for the mislabeled entry are correct — only
the `name` integer was wrong. Verified by computing the true bearing from each entry's `end1`/`end2`
coordinates (great-circle initial bearing) and confirming it matches `-course_true_deg`, then
checking which of the airbase's two physical headings (~054°/234° for 5/23 vs ~112°/292° for
11/29) that bearing actually falls on. The parallel 11/29 pair is auto-suffixed L/R by
`computeAirbaseLabels`/the suffix grouping in `runways.js` based on perpendicular offset, so
both mislabeled entries just needed their `name` changed to a valid designator for their true
heading (`11`, since `29` was already taken by the other correctly-labeled parallel entry).
