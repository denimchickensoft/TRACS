'use strict'

// The relay-hosted primary source, whichever one the relay serves: Tacview
// (tacviewRelayClient.js) or TRACS's own DCS exporter
// (exporterRelayClient.js). The relay's /health names it (`primary`), and at
// most one of the two clients is active at a time. Callers that only need to
// know whether the relay source is up use this rather than checking both.

const tacview = require('./tacviewRelayClient')
const exporter = require('./exporterRelayClient')

const clients = [tacview, exporter]

function activeClient() {
  return clients.find((c) => c.isActive()) ?? null
}

// Asks the relay which unit source it serves: 'exporter', 'tacview',
// 'unreachable' (no answer at all), or null for a relay too old to say, which
// the caller treats as Tacview.
async function fetchPrimary(relayUrl) {
  const healthUrl = `${relayUrl.replace(/\/+$/, '').replace(/^ws(s?):\/\//i, 'http$1://')}/health`
  let res
  try {
    res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) })
  } catch {
    return 'unreachable'
  }
  if (!res.ok) return null
  try {
    const body = await res.json()
    return body?.primary === 'exporter' || body?.primary === 'tacview' ? body.primary : null
  } catch {
    return null
  }
}

module.exports = {
  tacview,
  exporter,
  fetchPrimary,
  isConnected: () => clients.some((c) => c.isConnected()),
  isActive: () => activeClient() !== null,
  getLinkIssue: () => activeClient()?.getLinkIssue() ?? null,
  stop: () => { for (const c of clients) c.stop() },
}
