import { useEffect, useState, useRef, useCallback } from 'react'
import { useSessionStore, MODULE } from './store/session'
import { useOdsStore }        from './store/ods'
import { useControllersStore } from './store/controllers'
import { Login }         from './components/Login/Login'
import AtcScope          from './modules/atc/AtcScope'
import CabScope          from './modules/atc/CabScope'
import CatccScope        from './modules/catcc/CatccScope'
import { StatusBoard, SB_NATURAL_WIDTH } from './modules/catcc/StatusBoard'
import { StripBay }      from './components/StripBay/StripBay'
import { Par }           from './modules/par/Par'
import { ControllerList } from './components/ControllerList/ControllerList'
import { disconnectWebrtc } from './webrtc/client'

const CL_VISIBLE_KEY  = 'tracs.cl.visible'
const SB_WIDTH_KEY    = 'tracs.sb.width'

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
  const carrierUnitId    = useSessionStore((s) => s.carrierUnitId)

  const useDcsNames    = useSessionStore((s) => s.useDcsNames)
  const toggleDcsNames = useSessionStore((s) => s.toggleDcsNames)

  const [confirmingReset, setConfirmingReset] = useState(false)
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  const [activeOds,       setActiveOds]       = useState('atc')
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

  // ── Helper: build undock handler for any docked panel ─────────────
  function makeUndockHandler(url, winName, widthRef, setDocked, popupRef) {
    return () => {
      const popup = window.open(url, winName, `width=${widthRef.current},height=800,resizable=yes`)
      if (!popup) return
      popupRef.current = popup
      setDocked(false)
      const id = setInterval(() => {
        if (popup.closed) { setDocked(true); popupRef.current = null; clearInterval(id) }
      }, 500)
    }
  }

  function makeResizeHandler(widthRef, setWidth, min, max, storageKey = null) {
    return (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = widthRef.current
      const onMove = (ev) => {
        const newW = Math.max(min, Math.min(max, startW - (ev.clientX - startX)))
        widthRef.current = newW
        setWidth(newW)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup',   onUp)
        if (storageKey) localStorage.setItem(storageKey, String(widthRef.current))
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup',   onUp)
    }
  }

  // ── Status board ───────────────────────────────────────────────────
  const [sbDocked,  setSbDocked]  = useState(true)
  const initSbWidth = (() => { const v = parseInt(localStorage.getItem(SB_WIDTH_KEY), 10); return isNaN(v) ? SB_NATURAL_WIDTH : v })()
  const [sbWidth,   setSbWidth]   = useState(initSbWidth)
  const sbWidthRef = useRef(initSbWidth)
  const sbPopupRef = useRef(null)
  const handleSbResize  = useCallback(makeResizeHandler(sbWidthRef, setSbWidth, 320, 1400, SB_WIDTH_KEY), []) // eslint-disable-line
  const handleSbUndock  = useCallback(makeUndockHandler('/?window=catcc-board', 'tracs-catcc-board', sbWidthRef, setSbDocked, sbPopupRef), []) // eslint-disable-line

  // ── Strip bay ──────────────────────────────────────────────────────
  const [stripsDocked,  setStripsDocked]  = useState(true)
  const [stripsWidth,   setStripsWidth]   = useState(520)
  const stripsWidthRef  = useRef(520)
  const stripsPopupRef  = useRef(null)
  const handleStripsResize = useCallback(makeResizeHandler(stripsWidthRef, setStripsWidth, 280, 900), []) // eslint-disable-line
  const handleStripsUndock = useCallback(makeUndockHandler('/?window=strips', 'tracs-strips', stripsWidthRef, setStripsDocked, stripsPopupRef), []) // eslint-disable-line

  // ── PAR drawer ─────────────────────────────────────────────────────
  const [parDocked,  setParDocked]  = useState(true)
  const [parWidth,   setParWidth]   = useState(560)
  const parWidthRef  = useRef(560)
  const parPopupRef  = useRef(null)
  const handleParResize = useCallback(makeResizeHandler(parWidthRef, setParWidth, 400, 900), []) // eslint-disable-line

  // ── Active right panel per scope ('main' | 'par') ─────────────────
  const [atcPanel,   setAtcPanel]   = useState('main')   // 'main' = strips, 'par'
  const [catccPanel, setCatccPanel] = useState('main')   // 'main' = status board, 'par'

  const handleParUndock = useCallback(() => {
    const { mission, carrierUnitId: cid } = useSessionStore.getState()
    const theatre = mission?.mission?.theatre ?? null
    const p       = new URLSearchParams({ window: 'par' })
    if (theatre) p.set('theatre', theatre)
    if (activeModule === MODULE.CATCC) {
      p.set('module', 'catcc')
      if (cid != null) p.set('carrierUnitId', String(cid))
    } else {
      p.set('module', 'atc')
    }
    const popup = window.open(`/?${p}`, 'tracs-par', `width=${parWidthRef.current},height=700,resizable=yes`)
    if (!popup) return
    parPopupRef.current = popup
    setParDocked(false)
    const id = setInterval(() => {
      if (popup.closed) { setParDocked(true); parPopupRef.current = null; clearInterval(id) }
    }, 500)
  }, [activeModule]) // eslint-disable-line

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
        position:       'relative',
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
              onClick={() => { loadProfile(p.id); setActiveOds('atc') }}
              style={{
                background:    activeOds === 'atc' && activeProfileId === p.id ? '#2A4A7A' : '#1A1A1A',
                color:         activeOds === 'atc' && activeProfileId === p.id ? '#88BBFF' : '#555',
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

          {hasAtc && (
            <button
              onClick={() => setActiveOds('cab')}
              style={{
                background:    activeOds === 'cab' ? '#2A4A7A' : '#1A1A1A',
                color:         activeOds === 'cab' ? '#88BBFF' : '#555',
                border:        '1px solid #333',
                borderRadius:  '2px',
                padding:       '1px 6px',
                fontFamily:    'inherit',
                fontSize:      'inherit',
                letterSpacing: 'inherit',
                cursor:        'pointer',
              }}
            >
              CAB
            </button>
          )}

          <button
            onClick={() => setSettingsOpen((o) => !o)}
            title="Settings"
            style={{
              background:    settingsOpen ? '#222' : 'transparent',
              border:        `1px solid ${settingsOpen ? '#444' : '#333'}`,
              borderRadius:  '2px',
              color:         settingsOpen ? '#aaa' : '#555',
              fontFamily:    'inherit',
              fontSize:      '0.75rem',
              padding:       '1px 6px',
              cursor:        'pointer',
              lineHeight:    1,
            }}
            onMouseEnter={(e) => { if (!settingsOpen) { e.currentTarget.style.borderColor = '#555'; e.currentTarget.style.color = '#888' } }}
            onMouseLeave={(e) => { if (!settingsOpen) { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#555' } }}
          >
            ⚙
          </button>
        </div>

        {/* Settings panel */}
        {settingsOpen && (
          <div style={{
            position:      'absolute',
            top:           '100%',
            right:         '8px',
            background:    '#1a1a1a',
            border:        '1px solid #333',
            borderRadius:  '3px',
            padding:       '10px 14px',
            zIndex:        200,
            minWidth:      '220px',
            display:       'flex',
            flexDirection: 'column',
            gap:           '8px',
          }}>
            <div style={{ color: '#444', fontSize: '0.6rem', letterSpacing: '0.12em' }}>SETTINGS</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#888', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={useDcsNames}
                onChange={toggleDcsNames}
                style={{ cursor: 'pointer', accentColor: '#4488cc' }}
              />
              Use DCS Multiplayer Names
            </label>
          </div>
        )}
      </div>

      {/* ── Scope area ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
        {hasAtc && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              {activeOds === 'cab' ? <CabScope /> : <AtcScope />}
            </div>

            {/* ATC right panel — only one shown at a time */}
            {atcPanel === 'main' && stripsDocked && (
              <StripBay
                docked
                width={stripsWidth}
                onResize={handleStripsResize}
                onUndock={handleStripsUndock}
                onHide={() => setAtcPanel(null)}
              />
            )}
            {atcPanel === 'main' && !stripsDocked && null}
            {atcPanel === 'par' && parDocked && (
              <Par
                docked
                width={parWidth}
                onResize={handleParResize}
                onUndock={handleParUndock}
                onHide={() => setAtcPanel(null)}
              />
            )}
            {atcPanel === 'par' && !parDocked && null}

            {/* Tab strip */}
            <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background: '#0d0d0d', borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
              {[
                { key: 'main', label: stripsDocked ? 'STRIPS' : 'STRIPS ↗', onClick: () => { if (!stripsDocked && stripsPopupRef.current) stripsPopupRef.current.focus(); else setAtcPanel('main') } },
                { key: 'par',  label: parDocked    ? 'PAR'    : 'PAR ↗',    onClick: () => { if (!parDocked    && parPopupRef.current)    parPopupRef.current.focus();    else setAtcPanel('par')  } },
              ].map(({ key, label, onClick }) => (
                <div
                  key={key}
                  title={label}
                  onClick={onClick}
                  style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #1a1a1a', background: atcPanel === key ? '#141414' : 'transparent' }}
                >
                  <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: atcPanel === key ? '#555' : '#2a2a2a', textTransform: 'uppercase', userSelect: 'none' }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasCatcc && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              <CatccScope />
            </div>

            {/* CATCC right panel — only one shown at a time */}
            {catccPanel === 'main' && sbDocked && (
              <StatusBoard
                docked
                width={sbWidth}
                onResize={handleSbResize}
                onUndock={handleSbUndock}
                onHide={() => setCatccPanel(null)}
              />
            )}
            {catccPanel === 'main' && !sbDocked && null}
            {catccPanel === 'par' && parDocked && (
              <Par
                docked
                width={parWidth}
                onResize={handleParResize}
                onUndock={handleParUndock}
                onHide={() => setCatccPanel(null)}
              />
            )}
            {catccPanel === 'par' && !parDocked && null}

            {/* Tab strip */}
            <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background: '#0a0a0a', borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
              {[
                { key: 'main', label: sbDocked  ? 'STATUS'  : 'STATUS ↗',  onClick: () => { if (!sbDocked  && sbPopupRef.current)  sbPopupRef.current.focus();  else setCatccPanel('main') } },
                { key: 'par',  label: parDocked ? 'PAR'     : 'PAR ↗',     onClick: () => { if (!parDocked && parPopupRef.current) parPopupRef.current.focus(); else setCatccPanel('par')  } },
              ].map(({ key, label, onClick }) => (
                <div
                  key={key}
                  title={label}
                  onClick={onClick}
                  style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #1a1a1a', background: catccPanel === key ? '#141414' : 'transparent' }}
                >
                  <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: catccPanel === key ? '#555' : '#2a2a2a', textTransform: 'uppercase', userSelect: 'none' }}>{label}</span>
                </div>
              ))}
            </div>
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
