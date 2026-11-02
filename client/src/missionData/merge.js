// The pure parts of loading mission data, shared by the stores and
// missionData/guard.js (and tested on their own).

// Status board rows for mission aircraft not on the board yet (by
// callsign), as a patch for the board's state `s`.
export function missionEntriesPatch(s, incoming) {
  const existing = new Set(s.entries.map(e => e.callsign).filter(Boolean))
  const toAdd = []
  let id = s.nextId
  for (const e of incoming) {
    if (e.callsign && existing.has(e.callsign)) continue
    existing.add(e.callsign)
    toAdd.push({
      id, fromMission: true,
      evt: '', callsign: e.callsign, unitId: null,
      sideNumber: e.modex, bcn: '', pilot: '', type: e.type, msn: e.task,
      atd: '', radial: '', bingo: '', appRad: '', eat: '', btn: '', dme: '', angels: '', state: '', ata: '',
    })
    id++
  }
  return { entries: [...s.entries, ...toAdd], nextId: id }
}

// The ATO's flights after auto-loading mission `missionId`'s flights into
// state `s`: a different mission than the one auto-loaded last replaces the
// imported flights (manual and .stm ones stay); the same one, or one after
// a manual load, only adds flights not there yet, so edits stay.
export function mergeMissionFlights(s, flights, missionId) {
  if (s.missionId && s.missionId !== missionId) {
    return { flights: [...flights, ...s.flights.filter(f => f.manual || f.source === 'stm')], replaced: true }
  }
  const have = new Set(s.flights.map(f => f.groupId))
  return { flights: [...s.flights, ...flights.filter(f => !have.has(f.groupId))], replaced: false }
}

// Whose turn it is among the P2P load intents for one area
// (Map peerId -> { joinedAt, at }): the earliest room join, ties broken by
// peer id so every peer picks the same one. Intents older than ttlMs (a
// peer that vanished) don't count.
export function intentWinner(entries, now = Date.now(), ttlMs = 30_000) {
  let best = null
  for (const [peerId, e] of entries) {
    if (now - e.at > ttlMs) continue
    if (!best || e.joinedAt < best.joinedAt || (e.joinedAt === best.joinedAt && peerId < best.peerId)) {
      best = { peerId, joinedAt: e.joinedAt }
    }
  }
  return best?.peerId ?? null
}
