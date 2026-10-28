'use strict'

// Dev tool: subscribes to a relay's /data path and prints a one-line summary
// of everything the exporter sends. Being a subscriber is what wakes the DCS
// hook, so this is also how to make it collect before any TRACS backend
// consumes /data.
//
//   node scripts/exporter-tap.js [ws://127.0.0.1:8765/data] [coalition] [password]

const WebSocket = require('ws')
const { PROTOCOL_VERSION } = require('../protocolVersion')

const [url = 'ws://127.0.0.1:8765/data', coalition = 'blue', password = ''] = process.argv.slice(2)

function summarize(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) return `${Object.keys(data).length} keys`
  if (Array.isArray(data)) return `${data.length} items`
  return JSON.stringify(data)
}

const ws = new WebSocket(url)
ws.on('open', () => {
  console.log(`[tap] connected to ${url} - authenticating as ${coalition}`)
  ws.send(JSON.stringify({ type: 'auth', coalition, password, protocolVersion: PROTOCOL_VERSION }))
})
ws.on('message', (raw) => {
  const text = raw.toString('utf8')
  let msg
  try { msg = JSON.parse(text) } catch { console.log('[tap] unparseable message'); return }
  const time = new Date().toISOString().slice(11, 19)
  switch (msg.type) {
    case 'auth_ok':
      console.log(`[tap] ${time} authenticated (relay ${msg.relayVersion})`)
      break
    case 'exporterSnapshot':
      console.log(`[tap] ${time} snapshot - hook ${msg.hook ? JSON.stringify(msg.hook) : 'not connected'}, groups: ${Object.keys(msg.groups ?? {}).join(', ') || 'none'}`)
      break
    case 'exporterHello':
      console.log(`[tap] ${time} hook connected ${JSON.stringify(msg.hook)}`)
      break
    case 'exporterData':
      console.log(`[tap] ${time} ${msg.group} #${msg.seq} ${msg.kind} - ${summarize(msg.data)}, ${text.length} bytes`)
      break
    case 'exporterEvents':
      console.log(`[tap] ${time} ${msg.events.length} event(s)${msg.dropped ? `, ${msg.dropped} dropped` : ''}`)
      break
    case 'exporterReset':
      console.log(`[tap] ${time} hook disconnected`)
      break
    default:
      console.log(`[tap] ${time} ${msg.type}`)
  }
})
ws.on('close', (code, reason) => {
  console.log(`[tap] closed ${code} ${reason}`)
  process.exit(0)
})
ws.on('error', (err) => console.error(`[tap] ${err.message}`))
