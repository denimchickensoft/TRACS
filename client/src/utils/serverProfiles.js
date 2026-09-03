const STORAGE_KEY       = 'tracs.serverProfiles'
const LAST_CONN_KEY     = 'tracs.lastConnection'
const MAX_RECENTS  = 5

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

// Upserts by case-insensitive name match: overwrites url, sets passwords[coalition],
// bumps lastUsed and lastCoalition, preserves favorite. Persists and returns the new (trimmed) list.
// relayUrl is optional and not coalition-scoped (unlike password) — it's a property of
// the DCS-side deployment, not the controller's role on it.
export function upsertServerProfile(profiles, { name, url, coalition, password, relayUrl }) {
  const key = name.trim().toLowerCase()
  const idx = profiles.findIndex((p) => p.name.toLowerCase() === key)

  let next
  if (idx === -1) {
    next = [...profiles, {
      name:      name.trim(),
      url,
      relayUrl:      relayUrl ?? '',
      favorite:      false,
      lastUsed:      Date.now(),
      lastCoalition: coalition,
      passwords: { [coalition]: password },
    }]
  } else {
    const existing = profiles[idx]
    const updated  = {
      ...existing,
      url,
      relayUrl:      relayUrl ?? existing.relayUrl ?? '',
      lastUsed:      Date.now(),
      lastCoalition: coalition,
      passwords: { ...existing.passwords, [coalition]: password },
    }
    next = [...profiles.slice(0, idx), updated, ...profiles.slice(idx + 1)]
  }

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

export function saveLastConnection({ name, url, coalition, password, relayUrl }) {
  localStorage.setItem(LAST_CONN_KEY, JSON.stringify({ name, url, coalition, password, relayUrl: relayUrl ?? '' }))
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
