import https from "https";
import fs from "fs";
import path from "path";

const MIRROR = "https://maps.dcsolympus.com/maps";
const THEATRE = "alt-syria";
const OUT_DIR = path.join(import.meta.dirname, "../client/public/groundtiles/syria");

const rwyData = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, "../client/public/runways/Syria.json"), "utf8"
));

// Only real airfields — exclude helipads and FARPs (runway < 3000ft).
const AIRBASES = rwyData.airbases
  .filter((ab) => ab.runways?.some((r) => r.length_ft >= 3000))
  .map((ab) => {
    const rwy = ab.runways.find((r) => r.length_ft >= 3000);
    return { name: ab.airbase, lat: rwy.lat, lon: rwy.lon };
  });

// Grid radii per zoom level (tiles from center in each direction)
const ZOOM_CONFIGS = [
  { z: 15, radius: 3 }, // 7x7 = 49 tiles, ~6km
];

function latLonToTile(lat, lon, z) {
  const x = Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, z)
  );
  return { x, y };
}

function fetchTile(z, x, y) {
  return new Promise((resolve, reject) => {
    const url = `${MIRROR}/${THEATRE}/${z}/${x}/${y}.png`;
    const outPath = path.join(OUT_DIR, String(z), String(x), `${y}.png`);

    if (fs.existsSync(outPath)) {
      process.stdout.write(".");
      return resolve({ skipped: true });
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const file = fs.createWriteStream(outPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(outPath);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        process.stdout.write("#");
        resolve({ skipped: false });
      });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      reject(err);
    });
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchAirbase(airbase) {
  console.log(`\nFetching tiles for ${airbase.name}`);

  let total = 0;
  let skipped = 0;

  for (const { z, radius } of ZOOM_CONFIGS) {
    const center = latLonToTile(airbase.lat, airbase.lon, z);
    const count = (radius * 2 + 1) ** 2;
    console.log(`  z${z}: center tile (${center.x}, ${center.y}), ${count} tiles`);
    process.stdout.write("  ");

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        try {
          const result = await fetchTile(z, center.x + dx, center.y + dy);
          if (result.skipped) skipped++;
          total++;
          await sleep(50); // polite delay
        } catch (err) {
          console.error(`\n  Error: ${err.message}`);
        }
      }
    }
    console.log();
  }

  console.log(`  Done: ${total} tiles (${skipped} already cached)`);
}

for (const airbase of AIRBASES) {
  await fetchAirbase(airbase);
}

console.log("\nComplete. Tiles saved to:", OUT_DIR);
