#!/usr/bin/env python3
"""
Downloads Geofabrik .osm.pbf country extracts (cached locally) and filters
them down to the road/rail tag scope decided in abm-map-context-spec.md:
motorway/trunk/primary/secondary/tertiary highways + rail.

This replaces live Overpass API queries for roads/rail (see spec §5 item 5-6)
with a one-time bulk static-file download - gentler on shared infrastructure,
no rate limiting, no query timeouts.

Output: resources/osm-build/roads_rail_raw/<country>.json - one file per
country, each a flat list of
  {coords: [[lon,lat], ...], class: "<highway tag>" | null, railway: bool, name}
unclipped. The Node build script (buildRoadsWaterData.js) reads every file
in that directory, clips per theatre bbox, and writes the final per-theatre
mapcontext.json. Per-country (not one combined file) so re-running this
script only re-filters newly-added countries, and so the total never hits
Node's V8 max string length once enough countries pile up (a single combined
file did, at 568MB/977K features - see 2026-07-29 fix).

Raw country .pbf downloads and the per-country filtered output are cached in
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
import time
import requests
import osmium

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OSM_DIR = os.path.join(SCRIPT_DIR, '..', '..', 'resources', 'osm-build')
# One raw-features file per country (not one combined blob) - a combined
# file across enough theatres' countries eventually exceeds Node's V8 max
# string length (~536MB) when buildRoadsWaterData.js reads it back as a
# single JSON string (hit this at 568MB / ~1M features, PersianGulf).
# Per-country files also mean re-running this script only re-filters
# countries that aren't already cached, instead of re-filtering every
# previously-added country (incl. Turkey's 600MB+ extract) on every run.
RAW_DIR = os.path.join(OSM_DIR, 'roads_rail_raw')

# Country/region extracts needed to cover each ABM theatre's bbox. Geofabrik
# has no single combined regional file, so it's per-country (or, for huge
# countries like Russia/USA, per-subregion - see the Caucasus/Kola/Nevada
# entries below, which deliberately use Geofabrik's federal-district/state
# splits rather than the full-country extract to avoid multi-GB downloads
# for a small border sliver).
#
# Grouped by which theatre first needed each entry; a later theatre reusing
# an earlier one's country costs nothing extra (download() skips anything
# already on disk).
EXTRACTS = [
    # Syria
    ('https://download.geofabrik.de/asia/syria-latest.osm.pbf', 'syria'),
    ('https://download.geofabrik.de/asia/lebanon-latest.osm.pbf', 'lebanon'),
    ('https://download.geofabrik.de/asia/jordan-latest.osm.pbf', 'jordan'),
    ('https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf', 'israel-and-palestine'),
    ('https://download.geofabrik.de/asia/iraq-latest.osm.pbf', 'iraq'),
    ('https://download.geofabrik.de/europe/turkey-latest.osm.pbf', 'turkey'),
    ('https://download.geofabrik.de/europe/cyprus-latest.osm.pbf', 'cyprus'),
    # Sinai (reuses israel-and-palestine + jordan above)
    ('https://download.geofabrik.de/africa/egypt-latest.osm.pbf', 'egypt'),
    # PersianGulf - Geofabrik's "gcc-states" extract covers all six Gulf
    # Cooperation Council members (Bahrain, Kuwait, Oman, Qatar, Saudi
    # Arabia, UAE) in one file - Saudi Arabia has no separate extract.
    ('https://download.geofabrik.de/asia/iran-latest.osm.pbf', 'iran'),
    ('https://download.geofabrik.de/asia/gcc-states-latest.osm.pbf', 'gcc-states'),
    # Nevada - US state-level extracts (not the full-country one, which is
    # much larger than needed for a bbox spanning only these four states'
    # borders).
    ('https://download.geofabrik.de/north-america/us/california-latest.osm.pbf', 'us-california'),
    ('https://download.geofabrik.de/north-america/us/nevada-latest.osm.pbf', 'us-nevada'),
    ('https://download.geofabrik.de/north-america/us/arizona-latest.osm.pbf', 'us-arizona'),
    ('https://download.geofabrik.de/north-america/us/utah-latest.osm.pbf', 'us-utah'),
    # Caucasus - Georgia/Armenia/Azerbaijan are small standalone extracts.
    # The Russia sliver needs TWO federal-district sub-regions, not one -
    # North Caucasus fed. district covers Dagestan/Chechnya/Stavropol etc,
    # but the Krasnodar Krai/Black Sea coast lowland north of the mountains
    # (Sochi area) is in the separate South federal district. Both together
    # are still far smaller than all of Russia (multiple GB).
    ('https://download.geofabrik.de/europe/georgia-latest.osm.pbf', 'georgia'),
    ('https://download.geofabrik.de/asia/armenia-latest.osm.pbf', 'armenia'),
    ('https://download.geofabrik.de/asia/azerbaijan-latest.osm.pbf', 'azerbaijan'),
    ('https://download.geofabrik.de/russia/north-caucasus-fed-district-latest.osm.pbf', 'russia-north-caucasus'),
    ('https://download.geofabrik.de/russia/south-fed-district-latest.osm.pbf', 'russia-south'),
    # Kola - Norway/Finland have no finer Geofabrik sub-split (full country
    # is the smallest unit for both). Murmansk Oblast/Kola Peninsula is
    # administratively part of Russia's Northwestern federal district -
    # unlike Caucasus, no neighboring district borders this far north.
    ('https://download.geofabrik.de/europe/norway-latest.osm.pbf', 'norway'),
    ('https://download.geofabrik.de/europe/finland-latest.osm.pbf', 'finland'),
    ('https://download.geofabrik.de/russia/northwestern-fed-district-latest.osm.pbf', 'russia-northwestern'),
    # SouthAtlantic - real airbases (Punta Arenas, Puerto Natales, Porvenir)
    # sit in Chile, not just Argentina - both are full-country-only extracts
    # on Geofabrik (no provincial split), but small enough (406MB + 329MB)
    # that it doesn't matter.
    ('https://download.geofabrik.de/south-america/argentina-latest.osm.pbf', 'argentina'),
    ('https://download.geofabrik.de/south-america/chile-latest.osm.pbf', 'chile'),
    # Germany - bbox [6,46,20,56] genuinely spans Germany + Poland + Czech
    # Republic + Austria + Switzerland + Denmark (confirmed via runway audit:
    # 0 out-of-bbox, so this bbox itself is fine, just wide). ~9GB total,
    # confirmed acceptable.
    ('https://download.geofabrik.de/europe/germany-latest.osm.pbf', 'germany'),
    ('https://download.geofabrik.de/europe/poland-latest.osm.pbf', 'poland'),
    ('https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf', 'czech-republic'),
    ('https://download.geofabrik.de/europe/austria-latest.osm.pbf', 'austria'),
    ('https://download.geofabrik.de/europe/switzerland-latest.osm.pbf', 'switzerland'),
    ('https://download.geofabrik.de/europe/denmark-latest.osm.pbf', 'denmark'),
    # Germany bbox also reaches southern Sweden (Malmo/ESMS area, across the
    # Oresund from Denmark) - missed on the first pass since water (Natural
    # Earth, bbox-only clipped) covered it but roads (Geofabrik, per-country)
    # didn't.
    ('https://download.geofabrik.de/europe/sweden-latest.osm.pbf', 'sweden'),
    # MarianaIslands - initially skipped as "low payoff" without actually
    # checking; Geofabrik's american-oceania extract covers Guam/CNMI at
    # only 5.1MB, effectively free.
    ('https://download.geofabrik.de/australia-oceania/american-oceania-latest.osm.pbf', 'american-oceania'),
]

ROAD_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}


DOWNLOAD_DELAY_S = 3   # courtesy pause between files - one sequential
                       # connection already, but this is a lot of country
                       # extracts to pull from a shared static host
MAX_RETRIES = 4

def download(url, dest):
    if os.path.exists(dest):
        size_mb = os.path.getsize(dest) / 1024 / 1024
        print(f'  {os.path.basename(dest)}: using cached copy ({size_mb:.1f} MB)')
        return

    for attempt in range(1, MAX_RETRIES + 1):
        print(f'  {os.path.basename(dest)}: downloading...', end='', flush=True)
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                if r.status_code == 429 or r.status_code == 503:
                    wait = int(r.headers.get('Retry-After', 30 * attempt))
                    print(f' rate-limited (HTTP {r.status_code}), waiting {wait}s (attempt {attempt}/{MAX_RETRIES})...')
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                # Geofabrik serves its "not found" page with HTTP 200 (not
                # 404), so raise_for_status() alone doesn't catch a bad URL
                # slug - it just silently downloads an HTML error page as if
                # it were the .pbf (bit us on a guessed Saudi Arabia URL).
                # PBF files start with a protobuf blob-length header, never
                # '<' - cheap enough to check without a real PBF parser.
                content_type = r.headers.get('Content-Type', '')
                tmp = dest + '.part'
                with open(tmp, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        f.write(chunk)
                first_bytes = open(tmp, 'rb').read(16)
                if 'html' in content_type.lower() or first_bytes.lstrip()[:1] == b'<':
                    os.remove(tmp)
                    raise RuntimeError(f'got HTML (wrong URL?) instead of a .pbf for {url}')
                os.rename(tmp, dest)
            size_mb = os.path.getsize(dest) / 1024 / 1024
            print(f' done ({size_mb:.1f} MB)')
            time.sleep(DOWNLOAD_DELAY_S)
            return
        except requests.exceptions.RequestException as e:
            print(f' error ({e}), retrying in {10 * attempt}s (attempt {attempt}/{MAX_RETRIES})...')
            time.sleep(10 * attempt)

    raise RuntimeError(f'{os.path.basename(dest)}: failed after {MAX_RETRIES} attempts (rate-limited or unreachable)')


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
    os.makedirs(RAW_DIR, exist_ok=True)
    print('Downloading Geofabrik extracts:')
    total_features = 0
    for url, key in EXTRACTS:
        raw_path = os.path.join(RAW_DIR, f'{key}.json')
        if os.path.exists(raw_path):
            with open(raw_path) as f:
                count = len(json.load(f)['features'])
            print(f'  {key}: already filtered ({count} features)')
            total_features += count
            continue

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
        with open(raw_path, 'w') as f:
            json.dump({'features': handler.features}, f)
        total_features += len(handler.features)

    print(f'\n{total_features} total features across {len(EXTRACTS)} countries in {RAW_DIR}')


if __name__ == '__main__':
    main()
