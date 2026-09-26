'use strict'

// Pure helpers + the delta-buffer factory shared between tacview.js (direct
// RTT mode) and tacviewRelayClient.js (relay-hosted mode) — the pure subset
// only. The theatre-vote-tracker and the direct-vs-relay dispatch logic
// (processIncoming vs applyTacviewData) stay independent in each file: they
// own module-level mutable state and encode a genuine relay-vs-direct-mode
// timing difference (the relay path has an extra async detection-config
// handshake window direct mode doesn't), not incidental duplication.

// Splits parseLines()'s/the relay's single mixed `updated` map by category —
// Tacview's wire format doesn't distinguish "kinds" of object at the
// transport level (classify() just assigns a category string per Type= tag),
// so units and missiles arrive interleaved and have to be separated here
// before their two very different visibility pipelines (fogFilter vs
// missileDetection.js).
function splitByCategory(updated) {
  const units = {}
  const weapons = {}
  for (const [id, obj] of Object.entries(updated)) {
    if (obj.category === 'Missile') weapons[id] = obj
    else units[id] = obj
  }
  return { units, weapons }
}

// Tacview's ReferenceTime is real-world UTC (confirmed live by its trailing
// 'Z', e.g. "2011-06-25T09:30:01Z"). DCS's own dateAndTime (what Olympus
// sends, and what useMissionClock()/toUtcDateTime() expect) is theatre-local
// relative to DCS's own INTERNAL clock — a separate thing from real-world
// UTC, skewed from it by its own fixed per-theatre amount (confirmed live:
// PersianGulf needed a real-UTC→local offset of +3.5, distinct
// from the existing +4 used for the internal-Zulu→local leg — see
// navdata.theatreTacviewRealUtcOffset()'s comment for the full story). This
// converts real UTC straight to the theatre-local shape the existing
// pipeline expects, using the Tacview-specific constant, not the Olympus one.
function computeDateAndTime(missionUtcMs, offsetHours) {
  const d = new Date(missionUtcMs + offsetHours * 3600000)
  return {
    date: { Day: d.getUTCDate(), Month: d.getUTCMonth() + 1, Year: d.getUTCFullYear() },
    time: { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() },
  }
}

// Marks a rejection with a specific, surfaceable reason — routes/
// sourceConnect.js's autoDetectSourceType (direct mode) and its
// usingRelayAsPrimary probe path (relay mode) both know how to distinguish
// this from a generic/unidentified failure.
function identifiedError(message) {
  return Object.assign(new Error(message), { identified: true })
}

// Encapsulates the accumulate-at-full-stream-rate / flush-at-rateConfig-
// interval pattern both files use twice (once for units, once for weapons).
// `applyFn` is state.applyDelta or state.applyWeaponsDelta (fixed at
// creation); `merge` selects the two files' two different queue semantics:
// units merge partial writes together (processIncoming's full unit vs.
// runDetectionPass's partial {contacts:[...]} racing into the same buffer
// before one flush would otherwise wholesale-replace each other — seen live
// as a radar-equipped unit's position freezing intermittently),
// weapons simply overwrite (no equivalent partial-write race for weapons).
//
// The delta callback (onUnitsDelta/onWeaponsDelta) is intentionally NOT
// captured at creation time — both are module-level `let`s reassigned by
// start()/stop() in the caller, so flush() takes the current callback value
// as a parameter each call, read fresh at the call site exactly as the
// original inline flushBroadcast()/flushWeaponsBroadcast() did.
function createDeltaBuffer({ applyFn, merge }) {
  let pendingUpdated = {}
  let pendingRemoved = new Set()

  function queue(updated, removed) {
    for (const [id, item] of Object.entries(updated)) {
      pendingUpdated[id] = merge ? { ...pendingUpdated[id], ...item } : item
      pendingRemoved.delete(id)
    }
    for (const id of removed) {
      delete pendingUpdated[id]
      pendingRemoved.add(id)
    }
  }

  function flush(onDelta) {
    if (Object.keys(pendingUpdated).length === 0 && pendingRemoved.size === 0) return
    const delta = { updated: pendingUpdated, removed: [...pendingRemoved], time: Date.now() }
    applyFn(delta)
    if (onDelta) onDelta(delta)
    pendingUpdated = {}
    pendingRemoved = new Set()
  }

  function reset() {
    pendingUpdated = {}
    pendingRemoved = new Set()
  }

  return { queue, flush, reset }
}

module.exports = { splitByCategory, computeDateAndTime, identifiedError, createDeltaBuffer }
