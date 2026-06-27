import { useUnitsStore } from '../store/units'
import { useFlightPlansStore } from '../store/flightPlans'
import { useAtcStore } from '../store/atc'
import { useSessionStore } from '../store/session'
import { useStripsStore } from '../store/strips'
import { resolveCallsign } from '../utils/callsign'

const WS_URL = '/ws'
const RECONNECT_INTERVAL_MS = 3000

let socket = null
let reconnectTimer = null
let intentionalClose = false
let lastSessionHash = null

// Handlers registered by other modules (e.g. WebRTC layer) for server state hydration.
// Key is the state file key ('atc' | 'catcc' | 'session').
const stateHandlers = {}

export function registerStateHandler(key, handler) {
  stateHandlers[key] = handler
}

function dispatch(message) {
  switch (message.type) {
    case 'units_delta': {
      const delta        = message.data
      const currentUnits = useUnitsStore.getState().units

      // Sync strip AIDs before units are removed — captures the last-known callsign
      // so the fallback display after unit drop shows the correct callsign, not unit.id
      if (delta.removed) {
        const strips = useStripsStore.getState()
        for (const unitId of delta.removed) {
          const unit = currentUnits[unitId]
          if (unit) strips.renameAid(unitId, resolveCallsign(unit))
        }
      }

      useUnitsStore.getState().applyDelta(delta)

      // Sync strip AIDs for updated units — corrects strips whose AID was set to
      // unit.id at creation time because callsign data wasn't populated yet
      if (delta.updated) {
        const updatedUnits = useUnitsStore.getState().units
        const strips       = useStripsStore.getState()
        const stripList    = Object.values(strips.strips)
        for (const unitId of Object.keys(delta.updated)) {
          const unit = updatedUnits[unitId]
          if (!unit) continue
          const strip = stripList.find((s) => String(s.unitId) === unitId)
          if (!strip) continue
          if (!unit.callsign && !unit.unitName) continue  // dead/stub unit — no name data to rename from
          const callsign = resolveCallsign(unit)
          if (strip.aid !== callsign) strips.renameAid(unitId, callsign)
        }
      }
      break
    }

    case 'units_clear':
      useUnitsStore.getState().clearUnits()
      useFlightPlansStore.getState().reset()
      useAtcStore.getState().reset()
      break

    case 'mission': {
      const hash = message.data?.sessionHash ?? null
      if (hash && lastSessionHash && hash !== lastSessionHash) {
        useUnitsStore.getState().clearUnits()
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

    case 'status': {
      useSessionStore.getState().setConnected(message.data.polling === true)
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

    case 'state':
      stateHandlers[message.key]?.(message.data)
      break

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
    console.log('[ws] connected')
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
    console.log(`[ws] disconnected — reconnecting in ${RECONNECT_INTERVAL_MS}ms`)
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
