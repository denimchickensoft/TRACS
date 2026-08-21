'use strict'

// Trystero signal relay — simple WebSocket pub/sub broker implementing the
// @trystero-p2p/ws-relay server protocol. Browsers connect here instead of
// public Nostr relays so signaling is local and reliable for LAN/offline
// deployments.
function createSignalRelay(signalWss) {
  const signalTopics = new Map()      // topic → Set<WebSocket>
  const signalSocks  = new WeakMap()  // WebSocket → Set<topic>

  function sigSubscribe(ws, topic) {
    let subs = signalTopics.get(topic)
    if (!subs) { subs = new Set(); signalTopics.set(topic, subs) }
    subs.add(ws)
    let mine = signalSocks.get(ws)
    if (!mine) { mine = new Set(); signalSocks.set(ws, mine) }
    mine.add(topic)
  }

  function sigUnsubscribe(ws, topic) {
    signalSocks.get(ws)?.delete(topic)
    const subs = signalTopics.get(topic)
    if (!subs) return
    subs.delete(ws)
    if (subs.size === 0) signalTopics.delete(topic)
  }

  function sigPublish(topic, payload) {
    const msg = JSON.stringify({ topic, payload })
    const subs = signalTopics.get(topic)
    if (!subs) return
    for (const ws of subs) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  signalWss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) } catch { return }
      if (!msg || typeof msg.topic !== 'string') return
      if (msg.type === 'subscribe')                              sigSubscribe(ws, msg.topic)
      else if (msg.type === 'unsubscribe')                       sigUnsubscribe(ws, msg.topic)
      else if (msg.type === 'publish' && msg.payload !== undefined) sigPublish(msg.topic, msg.payload)
    })
    ws.on('close', () => {
      for (const topic of signalSocks.get(ws) ?? []) sigUnsubscribe(ws, topic)
    })
    ws.on('error', (err) => {
      if (err.code !== 'ECONNRESET') console.error('[signal] ws error:', err.message)
    })
  })
}

module.exports = { createSignalRelay }
