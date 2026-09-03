'use strict'

// App-WS layer: tracks connected browser clients and broadcasts server-side
// events (unit deltas, mission/airbases/bullseyes updates, status) to all of
// them. Also hydrates a newly-connected client with the current snapshot +
// persisted state files.
function createWsBroadcast(wss, { state, stateFiles, sourceRegistry, serverInstanceId }) {
  const clients = new Set()

  wss.on('connection', (ws) => {
    clients.add(ws)
    console.log(`[ws] client connected (total: ${clients.size})`)

    // Send full unit snapshot to newly connected browser
    const snapshot = state.getSnapshot()
    if (Object.keys(snapshot.updated).length > 0) {
      ws.send(JSON.stringify({ type: 'units_delta', data: snapshot }))
    }

    // Send mission/airbases if available
    const mission = state.getMission()
    if (mission) ws.send(JSON.stringify({ type: 'mission', data: mission }))

    const airbases = state.getAirbases()
    if (airbases && typeof airbases === 'object' && Object.keys(airbases).length > 0)
      ws.send(JSON.stringify({ type: 'airbases', data: airbases }))

    const bullseyes = state.getBullseyes()
    if (bullseyes) ws.send(JSON.stringify({ type: 'bullseyes', data: bullseyes }))

    // Status — includes instanceId so clients can detect server restarts
    const sourceType = state.getSourceType()
    const polling = sourceRegistry.get(sourceType)?.isPolling() ?? false
    ws.send(JSON.stringify({ type: 'status', data: { polling, sourceType, instanceId: serverInstanceId } }))

    // Send persisted state files so the browser can hydrate after refresh.
    // If intentionalReset is true (deliberate position change), send defaults
    // and clear the flag so the next connection gets a clean slate.
    const sessionState = stateFiles.read('session')
    if (sessionState.intentionalReset) {
      stateFiles.setIntentionalReset(false)
      ws.send(JSON.stringify({ type: 'state', key: 'atc',     data: stateFiles.DEFAULTS.atc }))
      ws.send(JSON.stringify({ type: 'state', key: 'catcc',   data: stateFiles.DEFAULTS.catcc }))
      ws.send(JSON.stringify({ type: 'state', key: 'session', data: { ...stateFiles.DEFAULTS.session, olympusAddress: sessionState.olympusAddress } }))
    } else {
      ws.send(JSON.stringify({ type: 'state', key: 'atc',     data: stateFiles.read('atc') }))
      ws.send(JSON.stringify({ type: 'state', key: 'catcc',   data: stateFiles.read('catcc') }))
      ws.send(JSON.stringify({ type: 'state', key: 'session', data: sessionState }))
    }

    ws.on('close', () => {
      clients.delete(ws)
      console.log(`[ws] client disconnected (total: ${clients.size})`)
      if (clients.size === 0) {
        stateFiles.patch('session', { clientList: [] })
        console.log('[ws] all clients gone — session clientList cleared')
      }
    })

    ws.on('error', (err) => {
      if (err.code === 'ECONNRESET') return
      console.error('[ws] client error:', err.message)
    })
  })

  function broadcast(message) {
    const payload = JSON.stringify(message)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload)
      }
    }
  }

  function getWsClientCount() {
    return clients.size
  }

  return { broadcast, getWsClientCount }
}

module.exports = { createWsBroadcast }
