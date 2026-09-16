import { useEffect, useState, useRef, useCallback } from 'react'
import { useSessionStore, MODULE } from './store/session'
import { useOdsStore }        from './store/ods'
import { useControllersStore } from './store/controllers'
import { useUnitsStore }       from './store/units'
import { useFlightPlansStore } from './store/flightPlans'
import { useAssociationStore } from './store/association'
import { computeAssociations } from './modules/atc/shared/associationEngine.js'
import { dcsUnitIdReliable } from './utils/callsign.js'
import { useAtcStore }         from './store/atc.js'
import { Login }         from './components/Login/Login'
import StarsScope        from './modules/atc/stars/StarsScope'
import AsdexScope        from './modules/atc/asdex/AsdexScope'
import CatccScope        from './modules/catcc/CatccScope'
import { StatusBoard } from './modules/catcc/StatusBoard'
import { SB_NATURAL_WIDTH } from './modules/catcc/statusBoardColumns.js'
import { Deck }           from './modules/catcc/Deck'
import AicScope          from './modules/aic/AicScope'
import { BraaList, BRAA_NATURAL_WIDTH } from './modules/aic/BraaList'
import AbmScope          from './modules/abm/AbmScope'
import { AbmFocusPanel } from './modules/abm/AbmFocusPanel'
import { useAbmFocusPanelsStore } from './store/abmFocusPanels'
import { Ato, ATO_NATURAL_WIDTH } from './modules/abm/Ato'
import { Frag }          from './modules/abm/Frag'
import { Drawings }      from './modules/abm/Drawings'
import { useAbmMissionStore } from './store/abmMission'
import { StripBay }      from './components/StripBay/StripBay'
import { Par }           from './components/par/Par'
import { ControllerList } from './components/ControllerList/ControllerList'
import { Messages }        from './components/Messages/Messages'
import { disconnectWebrtc } from './webrtc/client'
import { setProjectionParams } from './utils/magvar'
import { resumeAudioContext } from './audio/audioEngine'

const CL_VISIBLE_KEY  = 'tracs.cl.visible'
const MSG_VISIBLE_KEY = 'tracs.msg.visible'
const SB_WIDTH_KEY    = 'tracs.sb.width'

const PROFILE_STORAGE_KEY = 'tracs.lastProfile'
const DEFAULT_PROFILE     = 'stars'

const MODULE_DOCS_PAGE = {
  [MODULE.ATC]:   'atc',
  [MODULE.CATCC]: 'catcc',
  [MODULE.AIC]:   'aic',
  [MODULE.ABM]:   'abm',
}

function getSavedProfile() {
  return localStorage.getItem(PROFILE_STORAGE_KEY) ?? DEFAULT_PROFILE
}

