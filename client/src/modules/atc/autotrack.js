/**
 * .autotrack — automatically claim departures from chosen airports.
 *
 * APP/DEP/RDR: a bare `.autotrack` toggles the position's own airport. Any of
 * APP/DEP/RDR/CTR can list ICAOs (`.autotrack EDDF EHAM`) to toggle each one;
 * a bare `.autotrack` with any airport on turns them all off.
 *
 * One autotracker per airport. While autotrack is on, a position broadcasts
 * its airports (AUTOTRACK_STATE) on every change and every HEARTBEAT_MS;
 * an entry not heard from for EXPIRE_MS is ignored, so a position that leaves
 * or reloads (autotrack isn't persisted) drops out on its own. When two
 * positions take the same airport at once, the one that turned it on first
 * keeps it (then the lower position name), and every client works out the
 * same answer; the other drops it and is told.
 *
 * The departures themselves are detected by AutotrackDetector.jsx.
 */

import { useAutotrackStore }   from '../../store/autotrack.js'
import { useSessionStore }     from '../../store/session.js'
import { useRunwaysStore }     from '../../store/runways.js'
import { useControllersStore } from '../../store/controllers.js'
import { usePreviewStore }     from '../../store/preview.js'
import { sendWebrtcEvent }     from '../../webrtc/client.js'

const HEARTBEAT_MS = 30_000
const EXPIRE_MS    = 75_000
const POSITIONS    = ['APP', 'DEP', 'RDR', 'CTR']

let heartbeat = null

function controllerIdOf(positionName) {
  return useControllersStore.getState().registry[positionName]?.controllerId ?? positionName
}

function broadcast() {
  const { positionName } = useSessionStore.getState()
  if (!positionName) return
  sendWebrtcEvent('AUTOTRACK_STATE', { positionName, airports: useAutotrackStore.getState().mine })
}

function setMine(mine) {
  useAutotrackStore.getState().setMine(mine)
  const on = Object.keys(mine).length > 0
  if (on && !heartbeat) heartbeat = setInterval(broadcast, HEARTBEAT_MS)
  if (!on && heartbeat) { clearInterval(heartbeat); heartbeat = null }
}

// The other position holding this airport, or null.
function holderOf(icao) {
  const now = Date.now()
  for (const [positionName, { airports, heardAt }] of Object.entries(useAutotrackStore.getState().others)) {
    if (now - heardAt <= EXPIRE_MS && airports[icao] != null) return positionName
  }
  return null
}

// A new position (or signing off) starts with autotrack off.
useSessionStore.subscribe((s, prev) => {
  if (s.positionName !== prev.positionName && Object.keys(useAutotrackStore.getState().mine).length) setMine({})
})

/**
 * Toggle autotrack. icaos: the typed ICAOs (uppercased), possibly empty.
 * Returns { ok, msg } for the response line.
 */
export function toggleAutotrack(icaos) {
  const { positionSuffix, facilityId } = useSessionStore.getState()
  if (!POSITIONS.includes(positionSuffix)) return { ok: false, msg: 'ILL POS' }
  const mine = { ...useAutotrackStore.getState().mine }

  if (!icaos.length) {
    if (Object.keys(mine).length) {
      setMine({})
      broadcast()
      return { ok: true, msg: 'AUTOTRACK OFF' }
    }
    if (positionSuffix === 'CTR') return { ok: false, msg: 'FORMAT' }
    icaos = [facilityId]
  }

  const positions = useRunwaysStore.getState().airportPositions
  const unknown = icaos.find((icao) => !positions[icao])
  if (unknown) return { ok: false, msg: `AUTOTRACK: UNKNOWN ${unknown}` }

  const refused = []
  for (const icao of new Set(icaos)) {
    if (mine[icao] != null) { delete mine[icao]; continue }
    const holder = holderOf(icao)
    if (holder) { refused.push(`${icao}: ${controllerIdOf(holder)}`); continue }
    mine[icao] = Date.now()
  }
  setMine(mine)
  broadcast()

  const on = Object.keys(mine)
  const head = on.length ? `AUTOTRACK ON: ${on.join(' ')}` : (refused.length ? 'AUTOTRACK' : 'AUTOTRACK OFF')
  return { ok: true, msg: [head, ...refused].join(on.length ? '  ' : ' ') }
}

// AUTOTRACK_STATE from another position.
export function handleAutotrackState({ positionName, airports }) {
  const me = useSessionStore.getState().positionName
  if (!positionName || positionName === me) return
  const theirs = airports ?? {}
  useAutotrackStore.getState().setOther(positionName, theirs)

  const mine = { ...useAutotrackStore.getState().mine }
  const lost = []
  for (const [icao, since] of Object.entries(theirs)) {
    const ours = mine[icao]
    if (ours == null) continue
    if (since < ours || (since === ours && positionName < me)) {
      delete mine[icao]
      lost.push(icao)
    }
  }
  if (!lost.length) return
  setMine(mine)
  // Sends made while a received message is being applied are dropped, so
  // announce the change once this one is done.
  setTimeout(broadcast, 0)
  const cid = controllerIdOf(positionName)
  usePreviewStore.getState().setResponse(`AUTOTRACK ${lost.map((icao) => `${icao}: ${cid}`).join(' ')}`)
}
