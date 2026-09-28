import { useUnitsStore } from '../store/units'
import { useWeaponsStore } from '../store/weapons'
import { useFlightPlansStore } from '../store/flightPlans'
import { useAtcStore } from '../store/atc'
import { useSessionStore } from '../store/session'
import { useStripsStore } from '../store/strips'
import { findFlightPlanAid } from '../utils/callsign'
import { log } from '../utils/log.js'

const WS_URL = '/ws'

// Server status reasons (routes/sourceConnect.js's onDisconnect) shown in the
// top bar next to DISCONNECTED.
// Server status reasons (server/src/linkStatus.js). The *_no_response ones
// name the source behind a NO RESPONSE: RECONNECTING; the rest explain a
// DISCONNECTED.
const CONNECTION_ISSUES = {
  olympus_no_response:     'Olympus',
  tacview_no_response:     'Tacview',
  relay_no_response:       'Relay',
  olympus_unreachable:     'Olympus not responding - retrying every 10 s',
  tacview_unreachable:     'Tacview rejected the RTT password - reconnect with the right one',
  relay_invalid_password:  'Relay rejected the password - reconnect with the right one',
  relay_protocol_mismatch: 'Relay and TRACS versions don’t match - update one of them',
}
const RECONNECT_INTERVAL_MS = 3000

let socket = null
let reconnectTimer = null
let intentionalClose = false
let lastSessionHash = null

function dispatch(message) {
  switch (message.type) {
    case 'units_delta': {
      const delta        = message.data
      const currentUnits = useUnitsStore.getState().units

      // Sync strip AIDs before units are removed — captures the last-known callsign
      // so the fallback display after unit drop shows the correct callsign, not unit.id
      if (delta.removed) {
        const strips = useStripsStore.getState()
        const plansAtRemoval = useFlightPlansStore.getState().plans
        for (const unitId of delta.removed) {
          const unit = currentUnits[unitId]
          if (unit) strips.renameAid(unitId, findFlightPlanAid(unit, plansAtRemoval))
        }
      }

      useUnitsStore.getState().applyDelta(delta)

      // Sync strip AIDs for updated units — corrects strips whose AID was set to
      // unit.id at creation time because callsign data wasn't populated yet
      if (delta.updated) {
        const updatedUnits = useUnitsStore.getState().units
        const strips       = useStripsStore.getState()
        const stripList    = Object.values(strips.strips)
        const plans        = useFlightPlansStore.getState().plans
        for (const unitId of Object.keys(delta.updated)) {
          const unit = updatedUnits[unitId]
          if (!unit) continue
          const strip = stripList.find((s) => String(s.unitId) === unitId)
          if (!strip) continue
          if (!unit.callsign && !unit.unitName) continue  // dead/stub unit — no name data to rename from
          const callsign = findFlightPlanAid(unit, plans)
          if (strip.aid !== callsign) strips.renameAid(unitId, callsign)
        }
      }
      break
    }

    case 'weapons_delta':
      useWeaponsStore.getState().applyDelta(message.data)
      break

    case 'units_clear':
      useUnitsStore.getState().clearUnits()
      useWeaponsStore.getState().clearWeapons()
      useFlightPlansStore.getState().reset()
      useAtcStore.getState().reset()
      break

    case 'mission': {
      const hash = message.data?.sessionHash ?? null
      if (hash && lastSessionHash && hash !== lastSessionHash) {
        useUnitsStore.getState().clearUnits()
        useWeaponsStore.getState().clearWeapons()
        useFlightPlansStore.getState().reset()
        useAtcStore.getState().reset()
      }
      if (hash) lastSessionHash = hash
      useSessionStore.getState().setMission(message.data)
      break
    }

    case 'airbases':
      useSessionStore.getState().setAirbases(message.data)
      break

    case 'bullseyes':
      useSessionStore.getState().setBullseyes(message.data)
      break

    case 'srs_status':
      useSessionStore.getState().setSrsIssue(message.data?.issue ?? null)
      break

    case 'status': {
      const polling  = message.data.polling === true
      const retrying = polling && message.data.retrying === true
      useSessionStore.getState().setConnected(polling)
      useSessionStore.getState().setConnectionRetrying(retrying)
      useSessionStore.getState().setConnectionIssue(
        polling && !retrying ? null : (CONNECTION_ISSUES[message.data.reason] ?? null)
      )
      useSessionStore.getState().setSourceType(message.data.sourceType ?? null)
      const instanceId = message.data.instanceId
      if (instanceId) {
        const prev = sessionStorage.getItem('tracs.serverInstanceId')
        if (prev && prev !== instanceId) {
          useAtcStore.getState().reset()
        }
        sessionStorage.setItem('tracs.serverInstanceId', instanceId)
      }
      break
    }

    default:
      console.warn('[ws] unknown message type:', message.type)
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  intentionalClose = false

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${protocol}://${location.host}${WS_URL}`

  socket = new WebSocket(url)

  socket.onopen = () => {
    log.info('[ws] connected')
    clearTimeout(reconnectTimer)
  }

  socket.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      console.error('[ws] failed to parse message:', event.data)
      return
    }
    dispatch(message)
  }

  socket.onclose = () => {
    if (intentionalClose) return
    log.info(`[ws] disconnected - reconnecting in ${RECONNECT_INTERVAL_MS}ms`)
    useSessionStore.getState().setConnected(false)
    reconnectTimer = setTimeout(connect, RECONNECT_INTERVAL_MS)
  }

  socket.onerror = (err) => {
    console.error('[ws] error:', err)
  }
}

function disconnect() {
  intentionalClose = true
  clearTimeout(reconnectTimer)
  if (socket) {
    socket.close()
    socket = null
  }
}

function reconnect() {
  intentionalClose = false
  disconnect()
  intentionalClose = false
  connect()
}

export const wsClient = { connect, disconnect, reconnect }
