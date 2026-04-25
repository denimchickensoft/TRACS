import { useState, useEffect, useRef, useMemo } from 'react'
import { useSessionStore, MODULE, POSITION_MODE } from '../../store/session'
import { useControllersStore } from '../../store/controllers'
import { useUnitsStore } from '../../store/units'
import { useAicStore } from '../../store/aic'
import { wsClient } from '../../ws/client'
import { CARRIER_TYPES } from '../../utils/carriers'
import './Login.css'

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
  const [olympusUrl, setOlympusUrl] = useState(
    () => localStorage.getItem('tracs.lastOlympusUrl') ?? 'http://localhost:4514'
  )
  const [password,   setPassword]   = useState(
    () => localStorage.getItem('tracs.lastCoalitionPassword') ?? ''
  )
  const [coalition,  setCoalition]  = useState('blue')
  const [error,      setError]      = useState(null)
  const [connecting, setConnecting] = useState(false)

  const { setConnection } = useSessionStore()

  async function handleConnect(e) {
    e.preventDefault()
    setError(null)
    setConnecting(true)

    try {
      const res = await fetch('/api/connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ olympusUrl, password, coalition }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Server responded ${res.status}`)
      }

      localStorage.setItem('tracs.lastOlympusUrl', olympusUrl)
      localStorage.setItem('tracs.lastCoalitionPassword', password)
      setConnection({ olympusUrl, coalition })
      wsClient.connect()
      onConnected()
    } catch (err) {
      setError(err.message)
      setConnecting(false)
    }
  }

  return (
    <form className="login-form" onSubmit={handleConnect}>
      <section>
        <label>Olympus Server URL</label>
        <input
          type="url"
          value={olympusUrl}
          onChange={(e) => setOlympusUrl(e.target.value)}
          placeholder="http://your-dcs-server:4514"
          required
          disabled={connecting}
        />
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
    return saved === 'CTR' ? (localStorage.getItem('tracs.atc.lastFacilityId') ?? '') : ''
  })
  const [suffix,    setSuffix]    = useState(() => localStorage.getItem('tracs.atc.lastSuffix')    ?? '')
  const [frequency, setFrequency] = useState(() => localStorage.getItem('tracs.atc.lastFrequency') ?? '')

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

  // ── Session password (shared across modules) ───────────────────────
  const [sessionPassword, setSessionPassword] = useState(
    () => localStorage.getItem('tracs.lastSessionPassword') ?? ''
  )

  const [error,     setError]     = useState(null)
  const [signingIn, setSigningIn] = useState(false)

  // Load position types + ICAO mapping
  useEffect(() => {
    loadPositionTypes()
    fetch('/icaoMapping.json')
      .then((r) => r.json())
      .then((data) => setIcaoMap(data))
      .catch(() => {})
  }, [loadPositionTypes])

  // Default suffix once positionTypes are loaded; also validates saved suffix still exists
  useEffect(() => {
    if (positionTypes.length === 0) return
    if (!suffix || !positionTypes.some((pt) => pt.suffix === suffix)) {
      const twr = positionTypes.find((pt) => pt.suffix === 'TWR')
      setSuffix(twr ? twr.suffix : positionTypes[0].suffix)
    }
  }, [positionTypes]) // eslint-disable-line

  const isCtr = suffix === 'CTR'

  // Skip the first run of the CTR-toggle clear so restored CTR facilityId isn't wiped on mount
  const isCtrMountRef = useRef(true)

  // Normalise Olympus airbases into a flat list, deduplicating by name
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
        return true
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [airbases])

  const landBases      = airbaseList.filter((ab) => !ab.isCarrier)
  const carriers       = airbaseList.filter((ab) =>  ab.isCarrier)
  const airbasesLoaded = airbaseList.length > 0

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
    const theatre = (mission?.theater ?? '').toLowerCase()
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

  const selectedEntry   = airbaseList.find((ab) => ab.name === selectedBase) ?? null
  const isCarrier       = selectedEntry?.isCarrier ?? false
  const constructedName = facilityId && suffix ? `${facilityId}_${suffix}` : ''

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

  function handleSignIn(e) {
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
        positionSuffix:   suffix,
        carrierUnitId:    isCarrier ? selectedEntry.unitId : null,
      })
      registerController(atcPositionName, {
        facility:  facilityId.toUpperCase(),
        suffix,
        frequency: formattedFreq,
      })

    } else if (selectedModule === MODULE.CATCC) {
      const formattedFreq  = parseFloat(catccFrequency).toFixed(3)
      const posTypeDef     = CATCC_POSITION_TYPES.find((pt) => pt.suffix === catccSuffix)
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
      useAicStore.getState().setPlatform(null)
      setPosition({ mode: POSITION_MODE.CONFIGURED, name: callsign })
      setFacility({
        facilityType:     'aic',
        facilityId:       callsign,
        facilityDcsName:  '',
        facilityName:     callsign,
        positionTypeName: 'Controller',
        carrierUnitId:    null,
      })
      registerController(callsign, {
        facility:  callsign,
        suffix:    'AIC',
        frequency: formattedFreq,
      })
    }

    setActiveModule(selectedModule)
    setPositionSet(true)
    onSignedIn()
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
          {!isCtr && (
            <section>
              <label>Facility</label>
              {!airbasesLoaded ? (
                <div className="login-loading">Waiting for Olympus data…</div>
              ) : (
                <select
                  value={selectedBase}
                  onChange={(e) => setSelectedBase(e.target.value)}
                  disabled={signingIn}
                >
                  <option value="">— Select facility —</option>
                  {landBases.length > 0 && (
                    <optgroup label="Airports">
                      {landBases.map((ab) => (
                        <option key={ab.name} value={ab.name}>{ab.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {carriers.length > 0 && (
                    <optgroup label="Carriers">
                      {carriers.map((ab) => (
                        <option key={ab.name} value={ab.name}>{ab.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
            </section>
          )}

          <section className="position-section">
            <label>Position</label>
            <div className="position-fields">
              <input
                type="text"
                className="facility-input"
                value={facilityId}
                onChange={(e) => setFacilityId(e.target.value.toUpperCase())}
                placeholder={isCtr ? 'FIR' : isCarrier ? 'CV74' : 'ICAO'}
                maxLength={4}
                disabled={signingIn}
              />
              <select
                className="suffix-select"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                disabled={signingIn || positionTypes.length === 0}
              >
                {positionTypes.map((pt) => (
                  <option key={pt.suffix} value={pt.suffix}>{pt.displayName}</option>
                ))}
              </select>
            </div>
            {constructedName && (
              <span className="callsign-preview">{constructedName.toUpperCase()}</span>
            )}
            {isCtr && (
              <span className="login-hint">Enter your FIR or ARTCC identifier (e.g. UGGG, KZDC)</span>
            )}
          </section>

          <section>
            <label>Frequency (MHz)</label>
            <input
              type="text"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) setFrequency(n.toFixed(3)) }}
              placeholder="118.100"
              maxLength={7}
              disabled={signingIn}
            />
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
