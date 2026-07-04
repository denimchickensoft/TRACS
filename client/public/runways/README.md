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

### Notes on the Ben Gurion correction (Syria)

Ben Gurion (LLBG) has three runways: 03/21, 08/26, and 12/30.
DCS exported the 03/21 runway with `name: 30` and the 08/26 runway with `name: 21`.
The 12/30 runway (`name: 12`) was correct.
Headings were verified by computing magnetic bearing from `course_true_deg` using
Syria's TM central meridian (39°E) and WMM magvar for the region.
