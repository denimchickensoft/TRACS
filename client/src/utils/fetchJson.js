// fetch() + JSON parse that fails with the HTTP status on a non-2xx response,
// instead of a confusing JSON parse error on an error page or empty body.
export async function fetchJson(url, init) {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`)
  return res.json()
}