// 'relay' (centralized sync, more reliable) is green; 'webrtc' (P2P WebRTC
// mesh, the fallback) is yellow — the more reliable transport gets the "good"
// color, not whichever one happens to be the original/default path.
const WEBRTC_COLOR = {
  webrtc:       '#ccaa00',
  relay:        '#00cc66',
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

  const abmFocusOrder = useAbmFocusPanelsStore((s) => s.order)

  const useDcsNames    = useSessionStore((s) => s.useDcsNames)
  const toggleDcsNames = useSessionStore((s) => s.toggleDcsNames)
  const unreadGeneral  = useSessionStore((s) => s.unreadGeneral)
  const unreadDm       = useSessionStore((s) => s.unreadDm)
  const openDmTab      = useSessionStore((s) => s.openDmTab)

  const [confirmingReset, setConfirmingReset] = useState(false)
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  const [activeOds,       setActiveOds]       = useState('atc')
  const [clVisible,  setClVisible]  = useState(() => localStorage.getItem(CL_VISIBLE_KEY)  === 'true')
  const [msgVisible, setMsgVisible] = useState(() => localStorage.getItem(MSG_VISIBLE_KEY) === 'true')
  const [clDocked,   setClDocked]   = useState(true)
  const clPopupRef = useRef(null)

  const [asdexDocked, setAsdexDocked] = useState(true)
  const asdexPopupRef = useRef(null)

  const { loadManifest, loadProfile, availableProfiles, activeProfileId, activeProfile } = useOdsStore()
  const myEntry = useControllersStore((s) => s.registry[positionName])

  useEffect(() => {
    fetch('/projection_params.json').then((r) => r.ok ? r.json() : null).then((d) => { if (d) setProjectionParams(d) }).catch(() => {})
    loadManifest()
    loadProfile(getSavedProfile())
  }, []) // eslint-disable-line

  useEffect(() => {
    if (activeProfileId) localStorage.setItem(PROFILE_STORAGE_KEY, activeProfileId)
  }, [activeProfileId])

  // ── Transponder-based association — single compute owner ─────────────
  // Mounted here, not inside StarsScope/AsdexScope, because App is the one
  // component always mounted regardless of which ODS is active. Neither
  // units.js nor flightPlans.js needs to know association exists — this is
  // the only place they're read together. See
  // resources/specs/transponder-correlation-spec.md §7.
  const unitsForAssoc     = useUnitsStore((s) => s.units)
  const plansForAssoc     = useFlightPlansStore((s) => s.plans)
  const ownershipForAssoc = useAtcStore((s) => s.ownership)
  const sourceTypeForAssoc = useSessionStore((s) => s.sourceType)
  useEffect(() => {
    const previous = useAssociationStore.getState().associated
    const next = computeAssociations({
      units: unitsForAssoc, flightPlans: plansForAssoc, ownership: ownershipForAssoc, previousAssociated: previous,
      dcsUnitIdReliable: dcsUnitIdReliable(),
    })
    useAssociationStore.getState().setAssociated(next)
  }, [unitsForAssoc, plansForAssoc, ownershipForAssoc, sourceTypeForAssoc])

  // ── IDENT onset detection ─────────────────────────────────────────────
  // Latches identUnacked on the edge (status becomes 2) — same blink
  // treatment as a handoff, cleared only by slewing the contact (see
  // StarsScope.jsx's bare-slew handler and dispatch call), not by a timer
  // and not just because status reverts. See
  // resources/specs/transponder-correlation-spec.md §4.
  const prevIdentStatusRef = useRef({})
  useEffect(() => {
    const prev = prevIdentStatusRef.current
    const nextStatus = {}
    for (const [uid, unit] of Object.entries(unitsForAssoc)) {
      const status = unit.transponder?.status
      if (status === 2 && prev[uid] !== 2) useAtcStore.getState().markIdent(uid)
      if (status != null) nextStatus[uid] = status
    }
    prevIdentStatusRef.current = nextStatus
  }, [unitsForAssoc])

  // Chromium suspends AudioContexts until a user gesture — resume once on
  // the first interaction anywhere in the app so alert tones can play later.
  useEffect(() => {
    const handler = () => {
      resumeAudioContext()
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('keydown', handler)
    }
    window.addEventListener('pointerdown', handler)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('pointerdown', handler)
      window.removeEventListener('keydown', handler)
    }
  }, [])

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault()
        setClVisible((v) => {
          localStorage.setItem(CL_VISIBLE_KEY, String(!v))
          return !v
        })
      }
      if (e.ctrlKey && e.key === 'm') {
        e.preventDefault()
        setMsgVisible((v) => {
          localStorage.setItem(MSG_VISIBLE_KEY, String(!v))
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

  // ── ASDE-X ODS undock handler ──────────────────────────────────────
  const handleAsdexUndock = useCallback(() => {
    const { facilityDcsName, positionSuffix } = useSessionStore.getState()
    const p = new URLSearchParams({ window: 'asdex-ods', facilityDcsName, positionSuffix })
    const popup = window.open(`/?${p}`, 'tracs-asdex-ods', 'width=1024,height=768,resizable=yes')
    if (!popup) return
    asdexPopupRef.current = popup
    setAsdexDocked(false)
    setActiveOds('atc')
    const id = setInterval(() => {
      if (popup.closed) { setAsdexDocked(true); asdexPopupRef.current = null; clearInterval(id) }
    }, 500)
  }, [])

  // ── CATCC right partition (status board + par share one width) ────
  const [sbDocked,  setSbDocked]  = useState(true)
  const initCatccWidth = (() => { const v = parseInt(localStorage.getItem(SB_WIDTH_KEY), 10); return isNaN(v) ? SB_NATURAL_WIDTH : v })()
  const [catccWidth, setCatccWidth] = useState(initCatccWidth)
  const [sbScale,    setSbScale]    = useState(() => {
    const s = parseFloat(localStorage.getItem('tracs.sb.scale'))
    return isNaN(s) ? 1.0 : Math.max(0.5, Math.min(2.0, s))
  })
  const catccWidthRef = useRef(initCatccWidth)
  const sbPopupRef    = useRef(null)
  const handleCatccResize = useCallback(makeResizeHandler(catccWidthRef, setCatccWidth, 320, 1400, SB_WIDTH_KEY), []) // eslint-disable-line
  const handleSbUndock    = useCallback(makeUndockHandler('/?window=catcc-board', 'tracs-catcc-board', catccWidthRef, setSbDocked, sbPopupRef), []) // eslint-disable-line

  const [deckDocked, setDeckDocked] = useState(true)
  const deckPopupRef   = useRef(null)
  // Bespoke (not makeUndockHandler): Deck needs coalition + carrierUnitId, which
  // aren't broadcast on the session BroadcastChannel (see store/session.js —
  // that channel is deliberately scoped to session-wide fields only, since
  // facility/carrier identity is per-scope and must not leak across windows).
  // Passed via URL param instead, same pattern as handleAsdexUndock below.
  const handleDeckUndock = useCallback(() => {
    const { coalition, carrierUnitId } = useSessionStore.getState()
    const p = new URLSearchParams({ window: 'catcc-deck', coalition: coalition ?? '' })
    if (carrierUnitId != null) p.set('carrierUnitId', String(carrierUnitId))
    const popup = window.open(`/?${p}`, 'tracs-catcc-deck', `width=${catccWidthRef.current},height=800,resizable=yes`)
    if (!popup) return
    deckPopupRef.current = popup
    setDeckDocked(false)
    const id = setInterval(() => {
      if (popup.closed) { setDeckDocked(true); deckPopupRef.current = null; clearInterval(id) }
    }, 500)
  }, [])

  // ── ATC right partition (strips + par share one width) ─────────────
  const [stripsDocked,  setStripsDocked]  = useState(true)
  const initAtcWidth = (() => { const v = parseInt(localStorage.getItem('tracs.atc.width'), 10); return isNaN(v) ? 520 : v })()
  const [atcWidth,   setAtcWidth]   = useState(initAtcWidth)
  const [stripsScale, setStripsScale] = useState(() => {
    const s = parseFloat(localStorage.getItem('tracs.strip-bay.scale'))
    return isNaN(s) ? 1.0 : Math.max(0.5, Math.min(2.0, s))
  })
  const atcWidthRef    = useRef(initAtcWidth)
  const stripsPopupRef = useRef(null)
  const handleAtcResize    = useCallback(makeResizeHandler(atcWidthRef, setAtcWidth, 280, 900, 'tracs.atc.width'), []) // eslint-disable-line
  const handleStripsUndock = useCallback(makeUndockHandler('/?window=strips', 'tracs-strips', atcWidthRef, setStripsDocked, stripsPopupRef), []) // eslint-disable-line

  // ── PAR drawer ─────────────────────────────────────────────────────
  const [parDocked, setParDocked] = useState(true)
  const parPopupRef = useRef(null)

  // ── AIC right partition ────────────────────────────────────────────
  const initAicWidth = (() => { const v = parseInt(localStorage.getItem('tracs.braa.width'), 10); return isNaN(v) ? BRAA_NATURAL_WIDTH : v })()
  const [aicWidth,   setAicWidth]   = useState(initAicWidth)
  const [braaScale,  setBraaScale]  = useState(() => {
    const s = parseFloat(localStorage.getItem('tracs.braa.scale'))
    return isNaN(s) ? 1.0 : Math.max(0.7, Math.min(1.4, s))
  })
  const aicWidthRef  = useRef(initAicWidth)
  const braaPopupRef = useRef(null)
  const [aicDocked, setAicDocked] = useState(true)
  const handleAicResize  = useCallback(makeResizeHandler(aicWidthRef, setAicWidth, 220, 600, 'tracs.braa.width'), []) // eslint-disable-line
  const handleBraaUndock = useCallback(makeUndockHandler('/?window=braa', 'tracs-braa', aicWidthRef, setAicDocked, braaPopupRef), []) // eslint-disable-line

  // ── ABM right partition (ATO / FRAG) ───────────────────────────────
  const initAbmWidth = (() => { const v = parseInt(localStorage.getItem('tracs.abm.width'), 10); return isNaN(v) ? ATO_NATURAL_WIDTH : v })()
  const [abmWidth, setAbmWidth] = useState(initAbmWidth)
  const abmWidthRef = useRef(initAbmWidth)
  const atoPopupRef = useRef(null)
  const fragPopupRef = useRef(null)
  const drawingsPopupRef = useRef(null)
  const [atoDocked, setAtoDocked] = useState(true)
  const [fragDocked, setFragDocked] = useState(true)
  const [drawingsDocked, setDrawingsDocked] = useState(true)
  const [atoScale, setAtoScale]   = useState(() => {
    const s = parseFloat(localStorage.getItem('tracs.ato.scale'))
    return isNaN(s) ? 1.0 : Math.max(0.5, Math.min(2.0, s))
  })
  const [fragScale, setFragScale] = useState(() => {
    const s = parseFloat(localStorage.getItem('tracs.frag.scale'))
    return isNaN(s) ? 1.0 : Math.max(0.5, Math.min(2.0, s))
  })
  const [drawingsScale, setDrawingsScale] = useState(() => {
    const s = parseFloat(localStorage.getItem('tracs.abm.drawings.scale'))
    return isNaN(s) ? 1.0 : Math.max(0.5, Math.min(2.0, s))
  })
  const handleAbmResize = useCallback(makeResizeHandler(abmWidthRef, setAbmWidth, 280, 700, 'tracs.abm.width'), []) // eslint-disable-line
  const handleAtoUndock  = useCallback(makeUndockHandler('/?window=abm-ato',  'tracs-abm-ato',  abmWidthRef, setAtoDocked, atoPopupRef), []) // eslint-disable-line
  const handleFragUndock = useCallback(makeUndockHandler('/?window=abm-frag', 'tracs-abm-frag', abmWidthRef, setFragDocked, fragPopupRef), []) // eslint-disable-line
  const handleDrawingsUndock = useCallback(makeUndockHandler('/?window=abm-drawings', 'tracs-abm-drawings', abmWidthRef, setDrawingsDocked, drawingsPopupRef), []) // eslint-disable-line

  // ── Active right panel per scope ('main' | 'par') ─────────────────
  const [atcPanel,   setAtcPanel]   = useState('main')   // 'main' = strips, 'par'
  const [catccPanel, setCatccPanel] = useState('main')   // 'main' = status board, 'par', 'deck'
  const [aicPanel,   setAicPanel]   = useState('main')   // 'main' = braa list
  const [abmPanel,   setAbmPanel]   = useState(null)      // null | 'ato' | 'frag' | 'drawings'

  // Selecting a flight (Ctrl+Shift+Click on the scope, or a row in ATO)
  // auto-switches to the FRAG tab — keyed on selectNonce (not selectedGroupId)
  // so reselecting the same contact still reopens the panel if it was closed.
  const abmSelectedGroupId = useAbmMissionStore((s) => s.selectedGroupId)
  const abmSelectNonce     = useAbmMissionStore((s) => s.selectNonce)
  useEffect(() => {
    if (abmSelectedGroupId != null) setAbmPanel('frag')
  }, [abmSelectNonce]) // eslint-disable-line

  const handleParUndock = useCallback(() => {
    const { mission, carrierUnitId: cid, activeModule: am, facilityDcsName } = useSessionStore.getState()
    const theatre = mission?.mission?.theatre ?? null
    const p       = new URLSearchParams({ window: 'par' })
    if (theatre) p.set('theatre', theatre)
    if (facilityDcsName) p.set('facilityDcsName', facilityDcsName)
    if (am === MODULE.CATCC) {
      p.set('module', 'catcc')
      if (cid != null) p.set('carrierUnitId', String(cid))
    } else {
      p.set('module', 'atc')
    }
    const wRef  = am === MODULE.CATCC ? catccWidthRef : atcWidthRef
    const popup = window.open(`/?${p}`, 'tracs-par', `width=${wRef.current},height=700,resizable=yes`)
    if (!popup) return
    parPopupRef.current = popup
    setParDocked(false)
    const id = setInterval(() => {
      if (popup.closed) { setParDocked(true); parPopupRef.current = null; clearInterval(id) }
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
  const hasAic   = activeModule === MODULE.AIC
  const hasAbm   = activeModule === MODULE.ABM

  const docsPage   = MODULE_DOCS_PAGE[activeModule] ?? 'index'
  const docsAnchor = hasAtc && activeOds === 'asdex' ? '#asde-x-ground-radar' : ''
  const docsHref   = `/docs/${docsPage}${docsAnchor}`

  // Right inset = width consumed by the right panel + the 18px tab strip.
  // Floating windows are clamped so they cannot overlap this area.
  const TAB_STRIP_W = 18
  const panelRightInset = (() => {
    if (hasAtc) {
      if (atcPanel === 'main' && stripsDocked) return Math.round(atcWidth * stripsScale) + TAB_STRIP_W
      if (atcPanel === 'par'  && parDocked)    return atcWidth + TAB_STRIP_W
      return TAB_STRIP_W
    }
    if (hasCatcc) {
      if (catccPanel === 'main' && sbDocked)   return Math.round(catccWidth * sbScale) + TAB_STRIP_W
      if (catccPanel === 'par'  && parDocked)  return catccWidth + TAB_STRIP_W
      if (catccPanel === 'deck' && deckDocked) return catccWidth + TAB_STRIP_W
      return TAB_STRIP_W
    }
    if (hasAic) {
      if (aicPanel === 'main' && aicDocked)    return Math.round(aicWidth * braaScale) + TAB_STRIP_W
      return TAB_STRIP_W
    }
    if (hasAbm) {
      if (abmPanel === 'ato'      && atoDocked)      return Math.round(abmWidth * atoScale)  + TAB_STRIP_W
      if (abmPanel === 'frag'     && fragDocked)     return Math.round(abmWidth * fragScale) + TAB_STRIP_W
      if (abmPanel === 'drawings' && drawingsDocked) return Math.round(abmWidth * drawingsScale) + TAB_STRIP_W
      return TAB_STRIP_W
    }
    return 0
  })()

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

        {/* Unread message indicator */}
        {(() => {
          const totalDm = Object.values(unreadDm).reduce((a, b) => a + b, 0)
          if (!msgVisible && (unreadGeneral > 0 || totalDm > 0)) {
            return (
              <span
                style={{ color: '#cc9900', cursor: 'pointer', letterSpacing: '0.06em' }}
                onClick={() => { setMsgVisible(true); localStorage.setItem(MSG_VISIBLE_KEY, 'true') }}
                title="Open Messages (Ctrl+M)"
              >
                MSG: {unreadGeneral}{totalDm > 0 ? ` / ${totalDm} DM` : ''}
              </span>
            )
          }
          return null
        })()}

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
              onClick={(e) => {
                if (e.shiftKey) {
                  if (!asdexDocked && asdexPopupRef.current && !asdexPopupRef.current.closed) {
                    asdexPopupRef.current.focus()
                  } else {
                    handleAsdexUndock()
                  }
                } else {
                  setActiveOds('asdex')
                }
              }}
              title="ASDE-X — shift-click to open ODS in new window"
              style={{
                background:    activeOds === 'asdex' ? '#2A4A7A' : '#1A1A1A',
                color:         activeOds === 'asdex' ? '#88BBFF' : '#555',
                border:        '1px solid #333',
                borderRadius:  '2px',
                padding:       '1px 6px',
                fontFamily:    'inherit',
                fontSize:      'inherit',
                letterSpacing: 'inherit',
                cursor:        'pointer',
              }}
            >
              ASDE-X
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
            <a
              href={docsHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#888', textDecoration: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#ccc' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#888' }}
            >
              Help / Docs ↗
            </a>
          </div>
        )}
      </div>

      {/* ── Scope area ──────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex' }}>
        {hasAtc && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              {activeOds === 'asdex' ? <AsdexScope /> : <StarsScope />}
            </div>

            {/* ATC right panel — only one shown at a time */}
            {atcPanel === 'main' && stripsDocked && (
              <StripBay
                docked
                width={atcWidth}
                onResize={handleAtcResize}
                onUndock={handleStripsUndock}
                onHide={() => setAtcPanel(null)}
                onScaleChange={setStripsScale}
              />
            )}
            {atcPanel === 'main' && !stripsDocked && null}
            {atcPanel === 'par' && parDocked && (
              <Par
                docked
                width={atcWidth}
                onResize={handleAtcResize}
                onUndock={handleParUndock}
                onHide={() => setAtcPanel(null)}
              />
            )}
            {atcPanel === 'par' && !parDocked && null}

            {/* Tab strip */}
            <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background: '#0d0d0d', borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
              {[
                { key: 'main', label: stripsDocked ? 'STRIPS' : 'STRIPS ↗', onClick: () => { if (!stripsDocked && stripsPopupRef.current) stripsPopupRef.current.focus(); else setAtcPanel((p) => p === 'main' ? null : 'main') } },
                { key: 'par',  label: parDocked    ? 'PAR'    : 'PAR ↗',    onClick: () => { if (!parDocked    && parPopupRef.current)    parPopupRef.current.focus();    else setAtcPanel((p) => p === 'par'  ? null : 'par')  } },
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
                width={catccWidth}
                onResize={handleCatccResize}
                onUndock={handleSbUndock}
                onHide={() => setCatccPanel(null)}
                onScaleChange={setSbScale}
              />
            )}
            {catccPanel === 'main' && !sbDocked && null}
            {catccPanel === 'par' && parDocked && (
              <Par
                docked
                width={catccWidth}
                onResize={handleCatccResize}
                onUndock={handleParUndock}
                onHide={() => setCatccPanel(null)}
              />
            )}
            {catccPanel === 'par' && !parDocked && null}
            {catccPanel === 'deck' && deckDocked && (
              <Deck
                docked
                width={catccWidth}
                onResize={handleCatccResize}
                onUndock={handleDeckUndock}
                onHide={() => setCatccPanel(null)}
              />
            )}
            {catccPanel === 'deck' && !deckDocked && null}

            {/* Tab strip */}
            <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background: '#0a0a0a', borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
              {[
                { key: 'main', label: sbDocked   ? 'STATUS'  : 'STATUS ↗',  onClick: () => { if (!sbDocked   && sbPopupRef.current)   sbPopupRef.current.focus();   else setCatccPanel((p) => p === 'main' ? null : 'main') } },
                { key: 'par',  label: parDocked  ? 'PAR'     : 'PAR ↗',     onClick: () => { if (!parDocked  && parPopupRef.current)  parPopupRef.current.focus();  else setCatccPanel((p) => p === 'par'  ? null : 'par')  } },
                { key: 'deck', label: deckDocked ? 'DECK'    : 'DECK ↗',    onClick: () => { if (!deckDocked && deckPopupRef.current) deckPopupRef.current.focus(); else setCatccPanel((p) => p === 'deck' ? null : 'deck') } },
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

        {hasAic && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              <AicScope />
            </div>

            {aicPanel === 'main' && aicDocked && (
              <BraaList
                docked
                width={aicWidth}
                onResize={handleAicResize}
                onUndock={handleBraaUndock}
                onHide={() => setAicPanel(null)}
                onScaleChange={setBraaScale}
              />
            )}

            {/* Tab strip */}
            <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background: '#0a0a0a', borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
              {[
                { key: 'main', label: aicDocked ? 'BRAA' : 'BRAA ↗', onClick: () => { if (!aicDocked && braaPopupRef.current) braaPopupRef.current.focus(); else setAicPanel(p => p === 'main' ? null : 'main') } },
              ].map(({ key, label, onClick }) => (
                <div
                  key={key}
                  title={label}
                  onClick={onClick}
                  style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #1a1a1a', background: aicPanel === key ? '#141414' : 'transparent' }}
                >
                  <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: aicPanel === key ? '#555' : '#2a2a2a', textTransform: 'uppercase', userSelect: 'none' }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {hasAbm && (
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0, height: '100%' }}>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', height: '100%' }}>
              <AbmScope />
            </div>

            {abmPanel === 'ato' && atoDocked && (
              <Ato
                docked
                width={abmWidth}
                onResize={handleAbmResize}
                onUndock={handleAtoUndock}
                onHide={() => setAbmPanel(null)}
                onScaleChange={setAtoScale}
              />
            )}
            {abmPanel === 'frag' && fragDocked && (
              <Frag
                docked
                width={abmWidth}
                onResize={handleAbmResize}
                onUndock={handleFragUndock}
                onHide={() => setAbmPanel(null)}
                onScaleChange={setFragScale}
              />
            )}
            {abmPanel === 'drawings' && drawingsDocked && (
              <Drawings
                docked
                width={abmWidth}
                onResize={handleAbmResize}
                onUndock={handleDrawingsUndock}
                onHide={() => setAbmPanel(null)}
                onScaleChange={setDrawingsScale}
              />
            )}

            {/* Tab strip */}
            <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background: '#0a0a0a', borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
              {[
                { key: 'ato',      label: atoDocked      ? 'ATO'  : 'ATO ↗',  onClick: () => { if (!atoDocked      && atoPopupRef.current)      atoPopupRef.current.focus();      else setAbmPanel(p => p === 'ato'      ? null : 'ato')      } },
                { key: 'frag',     label: fragDocked     ? 'FRAG' : 'FRAG ↗', onClick: () => { if (!fragDocked     && fragPopupRef.current)     fragPopupRef.current.focus();     else setAbmPanel(p => p === 'frag'     ? null : 'frag')     } },
                { key: 'drawings', label: drawingsDocked ? 'DRAW' : 'DRAW ↗', onClick: () => { if (!drawingsDocked && drawingsPopupRef.current) drawingsPopupRef.current.focus(); else setAbmPanel(p => p === 'drawings' ? null : 'drawings') } },
              ].map(({ key, label, onClick }) => (
                <div
                  key={key}
                  title={label}
                  onClick={onClick}
                  style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #1a1a1a', background: abmPanel === key ? '#141414' : 'transparent' }}
                >
                  <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: abmPanel === key ? '#555' : '#2a2a2a', textTransform: 'uppercase', userSelect: 'none' }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!hasAtc && !hasCatcc && !hasAic && !hasAbm && (
          <div style={{ color: '#333', fontFamily: 'Roboto Mono, monospace', padding: '40px', fontSize: '0.8rem' }}>
            No active display module.
          </div>
        )}

        {clDocked && (
          <ControllerList
            visible={clVisible}
            onClose={() => { setClVisible(false); localStorage.setItem(CL_VISIBLE_KEY, 'false') }}
            onUndock={handleClUndock}
            rightInset={panelRightInset}
            onOpenDm={(positionName) => {
              setMsgVisible(true)
              localStorage.setItem(MSG_VISIBLE_KEY, 'true')
              openDmTab(positionName)
            }}
          />
        )}

        <Messages
          visible={msgVisible}
          onClose={() => { setMsgVisible(false); localStorage.setItem(MSG_VISIBLE_KEY, 'false') }}
          rightInset={panelRightInset}
        />

        {/* ABM focus panels — mounted unconditionally (not gated on hasAbm) so a
            focus panel keeps tracking its contact even after switching modules,
            same as ControllerList/Messages above. */}
        {abmFocusOrder.map((callsign, i) => (
          <AbmFocusPanel key={callsign} callsign={callsign} zIndex={850 + i} cascadeIndex={i} />
        ))}
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
