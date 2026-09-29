import { useEffect, useState, useRef, useCallback } from 'react'
import { useSessionStore, MODULE } from './store/session'
import { useOdsStore }        from './store/ods'
import { useControllersStore } from './store/controllers'
import { useFpeStore }         from './store/fpe.js'
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
import { relayInfo } from './webrtc/syncClient'
import { setProjectionParams } from './utils/magvar'
import { resumeAudioContext } from './audio/audioEngine'
import { useLnmStore, lnmPromptDismissed } from './store/lnm.js'
import { LnmSetupDialog } from './components/LnmSetup/LnmSetupDialog'
import { RightTabStrip } from './components/RightTabStrip'
import { AssociationOwner } from './components/AssociationOwner'

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

// Relay trouble shown next to the peer count: the sync link (syncIssue) and
// the SRS transponder feed (srsIssue), prefixed SYNC or SRS.
const RELAY_ISSUE_TEXT = {
  retrying: 'NO RESPONSE: RECONNECTING',
  password: 'DISCONNECTED (relay rejected the password)',
  protocol: 'DISCONNECTED (relay and TRACS versions don’t match)',
}

// A panel's saved zoom scale from localStorage, clamped to [min, max];
// 1.0 when unset or unreadable.
function readScale(key, min = 0.5, max = 2.0) {
  const s = parseFloat(localStorage.getItem(key))
  return isNaN(s) ? 1.0 : Math.max(min, Math.min(max, s))
}

