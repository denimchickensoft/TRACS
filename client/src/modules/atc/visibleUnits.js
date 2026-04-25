/**
 * Detection / visibility model.
 *
 * Rules:
 *   - Friendly units (same coalition as controller) are always visible.
 *   - Enemy / neutral units are visible only if at least one friendly unit
 *     has them in its contacts list with bit 4 (RADAR, value 16) set in
 *     the detectionMethod bitmask.
 *
 * Coalition values from Olympus:
 *   0 = neutral, 1 = red, 2 = blue
 */

const DETECTION_RADAR = 16  // bit 4

const AIRBORNE_CATEGORIES = new Set(['Aircraft', 'Helicopter'])

/**
 * @param {Object} allUnits   { [id]: unitObject }  — raw units from store
 * @param {string} coalition  controller coalition: 'blue' | 'red' | 'gm' | 'admin'
 * @returns {Object}          filtered units map (same shape)
 */
export function getVisibleUnits(allUnits, coalition) {
  // GM / admin see all airborne contacts
  if (coalition === 'gm' || coalition === 'admin') {
    return Object.fromEntries(
      Object.entries(allUnits).filter(([, u]) => AIRBORNE_CATEGORIES.has(u.category))
    )
  }

  const myCoalitionId = coalition === 'blue' ? 2 : 1

  // Build set of radar-detected enemy/neutral unit IDs
  const radarDetected = new Set()

  for (const unit of Object.values(allUnits)) {
    if (unit.coalition !== myCoalitionId) continue        // only friendlies have contacts
    if (!Array.isArray(unit.contacts)) continue

    for (const contact of unit.contacts) {
      if (contact.detectionMethod & DETECTION_RADAR) {
        radarDetected.add(String(contact.ID))
      }
    }
  }

  const visible = {}
  for (const [id, unit] of Object.entries(allUnits)) {
    if (!AIRBORNE_CATEGORIES.has(unit.category)) continue
    if (unit.coalition === myCoalitionId) {
      visible[id] = unit
    } else if (radarDetected.has(String(id))) {
      visible[id] = unit
    }
  }

  return visible
}
