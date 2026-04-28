import { useAtcStore } from '../store/atc'
import { useSessionStore } from '../store/session'

/**
 * Resolve the display callsign for a unit.
 *
 * Priority:
 *   1. Controller-assigned override (callsignOverrides in atc store)
 *   2. Olympus callsign (multiplayer pilot username) if showPilotCallsigns is on
 *   3. unitName (DCS mission editor name)
 *   4. Unit ID as last resort
 *
 * @param {object} unit - unit object from the units store
 * @returns {string}
 */
function stripCallsign(s) {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

export function resolveCallsign(unit) {
  const override = useAtcStore.getState().callsignOverrides[String(unit.id)]
  if (override) return stripCallsign(override)

  const showPilot = useSessionStore.getState().showPilotCallsigns
  if (showPilot && unit.callsign) return stripCallsign(unit.callsign)

  return stripCallsign(unit.unitName || String(unit.id))
}
