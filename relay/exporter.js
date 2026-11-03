'use strict'

// Exporter capability - receives data from TRACS's own DCS hook
// (dcs/Scripts/Hooks/TRACS-Exporter.lua) over a localhost TCP connection and
// serves it to TRACS backends over WebSocket (mounted at /data by
// relay/index.js).
//
// The hook only gathers while this module says someone wants the data: it
// sends {type:'demand', subscribers} whenever that changes, after a grace
// period on the way down so a backend reconnecting doesn't flap the hook
// between idle and awake. Waking the hook also sends {type:'resync'} so the
// first data after idle is a full snapshot. Keeping these decisions here,
// not in the hook, leaves the DCS side a plain executor that a native
// transport could replace without changing this file.
//
// Data arrives as named groups ({type:'data', group, kind, seq, t, data}).
// This module stores and forwards groups without knowing what's in them, so
// a new collector in the hook needs no change here.

const net = require('net')
const path = require('path')
const { gateConnection } = require('./auth')
const { getDetectionConfig } = require('./tacview')
const { loadMission } = require('./missionFile')
const { audienceFor } = require('./missionText')
const { createFrameMeter } = require('./frameMeter')
const { RELAY_DIR } = require('./paths')

const HOOK_PROTOCOL = 1
// One collector's output for a large mission can be big; anything past this
// without a newline is a broken peer.
const MAX_HOOK_LINE = 32 * 1024 * 1024

// Applies one data message to a group store. 'full' replaces the group;
// 'delta' merges keyed entries, with null meaning the key was removed.
function applyGroupMessage(groups, msg) {
  if (typeof msg.group !== 'string' || !msg.group) return false
  if (msg.kind === 'delta') {
    const current = groups[msg.group]
    const base = current && typeof current.data === 'object' && current.data !== null && !Array.isArray(current.data)
      ? { ...current.data } : {}
    if (msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data)) {
      for (const [key, value] of Object.entries(msg.data)) {
        if (value === null) delete base[key]
        else base[key] = value
      }
    }
    groups[msg.group] = { data: base, seq: msg.seq, t: msg.t }
  } else {
    groups[msg.group] = { data: msg.data, seq: msg.seq, t: msg.t }
  }
  return true
}

// One timing line: the group and kind, then every numeric field the hook
// sent (ms and bytes always; e.g. maxStepMs/steps/changed for sliced ones),
// then any text field (a diagnostic note), quoted.
function formatTiming(msg) {
  const entries = Object.entries(msg).filter(([k]) => k !== 'type' && k !== 'group' && k !== 'kind')
  const fields = entries
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(2)}`)
    .concat(entries.filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}=${JSON.stringify(v)}`))
  const kind = typeof msg.kind === 'string' ? ` (${msg.kind})` : ''
  return `${msg.group}${kind}: ${fields.join(' ')}`
}

// Splits a TCP stream into lines; returns the complete lines and the
// unfinished remainder.
function splitLines(buffer, chunk) {
  const lines = (buffer + chunk).split('\n')
  const rest = lines.pop() ?? ''
  return { lines: lines.filter((l) => l.trim() !== ''), rest }
}

