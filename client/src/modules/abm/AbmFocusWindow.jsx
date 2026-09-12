import AbmScope from './AbmScope'
import { sanitizeFocusToken } from '../../utils/callsign.js'

// Popped up by openAbmFocusWindow (actions/index.js) via .focus <callsign>
// or double-clicking a contact on the main scope — same window.open('/?window=…')
// pattern as AtoWindow/FragWindow/DrawingsWindow, wired in main.jsx. A full
// AbmScope instance (same commands/declarations/drawings, shared global
// stores), just its own displayStore window keyed by callsign and locked
// onto that contact's live position — see AbmScope.jsx's followCallsign prop.
const params    = new URLSearchParams(window.location.search)
const callsign  = params.get('callsign') ?? ''
const rangeParam = params.get('range')
const initialRangeNm = rangeParam ? parseFloat(rangeParam) : null
const windowId  = `abm-focus-${sanitizeFocusToken(callsign)}`

export function AbmFocusWindow() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <AbmScope windowId={windowId} followCallsign={callsign} initialRangeNm={initialRangeNm} />
    </div>
  )
}
