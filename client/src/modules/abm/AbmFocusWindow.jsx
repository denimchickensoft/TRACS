import AbmScope from './AbmScope'
import { sanitizeFocusToken } from '../../utils/callsign.js'

// Popped up by popOutAbmFocusPanel (actions/index.js), via the "pop out"
// button on an in-page AbmFocusPanel.jsx — same window.open('/?window=…')
// pattern as AtoWindow/FragWindow/DrawingsWindow, wired in main.jsx. A full
// AbmScope instance (same commands/declarations/drawings, shared global
// stores), just its own displayStore window keyed by focus key and either
// locked onto a contact's live position or opened on a fixed location — see
// AbmScope.jsx's focusKey prop. `callsign` is the param's older name, still
// read so a popup restored from an earlier URL keeps working.
const params    = new URLSearchParams(window.location.search)
const focusKey  = params.get('key') ?? params.get('callsign') ?? ''
const rangeParam = params.get('range')
const initialRangeNm = rangeParam ? parseFloat(rangeParam) : null
const latParam  = parseFloat(params.get('lat'))
const lngParam  = parseFloat(params.get('lng'))
const initialCenter = Number.isFinite(latParam) && Number.isFinite(lngParam) ? { lat: latParam, lng: lngParam } : null
const windowId  = `abm-focus-${sanitizeFocusToken(focusKey)}`

export function AbmFocusWindow() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <AbmScope windowId={windowId} focusKey={focusKey} initialRangeNm={initialRangeNm} initialCenter={initialCenter} />
    </div>
  )
}
