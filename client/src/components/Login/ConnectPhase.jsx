import { useState, useEffect, useRef, useMemo } from 'react'
import { useSessionStore } from '../../store/session'
import { wsClient } from '../../ws/client'
import { checkSyncCapable } from '../../webrtc/syncClient'
import {
  loadServerProfiles, upsertServerProfile, toggleFavoriteProfile,
  removeServerProfile, findProfileByName, filterServerProfiles, getMostRecentProfile,
  loadLastConnection, saveLastConnection, parseHostPort,
} from '../../utils/serverProfiles'

// Round-trips parseHostPort()'s output back into what the Server URL field
// should display: bare host for the (default) http case, 'https://host' when
// the saved URL was explicitly https — so a saved HTTPS profile doesn't
// silently downgrade to http on reload.
function displayHost({ host, protocol }) {
  return protocol === 'https' ? `https://${host}` : host
}

// Splits a user-typed Server URL into its explicit scheme (if any) and the
// rest, so composedOlympusUrl/composedStorageUrl can preserve whatever
// scheme was typed instead of forcing http://. Defaults to 'http' when no
// scheme is present — never fabricates https.
function splitScheme(raw) {
  const match = raw.trim().match(/^(https?):\/\//i)
  return {
    scheme: match ? match[1].toLowerCase() : 'http',
    rest:   raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
  }
}

const COALITION_OPTIONS = [
  { value: 'blue',  label: 'Blue Commander' },
  { value: 'red',   label: 'Red Commander'  },
  { value: 'gm',    label: 'Game Master'    },
  { value: 'admin', label: 'Admin'          },
]

// Primary data source — an explicit choice, not auto-detected. 'relay' is
// named for the relay itself, not for Tacview — what it forwards is a
// relay-operator config choice, invisible to the controller.
const SOURCE_MODES = [
  { value: 'olympus',        label: 'Olympus' },
  { value: 'tacview-direct', label: 'Tacview' },
  { value: 'relay',          label: 'Relay' },
]

// ── Phase 1: Connect to Olympus ───────────────────────────────────────────────
export function ConnectPhase({ onConnected }) {
  const [profiles,   setProfiles]   = useState(() => loadServerProfiles())
  const lastConnection = useMemo(() => loadLastConnection(), [])
  const lastProfile = useMemo(() => getMostRecentProfile(profiles), [profiles])
  const [sourceMode, setSourceMode] = useState(() => lastConnection?.sourceType ?? lastProfile?.sourceType ?? 'olympus')
  const [name,       setName]       = useState(() => lastConnection?.name ?? lastProfile?.name ?? '')
  const [serverHost, setServerHost] = useState(() => displayHost(parseHostPort(lastConnection?.url ?? lastProfile?.url ?? '')))
  const [sourcePort, setSourcePort] = useState(() => parseHostPort(lastConnection?.url ?? lastProfile?.url ?? '').port)
  const [coalition,  setCoalition]  = useState(() => lastConnection?.coalition ?? lastProfile?.lastCoalition ?? localStorage.getItem('tracs.lastCoalition') ?? 'blue')
  // Meaning depends on sourceMode: Olympus/Relay -> genuinely per-coalition
  // (profile.passwords[coalition]); Tacview-Direct -> Tacview's own flat RTT
  // password (profile.tacviewPassword), never coalition-keyed.
  const [password,   setPassword]   = useState(() => lastConnection?.password
    ?? (sourceMode === 'tacview-direct' ? lastProfile?.tacviewPassword : lastProfile?.passwords?.[coalition]) ?? '')
  // XPNDR port is optional — most deployments have no relay at all. Same host
  // as the server above by construction (the relay only ever runs alongside
  // Olympus/SRS), so there's nothing to guess or type separately except the port.
  const [xpndrPort,  setXpndrPort]  = useState(() => parseHostPort(lastConnection?.relayUrl ?? lastProfile?.relayUrl ?? '').port)
  // Only meaningful (and only ever shown) in Tacview-Direct mode with Relay
  // Port also filled — the relay's genuinely per-coalition secret, distinct
  // from the flat Tacview RTT password above in that one combination.
  const [relayPassword, setRelayPassword] = useState(() => lastConnection?.relayPassword ?? lastProfile?.relayPasswords?.[coalition] ?? '')
  const [error,        setError]        = useState(null)
  // Non-blocking — a relay-sync problem never prevents connecting, unlike
  // `error` above (which is exclusively for Olympus failures). Distinct
  // state so the two can never be conflated into one blocking/non-blocking
  // decision by accident.
  const [relayWarning, setRelayWarning] = useState(null)
  const [connecting,   setConnecting]   = useState(false)
  // True once the Olympus connect has succeeded but a relay warning needs to
  // be shown before advancing — set alongside relayWarning, never independently.
  const [awaitingContinue, setAwaitingContinue] = useState(false)

  const [showDropdown,      setShowDropdown]      = useState(false)
  const [confirmDeleteName, setConfirmDeleteName] = useState(null)
  const [confirmOverwrite, setConfirmOverwrite]   = useState(false)
  const [saveStatus,       setSaveStatus]         = useState(null) // null | 'saved'
  const saveStatusTimer = useRef(null)
  useEffect(() => () => clearTimeout(saveStatusTimer.current), [])

  const { setConnection, setSyncCapable } = useSessionStore()

  // Always show the full favorites+recents list — typing shouldn't filter it out from under the user.
  const filteredProfiles = useMemo(
    () => filterServerProfiles(profiles, ''),
    [profiles]
  )

  // Re-fill the password when the role changes, if the current name matches a
  // saved profile — skipped in Tacview-Direct mode, where the primary
  // password is Tacview's flat RTT password, not coalition-keyed at all;
  // re-running this there would silently stomp it with an unrelated lookup.
  useEffect(() => {
    if (sourceMode === 'tacview-direct') return
    const match = findProfileByName(profiles, name)
    if (match) setPassword(match.passwords[coalition] ?? '')
  }, [coalition]) // eslint-disable-line

  // serverHost + sourcePort → the composed olympusUrl the backend expects.
  // Blank exclusively in Relay mode — that's the explicit signal the mode
  // selector already carries for the backend's usingRelayAsPrimary dispatch
  // (routes/api.js). A blank Source Port in Olympus/Tacview-Direct mode is
  // NOT a signal for anything anymore (that was the old pre-selector
  // auto-detect convention) — it just means "use the scheme's standard port",
  // e.g. a reverse-proxied https://host with no port exposed at all.
  // NOTE: this is for the /api/connect payload only — see composedStorageUrl
  // below for saved-profile/last-connection persistence, which must keep
  // remembering the host even when Source Port is intentionally blank.
  function composedOlympusUrl(host = serverHost, port = sourcePort) {
    // Forced blank in Relay mode regardless of `port`'s actual value — Source
    // Port is hidden in this mode, but its state could still hold a stale
    // value from before a mode switch; relying on "happens to be blank" is
    // exactly the implicit-inference pattern this selector replaces.
    if (sourceMode === 'relay' || !host.trim()) return ''
    const { scheme, rest } = splitScheme(host)
    return port ? `${scheme}://${rest}:${port}` : `${scheme}://${rest}`
  }

  // Same composition, but for persistence (saved profiles, last-connection) —
  // always keeps the host, with or without a port, unlike composedOlympusUrl()
  // above. A relay-hosted-primary profile (blank Source Port) still has a
  // real Server URL the user typed and expects to see again on reload; it's
  // only the /api/connect payload that needs it blank, to signal
  // usingRelayAsPrimary to the backend. parseHostPort() round-trips a
  // portless "http://host" (or "https://host") back into { host, port: '',
  // protocol } correctly.
  function composedStorageUrl(host = serverHost, port = sourcePort) {
    const { scheme, rest } = splitScheme(host)
    return port ? `${scheme}://${rest}:${port}` : `${scheme}://${rest}`
  }

  // Same host, XPNDR port instead — empty port means "no relay configured",
  // never a guess, since the relay always lives alongside Olympus/Tacview.
  // An https:// server host means TLS in front of the DCS server (see the
  // README's relay TLS setup), so the relay is reached over wss:// too.
  function composedRelayUrl(host = serverHost, port = xpndrPort) {
    if (!port) return ''
    const { scheme, rest } = splitScheme(host)
    return `${scheme === 'https' ? 'wss' : 'ws'}://${rest}:${port}`
  }

  function handleSelectProfile(profile) {
    const profileCoalition = profile.lastCoalition ?? coalition
    const profileMode = profile.sourceType ?? 'olympus'
    const source = parseHostPort(profile.url)
    const relay  = parseHostPort(profile.relayUrl)
    setName(profile.name)
    setSourceMode(profileMode)
    setServerHost(displayHost(source))
    setSourcePort(source.port)
    setCoalition(profileCoalition)
    setPassword(profileMode === 'tacview-direct' ? (profile.tacviewPassword ?? '') : (profile.passwords?.[profileCoalition] ?? ''))
    setRelayPassword(profile.relayPasswords?.[profileCoalition] ?? '')
    setXpndrPort(relay.port)
    setShowDropdown(false)
  }

  function handleToggleFavorite(profileName) {
    setProfiles((prev) => toggleFavoriteProfile(prev, profileName))
  }

  function handleDelete(profileName) {
    setProfiles((prev) => removeServerProfile(prev, profileName))
    setConfirmDeleteName(null)
  }

  function persistProfile() {
    const normalizedUrl = composedStorageUrl()
    const effectiveRelayPassword = (sourceMode === 'tacview-direct' && xpndrPort) ? relayPassword : ''
    setProfiles((prev) => upsertServerProfile(prev, {
      name, url: normalizedUrl, coalition, password, relayUrl: composedRelayUrl(),
      sourceType: sourceMode, relayPassword: effectiveRelayPassword,
    }))
    setConfirmOverwrite(false)
    setSaveStatus('saved')
    clearTimeout(saveStatusTimer.current)
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 1500)
  }

  function handleSaveClick() {
    if (!name.trim()) return
    if (findProfileByName(profiles, name)) {
      setConfirmOverwrite(true)
      return
    }
    persistProfile()
  }

  async function handleConnect(e) {
    e.preventDefault()
    setError(null)
    setRelayWarning(null)
    setConnecting(true)

    const normalizedUrl = composedOlympusUrl()
    const storageUrl    = composedStorageUrl()
    const relayUrl = composedRelayUrl()
    // Sent explicitly now instead of relying on the backend's probe-race
    // auto-detect (which still exists and still works as a fallback, but
    // Login no longer needs it) — collapses to the 2-way dispatch distinction
    // routes/api.js actually cares about; Relay mode needs neither field, its
    // dispatch is already driven purely by relayUrl + blank olympusUrl.
    const requestedSourceType = sourceMode === 'olympus' ? 'olympus' : 'tacview'
    // Only genuinely distinct from `password` in Tacview-Direct mode with a
    // relay also configured (Tacview's RTT password is flat, not
    // coalition-scoped, so it can't double as the relay's secret).
    const effectiveRelayPassword = (sourceMode === 'tacview-direct' && xpndrPort) ? relayPassword : ''
    const syncPassword = effectiveRelayPassword || password

    // Checked in parallel with the Olympus connect below, not after sign-in —
    // this is the one place in the flow that already has password/relayUrl in
    // hand, already gates on an async check, and already has somewhere to show
    // a result.
    const syncCheck = relayUrl
      ? checkSyncCapable({ relayUrl, coalition, password: syncPassword })
      : Promise.resolve({ capable: false })

    try {
      const [res, syncResult] = await Promise.all([
        fetch('/api/connect', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            sourceType: sourceMode === 'relay' ? undefined : requestedSourceType,
            olympusUrl: normalizedUrl, password, coalition, relayUrl,
            relayPassword: effectiveRelayPassword,
          }),
        }),
        syncCheck,
      ])

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Server responded ${res.status}`)
      }

      // Relay-sync outcome never blocks connecting (unlike the Olympus check
      // above) — P2P remains fully functional as a fallback. Only "no relay
      // configured" stays silent; a rejected password or an unreachable relay
      // are both surfaced so the controller isn't left unknowingly on the
      // fallback transport.
      setSyncCapable(!!relayUrl && syncResult.capable)

      localStorage.setItem('tracs.lastCoalition', coalition)
      saveLastConnection({ name, url: storageUrl, coalition, password, relayUrl, sourceType: sourceMode, relayPassword: effectiveRelayPassword })
      if (name.trim()) {
        setProfiles((prev) => upsertServerProfile(prev, {
          name, url: storageUrl, coalition, password, relayUrl,
          sourceType: sourceMode, relayPassword: effectiveRelayPassword,
        }))
      }
      setConnection({ olympusUrl: normalizedUrl, coalition, password, relayUrl, relayPassword: syncPassword, sourceType: requestedSourceType })
      wsClient.connect()

      // A relay warning holds the phase transition here so the banner has a
      // chance to actually paint — calling onConnected() in the same handler
      // unmounts ConnectPhase before React ever renders it. The Olympus-connect
      // side effects above still run immediately either way.
      if (relayUrl && !syncResult.capable) {
        setRelayWarning(
          syncResult.reason === 'password' ? 'Relay password rejected — using peer-to-peer.'
          : syncResult.reason === 'blocked' ? 'Relay is refusing this computer after too many wrong passwords — try again in a few minutes. Using peer-to-peer.'
          : syncResult.reason === 'protocol' ? `Relay ${syncResult.detail ?? 'protocol mismatch'} — using peer-to-peer.`
          : 'Relay unreachable — using peer-to-peer.'
        )
        setAwaitingContinue(true)
        // connecting must clear here too, not just in the catch block below —
        // this isn't an error path (Olympus connected fine), so nothing else
        // resets it, and every field's `disabled={connecting}` left the whole
        // form stuck for good, Continue button included, if left set forever.
        setConnecting(false)
      } else {
        onConnected()
      }
    } catch (err) {
      const msg = err instanceof TypeError && err.message === 'Failed to fetch'
        ? 'Cannot reach TRACS server — is it running?'
        : err.message
      setError(msg)
      setConnecting(false)
    }
  }

  return (
    <form className="login-form" onSubmit={handleConnect}>
      <section className="server-name-section">
        <label>Server Name</label>
        <div className="server-name-row">
          <input
            type="text"
            className="server-name-input"
            value={name}
            onChange={(e) => { setName(e.target.value); setConfirmOverwrite(false) }}
            onFocus={() => setShowDropdown(true)}
            // Selecting a profile (handleSelectProfile) closes the dropdown
            // but never blurs this input -- the dropdown's own onMouseDown
            // preventDefault (below) deliberately keeps focus here so the
            // click registers before any blur-close race. That means a
            // second click, while still focused, fires no onFocus at all
            // (only a genuine blur→focus transition does) and the dropdown
            // stayed closed until the user clicked away and back. onClick
            // covers that case; onFocus alone left it needing a blur+refocus.
            onClick={() => setShowDropdown(true)}
            onBlur={() => setShowDropdown(false)}
            placeholder="DCS Server Name"
            disabled={connecting}
          />
          <button
            type="button"
            className="save-profile-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleSaveClick}
            disabled={connecting || !name.trim()}
            title="Save server"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
        </div>
        {confirmOverwrite && (
          <div className="profile-delete-confirm profile-overwrite-confirm">
            <span>Overwrite saved server "{name}"?</span>
            <button type="button" onClick={persistProfile}>Confirm</button>
            <button type="button" onClick={() => setConfirmOverwrite(false)}>Cancel</button>
          </div>
        )}
        {saveStatus === 'saved' && !confirmOverwrite && (
          <span className="login-hint save-status-hint">Saved</span>
        )}
        {showDropdown && filteredProfiles.length > 0 && (
          <ul className="server-profile-dropdown" onMouseDown={(e) => e.preventDefault()}>
            {filteredProfiles.map((p) => (
              <li key={p.name} className="server-profile-row">
                {confirmDeleteName === p.name ? (
                  <div className="profile-delete-confirm">
                    <span>Delete "{p.name}"?</span>
                    <button type="button" onClick={() => handleDelete(p.name)}>Confirm</button>
                    <button type="button" onClick={() => setConfirmDeleteName(null)}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="profile-name-btn"
                      onClick={() => handleSelectProfile(p)}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      className={`profile-star-btn ${p.favorite ? 'active' : ''}`}
                      onClick={() => handleToggleFavorite(p.name)}
                      aria-label="Toggle favorite"
                    >
                      ★
                    </button>
                    <button
                      type="button"
                      className="profile-trash-btn"
                      onClick={() => setConfirmDeleteName(p.name)}
                      aria-label="Delete server"
                    >
                      🗑
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <label>Primary Data Source</label>
        <div className="module-toggles">
          {SOURCE_MODES.map((m) => (
            <button
              type="button"
              key={m.value}
              className={`module-btn ${sourceMode === m.value ? 'active' : ''}`}
              onClick={() => setSourceMode(m.value)}
              disabled={connecting}
            >
              {m.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <label>Server URL</label>
        <input
          type="text"
          value={serverHost}
          onChange={(e) => setServerHost(e.target.value)}
          placeholder="dcs-server-address"
          required
          disabled={connecting}
        />
        <div className="position-fields">
          {sourceMode !== 'relay' && (
            <input
              type="text"
              style={{ flex: 1 }}
              value={sourcePort}
              onChange={(e) => setSourcePort(e.target.value)}
              placeholder="Source Port (optional)"
              disabled={connecting}
            />
          )}
          <input
            type="text"
            style={{ flex: 1 }}
            value={xpndrPort}
            onChange={(e) => setXpndrPort(e.target.value)}
            placeholder="Relay Port"
            required={sourceMode === 'relay'}
            disabled={connecting}
          />
        </div>
      </section>

      <section>
        <label>Coalition Role</label>
        <select
          value={coalition}
          onChange={(e) => setCoalition(e.target.value)}
          disabled={connecting}
        >
          {COALITION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </section>

      {sourceMode === 'tacview-direct' && xpndrPort && (
        // Same field, same label/placeholder/position as Olympus's Coalition
        // Password below -- to the user this *is* their coalition password,
        // it just happens to authenticate to the relay instead of the
        // primary source in this one mode (the primary source, Tacview,
        // needs a separate flat RTT password instead -- see the next field).
        <section>
          <label>Coalition Password</label>
          <input
            type="password"
            value={relayPassword}
            onChange={(e) => setRelayPassword(e.target.value)}
            placeholder="Coalition password"
            disabled={connecting}
          />
        </section>
      )}

      <section>
        <label>{sourceMode === 'tacview-direct' ? 'Tacview RTT Password' : 'Coalition Password'}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={sourceMode === 'tacview-direct' ? "Tacview's own RTT export password (flat, not per-coalition)" : 'Coalition password'}
          disabled={connecting}
        />
        <p className="login-hint">Passwords are remembered on this computer, unencrypted.</p>
      </section>

      {error && <p className="login-error">{error}</p>}
      {!error && relayWarning && <p className="login-warning">{relayWarning}</p>}

      {awaitingContinue ? (
        <button type="button" className="connect-btn" onClick={onConnected}>
          Continue
        </button>
      ) : (
        <button type="submit" className="connect-btn" disabled={connecting}>
          {connecting ? 'Connecting…' : 'Connect to Network'}
        </button>
      )}
    </form>
  )
}