export function App() {
  const connected        = useSessionStore((s) => s.connected)
  const connectionIssue  = useSessionStore((s) => s.connectionIssue)
  const connectionRetrying = useSessionStore((s) => s.connectionRetrying)
  const syncIssue        = useSessionStore((s) => s.syncIssue)
  const srsIssue         = useSessionStore((s) => s.srsIssue)
  const positionSet      = useSessionStore((s) => s.positionSet)
  const activeModule     = useSessionStore((s) => s.activeModule)
  const positionName     = useSessionStore((s) => s.positionName)
  const facilityName     = useSessionStore((s) => s.facilityName)
  const positionTypeName = useSessionStore((s) => s.positionTypeName)
  const olympusUrl       = useSessionStore((s) => s.olympusUrl)
  const relayUrl         = useSessionStore((s) => s.relayUrl)
  const webrtcStatus     = useSessionStore((s) => s.webrtcStatus)
  const peers            = useSessionStore((s) => s.peers)
  const resetPosition    = useSessionStore((s) => s.resetPosition)

  const abmFocusOrder = useAbmFocusPanelsStore((s) => s.order)

  const useDcsNames    = useSessionStore((s) => s.useDcsNames)
  const toggleDcsNames = useSessionStore((s) => s.toggleDcsNames)
  const soundsEnabled  = useSessionStore((s) => s.soundsEnabled)
  const toggleSounds   = useSessionStore((s) => s.toggleSounds)
  const unreadGeneral  = useSessionStore((s) => s.unreadGeneral)
  const unreadDm       = useSessionStore((s) => s.unreadDm)
  const openDmTab      = useSessionStore((s) => s.openDmTab)

  const [confirmingReset, setConfirmingReset] = useState(false)
  const [settingsOpen,    setSettingsOpen]    = useState(false)
  const [tracsVersion,    setTracsVersion]    = useState(null)
  const [relaySnapshot,   setRelaySnapshot]   = useState({ version: null, protocolVersion: null })
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI
  const firstRunPromptedRef = useRef(false)

  // LittleNavMap database setup (desktop app only - it needs the native file
  // picker). Opens automatically once per launch while no database is set,
  // unless the operator chose "Don't ask again"; Settings reopens it anytime.
  const lnmDbPath = useLnmStore((s) => s.lnmDbPath)
  const [lnmDialog, setLnmDialog] = useState(null) // null | 'first-run' | 'settings'
  const openLnmDialog = useCallback((mode) => {
    useLnmStore.setState({ error: null })
    setLnmDialog(mode)
  }, [])

  // "Check on launch, ask before downloading" —
  // electronAPI events only fire inside the packaged Electron app; a plain
  // browser tab never receives them.
  // The main process owns the state; read it on mount in case the check
  // finished before this page loaded, then follow its changes.
  const [update, setUpdate] = useState({ status: null, version: null, percent: 0 })
  // Dismissing hides the banner until the status changes (e.g. to 'ready').
  const [dismissedStatus, setDismissedStatus] = useState(null)

  useEffect(() => {
    if (!isElectron) return
    const off = window.electronAPI.onUpdateState(setUpdate)
    window.electronAPI.getUpdateState().then(setUpdate)
    return off
  }, [isElectron])

  const updateBanner = update.status !== dismissedStatus ? update.status : null

  useEffect(() => {
    if (!settingsOpen) return
    setRelaySnapshot({ ...relayInfo })
    if (isElectron && tracsVersion === null) {
      window.electronAPI.getVersion().then(setTracsVersion)
    }
  }, [settingsOpen, isElectron, tracsVersion])

  useEffect(() => {
    if (!isElectron || firstRunPromptedRef.current || lnmDbPath !== null) return
    firstRunPromptedRef.current = true
    if (!lnmPromptDismissed()) openLnmDialog('first-run')
  }, [isElectron, lnmDbPath, openLnmDialog])
  const [activeOds,       setActiveOds]       = useState('atc')
  // Scope-less FPE opens (Strip Bay double-click) land on whichever ODS is showing
  useEffect(() => { useFpeStore.getState().setDefaultScope(activeOds === 'asdex' ? 'asdex' : 'atc') }, [activeOds])
  const [clVisible,  setClVisible]  = useState(() => localStorage.getItem(CL_VISIBLE_KEY)  === 'true')
  const [msgVisible, setMsgVisible] = useState(() => localStorage.getItem(MSG_VISIBLE_KEY) === 'true')
  const [clDocked,   setClDocked]   = useState(true)
  const clPopupRef = useRef(null)

  const [asdexDocked, setAsdexDocked] = useState(true)
  const asdexPopupRef = useRef(null)

  const loadManifest      = useOdsStore((s) => s.loadManifest)
  const loadProfile       = useOdsStore((s) => s.loadProfile)
  const availableProfiles = useOdsStore((s) => s.availableProfiles)
  const activeProfileId   = useOdsStore((s) => s.activeProfileId)
  const activeProfile     = useOdsStore((s) => s.activeProfile)
  const myEntry = useControllersStore((s) => s.registry[positionName])

  useEffect(() => {
    fetch('/projection_params.json').then((r) => r.ok ? r.json() : null).then((d) => { if (d) setProjectionParams(d) }).catch(() => {})
    loadManifest()
    loadProfile(getSavedProfile())
  }, []) // eslint-disable-line

  useEffect(() => {
    if (activeProfileId) localStorage.setItem(PROFILE_STORAGE_KEY, activeProfileId)
  }, [activeProfileId])

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
  // `url` may be a plain string (resolved once, at call-construction time)
  // or a function returning one (resolved fresh on every actual undock click
  // — needed by handlers that must embed current session state in the
  // popup's URL). Every popup gets facilityId/positionName merged in here,
  // regardless of what `url` already contains — session.js's cross-window
  // sync (positionName/coalition/etc.) runs generically in every window and
  // needs this identity to scope itself to "this position's own windows
  // only," so a genuinely independent position (opened via New Window)
  // never bleeds into an unrelated one.
  function makeUndockHandler(url, winName, widthRef, setDocked, popupRef) {
    return () => {
      const resolvedUrl = typeof url === 'function' ? url() : url
      const [path, query] = resolvedUrl.split('?')
      const params = new URLSearchParams(query ?? '')
      const { facilityId, positionName } = useSessionStore.getState()
      params.set('facilityId', facilityId)
      params.set('positionName', positionName)
      const scopedUrl = `${path}?${params}`
      const popup = window.open(scopedUrl, winName, `width=${widthRef.current},height=800,resizable=yes`)
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
    const { facilityDcsName, positionSuffix, facilityId, positionName } = useSessionStore.getState()
    const p = new URLSearchParams({ window: 'asdex-ods', facilityDcsName, positionSuffix, facilityId, positionName })
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
  const [sbScale,    setSbScale]    = useState(() => readScale('tracs.sb.scale'))
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
    const { coalition, carrierUnitId, facilityId, positionName } = useSessionStore.getState()
    const p = new URLSearchParams({ window: 'catcc-deck', coalition: coalition ?? '', facilityId, positionName })
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
  const [stripsScale, setStripsScale] = useState(() => readScale('tracs.strip-bay.scale'))
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
  const [braaScale,  setBraaScale]  = useState(() => readScale('tracs.braa.scale', 0.7, 1.4))
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
  const [atoScale, setAtoScale]   = useState(() => readScale('tracs.ato.scale'))
  const [fragScale, setFragScale] = useState(() => readScale('tracs.frag.scale'))
  const [drawingsScale, setDrawingsScale] = useState(() => readScale('tracs.abm.drawings.scale'))
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
    const { mission, carrierUnitId: cid, activeModule: am, facilityDcsName, facilityId, positionName } = useSessionStore.getState()
    const theatre = mission?.mission?.theatre ?? null
    const p       = new URLSearchParams({ window: 'par', facilityId, positionName })
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
    const { facilityId, facilityName: facName, positionName } = useSessionStore.getState()
    const params = new URLSearchParams({ window: 'cl', facilityId, facilityName: facName, positionName }).toString()
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


  const lnmDialogEl = lnmDialog && (
    <LnmSetupDialog firstRun={lnmDialog === 'first-run'} onClose={() => setLnmDialog(null)} />
  )

  const updateButtonStyle = { background: '#254', border: '1px solid #4a6', borderRadius: '2px', color: '#cfc', fontSize: '0.68rem', padding: '2px 8px', cursor: 'pointer' }
  // Shown on the sign-in screen too, where it overlays the top edge instead
  // of taking a row in the layout.
  const updateBannerEl = updateBanner && (
    <div style={{
      display:        'flex',
      alignItems:     'center',
      gap:            '10px',
      padding:        '4px 10px',
      background:     '#1a2a1a',
      color:          '#9c9',
      fontSize:       '0.7rem',
      fontFamily:     'Roboto Mono, monospace',
      flexShrink:     0,
      ...(!positionSet && { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000 }),
    }}>
      {updateBanner === 'available'   && <span>Update available — v{update.version}</span>}
      {updateBanner === 'notify-only' && <span>Update available — v{update.version} (download manually — auto-update isn't supported on Mac without a code-signing certificate)</span>}
      {updateBanner === 'downloading' && <span>Downloading update... {Math.round(update.percent)}%</span>}
      {updateBanner === 'ready'       && <span>Update downloaded — restart to install</span>}

      {updateBanner === 'available' && (
        <button onClick={() => window.electronAPI.downloadUpdate()} style={updateButtonStyle}>
          Download
        </button>
      )}
      {updateBanner === 'notify-only' && (
        <button onClick={() => window.electronAPI.openReleasePage()} style={updateButtonStyle}>
          View release
        </button>
      )}
      {updateBanner === 'ready' && (
        <button onClick={() => window.electronAPI.installUpdate()} style={updateButtonStyle}>
          Restart to install
        </button>
      )}
      <button onClick={() => setDismissedStatus(update.status)}
        style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#688', cursor: 'pointer', fontSize: '0.7rem' }}>
        dismiss
      </button>
    </div>
  )

  if (!positionSet) return <><AssociationOwner />{lnmDialogEl}{updateBannerEl}<Login /></>

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

  // AssociationOwner is the first child of a top-level fragment in both this
  // return and the sign-in one above, so React keeps the same instance (and
  // its IDENT edge-detection state) when switching between them.
  return (
    <>
    <AssociationOwner />
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: activeProfile?.visual.colors.background ?? '#1A1A1A', overflow: 'hidden' }}>
      {lnmDialogEl}

      {updateBannerEl}

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div style={{
        position:       'relative',
        display:        'flex',
        alignItems:     'center',
        gap:            '12px',
        padding:        '2px 8px',
        background:     '#111',
        color:          '#888',
        fontSize:       '0.65rem',
        fontFamily:     'Roboto Mono, monospace',
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        flexShrink:     0,
      }}>

        {/* Identity + connection status */}
        <span>
          TRACS &mdash;
          <span style={{ color: !connected ? '#cc3333' : connectionRetrying ? '#ccaa00' : '#00cc66', marginLeft: '6px', marginRight: '6px' }}>
            {!connected
              ? `DISCONNECTED${connectionIssue ? ` (${connectionIssue})` : ''}`
              : connectionRetrying
                ? `NO RESPONSE: RECONNECTING${connectionIssue ? ` (${connectionIssue})` : ''}`
                : `CONNECTED: ${(olympusUrl || relayUrl).replace(/^(https?|wss?):\/\//, '')}`}
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
          <span style={{ color: '#777' }}>
            {peers.length} {peers.length === 1 ? 'PEER' : 'PEERS'}
          </span>
          {[['SYNC', syncIssue], ['SRS', srsIssue]].map(([label, issue]) => issue && (
            <span key={label} style={{ color: issue === 'retrying' ? '#ccaa00' : '#cc3333', marginLeft: '4px' }}>
              {label}: {RELAY_ISSUE_TEXT[issue]}
            </span>
          ))}
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
                  color:         '#888',
                  fontFamily:    'inherit',
                  fontSize:      'inherit',
                  letterSpacing: 'inherit',
                  padding:       '1px 8px',
                  cursor:        'pointer',
                  textTransform: 'uppercase',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#666'; e.currentTarget.style.color = '#ccc' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#888' }}
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
                color:         '#888',
                fontFamily:    'inherit',
                fontSize:      'inherit',
                letterSpacing: 'inherit',
                padding:       '1px 8px',
                cursor:        'pointer',
                textTransform: 'uppercase',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#666'; e.currentTarget.style.color = '#ccc' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#888' }}
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
                color:         activeOds === 'atc' && activeProfileId === p.id ? '#88BBFF' : '#888',
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
                color:         activeOds === 'asdex' ? '#88BBFF' : '#888',
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
              color:         settingsOpen ? '#aaa' : '#888',
              fontFamily:    'inherit',
              fontSize:      '0.75rem',
              padding:       '1px 6px',
              cursor:        'pointer',
              lineHeight:    1,
            }}
            onMouseEnter={(e) => { if (!settingsOpen) { e.currentTarget.style.borderColor = '#555'; e.currentTarget.style.color = '#ccc' } }}
            onMouseLeave={(e) => { if (!settingsOpen) { e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#888' } }}
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
            minWidth:      '320px',
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
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: '#888', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={soundsEnabled}
                onChange={toggleSounds}
                style={{ cursor: 'pointer', accentColor: '#4488cc' }}
              />
              Sounds
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#888', fontSize: '0.7rem' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lnmDbPath ?? ''}>
                Navigation Data: {typeof lnmDbPath === 'string' ? lnmDbPath.split(/[\\/]/).pop() : 'not configured'}
              </span>
              {isElectron && (
                <button
                  onClick={() => { setSettingsOpen(false); openLnmDialog('settings') }}
                  style={{ background: 'transparent', border: '1px solid #444', borderRadius: '3px', color: '#888', cursor: 'pointer', fontSize: '0.65rem', padding: '1px 8px' }}
                >
                  Change…
                </button>
              )}
            </div>

            <div style={{ borderTop: '1px solid #2a2a2a', paddingTop: '8px', fontSize: '0.65rem', color: '#888' }}>
              {isElectron ? `TRACS v${tracsVersion ?? '…'}` : 'TRACS (dev)'}
              {relaySnapshot.version && ` — Relay v${relaySnapshot.version} (protocol ${relaySnapshot.protocolVersion})`}
            </div>

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

            {/* Legal notices (GPLv3 §5(d)): the copyright, no-warranty and
                attribution text lives on these two pages. The OSM credit is
                shown on the login screen instead. */}
            <div style={{ borderTop: '1px solid #2a2a2a', paddingTop: '8px', fontSize: '0.6rem', color: '#888', lineHeight: 1.5, maxWidth: '320px' }}>
              <div style={{ display: 'flex', gap: '12px' }}>
                {[['/docs/license', 'License ↗'], ['/docs/third-party-notices', 'Third-party notices ↗']].map(([href, label]) => (
                  <a
                    key={href}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#888', textDecoration: 'none', cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#ccc' }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#888' }}
                  >
                    {label}
                  </a>
                ))}
              </div>
            </div>
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
            {atcPanel === 'par' && parDocked && (
              <Par
                docked
                width={atcWidth}
                onResize={handleAtcResize}
                onUndock={handleParUndock}
                onHide={() => setAtcPanel(null)}
              />
            )}

            {/* Tab strip */}
            <RightTabStrip
              background="#0d0d0d"
              active={atcPanel}
              setActive={setAtcPanel}
              tabs={[
                { key: 'main', name: 'STRIPS', docked: stripsDocked, popupRef: stripsPopupRef },
                { key: 'par',  name: 'PAR',    docked: parDocked,    popupRef: parPopupRef },
              ]}
            />
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
            {catccPanel === 'par' && parDocked && (
              <Par
                docked
                width={catccWidth}
                onResize={handleCatccResize}
                onUndock={handleParUndock}
                onHide={() => setCatccPanel(null)}
              />
            )}
            {catccPanel === 'deck' && deckDocked && (
              <Deck
                docked
                width={catccWidth}
                onResize={handleCatccResize}
                onUndock={handleDeckUndock}
                onHide={() => setCatccPanel(null)}
              />
            )}

            {/* Tab strip */}
            <RightTabStrip
              active={catccPanel}
              setActive={setCatccPanel}
              tabs={[
                { key: 'main', name: 'STATUS', docked: sbDocked,   popupRef: sbPopupRef },
                { key: 'par',  name: 'PAR',    docked: parDocked,  popupRef: parPopupRef },
                { key: 'deck', name: 'DECK',   docked: deckDocked, popupRef: deckPopupRef },
              ]}
            />
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
            <RightTabStrip
              active={aicPanel}
              setActive={setAicPanel}
              tabs={[
                { key: 'main', name: 'BRAA', docked: aicDocked, popupRef: braaPopupRef },
              ]}
            />
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
            <RightTabStrip
              active={abmPanel}
              setActive={setAbmPanel}
              tabs={[
                { key: 'ato',      name: 'ATO',  docked: atoDocked,      popupRef: atoPopupRef },
                { key: 'frag',     name: 'FRAG', docked: fragDocked,     popupRef: fragPopupRef },
                { key: 'drawings', name: 'DRAW', docked: drawingsDocked, popupRef: drawingsPopupRef },
              ]}
            />
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
    </>
  )
}
