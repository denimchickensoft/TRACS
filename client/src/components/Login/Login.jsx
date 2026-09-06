import { useState, useEffect, useRef, useMemo } from 'react'
import { useSessionStore, MODULE, POSITION_MODE } from '../../store/session'
import { useControllersStore } from '../../store/controllers'
import { useUnitsStore } from '../../store/units'
import { useStatusBoardStore } from '../../store/statusBoard'
import { wsClient } from '../../ws/client'
import { initWebrtc } from '../../webrtc/client'
import { checkSyncCapable } from '../../webrtc/syncClient'
import { CARRIER_TYPES } from '../../utils/carriers'
import {
  loadServerProfiles, upsertServerProfile, toggleFavoriteProfile,
  removeServerProfile, findProfileByName, filterServerProfiles, getMostRecentProfile,
  loadLastConnection, saveLastConnection,
} from '../../utils/serverProfiles'
import './Login.css'

const SUFFIX_TO_NAVDATA_ROLE = {
  TWR: 'twr',
  APP: 'app', RDR: 'app',
  DEP: 'dep',
  GND: 'gnd',
  CTR: 'ctr', CONTROL: 'ctr',
}

const CATCC_POSITION_TYPES = [
  { suffix: 'MAR', displayName: 'Marshal'   },
  { suffix: 'APP', displayName: 'Approach'  },
  { suffix: 'DEP', displayName: 'Departure' },
  { suffix: 'TWR', displayName: 'Tower'     },
]

const COALITION_OPTIONS = [
  { value: 'blue',  label: 'Blue Commander' },
  { value: 'red',   label: 'Red Commander'  },
  { value: 'gm',    label: 'Game Master'    },
  { value: 'admin', label: 'Admin'          },
]

// Splits a stored "http://host:port"-shaped string (or a bare host) back into
// its host and port, for editing as separate fields. The server URL and the
// relay URL always share the same host by construction — the relay only ever
// runs alongside Olympus/SRS/Tacview — so this is the only place a URL string
// gets parsed; everywhere else just composes host+port back together.
function parseHostPort(raw) {
  if (!raw) return { host: '', port: '' }
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    return { host: u.hostname, port: u.port }
  } catch {
    return { host: '', port: '' }
  }
}

