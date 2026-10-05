/**
 * Detection / visibility model.
 *
 * Rules:
 *   - Friendly units (same coalition as controller) are always visible.
 *   - Enemy / neutral units are visible only if at least one friendly unit
 *     has them in its contacts list with RADAR (value 4) set in
 *     the detectionMethod bitmask.
 *
 * Coalition values from Olympus:
 *   0 = neutral, 1 = red, 2 = blue
 */

const DETECTION_RADAR = 4

const AIRBORNE_CATEGORIES = new Set(['Aircraft', 'Helicopter'])

const AGL_FLOOR_M = 30  // ≈ 100 ft — suppress ground contacts

// An aircraft sitting on the ground (parked, taxiing). Trusts the source's
// own airborne flag when it sends one: Olympus reports DCS's unit:inAir(),
// and Tacview derives it from its own DCS-terrain AGL. The server-computed
// Olympus `agl` is only a fallback — it comes from a coarse real-world
// elevation grid that can sit 30m+ below DCS's flattened airfield terrain,
// which let some parked aircraft through.
export function isOnGround(unit) {
  if (unit.airborne !== undefined) return !unit.airborne
  return unit.agl !== undefined && unit.agl < AGL_FLOOR_M
}

/**
 * @param {Object}  allUnits   { [id]: unitObject }  — raw units from store
 * @param {string}  coalition  controller coalition: 'blue' | 'red' | 'gm' | 'admin'
 * @param {boolean} tdmMode    top-down mode — when true, bypass the ground filter
 * @returns {Object}           filtered units map (same shape)
 */
export function getVisibleUnits(allUnits, coalition, tdmMode = false) {
  let visible

  // GM / admin see all airborne contacts
  if (coalition === 'gm' || coalition === 'admin') {
    visible = Object.fromEntries(
      Object.entries(allUnits).filter(([, u]) => AIRBORNE_CATEGORIES.has(u.category))
    )
  } else {
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

    visible = {}
    for (const [id, unit] of Object.entries(allUnits)) {
      if (!AIRBORNE_CATEGORIES.has(unit.category)) continue
      if (unit.coalition === myCoalitionId) {
        visible[id] = unit
      } else if (radarDetected.has(String(id))) {
        visible[id] = unit
      }
    }
  }

  // Ground filter: suppress aircraft on the ground when not in top-down mode.
  if (!tdmMode) {
    for (const id of Object.keys(visible)) {
      if (isOnGround(visible[id])) delete visible[id]
    }
  }

  return visible
}
