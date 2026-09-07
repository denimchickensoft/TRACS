const STORAGE_KEY       = 'tracs.serverProfiles'
const LAST_CONN_KEY     = 'tracs.lastConnection'
const MAX_RECENTS  = 5

// Splits a stored "http://host:port"-shaped string (or a bare host) back into
// its host and port, for editing as separate fields. Moved here from
// Login.jsx since inferLegacySourceType() below needs it too. Malformed
// input returns blanks rather than throwing.
export function parseHostPort(raw) {
  if (!raw) return { host: '', port: '' }
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return { host: u.hostname, port: u.port }
  } catch {
    return { host: '', port: '' }
  }
}

// Pre-source-selector profiles (and last-connection records) have no
// sourceType at all. A blank Source Port + a configured relay was always,
// deterministically, "relay is the primary source" (the old auto-detect
// rule) — recoverable with certainty. A port being set was historically
// ambiguous (could've meant Olympus or direct Tacview, indistinguishable —
// that was the whole point of auto-detect), so it defaults to Olympus, the
// pre-existing majority case; a wrong guess surfaces immediately as a failed
// connect and the user flips the selector once. See
// resources/specs/data-sources/pluggable-source-architecture-spec.md §5.
export function inferLegacySourceType(record) {
  if (!record) return 'olympus'
  if (record.sourceType) return record.sourceType
  const hasPort = !!parseHostPort(record.url).port
  if (!hasPort && record.relayUrl) return 'relay'
  return 'olympus'
}

export function loadServerProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveServerProfiles(profiles) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
}

// Favorites are never evicted; non-favorites beyond MAX_RECENTS (by lastUsed) are dropped.
function trim(profiles) {
  const favorites = profiles.filter((p) => p.favorite)
  const recents   = profiles
    .filter((p) => !p.favorite)
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, MAX_RECENTS)
  return [...favorites, ...recents]
}

export function findProfileByName(profiles, name) {
  const key = name.trim().toLowerCase()
  if (!key) return null
  return profiles.find((p) => p.name.toLowerCase() === key) ?? null
}

// Upserts by case-insensitive name match: overwrites url, bumps lastUsed and
// lastCoalition, preserves favorite. Persists and returns the new (trimmed) list.
// relayUrl is optional and not coalition-scoped (unlike password) — it's a property of
// the DCS-side deployment, not the controller's role on it.
//
// Which password slot `password`/`relayPassword` land in depends on
// `sourceType`, since the three primary-source modes have structurally
// different password semantics (see
// resources/specs/data-sources/pluggable-source-architecture-spec.md §7):
//   - 'olympus' / 'relay': `password` is genuinely per-coalition -> merged into
//     the `passwords` map, same slot reused by both modes (a profile only
//     has one active sourceType at a time, same pattern lastCoalition uses).
//   - 'tacview-direct': `password` is Tacview's own flat RTT password, not
//     coalition-scoped at all -> stored plainly as `tacviewPassword`, never
//     put in the `passwords` map. `relayPassword` (only meaningful when this
//     mode also has a relay configured) is the *separate*, genuinely
//     per-coalition secret the relay itself needs -> its own `relayPasswords`
//     map, independent of `tacviewPassword`.
// Whichever slot(s) don't apply to the current sourceType are left untouched
// from `existing`, so switching modes on a saved profile never clobbers the
// other mode's remembered password(s).
export function upsertServerProfile(profiles, { name, url, coalition, password, relayUrl, sourceType, relayPassword }) {
  const key = name.trim().toLowerCase()
  const idx = profiles.findIndex((p) => p.name.toLowerCase() === key)
  const existing = idx === -1 ? null : profiles[idx]

  const passwords = sourceType === 'tacview-direct'
    ? (existing?.passwords ?? {})
    : { ...existing?.passwords, [coalition]: password }
  const tacviewPassword = sourceType === 'tacview-direct'
    ? password
    : (existing?.tacviewPassword ?? '')
  const relayPasswords = (sourceType === 'tacview-direct' && relayUrl)
    ? { ...existing?.relayPasswords, [coalition]: relayPassword ?? '' }
    : (existing?.relayPasswords ?? {})

  const record = {
    name:      name.trim(),
    url,
    relayUrl:      relayUrl ?? existing?.relayUrl ?? '',
    favorite:      existing?.favorite ?? false,
    lastUsed:      Date.now(),
    lastCoalition: coalition,
    sourceType,
    passwords,
    tacviewPassword,
    relayPasswords,
  }

  const next = idx === -1
    ? [...profiles, record]
    : [...profiles.slice(0, idx), record, ...profiles.slice(idx + 1)]

  const trimmed = trim(next)
  saveServerProfiles(trimmed)
  return trimmed
}

export function toggleFavoriteProfile(profiles, name) {
  const next = profiles.map((p) => p.name === name ? { ...p, favorite: !p.favorite } : p)
  saveServerProfiles(next)
  return next
}

export function removeServerProfile(profiles, name) {
  const next = profiles.filter((p) => p.name !== name)
  saveServerProfiles(next)
  return next
}

export function getMostRecentProfile(profiles) {
  return profiles.reduce((latest, p) => (!latest || p.lastUsed > latest.lastUsed) ? p : latest, null)
}

// Tracks the literal last successful connection, independent of the named profile list —
// so the login form defaults to it even when the server was never named/saved.
export function loadLastConnection() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_CONN_KEY))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function saveLastConnection({ name, url, coalition, password, relayUrl, sourceType, relayPassword }) {
  localStorage.setItem(LAST_CONN_KEY, JSON.stringify({
    name, url, coalition, password, relayUrl: relayUrl ?? '',
    sourceType, relayPassword: relayPassword ?? '',
  }))
}

// Favorites first, then up to MAX_RECENTS non-favorites, both by most-recently-used;
// filtered by a case-insensitive substring match against the query.
export function filterServerProfiles(profiles, query) {
  const q = query.trim().toLowerCase()
  const matches = q ? profiles.filter((p) => p.name.toLowerCase().includes(q)) : profiles

  const favorites = matches.filter((p) => p.favorite).sort((a, b) => b.lastUsed - a.lastUsed)
  const recents   = matches.filter((p) => !p.favorite).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENTS)
  return [...favorites, ...recents]
}
