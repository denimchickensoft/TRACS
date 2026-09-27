import { DECLARATION } from './createDeclarationStore.js'
import { MS_TO_KT, M_TO_FT } from './units.js'

// Small picture helpers shared by the AIC and ABM scopes (and their action
// modules, pop-outs and BRAA list).

// Coalition name → DCS coalition number. GM/Admin see the picture as Blue.
export const COALITION_NUM = { blue: 2, red: 1, gm: 2, admin: 2 }

// A unit's TRUE declaration, straight off its coalition (used by .autodec):
// own coalition is FRIENDLY, coalition 0 (DCS's neutral) is NEUTRAL,
// anything else is HOSTILE (not BOGEY — autodec means no ambiguity).
export function trueDeclaration(unit, myCoalitionNum) {
  if (unit.coalition === myCoalitionNum) return DECLARATION.FRIENDLY
  if (unit.coalition === 0) return DECLARATION.NEUTRAL
  return DECLARATION.HOSTILE
}

// Fog-of-war filter for missiles: own-coalition and neutral missiles are
// always visible; any other missile only once at least one unit reports it
// in its missileContacts. missileContacts is a separate field from a unit's
// contacts, so this never races Olympus's own 1 s refresh of real contacts.
// No AGL floor (a missile spends its early flight near the ground) and no
// category filter (weapons are already missiles-only by the time they reach
// the client — see olympus.js's pollWeapons()/tacviewCore.js's classify()).
export function getVisibleMissiles(weapons, units, myCoalitionNum) {
  const result      = {}
  const detectedIds = new Set()

  for (const unit of Object.values(units)) {
    if (!unit.missileContacts) continue
    for (const c of unit.missileContacts) detectedIds.add(String(c.ID))
  }

  for (const [id, weapon] of Object.entries(weapons)) {
    if (!weapon.position) continue
    const c = weapon.coalition
    if (c === myCoalitionNum || c === 0 || detectedIds.has(id)) result[id] = weapon
  }

  return result
}

// HIGH / FAST / VERY FAST picture-call flags from a unit's altitude and speed.
export function speedFlags(unit) {
  if (!unit) return ''
  const kts   = (unit.speed ?? 0) * MS_TO_KT
  const altFt = (unit.position?.alt ?? 0) * M_TO_FT
  const parts = []
  if (altFt >= 40000) parts.push('HIGH')
  if (kts >= 900) parts.push('VERY FAST')
  else if (kts >= 600) parts.push('FAST')
  return parts.join('  ')
}

// The mission bullseye for `coalition` (red uses Red's; everyone else Blue's),
// falling back to the first one listed. `bullseyes` is the session store's
// value. Returns null when the mission has none.
export function findCoalitionBullseye(bullseyes, coalition) {
  if (!bullseyes?.bullseyes) return null
  const coalStr = coalition === 'red' ? 'red' : 'blue'
  return Object.values(bullseyes.bullseyes).find(b => b.coalition === coalStr)
      ?? Object.values(bullseyes.bullseyes)[0]
      ?? null
}
