# Third-Party Notices

TRACS is Copyright (C) 2026 denimchickensoft and is free software licensed under the GNU General Public License v3.0 or later (see [LICENSE](LICENSE)), with ABSOLUTELY NO WARRANTY. Source: <https://github.com/denimchickensoft/TRACS>. It includes, or was built from, the third-party data and software listed below. Each item keeps its own license.

TRACS is an independent community project. It is not affiliated with or endorsed by Eagle Dynamics SA, the DCS Olympus team, Tacview (Raia Software), the DCS-SRS or LotATC developers, LittleNavMap, Navigraph, the FAA, or any other organization or product it mentions. DCS World and all other trademarks belong to their respective owners, and TRACS uses them only to describe compatibility.

## Map data

### OpenStreetMap

Map data © OpenStreetMap contributors, available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). See <https://www.openstreetmap.org/copyright>.

The following databases are derived from OpenStreetMap data and are made available under the ODbL:
- Roads and railways: `server/navdata/cache/<theatre>/roads.json` and `roads.png`. They were built from [Geofabrik](https://download.geofabrik.de/) country extracts.
- Taxiway labels: `server/navdata/cache/<theatre>/airports_taxiway_labels.json`. They were built from [Geofabrik](https://download.geofabrik.de/) extracts and hold only label positions and taxiway designators.
- Coastlines in `server/navdata/cache/<theatre>/geo.json`, and the land/sea raster `basemap.png`. They were built from the land polygons published at [osmdata.openstreetmap.de](https://osmdata.openstreetmap.de/).

### Natural Earth

Made with Natural Earth. Free vector and raster map data @ [naturalearthdata.com](https://www.naturalearthdata.com/). The data is in the public domain. It's used for boundaries and land in `geo.json`, and for water in `water.json` and `water.png`.

## Terrain data

Elevation data (`server/data/elevation.db`, and the relief, terrain and MVA layers derived from it) comes from the Terrain Tiles dataset hosted on AWS (`elevation-tiles-prod`), originally produced by Mapzen's Joerd project. It requires the following attribution:

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736;
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
- Canada terrain data contains information licensed under the Open Government Licence – Canada;
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers;
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;
- Mexico terrain data source: INEGI, Continental relief, 2016;
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved);
- Norway terrain data © Kartverket;
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved;
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.

## DCS World data

The following files were extracted from DCS World game files or from the running game, and reflect Eagle Dynamics SA's source data. DCS World is © Eagle Dynamics SA. TRACS includes this data only to interoperate with DCS World, and will remove it at Eagle Dynamics' request.
- `client/public/runways/*.json`: runway geometry.
- `client/public/towns/*.json`: town labels.
- `server/navdata/cache/<theatre>/airports_polygons.json`: airport surface geometry.
- `client/public/units/aircraftSensorDatabase.json` and `weaponSensorDatabase.json`: sensor and weapon values, extracted with the help of [Quaggles' dcs-lua-datamine](https://github.com/Quaggles/dcs-lua-datamine).

## DCS Olympus

[DCS Olympus](https://github.com/Pax1601/DCSOlympus) is Copyright (C) 2023 Veltro & Gang (the "DCS Olympus Team"). It is licensed under the GNU General Public License v3, with additional terms covering governing law, entire agreement and modification of terms (see its [LEGAL.txt](https://github.com/Pax1601/DCSOlympus/blob/HEAD/LEGAL.txt)). The following files come from DCS Olympus:
- `client/public/units/aircraftdatabase.json`, `helicopterdatabase.json`, `groundunitdatabase.json`, `navyunitdatabase.json` and `mods.json`: unit databases.
- `client/public/carriers/*.png`: carrier deck images.

## pydcs

Airdrome IDs in `client/public/airdromes/*.json` were generated with [pydcs](https://github.com/pydcs/dcs), which is licensed under the GNU Lesser General Public License v3.0.

## Brevity glossary

`client/public/brevity.json` is transcribed from *Multi-Service Tactics, Techniques, and Procedures for Multi-Service Brevity Codes* (ATP 1-02.1, April 2025), a U.S. Government publication approved for public release with unlimited distribution.

## Fonts

TRACS bundles the **Roboto Mono** typeface, Copyright 2015 The Roboto Mono Project Authors (https://github.com/googlefonts/robotomono), via the `@fontsource/roboto-mono` package. It is licensed under the SIL Open Font License, Version 1.1 (https://openfontlicense.org).

## Software dependencies

The TRACS desktop app bundles open-source npm packages and the Electron runtime. Each package's license file is included in its folder under `node_modules`, and Electron ships its own Chromium license notices (`LICENSES.chromium.html`). The TRACS Relay bundles the Node.js runtime (MIT license) and the `ws` package (MIT license).

### DCS exporter

The exporter DLL (`tracs_exporter.dll`, built into the Windows TRACS Relay and installed into DCS by it) is compiled with the following, both under the MIT license:

- **cJSON 1.7.18** (`relay/native/cjson-1.7.18/`): Copyright (c) 2009-2017 Dave Gamble and cJSON contributors.
- **Lua 5.1.5** (`relay/native/lua-5.1.5/`): Copyright (C) 1994-2012 Lua.org, PUC-Rio. The DLL is compiled against its headers. The rest of its source is in the repository only to build a test copy of Lua; it isn't part of the DLL or the relay.

Both are distributed under this license text:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
