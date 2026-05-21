import { useAtcStore }     from '../store/atc'
import { useSessionStore } from '../store/session'

function stripAcid(s) {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

// Split "VIPER1 | John Smith" → { acid: 'VIPER1', pilotName: 'John Smith' }
// No pipe → { acid: stripped unitName, pilotName: null }
export function parseUnitName(unitName) {
  if (!unitName) return { acid: '', pilotName: null }
  const pipeIdx = unitName.indexOf('|')
  if (pipeIdx === -1) return { acid: stripAcid(unitName), pilotName: null }
  return {
    acid:      stripAcid(unitName.slice(0, pipeIdx).trim()),
    pilotName: unitName.slice(pipeIdx + 1).trim() || null,
  }
}

/**
 * Resolve the base AID from Olympus data, ignoring any controller override.
 * Used when reverting a rename back to the original name.
 */
export function resolveOriginalCallsign(unit) {
  if (useSessionStore.getState().useDcsNames) {
    const { acid } = parseUnitName(unit.unitName)
    return acid || stripAcid(unit.callsign || String(unit.id))
  }
  return stripAcid(unit.callsign || unit.unitName || String(unit.id))
}

/**
 * Resolve the AID (Aircraft ID) shown in datablocks.
 *
 * Priority:
 *   1. Controller-assigned callsign override
 *   2. If useDcsNames ON: unit.unitName (pipe-split left side if '|' present)
 *   3. If useDcsNames OFF: unit.callsign (mission editor name)
 *   4. Unit ID as last resort
 */
export function resolveCallsign(unit) {
  const override = useAtcStore.getState().callsignOverrides[String(unit.id)]
  if (override) return stripAcid(override)

  if (useSessionStore.getState().useDcsNames) {
    const { acid } = parseUnitName(unit.unitName)
    return acid || stripAcid(unit.callsign || String(unit.id))
  }

  return stripAcid(unit.callsign || unit.unitName || String(unit.id))
}

/**
 * Resolve the pilot's real name from the pipe convention ("VIPER1 | John Smith").
 * Returns null if useDcsNames is off, no pipe is present, or no unitName exists.
 */
export function resolvePilotName(unit) {
  if (!useSessionStore.getState().useDcsNames) return null
  return parseUnitName(unit.unitName).pilotName
}