function createExporter(wss, config) {
  const cfg = config.exporter
  const subscribers = new Set()
  let groups = {}
  let hookSocket = null
  let hookInfo = null
  let hookAwake = false
  let idleTimer = null
  let server = null
  // The running mission's file, read once per mission load
  // ({ key, id, theatre, texts } once read; see missionFile.js). Each
  // subscriber gets the text for its own coalition (missionText.js).
  let mission = null
  let missionKey = null
  let meterKey = null
  const meter = cfg.frameMeter ? createFrameMeter(path.join(RELAY_DIR, 'frame-meter')) : null

  function sendToHook(obj) {
    if (hookSocket && !hookSocket.destroyed) hookSocket.write(JSON.stringify(obj) + '\n')
  }

  function broadcast(obj) {
    const text = JSON.stringify(obj)
    for (const ws of subscribers) {
      if (ws.readyState === ws.OPEN) ws.send(text)
    }
  }

  function missionMessage(ws) {
    const audience = audienceFor(ws.tracsCoalition)
    if (!mission || !audience) return null
    return JSON.stringify({ type: 'exporterMission', mission: { id: mission.id, theatre: mission.theatre, text: mission.texts[audience] } })
  }

  function sendMission() {
    for (const ws of subscribers) {
      const msg = missionMessage(ws)
      if (msg && ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  // A new mission load (not a repeated hello for the same one, e.g. a status
  // update) drops the previous mission and reads this one's file.
  function missionLoaded(hello) {
    if (!cfg.missionData) return
    const key = `${hello.side}|${hello.loadTimeMs}|${hello.missionFile ?? ''}`
    if (key === missionKey) return
    missionKey = key
    mission = null
    if (!hello.loadTimeMs) {
      console.log('[relay:exporter] mission data unavailable - the DLL is older than the relay (no load time in hello)')
      return
    }
    loadMission(hello, { isCancelled: () => missionKey !== key }).then((result) => {
      if (missionKey !== key) return
      if (!result.ok) {
        if (result.error !== 'cancelled') console.warn(`[relay:exporter] mission data unavailable - ${result.error}`)
        return
      }
      mission = { key, id: result.id, theatre: result.theatre, texts: result.texts }
      console.log(`[relay:exporter] mission data read from ${result.file} (${(result.bytes / 1e6).toFixed(1)} MB, theatre=${result.theatre ?? 'unknown'})`)
      sendMission()
    })
  }

  // One frame-meter file per mission load (a repeated hello for the same
  // mission keeps writing to the same file).
  function meterStart(hello) {
    if (!meter) return
    const key = `${hello.side}|${hello.loadTimeMs}|${hello.missionFile ?? ''}`
    if (key === meterKey) return
    meterKey = key
    meter.start(hello)
  }

  function setAwake(awake) {
    clearTimeout(idleTimer)
    idleTimer = null
    if (awake === hookAwake) return
    hookAwake = awake
    sendToHook({ type: 'demand', subscribers: awake ? subscribers.size : 0, groups: null })
    if (awake) sendToHook({ type: 'resync' })
  }

  function subscribersChanged() {
    if (subscribers.size > 0) {
      setAwake(true)
    } else if (hookAwake && !idleTimer) {
      idleTimer = setTimeout(() => setAwake(false), cfg.idleGraceMs)
    }
  }

  function handleHookMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.v !== undefined && msg.v !== HOOK_PROTOCOL) {
      console.warn(`[relay:exporter] hook speaks protocol ${msg.v}, relay expects ${HOOK_PROTOCOL} - update the hook (or the relay)`)
    }
    switch (msg.type) {
      case 'hello':
        hookInfo = { side: msg.side, multiplayer: msg.multiplayer, theatre: msg.theatre, collectors: msg.collectors, dll: msg.dll }
        missionLoaded(msg)
        meterStart(msg)
        console.log(`[relay:exporter] hook connected - side=${msg.side} theatre=${msg.theatre ?? 'unknown'}`)
        if (msg.dll && !msg.dll.ok) {
          console.error(`[relay:exporter] exporter not collecting - ${msg.dll.error ?? 'DLL unavailable'}`)
        } else if (msg.dll?.pending) {
          console.log(`[relay:exporter] tracs_exporter.dll v${msg.dll.version} loaded - self-test waits for world objects`)
        } else if (msg.dll) {
          console.log(`[relay:exporter] tracs_exporter.dll v${msg.dll.version} ready`)
        }
        broadcast({ type: 'exporterHello', hook: hookInfo })
        break
      case 'data':
        if (applyGroupMessage(groups, msg)) {
          broadcast({ type: 'exporterData', group: msg.group, kind: msg.kind, seq: msg.seq, t: msg.t, data: msg.data })
        }
        break
      case 'events':
        broadcast({ type: 'exporterEvents', events: Array.isArray(msg.events) ? msg.events : [], dropped: msg.dropped ?? 0 })
        break
      case 'timing':
        if (cfg.logTimings) console.log(`[relay:exporter] timing ${formatTiming(msg)}`)
        meter?.record(msg)
        break
    }
  }

  function onHookConnection(socket) {
    // One hook at a time: a new connection (e.g. DCS restarted) replaces the old.
    if (hookSocket) hookSocket.destroy()
    hookSocket = socket
    hookAwake = false
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setNoDelay(true)

    sendToHook({
      type: 'config', v: HOOK_PROTOCOL, collectors: cfg.collectors, eventBufferSize: cfg.eventBufferSize,
      logTimings: cfg.logTimings, frameMeter: cfg.frameMeter,
    })
    if (subscribers.size > 0) setAwake(true)

    socket.on('data', (chunk) => {
      if (socket !== hookSocket) return
      const { lines, rest } = splitLines(buffer, chunk)
      buffer = rest
      if (buffer.length > MAX_HOOK_LINE) {
        console.error(`[relay:exporter] hook sent over ${MAX_HOOK_LINE} bytes without a line break - dropping it`)
        socket.destroy()
        return
      }
      for (const line of lines) {
        let msg
        try { msg = JSON.parse(line) } catch (err) {
          console.error('[relay:exporter] unparseable message from hook:', err.message)
          continue
        }
        handleHookMessage(msg)
      }
    })

    socket.on('close', () => {
      if (socket !== hookSocket) return
      hookSocket = null
      hookInfo = null
      hookAwake = false
      clearTimeout(idleTimer)
      idleTimer = null
      groups = {}
      mission = null
      missionKey = null
      meterKey = null
      meter?.stop()
      console.log('[relay:exporter] hook disconnected')
      broadcast({ type: 'exporterReset' })
    })

    socket.on('error', (err) => {
      if (socket !== hookSocket) return
      console.error(`[relay:exporter] hook connection error: ${err.code ?? err.message}`)
    })
  }

  if (cfg.enabled) {
    // Loopback only: the hook always runs on the same machine, and this port
    // carries unauthenticated mission data.
    server = net.createServer(onHookConnection)
    server.on('error', (err) => {
      console.error(`[relay:exporter] could not listen for the DCS hook on 127.0.0.1:${cfg.hookPort} - ${err.message}`)
    })
    server.listen(cfg.hookPort, '127.0.0.1', () => {
      console.log(`[relay:exporter] waiting for the DCS hook on 127.0.0.1:${cfg.hookPort}`)
    })
  } else {
    console.log('[relay:exporter] disabled in config - capability idle')
  }

  wss.on('connection', (ws, req) => {
    if (!cfg.enabled) {
      ws.close(4004, 'exporter disabled on this relay')
      return
    }
    gateConnection(ws, config.passwords, {
      req,
      label: 'data',
      onAuthenticated: (authMsg) => {
        ws.tracsCoalition = authMsg.coalition
        subscribers.add(ws)
        console.log(`[relay:exporter] client authenticated coalition=${authMsg.coalition} (total: ${subscribers.size})`)
        // The relay operator's detection and rate tuning, as /tacview sends
        // it; the backend's modelled fog of war uses it until real DCS
        // contacts arrive.
        ws.send(JSON.stringify({
          type: 'exporterConfig',
          detection: getDetectionConfig(),
          rates: {
            unitUpdateMs: config.unitUpdateMs,
            detectionMs: config.detectionMs,
            missileDetectionMs: config.missileDetectionMs,
          },
        }))
        ws.send(JSON.stringify({ type: 'exporterSnapshot', hook: hookInfo, groups }))
        const missionMsg = missionMessage(ws)
        if (missionMsg) ws.send(missionMsg)
        subscribersChanged()
      },
    })
    ws.on('close', () => {
      if (subscribers.delete(ws)) subscribersChanged()
    })
  })

  function stop() {
    clearTimeout(idleTimer)
    meter?.stop()
    hookSocket?.destroy()
    server?.close()
  }

  return { stop }
}

module.exports = { createExporter, applyGroupMessage, splitLines, formatTiming, HOOK_PROTOCOL }
