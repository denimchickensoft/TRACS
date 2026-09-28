'use strict'

const { statusPayload, srsStatusPayload } = require('../linkStatus')

// Registers /api/connect and its two theatre-override/reset companions —
// the source-type auto-detection, crash-avoidance cooldowns, and
// mutual-exclusivity teardown that carry essentially all of routes/api.js's
// real business logic. Split out from api.js's boilerplate REST passthrough
// (navdata/elevation/airports/etc.) — see registerApiRoutes's own comment
// for why `broadcast` is threaded in from the app-WS layer.
function registerSourceConnectRoutes(app, { sourceRegistry, srs, tacviewRelayClient, state, broadcast }) {
  // Races probe() across every registered source type, resolving to whichever
  // answers first. Only used when the request doesn't name a sourceType
  // (Login.jsx's source selector normally does). Each
  // source's own probe() is responsible for actually distinguishing itself
  // (e.g. tacview.js's probe waits for Tacview's unsolicited handshake greeting
  // rather than just checking the TCP connection succeeded, since a bare
  // connect would also succeed against Olympus's HTTP port).
  async function autoDetectSourceType(sourceCfg, sourceRegistry) {
    const attempts = sourceRegistry.SOURCE_TYPES.map((type) =>
      sourceRegistry.get(type).probe(sourceCfg).then(
        () => type,
        (err) => { throw Object.assign(err, { sourceType: type }) },
      )
    )
    try {
      return { sourceType: await Promise.any(attempts) }
    } catch (err) {
      // Promise.any's AggregateError swallows each attempt's specific reason
      // by default — log them individually (tagged with which source type,
      // server-side only) so a total failure is diagnosable. If any one of
      // them positively identified its protocol (e.g. Tacview's greeting
      // matched, then it rejected our password), surface that message as-is
      // to the client instead of the generic "nothing answered" one — it's
      // already specific and doesn't need a type tag, since it names its own
      // protocol in the text.
      const errors = err.errors ?? []
      for (const e of errors) console.error(`[autoDetect] ${e.sourceType}: ${e.message}`)
      const identified = errors.find((e) => e.identified)
      return { sourceType: null, error: identified?.message ?? null }
    }
  }

  // Stops every source unconditionally, not just the ones reporting
  // connected: a Tacview source between reconnect attempts reports
  // not-connected but still has live timers and a pending reconnect, and
  // skipping it left it broadcasting its own theatre (and later units)
  // alongside the new source. Each stop() is safe on an idle source.
  function stopAllSources(sourceRegistry) {
    for (const type of sourceRegistry.SOURCE_TYPES) {
      sourceRegistry.get(type).stop()
    }
    tacviewRelayClient.stop()
  }

  // Rapid repeated /api/connect calls each tear down and rebuild the live
  // Tacview RTT socket via stopAllSources()+start() (a browser relogin,
  // multiple controllers/tabs connecting around the same time, or just
  // re-clicking Connect) — Tacview's own RTT server can't tolerate that
  // churn and corrupts its internal state, crashing tacview.dll with an
  // ACCESS_VIOLATION on DCS's next export tick (reproduced live: three full
  // /api/connect cycles ~3-4s apart, the third crashing mid-handshake of the
  // second). The in-request double-probe within a single /api/connect is
  // handled separately (see the comment further down); this guards the gap
  // between *separate* requests. 5s comfortably covers the
  // observed 3-4s cadence with margin, without being so long it blocks a
  // genuine "fix my password, try again" retry.
  let lastTacviewConnectAt = 0
  const TACVIEW_RECONNECT_COOLDOWN_MS = 5000
  function tacviewReconnectTooSoon() {
    return Date.now() - lastTacviewConnectAt < TACVIEW_RECONNECT_COOLDOWN_MS
  }

  // POST /api/connect — start a primary data source with supplied credentials,
  // dispatched through sourceRegistry (including the two Tacview connection
  // modes: direct RTT, or via a TRACS relay).
  app.post('/api/connect', async (req, res) => {
    const { sourceType: requestedSourceType, relayUrl, ...sourceCfg } = req.body ?? {}

    // SRS relay — best-effort and optional, never probed and never blocks/fails
    // this request. A truthy relayUrl (re)starts the relay-client; an empty one
    // is treated as "no opinion" and leaves whatever's already running alone,
    // so a server-side default (TRACS_RELAY_URL) isn't silently undone by a
    // browser that never filled in the field.
    // Skip restarting when already connected with this exact relayUrl+password —
    // otherwise every login to a shared backend (any number of browsers can be
    // logged into one) would tear down and rebuild a perfectly working relay
    // connection for no reason, same class of check olympus.js's
    // alreadyOnSameSource does below.
    // relayPassword is only ever distinct from `password` in Tacview-Direct
    // mode with a relay also configured (Tacview's RTT password is flat, not
    // coalition-scoped, so it can't double as the relay's per-coalition
    // secret there) -- every other source mode leaves relayPassword unset
    // client-side, falling back to `password` here.
    const relayConfig = srs.getConfig()
    const relayAuthPassword = sourceCfg.relayPassword || sourceCfg.password
    const alreadyOnSameRelay = srs.isConnected()
      && relayConfig?.relayUrl === relayUrl
      && relayConfig?.password === relayAuthPassword
      && relayConfig?.coalition === sourceCfg.coalition
    if (relayUrl && !alreadyOnSameRelay) {
      srs.start(
        { relayUrl, password: relayAuthPassword, coalition: sourceCfg.coalition },
        {
          onUnitsDelta: (delta) => broadcast({ type: 'units_delta', data: delta }),
          onLinkIssue:  (issue) => broadcast({ type: 'srs_status', data: srsStatusPayload(issue) }),
        },
      )
    }

    // Fast path for the overwhelmingly common case a plain relogin/refresh
    // hits: the exact same primary source, same config, already live. Short-
    // circuits BEFORE autoDetectSourceType's probe race below (which itself
    // briefly connects to Tacview's RTT port) — not just before the restart
    // further down — since re-probing a source that's already known-good is
    // exactly the kind of unnecessary churn that contributed to the crashes
    // documented on tacviewReconnectTooSoon() above. Only applies to the
    // direct-source path (a truthy olympusUrl rules out usingRelayAsPrimary,
    // which has its own identical alreadyOnSameTvRelay check just above).
    if (sourceCfg.olympusUrl) {
      const currentType = state.getSourceType()
      const current = currentType ? sourceRegistry.get(currentType) : null
      const alreadyLiveOnSameConfig = current
        && (!requestedSourceType || requestedSourceType === currentType)
        && current.isPolling()
        && !current.isUnreachable?.()
        && current.getConfig()?.olympusUrl === sourceCfg.olympusUrl
      if (alreadyLiveOnSameConfig) {
        broadcast({ type: 'status', data: statusPayload(currentType, current.getLinkIssue?.() ?? null) })
        return res.json({ ok: true })
      }
    }

    // Relay-hosted Tacview as the PRIMARY source — relayUrl set with no
    // olympusUrl (a slot a future relay-hosted dataminer could share; a relay
    // only ever runs one occupant of it). Distinct from the SRS-relay block above, which always runs
    // whenever relayUrl is set, regardless of which primary source is active.
    const usingRelayAsPrimary = Boolean(relayUrl) && !sourceCfg.olympusUrl
    if (usingRelayAsPrimary) {
      const tvConfig = tacviewRelayClient.getConfig()
      const alreadyOnSameTvRelay = tacviewRelayClient.isConnected()
        && tvConfig?.relayUrl === relayUrl
        && tvConfig?.password === sourceCfg.password
        && tvConfig?.coalition === (sourceCfg.coalition ?? 'blue')
      if (!alreadyOnSameTvRelay) {
        if (tacviewReconnectTooSoon()) {
          return res.status(429).json({ error: 'Reconnected to Tacview too recently — wait a few seconds before trying again (rapid reconnects can crash Tacview’s DCS export)' })
        }
        // start() itself is fire-and-forget and never used to be checked here
        // at all -- a wrong coalition/password used to return {ok:true}
        // regardless, since nothing awaited whether the connection actually
        // authenticated. probe() (a separate, throwaway connection, same
        // pattern tacview.js's direct-mode probe already uses) catches that
        // before committing to a live connection.
        try {
          await tacviewRelayClient.probe({ relayUrl, password: sourceCfg.password ?? '', coalition: sourceCfg.coalition ?? 'blue' })
        } catch (err) {
          return res.status(502).json({ error: err.identified ? err.message : 'Cannot reach the relay for Tacview data — check the Relay Port and coalition password' })
        }
        lastTacviewConnectAt = Date.now()
        stopAllSources(sourceRegistry)
        state.setSourceType('tacview')
        tacviewRelayClient.start(
          { relayUrl, password: sourceCfg.password ?? '', coalition: sourceCfg.coalition ?? 'blue' },
          {
            onUnitsDelta:   (delta) => broadcast({ type: 'units_delta', data: delta }),
            onWeaponsDelta: (delta) => broadcast({ type: 'weapons_delta', data: delta }),
            onMission:      (data)  => broadcast({ type: 'mission',    data }),
            onBullseyes:    (data)  => broadcast({ type: 'bullseyes', data }),
            onLinkIssue:    (issue) => broadcast({ type: 'status', data: statusPayload('tacview', issue) }),
          }
        )
        broadcast({ type: 'units_clear' })
      }
      broadcast({ type: 'status', data: statusPayload('tacview', tacviewRelayClient.getLinkIssue()) })
      return res.json({ ok: true })
    }

    if (!sourceCfg.olympusUrl) {
      return res.status(400).json({ error: 'olympusUrl is required' })
    }
    sourceCfg.password   = sourceCfg.password   ?? ''
    sourceCfg.coalition  = sourceCfg.coalition  ?? 'blue'

    let sourceType = requestedSourceType
    let alreadyProbed = false
    if (!sourceType) {
      const detected = await autoDetectSourceType(sourceCfg, sourceRegistry)
      sourceType = detected.sourceType
      alreadyProbed = true
      if (!sourceType) {
        return res.status(502).json({ error: detected.error ?? 'Cannot reach any known source type at that address' })
      }
    }

    const source = sourceRegistry.get(sourceType)
    if (!source) {
      return res.status(400).json({ error: `unknown sourceType: ${sourceType}` })
    }

    // Skip probe + restart only when already polling the same source with the
    // same config — a simultaneous probe to the same server triggers a 426
    // from Olympus. A different config is a reconnect, so probe and restart.
    // coalition/password both matter here, not just olympusUrl: coalition
    // picks Olympus's auth role header and Tacview's fogFilter side, so a
    // coalition-only change at the same address is a genuine reconnect, not
    // a duplicate of the same session.
    const alreadyOnSameSource = state.getSourceType() === sourceType
      && source.isPolling()
      && !source.isUnreachable?.()
      && source.getConfig()?.olympusUrl === sourceCfg.olympusUrl
      && source.getConfig()?.coalition === sourceCfg.coalition
      && source.getConfig()?.password === sourceCfg.password
    if (!alreadyOnSameSource) {
      // autoDetectSourceType() above already completed a full probe cycle for
      // `sourceType` moments ago (that's how it was identified) — re-probing
      // here would be a second connect/handshake/disconnect round-trip against
      // the same server in near-zero elapsed time. Harmless against Olympus,
      // but observed live (DCS crash log) to land two back-to-back
      // Tacview RTT connections close enough together to crash tacview.dll
      // with an ACCESS_VIOLATION on its next export tick — so only probe here
      // when `sourceType` was client-specified and genuinely never probed yet.
      if (sourceType === 'tacview' && tacviewReconnectTooSoon()) {
        return res.status(429).json({ error: 'Reconnected to Tacview too recently — wait a few seconds before trying again (rapid reconnects can crash Tacview’s DCS export)' })
      }

      // A successful Tacview probe (here or in auto-detect) leaves its
      // connection open, and source.start() below adopts it, so the probe
      // and the live feed are one RTT connection (see tacview.js probe()).
      if (!alreadyProbed) {
        try {
          await source.probe(sourceCfg)
        } catch (err) {
          const label = sourceType === 'olympus' ? 'Olympus' : 'Tacview'
          return res.status(502).json({ error: err.identified || err.describesItself ? err.message : `Cannot reach ${label}: ${err.message}` })
        }
      }

      // Mutual exclusivity — stop every other source (including relay-hosted
      // Tacview, if that was active) before starting this one.
      stopAllSources(sourceRegistry)

      if (sourceType === 'tacview') lastTacviewConnectAt = Date.now()
      state.setSourceType(sourceType)
      source.start(
        sourceCfg,
        {
          onUnitsDelta:   (delta) => broadcast({ type: 'units_delta', data: delta }),
          onWeaponsDelta: (delta) => broadcast({ type: 'weapons_delta', data: delta }),
          onMission:      (data)  => broadcast({ type: 'mission',    data }),
          onAirbases:     (data)  => broadcast({ type: 'airbases',  data }),
          onBullseyes:    (data)  => broadcast({ type: 'bullseyes', data }),
          onLinkIssue:    (issue) => broadcast({ type: 'status', data: statusPayload(sourceType, issue) }),
        }
      )
      broadcast({ type: 'units_clear' })
    }

    // Notify all currently-connected WS clients that polling has started (or is
    // already running). This covers new browser windows joining an active session.
    broadcast({ type: 'status', data: statusPayload(sourceType, source.getLinkIssue?.() ?? null) })

    res.json({ ok: true })
  })

  // POST /api/tacview/theatre-override — Login.jsx's Theatre control
  // (Tacview-only: bbox auto-detection alone can't always be trusted, e.g.
  // the unbreakable
  // MarianaIslands/MarianaIslandsWWII bbox tie). Dispatches to whichever
  // Tacview connection mode is actually active — direct (sourceRegistry) or
  // relay-hosted-primary (tacviewRelayClient) — same distinction /api/connect
  // itself has to make.
  app.post('/api/tacview/theatre-override', (req, res) => {
    const { theatre } = req.body ?? {}
    if (!theatre) return res.status(400).json({ error: 'theatre is required' })
    const tacview = sourceRegistry.get('tacview')
    if (tacviewRelayClient.isConnected()) {
      tacviewRelayClient.overrideTheatre(theatre)
    } else if (tacview.isPolling()) {
      tacview.overrideTheatre(theatre)
    } else {
      return res.status(409).json({ error: 'no active Tacview source to override' })
    }
    res.json({ ok: true })
  })

  // POST /api/tacview/theatre-reset — undo a theatre override (or a bad
  // initial auto-vote) and re-run detection over a fresh window, without
  // touching the live Tacview connection (a browser relogin alone can't do
  // this — see /api/connect's alreadyOnSameSource skip above).
  app.post('/api/tacview/theatre-reset', (req, res) => {
    const tacview = sourceRegistry.get('tacview')
    if (tacviewRelayClient.isConnected()) {
      tacviewRelayClient.resetTheatreDetection()
    } else if (tacview.isPolling()) {
      tacview.resetTheatreDetection()
    } else {
      return res.status(409).json({ error: 'no active Tacview source to reset' })
    }
    res.json({ ok: true })
  })
}

module.exports = { registerSourceConnectRoutes }
