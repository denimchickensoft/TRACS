// Decodes DCS payload CLSID strings (from a parsed mission's unit.payload.pylons)
// into human-readable ordnance names, using the static per-aircraft-type
// databases in /public/units/ — currently unused by any other code.
//
// Lazy-loaded on first call rather than bundled eagerly: aircraftdatabase.json
// alone carries 14k+ CLSID entries.

let _map = null
let _loading = null

async function loadDb() {
  const [acRes, heloRes] = await Promise.all([
    fetch('/units/aircraftdatabase.json'),
    fetch('/units/helicopterdatabase.json'),
  ])
  const [acDb, heloDb] = await Promise.all([acRes.json(), heloRes.json()])

  const map = {}
  for (const db of [acDb, heloDb]) {
    for (const unitType of Object.keys(db)) {
      const payloads = db[unitType]?.acceptedPayloads
      if (!payloads) continue
      for (const station of Object.keys(payloads)) {
        for (const item of payloads[station]) {
          if (item?.clsid && item?.name && !map[item.clsid]) map[item.clsid] = item.name
        }
      }
    }
  }
  return map
}

// Kicks off the lazy load without blocking; call when the ATO/FRAG drawer
// first opens so getOrdnanceName() has real names by the time it's needed.
export function preloadOrdnanceDb() {
  if (!_loading) _loading = loadDb().then((map) => { _map = map; return map })
  return _loading
}

// Sync lookup — returns the raw CLSID until the lazy load resolves.
export function getOrdnanceName(clsid) {
  if (!clsid) return ''
  if (_map) return _map[clsid] ?? clsid
  preloadOrdnanceDb()
  return clsid
}
