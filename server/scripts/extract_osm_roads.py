#!/usr/bin/env python3
"""
Downloads Geofabrik .osm.pbf country extracts (cached locally) and filters
them down to the road/rail tag scope decided in abm-map-context-spec.md:
motorway/trunk/primary/secondary/tertiary highways + rail.

This replaces live Overpass API queries for roads/rail (see spec §5 item 5-6)
with a one-time bulk static-file download - gentler on shared infrastructure,
no rate limiting, no query timeouts.

Output: resources/osm-build/roads_rail_raw.json - a flat list of
  {coords: [[lon,lat], ...], class: "<highway tag>" | null, railway: bool, name}
covering all requested countries, unclipped. The Node build script
(buildRoadsWaterData.js) clips this per theatre bbox and writes the final
per-theatre mapcontext.json.

Raw country .pbf downloads and this combined output are cached in
resources/osm-build/ (gitignored, like the rest of resources/) rather than
server/data/ - this is exploratory build tooling, not committed source, and
the cache is keyed by country so it's naturally reused across theatres that
share territory (e.g. Israel-and-Palestine is needed by both Syria and
Sinai; Iraq likely by both Syria and a future Iraq theatre).

Usage:
    pip install osmium requests
    python server/scripts/extract_osm_roads.py

Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import os
import sys
import requests
import osmium

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OSM_DIR = os.path.join(SCRIPT_DIR, '..', '..', 'resources', 'osm-build')
OUTPUT_PATH = os.path.join(OSM_DIR, 'roads_rail_raw.json')

# Country extracts needed to cover the DCS Syria map's bbox (lon 28-42, lat
# 30-39 per theatres.json) - Geofabrik has no single combined "Middle East"
# file, so it's per-country.
EXTRACTS = [
    ('https://download.geofabrik.de/asia/syria-latest.osm.pbf', 'syria'),
    ('https://download.geofabrik.de/asia/lebanon-latest.osm.pbf', 'lebanon'),
    ('https://download.geofabrik.de/asia/jordan-latest.osm.pbf', 'jordan'),
    ('https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf', 'israel-and-palestine'),
    ('https://download.geofabrik.de/asia/iraq-latest.osm.pbf', 'iraq'),
    ('https://download.geofabrik.de/europe/turkey-latest.osm.pbf', 'turkey'),
    ('https://download.geofabrik.de/europe/cyprus-latest.osm.pbf', 'cyprus'),
]

ROAD_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}


def download(url, dest):
    if os.path.exists(dest):
        size_mb = os.path.getsize(dest) / 1024 / 1024
        print(f'  {os.path.basename(dest)}: using cached copy ({size_mb:.1f} MB)')
        return
    print(f'  {os.path.basename(dest)}: downloading...', end='', flush=True)
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        tmp = dest + '.part'
        with open(tmp, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
        os.rename(tmp, dest)
    size_mb = os.path.getsize(dest) / 1024 / 1024
    print(f' done ({size_mb:.1f} MB)')


class RoadRailHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.factory = osmium.geom.GeoJSONFactory()
        self.features = []

    def way(self, w):
        highway = w.tags.get('highway')
        railway = w.tags.get('railway')
        is_road = highway in ROAD_CLASSES
        is_rail = railway == 'rail'
        if not is_road and not is_rail:
            return
        try:
            geojson = self.factory.create_linestring(w)
        except RuntimeError:
            return  # incomplete way (missing node refs) - skip
        geom = json.loads(geojson)
        coords = geom.get('coordinates', [])
        if len(coords) < 2:
            return
        self.features.append({
            'coords': coords,
            'class': highway if is_road else None,
            'railway': is_rail,
            'name': w.tags.get('name'),
        })


def main():
    os.makedirs(OSM_DIR, exist_ok=True)
    print('Downloading Geofabrik extracts:')
    all_features = []
    for url, key in EXTRACTS:
        dest = os.path.join(OSM_DIR, f'{key}-latest.osm.pbf')
        try:
            download(url, dest)
        except Exception as e:
            print(f'\n  {key}: FAILED to download ({e}) - skipping')
            continue

        print(f'  {key}: filtering roads/rail...', end='', flush=True)
        handler = RoadRailHandler()
        handler.apply_file(dest, locations=True)
        print(f' {len(handler.features)} features')
        all_features.extend(handler.features)

    with open(OUTPUT_PATH, 'w') as f:
        json.dump({'features': all_features}, f)
    size_mb = os.path.getsize(OUTPUT_PATH) / 1024 / 1024
    print(f'\nWrote {len(all_features)} total features to {OUTPUT_PATH} ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
