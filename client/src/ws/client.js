import { useUnitsStore } from '../store/units'
import { useSessionStore } from '../store/session'

const WS_URL = '/ws'
const RECONNECT_INTERVAL_MS = 3000

let socket = null
let reconnectTimer = null
let intentionalClose = false

function dispatch(message) {
  switch (message.type) {
    case 'units_delta':
      useUnitsStore.getState().applyDelta(message.data)
      break

    case 'mission':
      useSessionStore.getState().setMission(message.data)
      break

    case 'airbases':
      useSessionStore.getState().setAirbases(message.data)
      break

    case 'status':
      useSessionStore.getState().setConnected(message.data.polling === true)
      break

    default:
      console.warn('[ws] unknown message type:', message.type)
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

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
