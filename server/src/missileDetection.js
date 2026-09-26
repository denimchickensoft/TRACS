'use strict'

// Synthetic AWACS/EWR-only detection for in-flight missiles — a separate,
// dedicated module from tacviewDetection.js (per explicit direction), even
// though it reuses the same geodetic math (server/src/utils/geo.js) and a
// couple of small role/type lookups (hasAwacsRole/ewrRangeNm, exported from
// tacviewDetection.js rather than re-derived here).
//
// Why this exists at all, and why it's not just tacviewDetection.js's own
// computeContacts(): neither Olympus nor Tacview weapon objects carry any
// native detection data (Olympus's Weapon class never populates
// contacts[]/radarState — only Unit does; Tacview has none for anything).
// So both sources need the exact same synthetic treatment for missiles,
// unlike aircraft/ground/naval units where Olympus already has real native
// detection and only Tacview needed a synthetic model.
//
// Detectors are deliberately limited to AWACS and EWR only — SAM/AAA/
// AirDefence radars are excluded on purpose, per explicit direction, even
// though tacviewDetection.js's own TRUSTED_GROUND_TYPES treats them as valid
// detectors for aircraft/ground targets. A missile in flight is a fast,
// small, short-lived target; a SAM/AAA fire-control radar's job is engaging
// its own already-acquired target, not searching for other missiles.
//
// Output shape: { [detectingUnitId]: { missileContacts: [{ID, detectionMethod}] } }
// — a units-delta-shaped partial update, attached to the DETECTING (friendly
// AWACS/EWR) unit, not the missile itself, matching how real Olympus
// contacts[] and tacviewDetection.js's synthetic ones already work
// (confirmed by reading client/src/modules/abm/abmScopeHelpers.js's
// getAbmVisibleUnits(), which harvests detectedIds by scanning every unit's
// OWN contacts[] array, not anything on the target).
//
// Deliberately a SEPARATE field (`missileContacts`, not `contacts`): Olympus
// refreshes a unit's real native `contacts` on its own independent 1s poll
// cadence (olympus.js's pollUnits()), while this runs on its own 2s timer —
// if this wrote into the same `contacts` field, whichever update landed last
// would silently overwrite the other's data, causing missile contacts to
// flicker in and out roughly every second. A dedicated field sidesteps that
// entirely; the client-side missile-visibility filter reads
// `unit.missileContacts` instead of `unit.contacts`.
//
// Always emits an entry (even an empty array) for every unit that qualifies
// as a detector this pass, not just ones with an active hit — otherwise a
// detector whose only missile contact just left range/LOS would keep
// reporting its last-known (now stale) missileContacts forever, since a
// partial update that omits a field leaves the client's previous value in
// place rather than clearing it.

const { hasAwacsRole, ewrRangeNm, aircraftSensorRangeNm, pickAnchorUnitId, DETECTION_RADAR } = require('./tacviewDetection')
const { distanceNm, quickReject, hasLineOfSight } = require('./utils/geo')
const { getWeaponRcs } = require('./weaponDatabase')

// Mirrors tacviewDetection.js's own aircraftSensorScaling defaults (real
// radar-range-equation RCS^(1/4) relationship) — a separate, dedicated set of
// constants per explicit direction that this be its own module, not shared
// config with tacviewDetection.js. Provisional, same as the original.
const REFERENCE_RCS_M2 = 100
const RANGE_SCALING_EXPONENT = 0.25
const LOS_SAMPLE_COUNT = 8

// AWACS-role Aircraft/Helicopter get their own airframe's real detection
// range (aircraftSensorRangeNm — real per-unit detectionRangeMaxKm when the
// datamine has an entry, e.g. E-3A/E-2C/A-50/KJ-2000, falling back to
// AWACS_RANGE_NM internally only for an AWACS-role airframe missing one)
// rather than a single flat range for every AWACS type.
function detectorRangeNm(unit) {
  if (unit.category === 'Aircraft' || unit.category === 'Helicopter') {
    return hasAwacsRole(unit) ? aircraftSensorRangeNm(unit) : null
  }
  if (unit.category === 'GroundUnit') return ewrRangeNm(unit)
  return null
}

// units: { [id]: unitObject } — full mission-wide unit map (all coalitions).
// weapons: { [id]: weaponObject } — full mission-wide missile map (already
// filtered to category === 'Missile' and RCS-trackable by the caller).
// friendlyCoalitionId: numeric coalition this computation is "for" — only
// this side's AWACS/EWR act as detectors, matching computeContacts()'s own
// single-perspective design (a live session only ever needs one side's view).
function computeMissileContacts(units, weapons, friendlyCoalitionId) {
  const detectors = []
  for (const [id, unit] of Object.entries(units)) {
    if (unit.coalition !== friendlyCoalitionId) continue
    if (!unit.position) continue
    const rangeNm = detectorRangeNm(unit)
    if (!rangeNm) continue
    detectors.push({ id, unit, rangeNm })
  }
  if (detectors.length === 0) return {}

  // Pre-seed every qualifying detector with an empty array so a detector that
  // loses its only contact this pass still gets an explicit clear, not a
  // silently-stale value (see file header).
  const contactsById = new Map(detectors.map((d) => [d.id, []]))

  for (const [weaponId, weapon] of Object.entries(weapons)) {
    if (!weapon.position) continue
    if (weapon.coalition === friendlyCoalitionId || weapon.coalition === 0) continue // own-side/neutral shots are unconditionally visible client-side, not gated here
    const rcs = getWeaponRcs(weapon.name)
    if (rcs == null) continue // unresolved name — can't compute a range, stays undetected (conservative)

    for (const detector of detectors) {
      if (quickReject(detector.unit.position, weapon.position, detector.rangeNm)) continue
      const range = distanceNm(detector.unit.position, weapon.position)
      const effectiveRangeNm = detector.rangeNm * (rcs / REFERENCE_RCS_M2) ** RANGE_SCALING_EXPONENT
      if (range > effectiveRangeNm) continue
      if (!hasLineOfSight(detector.unit.position, weapon.position, LOS_SAMPLE_COUNT)) continue

      contactsById.get(detector.id).push({ ID: Number(weaponId), detectionMethod: DETECTION_RADAR })
    }
  }

  const updated = {}
  for (const [id, missileContacts] of contactsById) updated[id] = { missileContacts }
  return updated
}

