'use strict'

// Real DCS contacts from the exporter hook's contacts group, turned into what
// the rest of TRACS reads: contacts[] on friendly units, and (for a coalition
// controller) which enemy units are exposed at all.
//
// The hook sends one flat map, '<coalition>:<target unit id>' -> the sum of
// the detection method bits (Olympus's values) that coalition's units found
// it by, for every target not on that coalition's side (neutrals included:
// they reach a coalition controller only once detected, as enemies do). The client only asks whether some friendly unit's contacts name a
// target and by which method, not which unit saw it, so each coalition's
// contacts all go on one friendly "anchor" unit, as the omniscient fog-of-war
// mode does (tacviewDetection.js's pickAnchorUnitId).

const { DETECTION_RADAR, pickAnchorUnitId } = require('./tacviewDetection')

const DETECTION_DLINK = 32
const METHOD_BITS = [1, 2, 4, 8, 16, 32]

const isAir = (u) => u.category === 'Aircraft' || u.category === 'Helicopter'

// An enemy aircraft is shown on RADAR or DLINK only (RWR alone just reveals
// the type of one already shown), anything else on any method, the same
// rules the client applies to contacts.
function exposes(target, mask) {
  return isAir(target) ? (mask & (DETECTION_RADAR | DETECTION_DLINK)) !== 0 : mask !== 0
}

// One coalition's contacts that name a unit we know: the contacts[] entries
// (one per method bit) and the ids they expose.
function coalitionContacts(masks, coalitionId, internalUnits) {
  const contacts = []
  const visible = new Set()
  const prefix = `${coalitionId}:`
  for (const [key, mask] of Object.entries(masks)) {
    if (!key.startsWith(prefix) || typeof mask !== 'number') continue
    const id = key.slice(prefix.length)
    const target = internalUnits[id]
    if (!target) continue
    for (const bit of METHOD_BITS) if (mask & bit) contacts.push({ ID: Number(id), detectionMethod: bit })
    if (exposes(target, mask)) visible.add(id)
  }
  return { contacts, visible }
}

// Moves a coalition's contacts onto its anchor, clearing the old anchor's
// list when the anchor changes. Returns the new anchor id.
function anchorContacts(update, internalUnits, coalitionId, previousId, contacts) {
  const anchorId = pickAnchorUnitId(internalUnits, coalitionId, previousId)
  if (anchorId != null) update[anchorId] = { contacts }
  if (previousId != null && previousId !== anchorId && internalUnits[previousId] && !update[previousId]) {
    update[previousId] = { contacts: [] }
  }
  return anchorId
}

// Coalition controller: the same interface as tacviewDetection.js's
// createFogFilter, with exposure decided by the real contacts. exposedIds are
// the enemies already sent before this filter took over; the first pass
// hides any of them the real contacts don't show.
function createRealContactsFilter(friendlyCoalitionId, exposedIds = []) {
  let exposedEnemyIds = new Set(exposedIds)
  let anchorId = null

  return {
    filterFrameUpdate(updated) {
      const publicUpdated = {}
      for (const [id, unit] of Object.entries(updated)) {
        if (unit.coalition === friendlyCoalitionId || exposedEnemyIds.has(id)) publicUpdated[id] = unit
      }
      return publicUpdated
    },

    computeVisibility(internalUnits, masks) {
      const { contacts, visible } = coalitionContacts(masks, friendlyCoalitionId, internalUnits)
      const contactsUpdate = {}
      anchorId = anchorContacts(contactsUpdate, internalUnits, friendlyCoalitionId, anchorId, contacts)
      const revealed = {}
      for (const id of visible) {
        if (!exposedEnemyIds.has(id)) revealed[id] = internalUnits[id]
      }
      const hidden = [...exposedEnemyIds].filter((id) => !visible.has(id))
      exposedEnemyIds = visible
      return { contactsUpdate, revealed, hidden }
    },

    forget(id) {
      exposedEnemyIds.delete(id)
      if (id === anchorId) anchorId = null
    },
  }
}

// GM/Admin: nothing is hidden, but red and blue each get their own contacts
// on their own anchor.
function createRealAllSidesDetector() {
  const anchors = { 1: null, 2: null }

  return {
    computeContacts(internalUnits, masks) {
      const update = {}
      for (const coalitionId of [1, 2]) {
        const { contacts } = coalitionContacts(masks, coalitionId, internalUnits)
        anchors[coalitionId] = anchorContacts(update, internalUnits, coalitionId, anchors[coalitionId], contacts)
      }
      return update
    },
  }
}

// Applies one contacts group message to the current map: 'full' replaces it,
// 'delta' merges, null removing an entry.
function applyContactsMessage(current, kind, data) {
  const next = kind === 'full' || !current ? {} : { ...current }
  if (data && typeof data === 'object') {
    for (const [key, mask] of Object.entries(data)) {
      if (mask === null) delete next[key]
      else if (typeof mask === 'number') next[key] = mask
    }
  }
  return next
}

module.exports = { createRealContactsFilter, createRealAllSidesDetector, applyContactsMessage }
