'use strict'

// Short exclusive locks the sync relay hands out within a room
// (syncRelay.js's `lease` message). TRACS uses one to load the running
// mission into a store every controller in the room shares (the CATCC
// status board, flight plans): whoever holds the lock loads and broadcasts,
// and anyone after it finds the data already there. Two controllers loading
// at the same moment would otherwise each broadcast their own copy and end
// up holding each other's.
//
// A lease lapses on its own after ttlMs, so a holder that vanished
// mid-load can't block the room; it's also freed when its holder releases
// it or disconnects. Nothing is persisted: it only orders loads.

const DEFAULT_TTL_MS = 15_000

// onFree(key) is called whenever a held lease ends (released, lapsed or its
// holder gone), so the room can be told it may try again.
function createLeases({ ttlMs = DEFAULT_TTL_MS, onFree = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  const held = new Map() // key -> { holder, timer }

  function end(key) {
    const lease = held.get(key)
    if (!lease) return
    timers.clearTimeout(lease.timer)
    held.delete(key)
    onFree(key)
  }

  // { granted: true } or { granted: false, holder }. The current holder
  // asking again renews its lease.
  function acquire(key, holder) {
    const lease = held.get(key)
    if (lease && lease.holder !== holder) return { granted: false, holder: lease.holder }
    if (lease) timers.clearTimeout(lease.timer)
    held.set(key, { holder, timer: timers.setTimeout(() => end(key), ttlMs) })
    return { granted: true }
  }

  // Only the holder can release; false if it wasn't holding it.
  function release(key, holder) {
    if (held.get(key)?.holder !== holder) return false
    end(key)
    return true
  }

  // Everything this holder holds, e.g. when its connection closes.
  function releaseAll(holder) {
    for (const [key, lease] of [...held]) if (lease.holder === holder) end(key)
  }

  function holderOf(key) {
    return held.get(key)?.holder ?? null
  }

  function clear() {
    for (const lease of held.values()) timers.clearTimeout(lease.timer)
    held.clear()
  }

  return { acquire, release, releaseAll, holderOf, clear }
}

module.exports = { createLeases, DEFAULT_TTL_MS }
