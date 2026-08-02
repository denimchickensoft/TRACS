import { useState, useEffect, useRef, useMemo } from 'react'
import { useSessionStore, MODULE, POSITION_MODE } from '../../store/session'
import { useControllersStore } from '../../store/controllers'
import { useUnitsStore } from '../../store/units'
import { useAicStore } from '../../store/aic'
import { useStatusBoardStore } from '../../store/statusBoard'
import { wsClient } from '../../ws/client'
import { initWebrtc } from '../../webrtc/client'
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

// ── Phase 1: Connect to Olympus ───────────────────────────────────────────────
function ConnectPhase({ onConnected }) {
  const [profiles,   setProfiles]   = useState(() => loadServerProfiles())
  const lastConnection = useMemo(() => loadLastConnection(), []) // eslint-disable-line
  const lastProfile = useMemo(() => getMostRecentProfile(profiles), []) // eslint-disable-line
  const [name,       setName]       = useState(() => lastConnection?.name ?? lastProfile?.name ?? '')
  const [olympusUrl, setOlympusUrl] = useState(() => lastConnection?.url ?? lastProfile?.url ?? '')
  const [coalition,  setCoalition]  = useState(() => lastConnection?.coalition ?? lastProfile?.lastCoalition ?? localStorage.getItem('tracs.lastCoalition') ?? 'blue')
  const [password,   setPassword]   = useState(() => lastConnection?.password ?? lastProfile?.passwords?.[coalition] ?? '')
  const [error,      setError]      = useState(null)
  const [connecting, setConnecting] = useState(false)

  const [showDropdown,      setShowDropdown]      = useState(false)
  const [confirmDeleteName, setConfirmDeleteName] = useState(null)
  const [confirmOverwrite, setConfirmOverwrite]   = useState(false)
  const [saveStatus,       setSaveStatus]         = useState(null) // null | 'saved'
  const saveStatusTimer = useRef(null)
  useEffect(() => () => clearTimeout(saveStatusTimer.current), [])

  const { setConnection } = useSessionStore()

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

  function normalizeUrl(raw) {
    let url = raw.trim()
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url
    url = url.replace(/\/+$/, '')
    return url
  }

  function handleSelectProfile(profile) {
    const profileCoalition = profile.lastCoalition ?? coalition
    setName(profile.name)
    setOlympusUrl(profile.url)
    setCoalition(profileCoalition)
    setPassword(profile.passwords[profileCoalition] ?? '')
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
    const normalizedUrl = normalizeUrl(olympusUrl)
    setOlympusUrl(normalizedUrl)
    setProfiles((prev) => upsertServerProfile(prev, { name, url: normalizedUrl, coalition, password }))
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
    setConnecting(true)

    const normalizedUrl = normalizeUrl(olympusUrl)
    setOlympusUrl(normalizedUrl)

    try {
      const res = await fetch('/api/connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ olympusUrl: normalizedUrl, password, coalition }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Server responded ${res.status}`)
      }

      localStorage.setItem('tracs.lastCoalition', coalition)
      saveLastConnection({ name, url: normalizedUrl, coalition, password })
      if (name.trim()) {
        setProfiles((prev) => upsertServerProfile(prev, { name, url: normalizedUrl, coalition, password }))
      }
      setConnection({ olympusUrl: normalizedUrl, coalition })
      wsClient.connect()
      onConnected()
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
        <label>Olympus Server URL &amp; Port</label>
        <input
          type="text"
          value={olympusUrl}
          onChange={(e) => setOlympusUrl(e.target.value)}
          placeholder="http://dcs-server-address:4513"
          required
          disabled={connecting}
        />
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
          placeholder="Olympus coalition password"
          disabled={connecting}
        />
      </section>

      {error && <p className="login-error">{error}</p>}

      <button type="submit" className="connect-btn" disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect to Network'}
      </button>
    </form>
  )
}

// ── Phase 2: Sign in to position ──────────────────────────────────────────────
function PositionPhase({ onSignedIn }) {
  const {
    airbases, mission,
    setPosition, setFacility, setActiveModule, setPositionSet, setAicConfig, reset,
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

  // Normalise Olympus airbases into a flat list, deduplicating by name.
  // When runway data is loaded, filter out helicopter pads and FOBs (no runway geometry).
  const airbaseList = useMemo(() => {
    const raw  = airbases?.airbases ?? airbases ?? {}
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
  }, [airbases, runwayBaseNames])

  const landBases        = airbaseList.filter((ab) => !ab.isCarrier)
  const carriers         = airbaseList.filter((ab) =>  ab.isCarrier)
  const airbasesReceived = airbases !== null
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

  // Auto-populate facility ID when base selection changes
  useEffect(() => {
    if (!selectedBase || isCtr) return
    const entry = airbaseList.find((ab) => ab.name === selectedBase)
    if (!entry) return
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
  }, [facilityId, suffix, selectedModule, selectedBase, airbaseList]) // eslint-disable-line

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
  }, [isCtr, mission?.mission?.theatre]) // eslint-disable-line

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
                <div className="login-loading">Waiting for Olympus data…</div>
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
  const positionSet = useSessionStore((s) => s.positionSet)

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
