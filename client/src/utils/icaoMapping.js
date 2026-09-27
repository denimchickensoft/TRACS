// client/public/icaoMapping.json: theatre → DCS airbase name → real ICAO code.
// Fetched once per window and shared by every caller. Resolves to {} on any
// failure (network error, error page, bad JSON); a failure isn't cached, so
// the next caller tries again.
let _promise = null

export function getIcaoMapping() {
  if (!_promise) {
    _promise = fetch('/icaoMapping.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .catch(() => {
        _promise = null
        return {}
      })
  }
  return _promise
}