// Fog-of-war redaction for weapon data — needed on BOTH sources, not just
// Tacview. Confirmed live 2026-09-15: Olympus's own /olympus/weapons endpoint
// sends full, unredacted position telemetry for every coalition's missiles
// regardless of which coalition authenticated (a Blue-authenticated capture
// received complete real-time Red-coalition missile positions) — unlike
// /olympus/units, which Olympus itself redacts via real native detection.
// Weapon objects have no native detection concept for Olympus to gate on
// either, so this is exactly as necessary for Olympus as it already was for
// Tacview. Mirrors tacviewDetection.js's createFogFilter pattern closely
// (same revealed/hidden exposure-tracking shape), but kept in this module
// since it's specifically about missile visibility, not a modification of
// that file.
//
// isOmniscient: optional () => boolean, read every pass — Tacview's
// fogOfWarEnabled=false (tacviewDetection.js). When true, every non-friendly,
// non-neutral missile is "detected" by a single friendly anchor unit
// (pickAnchorUnitId) instead of by AWACS/EWR. A getter rather than a flag
// because relay-hosted mode creates this filter before the relay's config
// arrives. Olympus never passes it.
function createMissileFogFilter(friendlyCoalitionId, { isOmniscient } = {}) {
  let exposedEnemyWeaponIds = new Set()
  let anchorId = null

  function computeOmniscientMissileContacts(units, weapons) {
    anchorId = pickAnchorUnitId(units, friendlyCoalitionId, anchorId)
    if (anchorId == null) return {}
    const missileContacts = []
    for (const [weaponId, weapon] of Object.entries(weapons)) {
      if (!weapon.position) continue
      if (weapon.coalition === friendlyCoalitionId || weapon.coalition === 0) continue
      missileContacts.push({ ID: Number(weaponId), detectionMethod: DETECTION_RADAR })
    }
    return { [anchorId]: { missileContacts } }
  }

  return {
    // Called on every incoming weapon update, before it's ever queued for
    // broadcast — own-coalition/neutral pass straight through; a non-friendly
    // weapon only passes if already exposed from the last detection pass.
    filterFrameUpdate(weaponsUpdated) {
      const publicUpdated = {}
      for (const [id, weapon] of Object.entries(weaponsUpdated)) {
        if (weapon.coalition === friendlyCoalitionId || weapon.coalition === 0 || exposedEnemyWeaponIds.has(id)) {
          publicUpdated[id] = weapon
        }
      }
      return publicUpdated
    },

    // Called on the periodic missile-detection timer with the full internal
    // (omniscient) units + weapons maps. Returns the missileContacts update
    // (for friendly AWACS/EWR units, to broadcast alongside real/synthetic
    // unit contacts) plus which previously-hidden enemy missiles just became
    // visible (need their full current data pushed — filterFrameUpdate was
    // dropping their updates while hidden) and which previously-visible ones
    // just dropped out of detection (need an explicit removal — the missile
    // may still be alive, just no longer detected).
    computeVisibility(units, weapons) {
      const previousAnchorId = anchorId
      let contactsUpdate
      if (isOmniscient?.()) {
        contactsUpdate = computeOmniscientMissileContacts(units, weapons)
      } else {
        anchorId = null
        contactsUpdate = computeMissileContacts(units, weapons, friendlyCoalitionId)
      }
      // Anchor moved (or omniscient mode went off): explicitly clear the old
      // anchor's list, unless this pass already writes it a fresh one.
      if (previousAnchorId != null && previousAnchorId !== anchorId && units[previousAnchorId] && !contactsUpdate[previousAnchorId]) {
        contactsUpdate[previousAnchorId] = { missileContacts: [] }
      }

      const nowVisible = new Set()
      for (const { missileContacts } of Object.values(contactsUpdate)) {
        for (const { ID } of missileContacts) nowVisible.add(String(ID))
      }

      const revealed = {}
      for (const id of nowVisible) {
        if (!exposedEnemyWeaponIds.has(id) && weapons[id]) revealed[id] = weapons[id]
      }
      const hidden = [...exposedEnemyWeaponIds].filter((id) => !nowVisible.has(id))

      exposedEnemyWeaponIds = nowVisible
      return { contactsUpdate, revealed, hidden }
    },

    // Internal bookkeeping cleanup when the raw stream truly removes a
    // weapon (impact/expiration) — distinct from computeVisibility's
    // "hidden" (still exists, just out of detection range).
    forget(id) {
      exposedEnemyWeaponIds.delete(id)
    },
  }
}

module.exports = { computeMissileContacts, createMissileFogFilter }
