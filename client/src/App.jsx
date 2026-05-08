import { useEffect, useState, useRef, useCallback } from 'react'
import { useSessionStore, MODULE } from './store/session'
import { useOdsStore }        from './store/ods'
import { useControllersStore } from './store/controllers'
import { Login }         from './components/Login/Login'
import AtcScope          from './modules/atc/AtcScope'
import CatccScope        from './modules/catcc/CatccScope'
import { StatusBoard }   from './modules/catcc/StatusBoard'
import { StripBay }      from './components/StripBay/StripBay'
import { ControllerList } from './components/ControllerList/ControllerList'
import { disconnectWebrtc } from './webrtc/client'

const CL_VISIBLE_KEY = 'tracs.cl.visible'

const PROFILE_STORAGE_KEY = 'tracs.lastProfile'
const DEFAULT_PROFILE     = 'simple'

function getSavedProfile() {
  return localStorage.getItem(PROFILE_STORAGE_KEY) ?? DEFAULT_PROFILE
}

const WEBRTC_COLOR = {
  connected:    '#00cc66',
  relay:        '#ccaa00',
  disconnected: '#555555',
}

export function App() {
  const connected        = useSessionStore((s) => s.connected)
  const positionSet      = useSessionStore((s) => s.positionSet)
  const activeModule     = useSessionStore((s) => s.activeModule)
  const positionName     = useSessionStore((s) => s.positionName)
  const facilityName     = useSessionStore((s) => s.facilityName)
  const positionTypeName = useSessionStore((s) => s.positionTypeName)
  const olympusUrl       = useSessionStore((s) => s.olympusUrl)
  const webrtcStatus     = useSessionStore((s) => s.webrtcStatus)
  const peers            = useSessionStore((s) => s.peers)
  const resetPosition    = useSessionStore((s) => s.resetPosition)

  const [confirmingReset, setConfirmingReset] = useState(false)
  const [clVisible, setClVisible] = useState(() => localStorage.getItem(CL_VISIBLE_KEY) === 'true')
  const [clDocked,  setClDocked]  = useState(true)
  const clPopupRef = useRef(null)

  const { loadManifest, loadProfile, availableProfiles, activeProfileId, activeProfile } = useOdsStore()
  const myEntry = useControllersStore((s) => s.registry[positionName])

  useEffect(() => {
    loadManifest()
    loadProfile(getSavedProfile())
  }, []) // eslint-disable-line

  useEffect(() => {
    if (activeProfileId) localStorage.setItem(PROFILE_STORAGE_KEY, activeProfileId)
  }, [activeProfileId])

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault()
        setClVisible((v) => {
          localStorage.setItem(CL_VISIBLE_KEY, String(!v))
          return !v
        })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── Status board dock/resize/visibility state ──────────────────────
  const [sbDocked,  setSbDocked]  = useState(true)
  const [sbVisible, setSbVisible] = useState(true)
  const [sbWidth,   setSbWidth]   = useState(500)
  const sbWidthRef = useRef(500)
  const popupRef   = useRef(null)

  // ── Strip bay dock/resize/visibility state ─────────────────────────
  const [stripsDocked,  setStripsDocked]  = useState(true)
  const [stripsVisible, setStripsVisible] = useState(true)
  const [stripsWidth,   setStripsWidth]   = useState(520)
  const stripsWidthRef  = useRef(520)
  const stripsPopupRef  = useRef(null)

  const handleStripsResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = stripsWidthRef.current
    const onMove = (ev) => {
      const newW = Math.max(280, Math.min(900, startW - (ev.clientX - startX)))
      stripsWidthRef.current = newW
      setStripsWidth(newW)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [])

  const handleStripsUndock = useCallback(() => {
    const w = stripsWidthRef.current
    const popup = window.open('/?window=strips', 'tracs-strips', `width=${w},height=800,resizable=yes`)
    if (!popup) return
    stripsPopupRef.current = popup
    setStripsDocked(false)
    const id = setInterval(() => {
      if (popup.closed) {
        setStripsDocked(true)
        stripsPopupRef.current = null
        clearInterval(id)
      }
    }, 500)
  }, [])

  const handleSbResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sbWidthRef.current
    const onMove = (ev) => {
      const newW = Math.max(320, Math.min(900, startW - (ev.clientX - startX)))
      sbWidthRef.current = newW
      setSbWidth(newW)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [])

  const handleSbUndock = useCallback(() => {
    const w = sbWidthRef.current
    const popup = window.open(
      '/?window=catcc-board',
      'tracs-catcc-board',
      `width=${w},height=800,resizable=yes`,
    )
    if (!popup) return
    popupRef.current = popup
    setSbDocked(false)
    const id = setInterval(() => {
      if (popup.closed) {
        setSbDocked(true)
        popupRef.current = null
        clearInterval(id)
      }
    }, 500)
  }, [])

  const handleClUndock = useCallback(() => {
    const { facilityId, facilityName: facName } = useSessionStore.getState()
    const params = new URLSearchParams({ window: 'cl', facilityId, facilityName: facName }).toString()
    const popup = window.open(`/?${params}`, 'tracs-cl', 'width=360,height=520,resizable=yes')
    if (!popup) return
    clPopupRef.current = popup
    setClDocked(false)
    const id = setInterval(() => {
      if (popup.closed) {
        setClDocked(true)
        clPopupRef.current = null
        clearInterval(id)
      }
    }, 500)
  }, [])

  if (!positionSet) return <Login />

  const hasAtc   = activeModule === MODULE.ATC
  const hasCatcc = activeModule === MODULE.CATCC

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: activeProfile?.visual.colors.background ?? '#1A1A1A', overflow: 'hidden' }}>

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        gap:            '12px',
        padding:        '2px 8px',
        background:     '#111',
        color:          '#555',
        fontSize:       '0.65rem',
        fontFamily:     'Roboto Mono, monospace',
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        flexShrink:     0,
      }}>

        {/* Identity + connection status */}
        <span>
          TRACS &mdash;
          <span style={{ color: connected ? '#00cc66' : '#cc3333', marginLeft: '6px', marginRight: '6px' }}>
            {connected ? `CONNECTED: ${olympusUrl.replace(/^https?:\/\//, '')}` : 'DISCONNECTED'}
          </span>
          &mdash;
          {facilityName && positionTypeName && <> {facilityName} {positionTypeName} &mdash;</>}
          {' '}{positionName}
          {myEntry?.controllerId && <> [{myEntry.controllerId}]</>}
          {myEntry?.frequency    && <> &mdash; {myEntry.frequency}</>}
          {' '}&mdash; {activeModule}
        </span>

        {/* WebRTC indicator + peer count */}
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{
            width:        '6px',
            height:       '6px',
            borderRadius: '50%',
            background:   WEBRTC_COLOR[webrtcStatus] ?? WEBRTC_COLOR.disconnected,
            display:      'inline-block',
            flexShrink:   0,
          }} />
          <span style={{ color: '#444' }}>
            {peers.length} {peers.length === 1 ? 'PEER' : 'PEERS'}
          </span>
        </span>

        {/* Right side: Change Position + profile switcher */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px', alignItems: 'center' }}>

          {confirmingReset ? (
            <>
              <span style={{ color: '#888' }}>Change Position?</span>
              <button
                onClick={() => { disconnectWebrtc(); resetPosition(); setConfirmingReset(false) }}
                style={{
                  background:    '#3a1a1a',
                  border:        '1px solid #662222',
                  borderRadius:  '2px',
                  color:         '#cc4444',
                  fontFamily:    'inherit',
                  fontSize:      'inherit',
                  letterSpacing: 'inherit',
                  padding:       '1px 8px',
                  cursor:        'pointer',
                  textTransform: 'uppercase',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#994444'; e.currentTarget.style.color = '#ee6666' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#662222'; e.currentTarget.style.color = '#cc4444' }}
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmingReset(false)}
                style={{
                  background:    'transparent',
                  border:        '1px solid #333',
                  borderRadius:  '2px',
                  color:         '#555',
                  fontFamily:    'inherit',
                  fontSize:      'inherit',
                  letterSpacing: 'inherit',
                  padding:       '1px 8px',
                  cursor:        'pointer',
                  textTransform: 'uppercase',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#666'; e.currentTarget.style.color = '#888' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#555' }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmingReset(true)}
              style={{
                background:    'transparent',
                border:        '1px solid #333',
                borderRadius:  '2px',
                color:         '#555',
                fontFamily:    'inherit',
                fontSize:      'inherit',
                letterSpacing: 'inherit',
                padding:       '1px 8px',
                cursor:        'pointer',
                textTransform: 'uppercase',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#666'; e.currentTarget.style.color = '#888' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#555' }}
            >
              Change Position
            </button>
          )}

          {hasAtc && availableProfiles.map((p) => (
            <button
              key={p.id}
              onClick={() => loadProfile(p.id)}
              style={{
                background:    activeProfileId === p.id ? '#2A4A7A' : '#1A1A1A',
                color:         activeProfileId === p.id ? '#88BBFF' : '#555',
                border:        '1px solid #333',
                borderRadius:  '2px',
                padding:       '1px 6px',
                fontFamily:    'inherit',
                fontSize:      'inherit',
                letterSpacing: 'inherit',
                cursor:        'pointer',
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* ── Scope area ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
        {hasAtc && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              <AtcScope />
            </div>
            {stripsVisible && stripsDocked && (
              <StripBay
                docked
                width={stripsWidth}
                onResize={handleStripsResize}
                onUndock={handleStripsUndock}
                onHide={() => setStripsVisible(false)}
              />
            )}
            {stripsVisible && !stripsDocked && (
              <div
                title="Strip bay is undocked"
                onClick={() => { if (stripsPopupRef.current && !stripsPopupRef.current.closed) stripsPopupRef.current.focus() }}
                style={{ width: '18px', background: '#0d0d0d', borderLeft: '1px solid #222', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: '#333', textTransform: 'uppercase' }}>STRIPS</span>
              </div>
            )}
            {!stripsVisible && (
              <div
                title="Show strip bay"
                onClick={() => setStripsVisible(true)}
                style={{ width: '18px', background: '#0d0d0d', borderLeft: '1px solid #222', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: '#333', textTransform: 'uppercase' }}>STRIPS</span>
              </div>
            )}
          </div>
        )}
        {hasCatcc && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              <CatccScope />
            </div>
            {sbVisible && sbDocked && (
              <StatusBoard
                docked
                width={sbWidth}
                onResize={handleSbResize}
                onUndock={handleSbUndock}
                onHide={() => setSbVisible(false)}
              />
            )}
            {sbVisible && !sbDocked && (
              <div
                title="Status board is undocked"
                onClick={() => { if (popupRef.current && !popupRef.current.closed) popupRef.current.focus() }}
                style={{ width: '18px', background: '#0A0A0A', borderLeft: '1px solid #222', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: '#333', textTransform: 'uppercase' }}>STATUS BOARD</span>
              </div>
            )}
            {!sbVisible && (
              <div
                title="Show status board"
                onClick={() => setSbVisible(true)}
                style={{ width: '18px', background: '#0A0A0A', borderLeft: '1px solid #222', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: '#333', textTransform: 'uppercase' }}>STATUS BOARD</span>
              </div>
            )}
          </div>
        )}
        {!hasAtc && !hasCatcc && (
          <div style={{ color: '#333', fontFamily: 'Roboto Mono, monospace', padding: '40px', fontSize: '0.8rem' }}>
            No active display module.
          </div>
        )}

        {clDocked && (
          <ControllerList
            visible={clVisible}
            onClose={() => { setClVisible(false); localStorage.setItem(CL_VISIBLE_KEY, 'false') }}
            onUndock={handleClUndock}
          />
        )}
        {!clDocked && (
          <div
            title="Controller list is in a separate window"
            onClick={() => { if (clPopupRef.current && !clPopupRef.current.closed) clPopupRef.current.focus() }}
            style={{ position: 'absolute', top: 8, right: 8, zIndex: 900, background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: '2px', cursor: 'pointer', padding: '3px 7px', fontFamily: 'Roboto Mono, monospace', fontSize: '8px', letterSpacing: '0.1em', color: '#444', textTransform: 'uppercase', userSelect: 'none' }}
          >
            Controllers ↗
          </div>
        )}
      </div>
    </div>
  )
}