// ── Phase 1: Connect to Olympus ───────────────────────────────────────────────
function ConnectPhase({ onConnected }) {
  const [profiles,   setProfiles]   = useState(() => loadServerProfiles())
  const lastConnection = useMemo(() => loadLastConnection(), [])
  const lastProfile = useMemo(() => getMostRecentProfile(profiles), [profiles])
  const [name,       setName]       = useState(() => lastConnection?.name ?? lastProfile?.name ?? '')
  const [serverHost, setServerHost] = useState(() => parseHostPort(lastConnection?.url ?? lastProfile?.url ?? '').host)
  const [sourcePort, setSourcePort] = useState(() => parseHostPort(lastConnection?.url ?? lastProfile?.url ?? '').port)
  const [coalition,  setCoalition]  = useState(() => lastConnection?.coalition ?? lastProfile?.lastCoalition ?? localStorage.getItem('tracs.lastCoalition') ?? 'blue')
  const [password,   setPassword]   = useState(() => lastConnection?.password ?? lastProfile?.passwords?.[coalition] ?? '')
  // XPNDR port is optional — most deployments have no relay at all. Same host
  // as the server above by construction (the relay only ever runs alongside
  // Olympus/SRS), so there's nothing to guess or type separately except the port.
  const [xpndrPort,  setXpndrPort]  = useState(() => parseHostPort(lastConnection?.relayUrl ?? lastProfile?.relayUrl ?? '').port)
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

  // Re-fill the password when the role changes, if the current name matches a saved profile
  useEffect(() => {
    const match = findProfileByName(profiles, name)
    if (match) setPassword(match.passwords[coalition] ?? '')
  }, [coalition]) // eslint-disable-line

  // serverHost + sourcePort → the composed olympusUrl the backend expects.
  function composedOlympusUrl(host = serverHost, port = sourcePort) {
    const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    return port ? `http://${cleanHost}:${port}` : `http://${cleanHost}`
  }

  // Same host, XPNDR port instead — empty port means "no relay configured",
  // never a guess, since the relay always lives alongside Olympus/Tacview.
  function composedRelayUrl(host = serverHost, port = xpndrPort) {
    if (!port) return ''
    const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    return `ws://${cleanHost}:${port}`
  }

  function handleSelectProfile(profile) {
    const profileCoalition = profile.lastCoalition ?? coalition
    const source = parseHostPort(profile.url)
    const relay  = parseHostPort(profile.relayUrl)
    setName(profile.name)
    setServerHost(source.host)
    setSourcePort(source.port)
    setCoalition(profileCoalition)
    setPassword(profile.passwords[profileCoalition] ?? '')
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
    const normalizedUrl = composedOlympusUrl()
    setProfiles((prev) => upsertServerProfile(prev, { name, url: normalizedUrl, coalition, password, relayUrl: composedRelayUrl() }))
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
    const relayUrl = composedRelayUrl()

    // Checked in parallel with the Olympus connect below, not after sign-in —
    // this is the one place in the flow that already has password/relayUrl in
    // hand, already gates on an async check, and already has somewhere to show
    // a result. See resources/specs/data-sources/webrtc-centralized-sync-spec.md §1.
    const syncCheck = relayUrl
      ? checkSyncCapable({ relayUrl, password })
      : Promise.resolve({ capable: false })

    try {
      const [res, syncResult] = await Promise.all([
        fetch('/api/connect', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ olympusUrl: normalizedUrl, password, coalition, relayUrl }),
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
      saveLastConnection({ name, url: normalizedUrl, coalition, password, relayUrl })
      if (name.trim()) {
        setProfiles((prev) => upsertServerProfile(prev, { name, url: normalizedUrl, coalition, password, relayUrl }))
      }
      setConnection({ olympusUrl: normalizedUrl, coalition, relayUrl })
      wsClient.connect()

      // A relay warning holds the phase transition here so the banner has a
      // chance to actually paint — calling onConnected() in the same handler
      // unmounts ConnectPhase before React ever renders it. The Olympus-connect
      // side effects above still run immediately either way.
      if (relayUrl && !syncResult.capable) {
        setRelayWarning(
          syncResult.reason === 'password'
            ? 'Relay password rejected — using peer-to-peer.'
            : 'Relay unreachable — using peer-to-peer.'
        )
        setAwaitingContinue(true)
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
          <input
            type="text"
            style={{ flex: 1 }}
            value={sourcePort}
            onChange={(e) => setSourcePort(e.target.value)}
            placeholder="Source Port"
            required
            disabled={connecting}
          />
          <input
            type="text"
            style={{ flex: 1 }}
            value={xpndrPort}
            onChange={(e) => setXpndrPort(e.target.value)}
            placeholder="Relay Port"
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

      <section>
        <label>Coalition Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Coalition password (also used as Tacview RTT password, direct mode)"
          disabled={connecting}
        />
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

// ── Phase 2: Sign in to position ──────────────────────────────────────────────
function PositionPhase({ onSignedIn }) {
  const {
    airbases, mission, sourceType,
    setPosition, setFacility, setActiveModule, setPositionSet, setAicConfig, reset,
    overrideTheatre,
    webrtcRejection, clearWebrtcRejection,
  } = useSessionStore()
  const { positionTypes, loadPositionTypes, registerController } = useControllersStore()


  const [selectedModule, setSelectedModule] = useState(
    () => localStorage.getItem('tracs.lastModule') ?? MODULE.ATC
  )

  // ── ATC state ──────────────────────────────────────────────────────
  const [icaoMap,      setIcaoMap]      = useState({})
  const [selectedBase, setSelectedBase] = useState('')
  const [facilityId,   setFacilityId]   = useState(() => {
    // Only pre-fill for CTR — non-CTR comes from the ICAO lookup once a base is selected
    const saved = localStorage.getItem('tracs.atc.lastSuffix')
    return (saved === 'CTR' || saved === 'CONTROL') ? (localStorage.getItem('tracs.atc.lastFacilityId') ?? '') : ''
  })
  const [suffix,    setSuffix]    = useState(() => localStorage.getItem('tracs.atc.lastSuffix')    ?? '')
  const [frequency, setFrequency] = useState(() => localStorage.getItem('tracs.atc.lastFrequency') ?? '')

  // Tracks the last frequency pre-filled from navdata so we know whether the
  // current value was user-typed (in which case we don't overwrite it).
  const [suggestedFreq,  setSuggestedFreq]  = useState(null)
  const [ctrList,        setCtrList]        = useState([])
  const [ctrLoading,     setCtrLoading]     = useState(false)

  // Manual theatre override — Tacview-only (gated on sourceType below): it
  // has no reliable auto-detected theatre signal at all
  // (custom-datasource-tacview-spec.md §4.2), and even its majority-vote
  // mitigation can never disambiguate MarianaIslands vs. MarianaIslandsWWII
  // (identical bboxes). Olympus reports its own theatre directly and
  // reliably, so this control would be pure clutter for that source — the
  // whole reason this needs sourceType at all rather than always showing.
  // theatreList is fetched once regardless of source (cheap, small); the
  // sourceType gate below is what actually decides whether to show anything.
  const [theatreList, setTheatreList] = useState([])
  // Collapsed by default — a rare-use escape hatch, not a permanent control.
  const [theatreOverrideOpen, setTheatreOverrideOpen] = useState(false)
  // Tracks only "did I click Override this page-load" — not whether the
  // server's current theatre came from an override versus a plain auto-vote
  // (that distinction isn't tracked server-side, and doesn't need to be: a
  // fresh page load always starts back at the plain "Override" control, and
  // "Reset to auto-detect" only needs to undo what *this* session just did).
  const [theatreOverridden, setTheatreOverridden] = useState(false)
  useEffect(() => {
    const ac = new AbortController()
    fetch('/api/navdata/theatres', { signal: ac.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => setTheatreList(data.theatres ?? []))
      .catch((err) => { if (err?.name === 'AbortError') return })
    return () => ac.abort()
  }, [])

  // ── CATCC state ────────────────────────────────────────────────────
  const [selectedCarrierId, setSelectedCarrierId] = useState(
    () => localStorage.getItem('tracs.catcc.lastCarrierId') ?? ''
  )
  const [catccSuffix,    setCatccSuffix]    = useState(
    () => localStorage.getItem('tracs.catcc.lastSuffix')    ?? 'MAR'
  )
  const [catccFrequency, setCatccFrequency] = useState(
    () => localStorage.getItem('tracs.catcc.lastFrequency') ?? ''
  )

  // ── AIC state ──────────────────────────────────────────────────────
  const [aicCallsign,  setAicCallsign]  = useState(
    () => localStorage.getItem('tracs.aic.lastCallsign')  ?? ''
  )
  const [aicFrequency, setAicFrequency] = useState(
    () => localStorage.getItem('tracs.aic.lastFrequency') ?? ''
  )

  // ── ABM state ──────────────────────────────────────────────────────
  const [abmCallsign,  setAbmCallsign]  = useState(
    () => localStorage.getItem('tracs.abm.lastCallsign')  ?? ''
  )
  const [abmFrequency, setAbmFrequency] = useState(
    () => localStorage.getItem('tracs.abm.lastFrequency') ?? ''
  )

  // ── Session password (shared across modules) ───────────────────────
  const [sessionPassword, setSessionPassword] = useState(
    () => localStorage.getItem('tracs.lastSessionPassword') ?? ''
  )

  const [error,     setError]     = useState(null)
  const [signingIn, setSigningIn] = useState(false)

  // Display and clear any rejection message from a previous sign-on attempt
  useEffect(() => {
    if (webrtcRejection) {
      setError(webrtcRejection)
      clearWebrtcRejection()
    }
  }, []) // eslint-disable-line

  const [runwayBaseNames, setRunwayBaseNames] = useState(null)

  // Synthetic airbases fallback — Tacview has no live airbases feed at all
  // (DCS's exporter emits no Aerodrome objects, confirmed in
  // custom-datasource-tacview-spec.md §6.0), so `airbases` from the live WS
  // feed never arrives and the facility picker below would otherwise be
  // stuck on "Waiting for data…" forever for a Tacview-sourced connection.
  // Built from the same runways/<theatre>.json already fetched just below
  // for the helipad filter — position is the mean of each airbase's runway
  // reference points, same derivation `buildMvaMap.js`'s buildRunwayIndex()
  // already uses server-side for the same file. No live coalition-ownership
  // data exists for this source, so every entry is unowned (`coalition:
  // null`) — the facility picker itself doesn't filter by coalition, so this
  // only affects ownership-tinted rendering elsewhere, not selection.
  const [staticAirbaseFallback, setStaticAirbaseFallback] = useState(null)

  // Load position types + ICAO mapping
  useEffect(() => {
    loadPositionTypes()
    fetch('/icaoMapping.json')
      .then((r) => r.json())
      .then((data) => setIcaoMap(data))
      .catch(() => {})
  }, [loadPositionTypes])

  // Fetch runway JSON for the current theatre to filter out helicopter pads / FOBs
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    const ac = new AbortController()
    fetch(`/runways/${encodeURIComponent(theatre)}.json`, { signal: ac.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return
        const names = new Set(
          (data.airbases ?? [])
            .filter((ab) => Array.isArray(ab.runways) && ab.runways.length > 0)
            .map((ab) => ab.airbase.toLowerCase())
        )
        setRunwayBaseNames(names)

        const fallback = {}
        for (const ab of data.airbases ?? []) {
          let sumLat = 0, sumLon = 0, n = 0
          for (const rw of Array.isArray(ab.runways) ? ab.runways : []) {
            let lat = rw.lat, lon = rw.lon
            if (lat == null && rw.end1 && rw.end2) { lat = (rw.end1.lat + rw.end2.lat) / 2; lon = (rw.end1.lon + rw.end2.lon) / 2 }
            if (lat == null || lon == null) continue
            sumLat += lat; sumLon += lon; n++
          }
          if (!n) continue
          fallback[ab.airbase] = { callsign: ab.airbase, latitude: sumLat / n, longitude: sumLon / n, coalition: null, unitId: null }
        }
        setStaticAirbaseFallback({ airbases: fallback })
      })
      .catch(() => {})
    return () => ac.abort()
  }, [mission?.mission?.theatre])

  // Default suffix once positionTypes are loaded; also validates saved suffix still exists
  const atcPositionTypes = positionTypes.filter((pt) => !pt.catccOnly)
  useEffect(() => {
    if (atcPositionTypes.length === 0) return
    if (!suffix || !atcPositionTypes.some((pt) => pt.suffix === suffix)) {
      const twr = atcPositionTypes.find((pt) => pt.suffix === 'TWR')
      setSuffix(twr ? twr.suffix : atcPositionTypes[0].suffix)
    }
  }, [positionTypes]) // eslint-disable-line

  const isCtr = suffix === 'CTR' || suffix === 'CONTROL'

  // Skip the first run of the CTR-toggle clear so restored CTR facilityId isn't wiped on mount
  const isCtrMountRef = useRef(true)

  // Live feed takes priority the moment it arrives; the static fallback only
  // covers the source-has-no-airbases-feed-at-all case (Tacview) and the
  // brief window before a real feed (Olympus) lands.
  const effectiveAirbases = airbases ?? staticAirbaseFallback

  // Normalise Olympus airbases into a flat list, deduplicating by name.
  // When runway data is loaded, filter out helicopter pads and FOBs (no runway geometry).
  const airbaseList = useMemo(() => {
    const raw  = effectiveAirbases?.airbases ?? effectiveAirbases ?? {}
    const seen = new Set()
    return Object.values(raw)
      .filter((ab) => ab.latitude && ab.longitude)
      .map((ab) => ({
        name:      ab.callsign || `Carrier #${ab.unitId}`,
        lat:       ab.latitude,
        lng:       ab.longitude,
        coalition: ab.coalition,
        unitId:    ab.unitId ?? null,
        isCarrier: !!(ab.unitId && ab.unitId > 0 && !ab.callsign),
      }))
      .filter((ab) => {
        if (seen.has(ab.name)) return false
        seen.add(ab.name)
        if (ab.isCarrier) return true
        if (runwayBaseNames && !runwayBaseNames.has(ab.name.toLowerCase())) return false
        return true
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [effectiveAirbases, runwayBaseNames])

  const landBases        = airbaseList.filter((ab) => !ab.isCarrier)
  const airbasesReceived = effectiveAirbases !== null
  const airbasesLoaded   = airbaseList.length > 0

  // CATCC: carriers derived from units store, not airbases — NavyUnits in the carrier table only.
  const unitsObj = useUnitsStore((s) => s.units)
  const catccCarriers = useMemo(() =>
    Object.entries(unitsObj)
      .filter(([, u]) => u.category === 'NavyUnit' && CARRIER_TYPES[u.name])
      .map(([storeKey, u]) => ({
        unitId:      storeKey,            // the units-store key — used for lookup in CatccScope
        unitName:    u.unitName || u.callsign || u.name,
        typeName:    u.name,
        displayName: CARRIER_TYPES[u.name].displayName,
      }))
  , [unitsObj])

  // Clear stale selections when the airbase/carrier lists change (e.g. theatre swap mid-login)
  useEffect(() => {
    if (!selectedBase) return
    if (!airbaseList.some((ab) => ab.name === selectedBase)) {
      setSelectedBase('')
      setFacilityId('')
    }
  }, [airbaseList]) // eslint-disable-line

  useEffect(() => {
    if (!selectedCarrierId) return
    if (!catccCarriers.some((c) => String(c.unitId) === selectedCarrierId)) {
      setSelectedCarrierId('')
    }
  }, [catccCarriers]) // eslint-disable-line

  // Restore last facility once airbaseList populates (one-shot)
  const facilityRestoredRef = useRef(false)
  useEffect(() => {
    if (facilityRestoredRef.current || airbaseList.length === 0) return
    facilityRestoredRef.current = true
    const saved = localStorage.getItem('tracs.atc.lastFacility')
    if (saved && airbaseList.some((ab) => ab.name === saved)) {
      setSelectedBase(saved)
    }
  }, [airbaseList])

  // Restore last carrier once catccCarriers populates (one-shot)
  const carrierRestoredRef = useRef(false)
  useEffect(() => {
    if (carrierRestoredRef.current || catccCarriers.length === 0) return
    carrierRestoredRef.current = true
    const saved = localStorage.getItem('tracs.catcc.lastCarrierId')
    if (saved && catccCarriers.some((c) => String(c.unitId) === saved)) {
      setSelectedCarrierId(saved)
    }
  }, [catccCarriers])

  // Auto-populate facility ID when base selection changes
  useEffect(() => {
    if (!selectedBase || isCtr) return
    const entry = airbaseList.find((ab) => ab.name === selectedBase)
    if (!entry) return

    // Lookup ICAO across all theatres
    function resolveIcao(dcsName) {
      const theatre = (mission?.mission?.theatre ?? '').toLowerCase()
      if (theatre && icaoMap[theatre]?.[dcsName]) return icaoMap[theatre][dcsName]
      for (const [key, map] of Object.entries(icaoMap)) {
        if (key === '_note' || typeof map !== 'object') continue
        if (map[dcsName]) return map[dcsName]
      }
      return ''
    }

    setFacilityId(entry.isCarrier ? '' : resolveIcao(entry.name))
  }, [selectedBase, airbaseList, icaoMap, mission, isCtr])

  // Clear base/facilityId when switching to/from CTR (skip on mount to preserve restored values)
  useEffect(() => {
    if (isCtrMountRef.current) { isCtrMountRef.current = false; return }
    setSelectedBase('')
    setFacilityId('')
  }, [isCtr])

  // Fetch frequency suggestion from navdata when facilityId + suffix are usable
  useEffect(() => {
    const role     = SUFFIX_TO_NAVDATA_ROLE[suffix?.toUpperCase()]
    const carrier  = airbaseList.find((ab) => ab.name === selectedBase)?.isCarrier ?? false
    if (selectedModule !== MODULE.ATC || !facilityId || carrier || !role) {
      setSuggestedFreq(null)
      return
    }

    const ac = new AbortController()
    fetch(`/api/navdata/frequencies?icao=${encodeURIComponent(facilityId)}&role=${role}`, { signal: ac.signal })
      .then((r) => { console.log(`[navdata] freq ${facilityId}/${role} → ${r.status}`); return r.ok ? r.json() : Promise.reject(r.status) })
      .then((data) => {
        console.log('[navdata] freq data', data)
        const raw = data?.freqs?.[0]
        if (!raw) { setSuggestedFreq(null); return }
        const formatted = parseFloat(raw).toFixed(3)
        setSuggestedFreq(formatted)
        setFrequency(formatted)
      })
      .catch((err) => { if (err?.name === 'AbortError') return; console.warn('[navdata] freq lookup failed', err); setSuggestedFreq(null) })

    return () => ac.abort()
  }, [facilityId, suffix, selectedModule, selectedBase, airbaseList])

  // Fetch CTR facility list for the current theatre when CTR is selected
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!isCtr || !theatre) { setCtrList([]); setCtrLoading(false); return }
    setCtrLoading(true)
    const ac = new AbortController()
    fetch(`/api/navdata/ctrs?theatre=${encodeURIComponent(theatre)}`, { signal: ac.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((data) => { setCtrList(data); setCtrLoading(false) })
      .catch((err) => { if (err?.name === 'AbortError') return; setCtrList([]); setCtrLoading(false) })
    return () => ac.abort()
  }, [isCtr, mission?.mission?.theatre])

  const selectedEntry   = airbaseList.find((ab) => ab.name === selectedBase) ?? null
  const isCarrier       = selectedEntry?.isCarrier ?? false
  const positionSuffix  = isCtr ? 'CTR' : suffix
  const constructedName = facilityId && suffix ? `${facilityId}_${positionSuffix}` : ''

  // CATCC: derive position ID from selected carrier + suffix
  const catccEntry      = catccCarriers.find((c) => String(c.unitId) === selectedCarrierId) ?? null
  const catccFacilityId = catccEntry ? CARRIER_TYPES[catccEntry.typeName].facilityId : ''
  const catccPositionId = catccEntry ? `${catccFacilityId}_${catccSuffix}` : ''

  function handleDisconnect() {
    wsClient.disconnect()
    reset()
  }

  function validateFreq(val) {
    const n    = parseFloat(val)
    const isVhf = n >= 118.0 && n <= 136.975
    const isUhf = n >= 225.0 && n <= 399.975
    return !isNaN(n) && (isVhf || isUhf)
  }

  async function handleSignIn(e) {
    e.preventDefault()
    setError(null)

    if (selectedModule === MODULE.ATC) {
      if (!isCtr && !selectedBase)      { setError('Select a facility.');                                                         return }
      if (!facilityId.trim())           { setError('Facility ID is required.');                                                   return }
      if (facilityId.length > 4)        { setError('Facility ID must be 4 characters or fewer.');                                 return }
      if (!suffix)                      { setError('Select a position type.');                                                    return }
      if (!frequency.trim())            { setError('Frequency is required.');                                                     return }
      if (!validateFreq(frequency))     { setError('Frequency must be VHF (118.000–136.975) or UHF (225.000–399.975).');         return }
    } else if (selectedModule === MODULE.CATCC) {
      if (!selectedCarrierId)           { setError('Select a carrier.');                                                          return }
      if (!catccFrequency.trim())       { setError('Frequency is required.');                                                     return }
      if (!validateFreq(catccFrequency)){ setError('Frequency must be VHF (118.000–136.975) or UHF (225.000–399.975).');         return }
    } else if (selectedModule === MODULE.AIC) {
      if (!aicCallsign.trim())          { setError('Callsign is required.');                                                      return }
      if (!aicFrequency.trim())         { setError('Frequency is required.');                                                     return }
      if (!validateFreq(aicFrequency))  { setError('Frequency must be VHF (118.000–136.975) or UHF (225.000–399.975).');         return }
    } else if (selectedModule === MODULE.ABM) {
      if (!abmCallsign.trim())          { setError('Callsign is required.');                                                      return }
      if (!abmFrequency.trim())         { setError('Frequency is required.');                                                     return }
      if (!validateFreq(abmFrequency))  { setError('Frequency must be VHF (118.000–136.975) or UHF (225.000–399.975).');         return }
    }

    // Pre-flight frequency deconfliction against the server's current client list.
    // Same facility+suffix = same controllerId = allowed to share a frequency.
    const freqCheck = selectedModule === MODULE.ATC   ? parseFloat(frequency).toFixed(3)
                    : selectedModule === MODULE.CATCC  ? parseFloat(catccFrequency).toFixed(3)
                    : selectedModule === MODULE.AIC     ? parseFloat(aicFrequency).toFixed(3)
                    :                                    parseFloat(abmFrequency).toFixed(3)
    const facCheck  = selectedModule === MODULE.ATC   ? facilityId.toUpperCase()
                    : selectedModule === MODULE.CATCC  ? catccFacilityId
                    : selectedModule === MODULE.AIC     ? aicCallsign.trim().toUpperCase()
                    :                                    abmCallsign.trim().toUpperCase()
    const sufCheck  = selectedModule === MODULE.ATC   ? positionSuffix
                    : selectedModule === MODULE.CATCC  ? catccSuffix
                    : selectedModule === MODULE.AIC     ? 'AIC'
                    :                                    'ABM'
    try {
      const res = await fetch('/api/state/session')
      if (res.ok) {
        const state = await res.json()
        const peers = state.clientList ?? []
        const conflict = peers.find((c) => {
          if (!c.frequency) return false
          if (parseFloat(c.frequency).toFixed(3) !== freqCheck) return false
          return c.facility !== facCheck || c.suffix !== sufCheck
        })
        if (conflict) {
          setError(`Frequency ${freqCheck} MHz is already in use by ${conflict.position}.`)
          return
        }
      }
    } catch {
      // Pre-flight unavailable — proceed; the host's HANDSHAKE check is the fallback.
    }

    setSigningIn(true)
    localStorage.setItem('tracs.lastModule', selectedModule)
    localStorage.setItem('tracs.lastSessionPassword', sessionPassword)

    if (selectedModule === MODULE.ATC) {
      localStorage.setItem('tracs.atc.lastFacility',   selectedBase)
      localStorage.setItem('tracs.atc.lastFacilityId', facilityId.toUpperCase())
      localStorage.setItem('tracs.atc.lastSuffix',     suffix)
      localStorage.setItem('tracs.atc.lastFrequency',  frequency)
      const formattedFreq   = parseFloat(frequency).toFixed(3)
      const atcPositionName = constructedName.toUpperCase()
      const fType           = isCtr ? 'fir' : isCarrier ? 'carrier' : 'land'
      const typeDef         = positionTypes.find((pt) => pt.suffix === suffix)

      setPosition({ mode: POSITION_MODE.CONFIGURED, name: atcPositionName })
      setFacility({
        facilityType:     fType,
        facilityId:       facilityId.toUpperCase(),
        facilityDcsName:  selectedEntry?.name ?? '',
        facilityName:     selectedBase,
        positionTypeName: typeDef?.displayName ?? suffix,
        positionSuffix:   positionSuffix,
        carrierUnitId:    isCarrier ? selectedEntry.unitId : null,
      })
      registerController(atcPositionName, {
        facility:  facilityId.toUpperCase(),
        suffix:    positionSuffix,
        frequency: formattedFreq,
      })

    } else if (selectedModule === MODULE.CATCC) {
      const formattedFreq  = parseFloat(catccFrequency).toFixed(3)
      const posTypeDef     = CATCC_POSITION_TYPES.find((pt) => pt.suffix === catccSuffix)
      // RAD is meant to default to the reciprocal of FB each session; without this
      // it keeps whatever was left in localStorage from the last time the tab was
      // closed without a clean Disconnect, which can be stale for the current mission.
      useStatusBoardStore.getState().setHeader('rad', '')
      localStorage.setItem('tracs.catcc.lastCarrierId', selectedCarrierId)
      localStorage.setItem('tracs.catcc.lastSuffix',    catccSuffix)
      localStorage.setItem('tracs.catcc.lastFrequency', catccFrequency)

      setPosition({ mode: POSITION_MODE.CONFIGURED, name: catccPositionId })
      setFacility({
        facilityType:     'carrier',
        facilityId:       catccFacilityId,
        facilityDcsName:  catccEntry.unitName,
        facilityName:     catccEntry.displayName,
        positionTypeName: posTypeDef?.displayName ?? catccSuffix,
        positionSuffix:   catccSuffix,
        carrierUnitId:    catccEntry.unitId,
      })
      registerController(catccPositionId, {
        facility:  catccFacilityId,
        suffix:    catccSuffix,
        frequency: formattedFreq,
      })

    } else if (selectedModule === MODULE.AIC) {
      const formattedFreq = parseFloat(aicFrequency).toFixed(3)
      const callsign      = aicCallsign.trim().toUpperCase()
      localStorage.setItem('tracs.aic.lastCallsign',  callsign)
      localStorage.setItem('tracs.aic.lastFrequency', aicFrequency)
      setAicConfig({ callsign, unitId: null, unitName: '' })
setPosition({ mode: POSITION_MODE.CONFIGURED, name: callsign })
      setFacility({
        facilityType:     'aic',
        facilityId:       callsign,
        facilityDcsName:  '',
        facilityName:     callsign,
        positionTypeName: 'AIC',
        carrierUnitId:    null,
      })
      registerController(callsign, {
        facility:  'AIC',
        suffix:    'AIC',
        frequency: formattedFreq,
      })

    } else if (selectedModule === MODULE.ABM) {
      const formattedFreq = parseFloat(abmFrequency).toFixed(3)
      const callsign      = abmCallsign.trim().toUpperCase()
      localStorage.setItem('tracs.abm.lastCallsign',  callsign)
      localStorage.setItem('tracs.abm.lastFrequency', abmFrequency)
      setPosition({ mode: POSITION_MODE.CONFIGURED, name: callsign })
      setFacility({
        facilityType:     'abm',
        facilityId:       callsign,
        facilityDcsName:  '',
        facilityName:     callsign,
        positionTypeName: 'ABM',
        carrierUnitId:    null,
      })
      registerController(callsign, {
        facility:  'ABM',
        suffix:    'ABM',
        frequency: formattedFreq,
      })
    }

    setActiveModule(selectedModule)
    setPositionSet(true)
    onSignedIn()

    const { olympusUrl } = useSessionStore.getState()
    let rtcPosition  = ''
    let rtcFrequency = ''
    if (selectedModule === MODULE.ATC) {
      rtcPosition  = constructedName.toUpperCase()
      rtcFrequency = parseFloat(frequency).toFixed(3)
    } else if (selectedModule === MODULE.CATCC) {
      rtcPosition  = catccPositionId
      rtcFrequency = parseFloat(catccFrequency).toFixed(3)
    } else if (selectedModule === MODULE.AIC) {
      rtcPosition  = aicCallsign.trim().toUpperCase()
      rtcFrequency = parseFloat(aicFrequency).toFixed(3)
    } else if (selectedModule === MODULE.ABM) {
      rtcPosition  = abmCallsign.trim().toUpperCase()
      rtcFrequency = parseFloat(abmFrequency).toFixed(3)
    }
    let rtcFacility = ''
    let rtcSuffix   = ''
    if (selectedModule === MODULE.ATC) {
      rtcFacility = facilityId.toUpperCase()
      rtcSuffix   = suffix
    } else if (selectedModule === MODULE.CATCC) {
      rtcFacility = catccFacilityId
      rtcSuffix   = catccSuffix
    } else if (selectedModule === MODULE.AIC) {
      rtcFacility = aicCallsign.trim().toUpperCase()
      rtcSuffix   = 'AIC'
    } else if (selectedModule === MODULE.ABM) {
      rtcFacility = abmCallsign.trim().toUpperCase()
      rtcSuffix   = 'ABM'
    }
    initWebrtc({ olympusUrl, password: sessionPassword, position: rtcPosition, module: selectedModule, frequency: rtcFrequency, facility: rtcFacility, suffix: rtcSuffix })
  }

  return (
    <form className="login-form" onSubmit={handleSignIn}>

      {/* ── Module selection ──────────────────────────────────────────── */}
      <section>
        <label>Module</label>
        <div className="module-toggles">
          {Object.values(MODULE).map((mod) => (
            <button
              key={mod}
              type="button"
              className={`module-btn ${selectedModule === mod ? 'active' : ''}`}
              onClick={() => { setSelectedModule(mod); setError(null) }}
              disabled={signingIn}
            >
              {mod}
            </button>
          ))}
        </div>
      </section>

      {/* ── Theatre override (Tacview only — Olympus reports its own theatre
           directly, no ambiguity to override) ────────────────────────── */}
      {sourceType === 'tacview' && theatreList.length > 0 && (
        <section>
          <label>
            Theatre {mission?.mission?.theatre
              ? `(${theatreOverridden ? 'overridden' : 'detected'}: ${mission.mission.theatre})`
              : '(detecting…)'}
            {theatreOverridden ? (
              <button
                type="button"
                className="theatre-override-toggle"
                onClick={() => {
                  setTheatreOverridden(false)
                  overrideTheatre(null)
                  fetch('/api/tacview/theatre-reset', { method: 'POST' }).catch(() => {})
                }}
                disabled={signingIn}
              >
                ⟲ Reset to auto-detect
              </button>
            ) : (
              <button
                type="button"
                className="theatre-override-toggle"
                onClick={() => setTheatreOverrideOpen((o) => !o)}
                disabled={signingIn}
              >
                {theatreOverrideOpen ? '▾' : '▸'} Override
              </button>
            )}
          </label>
          {theatreOverrideOpen && !theatreOverridden && (
            <select
              className="facility-input"
              value=""
              onChange={(e) => {
                const theatre = e.target.value
                if (theatre) {
                  // Local patch for immediate feedback (label text, airbase
                  // re-fetch effect below) — but the server is the one with
                  // the live theatreDecided/theatreTimer state, and its own
                  // pending auto-vote result would otherwise clobber this
                  // choice a few seconds later (THEATRE_VOTE_WINDOW_MS in
                  // tacview.js/tacviewRelayClient.js). This POST is what
                  // actually latches the override server-side and stops that.
                  overrideTheatre(theatre)
                  setTheatreOverrideOpen(false)
                  setTheatreOverridden(true)
                  fetch('/api/tacview/theatre-override', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ theatre }),
                  }).catch(() => {})
                }
              }}
              disabled={signingIn}
            >
              <option value="">— Override only if detected theatre is wrong —</option>
              {theatreList.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </section>
      )}

      {/* ── ATC ──────────────────────────────────────────────────────── */}
      {selectedModule === MODULE.ATC && (
        <>
          <section className="position-section">
            <label>Position</label>
            <div className="position-fields">
              {isCtr ? (
                ctrList.length > 0 ? (
                  <select
                    className="facility-input"
                    value={facilityId}
                    onChange={(e) => setFacilityId(e.target.value)}
                    disabled={signingIn}
                  >
                    <option value="">— Select center —</option>
                    {ctrList.map((c) => (
                      <option key={c.facilityId} value={c.facilityId}>{c.facilityId} — {c.name}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="facility-input"
                    value={facilityId}
                    onChange={(e) => setFacilityId(e.target.value.toUpperCase())}
                    placeholder="FIR"
                    maxLength={4}
                    disabled={signingIn || ctrLoading}
                  />
                )
              ) : !airbasesReceived ? (
                <div className="login-loading">Waiting for data…</div>
              ) : !airbasesLoaded ? (
                <div className="login-loading">{mission?.mission?.theatre ? `No airbases for theatre: ${mission.mission.theatre}` : 'Waiting for mission data…'}</div>
              ) : (
                <select
                  className="facility-input"
                  value={selectedBase}
                  onChange={(e) => setSelectedBase(e.target.value)}
                  disabled={signingIn}
                >
                  <option value="">— Select facility —</option>
                  {landBases.map((ab) => (
                    <option key={ab.name} value={ab.name}>{ab.name}</option>
                  ))}
                </select>
              )}
              <select
                className="suffix-select"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                disabled={signingIn || positionTypes.length === 0}
              >
                {atcPositionTypes.map((pt) => (
                  <option key={pt.suffix} value={pt.suffix}>{pt.displayName}</option>
                ))}
              </select>
            </div>
            {!isCtr && selectedBase && (
              <input
                type="text"
                className="facility-input facility-id-override"
                value={facilityId}
                onChange={(e) => setFacilityId(e.target.value.toUpperCase())}
                placeholder="ICAO or LID"
                maxLength={4}
                disabled={signingIn}
              />
            )}
            {constructedName && (
              <span className="callsign-preview">{constructedName.toUpperCase()}</span>
            )}
            {!isCtr && selectedBase && !facilityId && (
              <span className="login-hint">No ICAO/LID found — enter one manually</span>
            )}
            {isCtr && ctrLoading && (
              <span className="login-hint">Loading centers…</span>
            )}
            {isCtr && !ctrLoading && ctrList.length === 0 && (
              <span className="login-hint">Enter your FIR or ARTCC identifier (e.g. UGGG, KZDC)</span>
            )}
          </section>

          <section>
            <label>Frequency (MHz)</label>
            <input
              type="text"
              value={frequency}
              onChange={(e) => { setFrequency(e.target.value) }}
              onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setFrequency(n.toFixed(3)) }}
              placeholder="118.100"
              maxLength={7}
              disabled={signingIn}
            />
            {suggestedFreq && frequency === suggestedFreq && (
              <span className="login-hint">Suggested from navdata</span>
            )}
          </section>
        </>
      )}

      {/* ── CATCC ─────────────────────────────────────────────────────── */}
      {selectedModule === MODULE.CATCC && (
        <>
          <section>
            <label>Carrier</label>
            {catccCarriers.length === 0 ? (
              <div className="login-loading">No carriers detected in Olympus data</div>
            ) : (
              <select
                value={selectedCarrierId}
                onChange={(e) => setSelectedCarrierId(e.target.value)}
                disabled={signingIn}
              >
                <option value="">— Select carrier —</option>
                {catccCarriers.map((c) => (
                  <option key={c.unitId} value={String(c.unitId)}>{c.displayName} — {c.unitName}</option>
                ))}
              </select>
            )}
          </section>

          <section className="position-section">
            <label>Position</label>
            <div className="position-fields">
              <input
                type="text"
                className="facility-input"
                value={catccFacilityId}
                readOnly
                placeholder="CV74"
                disabled
              />
              <select
                className="suffix-select"
                value={catccSuffix}
                onChange={(e) => setCatccSuffix(e.target.value)}
                disabled={signingIn}
              >
                {CATCC_POSITION_TYPES.map((pt) => (
                  <option key={pt.suffix} value={pt.suffix}>{pt.displayName}</option>
                ))}
              </select>
            </div>
            {catccPositionId && (
              <span className="callsign-preview">{catccPositionId}</span>
            )}
          </section>

          <section>
            <label>Frequency (MHz)</label>
            <input
              type="text"
              value={catccFrequency}
              onChange={(e) => setCatccFrequency(e.target.value)}
              onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setCatccFrequency(n.toFixed(3)) }}
              placeholder="251.100"
              maxLength={7}
              disabled={signingIn}
            />
          </section>
        </>
      )}

      {/* ── AIC ──────────────────────────────────────────────────────── */}
      {selectedModule === MODULE.AIC && (
        <>
          <section>
            <label>Callsign</label>
            <input
              type="text"
              value={aicCallsign}
              onChange={(e) => setAicCallsign(e.target.value.toUpperCase())}
              placeholder="CHALICE"
              disabled={signingIn}
            />
          </section>

          <section>
            <label>Frequency (MHz)</label>
            <input
              type="text"
              value={aicFrequency}
              onChange={(e) => setAicFrequency(e.target.value)}
              onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setAicFrequency(n.toFixed(3)) }}
              placeholder="256.100"
              maxLength={7}
              disabled={signingIn}
            />
          </section>
        </>
      )}

      {/* ── ABM ──────────────────────────────────────────────────────── */}
      {selectedModule === MODULE.ABM && (
        <>
          <section>
            <label>Callsign</label>
            <input
              type="text"
              value={abmCallsign}
              onChange={(e) => setAbmCallsign(e.target.value.toUpperCase())}
              placeholder="OVERLORD"
              disabled={signingIn}
            />
          </section>

          <section>
            <label>Frequency (MHz)</label>
            <input
              type="text"
              value={abmFrequency}
              onChange={(e) => setAbmFrequency(e.target.value)}
              onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setAbmFrequency(n.toFixed(3)) }}
              placeholder="251.100"
              maxLength={7}
              disabled={signingIn}
            />
          </section>
        </>
      )}

      {/* ── Session password (all modules) ───────────────────────────── */}
      <section>
        <label>Session Password</label>
        <input
          type="password"
          value={sessionPassword}
          onChange={(e) => setSessionPassword(e.target.value)}
          placeholder="Optional — leave blank for open session"
          disabled={signingIn}
        />
      </section>

      {error && <p className="login-error">{error}</p>}

      <div className="login-actions">
        <button type="submit" className="connect-btn" disabled={signingIn}>
          {signingIn ? 'Signing in…' : 'Sign In'}
        </button>
        <button type="button" className="disconnect-btn" onClick={handleDisconnect}>
          Disconnect
        </button>
      </div>
    </form>
  )
}

// ── Root login shell ──────────────────────────────────────────────────────────
export function Login() {
  const connected   = useSessionStore((s) => s.connected)

  const [phase, setPhase] = useState(connected ? 'position' : 'connect')

  useEffect(() => {
    if (!connected) setPhase('connect')
  }, [connected])

  return (
    <div className="login-root">
      <div className="login-panel">
        <header className="login-header">
          <h1>TRACS</h1>
          <p>Tactical Radar And Control Suite</p>
          {phase === 'position' && (
            <p className="login-phase-label">Sign In to Position</p>
          )}
        </header>

        {phase === 'connect'
          ? <ConnectPhase  onConnected={() => setPhase('position')} />
          : <PositionPhase onSignedIn={() => {}} />
        }
      </div>
    </div>
  )
}
