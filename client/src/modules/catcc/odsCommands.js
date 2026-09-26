/**
 * CATCC ODS command processor.
 *
 * Each command handler receives (parts, context) and returns an array of
 * output line strings, or a Promise of one for handlers that hit the server
 * (.ASPCOLORS/.REFRESH). An empty array means success (no output, like STARS).
 *
 * context: { visibleUnits, correlations, view, fb, marshalBearing,
 *             windowSettings, positionName }
 *
 * Aircraft are identified by correlated side number OR callsign.
 */

import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../../store/atc.js'
import { useSessionStore }     from '../../store/session.js'
import { useControllersStore } from '../../store/controllers.js'
import { useDisplayStore }     from '../../store/display.js'
import { saveCatccPrefs }      from '../../store/catccPrefs.js'
import { useAbmAirspaceStore } from '../../store/abmAirspace.js'
import { useNavdataStore }     from '../../store/navdata.js'
import { sendWebrtcEvent, sendWebrtcSessionEvent } from '../../webrtc/client.js'
import { resolveCallsign }     from '../../utils/callsign.js'
import { applyCallsignChange } from '../../utils/callsignRename.js'
import { navdataNotFound } from '../../store/lnm.js'

const WINDOW_ID = 'catcc-main'

const COMMANDS = {}

function register(verb, fn) {
  COMMANDS[verb] = fn
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMyControllerId() {
  const pos = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[pos]?.controllerId ?? null
}

function findUnit(id, { visibleUnits, correlations }) {
  // Side number first
  for (const [unitId, sideNum] of Object.entries(correlations)) {
    if (sideNum === id) {
      const unit = visibleUnits[unitId]
      if (unit) return { unitId, unit }
    }
  }
  // Callsign fallback
  for (const [unitId, unit] of Object.entries(visibleUnits)) {
    if (resolveCallsign(unit) === id) return { unitId, unit }
  }
  return null
}

// ── Commands ──────────────────────────────────────────────────────────────────

// IT <callsign|side> — initiate track
register('IT', (parts, ctx) => {
  const id = parts[1]
  if (!id) return ['IT <callsign|side>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const { ownership, claimTrack } = useAtcStore.getState()
  if (ownership[target.unitId]) return ['ILL TRK']
  if (!ctx.correlations[String(target.unitId)]) return ['ILL TRK']
  const controllerId = getMyControllerId()
  claimTrack(target.unitId, controllerId)
  sendWebrtcEvent('TRACK_CLAIMED', { unitId: target.unitId, controllerId })
  return []
})

// DT <callsign|side> — drop track
register('DT', (parts, ctx) => {
  const id = parts[1]
  if (!id) return ['DT <callsign|side>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const { ownership, dropTrack, clearHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  if (ownership[target.unitId] !== controllerId) return ['ILL TRK']
  clearHandoff(target.unitId)
  dropTrack(target.unitId)
  sendWebrtcEvent('TRACK_DROPPED', { unitId: target.unitId })
  return []
})

// .DROPALL — drop every track you own, broadcasting each drop
register('.DROPALL', () => {
  const { ownership, dropTrack, clearHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  for (const [unitId, owner] of Object.entries(ownership)) {
    if (owner !== controllerId) continue
    clearHandoff(unitId)
    dropTrack(unitId)
    sendWebrtcEvent('TRACK_DROPPED', { unitId })
  }
  return []
})

// HO <callsign|side> <tcp> — handoff to controller.
// Bare "HO" (no args) — accept the nearest incoming handoff. Was formerly
// STARS' HND_OFF_ACCEPT_NEAR (commandParser.js `/^HO$/` ENTER), reachable
// only because CatccScope tried STARS' shared parser first; now local.
register('HO', (parts, ctx) => {
  if (parts.length === 1) {
    const { handoffs, claimTrack, clearHandoff } = useAtcStore.getState()
    const controllerId = getMyControllerId()
    for (const [unitId, ho] of Object.entries(handoffs)) {
      if (ho.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
        claimTrack(unitId, controllerId)
        clearHandoff(unitId)
        sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId, fromControllerId: ho.from, toControllerId: controllerId })
        return []
      }
    }
    return ['NO INCOMING HANDOFF']
  }
  const id  = parts[1]
  const tcp = parts[2]
  if (!id || !tcp) return ['HO <callsign|side> <tcp>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const { ownership, setHandoff } = useAtcStore.getState()
  const controllerId = getMyControllerId()
  if (ownership[target.unitId] !== controllerId) return ['ILL TRK']
  if (tcp === controllerId) return ['ILL POS']
  const knownIds = new Set(
    Object.values(useControllersStore.getState().registry)
      .map((e) => e.controllerId)
      .filter(Boolean)
  )
  if (!knownIds.has(tcp)) return [`ILL POS: ${tcp}`]
  setHandoff(target.unitId, { state: HANDOFF_STATE.INITIATED, from: controllerId, to: tcp })
  sendWebrtcEvent('HANDOFF_INITIATED', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  return []
})

// PO <callsign|side> <tcp> — point out to controller
register('PO', (parts, ctx) => {
  const id  = parts[1]
  const tcp = parts[2]
  if (!id || !tcp) return ['PO <callsign|side> <tcp>']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const controllerId = getMyControllerId()
  if (tcp === controllerId) return ['ILL POS']
  useAtcStore.getState().setPointOut(target.unitId, { state: POINTOUT_STATE.SENT, from: controllerId, to: tcp })
  sendWebrtcEvent('POINT_OUT_SENT', { unitId: target.unitId, fromControllerId: controllerId, toControllerId: tcp })
  return []
})

// RN <callsign|side> [newCallsign] — rename or reset (no second arg = reset)
register('RN', (parts, ctx) => {
  const id = parts[1]
  if (!id) return ['RN <callsign|side> [newCallsign]']
  const target = findUnit(id, ctx)
  if (!target) return [`NO TRACK: ${id}`]
  const newCallsign = parts[2]?.toUpperCase() ?? null
  const { oldCallsign } = applyCallsignChange(target.unitId, target.unit, newCallsign)
  sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(target.unitId), oldCallsign, newCallsign })
  return []
})

// .HISTORY — toggle history trails on/off
register('.HISTORY', () => {
  const ws = useDisplayStore.getState().windows[WINDOW_ID]
  const current = ws?.showHistory ?? true
  useDisplayStore.getState().updateWindow(WINDOW_ID, { showHistory: !current })
  saveCatccPrefs({ showHistory: !current })
  return []
})

// .LL [0-99] — set leader line length in pixels (omit to query current)
register('.LL', (parts) => {
  const val = parts[1]
  if (!val) {
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    return [`LL: ${ws?.catccLeaderLen ?? 16}`]
  }
  const n = parseInt(val, 10)
  if (isNaN(n) || n < 0 || n > 99) return ['ILL VAL']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { catccLeaderLen: n })
  saveCatccPrefs({ catccLeaderLen: n })
  return []
})

// .LABELSIZE [0-5] — set airspace/fix label size, shared with STARS' csMap (omit to query current)
register('.LABELSIZE', (parts) => {
  const val = parts[1]
  if (!val) {
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    return [`LABELSIZE: ${ws?.csMap ?? 2}`]
  }
  const n = parseInt(val, 10)
  if (isNaN(n) || n < 0 || n > 5) return ['ILL VAL']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { csMap: n })
  saveCatccPrefs({ csMap: n })
  return []
})

// .DBSIZE [0-5] — set aircraft datablock size (omit to query current)
register('.DBSIZE', (parts) => {
  const val = parts[1]
  if (!val) {
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    return [`DBSIZE: ${ws?.dbSize ?? 2}`]
  }
  const n = parseInt(val, 10)
  if (isNaN(n) || n < 0 || n > 5) return ['ILL VAL']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { dbSize: n })
  saveCatccPrefs({ dbSize: n })
  return []
})

// .LD [N|NE|E|SE|S|SW|W|NW|1-9|OFF] — set global default leader direction (OFF to reset)
const DIR_MAP = { N: '8', NE: '9', E: '6', SE: '3', S: '2', SW: '1', W: '4', NW: '7' }
const NUMPAD_DIRS = new Set(['1','2','3','4','6','7','8','9'])

register('.LD', (parts) => {
  const val = parts[1]
  if (!val || val === 'OFF') {
    useDisplayStore.getState().updateWindow(WINDOW_ID, { globalLeaderDir: null })
    saveCatccPrefs({ globalLeaderDir: null })
    return []
  }
  const key = DIR_MAP[val] ?? (NUMPAD_DIRS.has(val) ? val : null)
  if (!key) return ['ILL DIR']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { globalLeaderDir: key })
  saveCatccPrefs({ globalLeaderDir: key })
  return []
})

// .DBCA — toggle datablock collision avoidance (on by default for CATCC)
register('.DBCA', () => {
  const ws = useDisplayStore.getState().windows[WINDOW_ID]
  const next = !(ws?.dbca ?? true)
  useDisplayStore.getState().updateWindow(WINDOW_ID, { dbca: next })
  saveCatccPrefs({ dbca: next })
  return [`DBCA ${next ? 'ON' : 'OFF'}`]
})

// ── Airspace / navdata layers — same categories + bulk/.labels convention as
// ABM (modules/abm/AbmScope.jsx AIRSPACE_CATEGORIES/AIRSPACE_CMD_CATEGORY),
// reimplemented against window settings (CatccScope reads windowSettings for
// its draw effects, same as .LL/.LD/.DBCA above) rather than local useState.
const AIRSPACE_CATEGORIES = [
  'TMA', 'CTR', 'CTA', 'FIR', 'UIR', 'SUA', 'MIL', 'TRSA',
  'CLASS A', 'CLASS B', 'CLASS C', 'CLASS D', 'CLASS E', 'CLASS F', 'CLASS G',
]
const AIRSPACE_CMD_CATEGORY = {
  '.TMA': 'TMA', '.CTR': 'CTR', '.CTA': 'CTA', '.FIR': 'FIR', '.UIR': 'UIR',
  '.SUA': 'SUA', '.MIL': 'MIL', '.TRSA': 'TRSA',
  '.CLASSA': 'CLASS A', '.CLASSB': 'CLASS B', '.CLASSC': 'CLASS C', '.CLASSD': 'CLASS D',
  '.CLASSE': 'CLASS E', '.CLASSF': 'CLASS F', '.CLASSG': 'CLASS G',
}

// .ASP — bulk toggle: on if any category is currently visible, off otherwise.
register('.ASP', () => {
  const ws = useDisplayStore.getState().windows[WINDOW_ID]
  const asVisible = ws?.asVisible ?? {}
  const anyOn = AIRSPACE_CATEGORIES.some((c) => asVisible[c])
  const next  = anyOn ? {} : Object.fromEntries(AIRSPACE_CATEGORIES.map((c) => [c, true]))
  useDisplayStore.getState().updateWindow(WINDOW_ID, { asVisible: next })
  saveCatccPrefs({ asVisible: next })
  return [anyOn ? 'AIRSPACE OFF' : 'AIRSPACE ON']
})

// Per-category airspace toggles — .tma/.ctr/.cta/.fir/.uir/.sua/.mil/.trsa/
// .classa-.classg.
for (const [verb, cat] of Object.entries(AIRSPACE_CMD_CATEGORY)) {
  register(verb, () => {
    const ws = useDisplayStore.getState().windows[WINDOW_ID]
    const asVisible = ws?.asVisible ?? {}
    const next   = !asVisible[cat]
    const merged = { ...asVisible, [cat]: next }
    useDisplayStore.getState().updateWindow(WINDOW_ID, { asVisible: merged })
    saveCatccPrefs({ asVisible: merged })
    return [`${cat} ${next ? 'ON' : 'OFF'}`]
  })
}

// .LABELS/.LBL/.LABEL — name-label toggle for airspace/fix layers (same
// "show text too" role as ABM's .labels), interchangeable aliases.
function toggleLabels() {
  const ws   = useDisplayStore.getState().windows[WINDOW_ID]
  const next = !(ws?.labelsVisible ?? false)
  useDisplayStore.getState().updateWindow(WINDOW_ID, { labelsVisible: next })
  saveCatccPrefs({ labelsVisible: next })
  return [`LABELS ${next ? 'ON' : 'OFF'}`]
}
register('.LABELS', toggleLabels)
register('.LBL', toggleLabels)
register('.LABEL', toggleLabels)

// .FIXES — theatre fixes point layer (store/navdata.js, same data STARS/ABM use).
register('.FIXES', () => {
  const ws   = useDisplayStore.getState().windows[WINDOW_ID]
  const next = !(ws?.fixesVisible ?? false)
  useDisplayStore.getState().updateWindow(WINDOW_ID, { fixesVisible: next })
  saveCatccPrefs({ fixesVisible: next })
  return [`FIXES ${next ? 'ON' : 'OFF'}`]
})

// .FIX <name...> — force-show specific fixes regardless of .FIXES
// visibility. Each name toggles independently (repeat to un-pin); persisted
// per-theatre (store/catccPrefs.js) so pins survive a reload. No argument
// clears all pinned fixes for this theatre.
register('.FIX', (parts) => {
  const theatre = useSessionStore.getState().mission?.mission?.theatre
  if (!theatre) return ['NO THEATRE']
  const names = parts.slice(1).filter(Boolean)
  if (!names.length) {
    const ws        = useDisplayStore.getState().windows[WINDOW_ID]
    const byTheatre = ws?.pinnedFixes ?? {}
    const merged    = { ...byTheatre, [theatre]: [] }
    useDisplayStore.getState().updateWindow(WINDOW_ID, { pinnedFixes: merged })
    saveCatccPrefs({ pinnedFixes: merged })
    return ['FIX CLEARED']
  }
  // Pinning only affects rendering of the `fixes` layer (see CatccScope.jsx
  // pinnedIds filter), so validate against that list rather than a broader
  // fix/navaid/airport search — a name that resolves elsewhere would never
  // actually draw as pinned.
  const knownIds = new Set(useNavdataStore.getState().fixes.map(f => f.id.toUpperCase()))
  const notFound = names.filter((n) => !knownIds.has(n.toUpperCase()))
  if (notFound.length) return [navdataNotFound(`${notFound.join(' ')} NOT FOUND`)]
  const ws        = useDisplayStore.getState().windows[WINDOW_ID]
  const byTheatre = ws?.pinnedFixes ?? {}
  const current   = new Set(byTheatre[theatre] ?? [])
  for (const name of names) {
    if (current.has(name)) current.delete(name)
    else current.add(name)
  }
  const merged = { ...byTheatre, [theatre]: [...current] }
  useDisplayStore.getState().updateWindow(WINDOW_ID, { pinnedFixes: merged })
  saveCatccPrefs({ pinnedFixes: merged })
  return [`FIX ${names.join(' ')}`]
})

// .GEO — coastlines/boundaries layer (store/geo.js). Driven by this window's
// own setting rather than the shared store's `visible` flag, so toggling it
// here can't fight with STARS' DCB or ABM's always-on geo in another window.
register('.GEO', () => {
  const ws   = useDisplayStore.getState().windows[WINDOW_ID]
  const next = !(ws?.geoVisible ?? false)
  useDisplayStore.getState().updateWindow(WINDOW_ID, { geoVisible: next })
  saveCatccPrefs({ geoVisible: next })
  return [`GEO ${next ? 'ON' : 'OFF'}`]
})

// .FILL — toggle airspace polygon fill on/off, remembering the last
// percentage used. .FILL <1-100> — set fill percentage and turn it on.
register('.FILL', (parts) => {
  const ws = useDisplayStore.getState().windows[WINDOW_ID]
  const val = parts[1]
  if (!val) {
    const next = !(ws?.fillVisible ?? false)
    useDisplayStore.getState().updateWindow(WINDOW_ID, { fillVisible: next })
    saveCatccPrefs({ fillVisible: next })
    return [`FILL ${next ? 'ON' : 'OFF'}`]
  }
  const pct = parseInt(val, 10)
  if (isNaN(pct) || pct < 1 || pct > 100) return ['ILL VAL']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { fillVisible: true, fillPct: pct })
  saveCatccPrefs({ fillVisible: true, fillPct: pct })
  return [`FILL ${pct}%`]
})

// .ASPCOLORS <name> — same command STARS/ABM use for airspace palettes
// (store/abmAirspace.js), reimplemented against window settings. Refreshes
// palettes from the server first, same as ABM, so a palette added/edited in
// airspace_colors.json since load (e.g. the new "CATCC" palette) is pickable
// without a full reload. Explicitly set here always wins over the "CATCC"
// named-palette default in CatccScope's airspaceColors.
register('.ASPCOLORS', async (parts) => {
  const name = parts[1]
  if (!name) return ['.ASPCOLORS <name>']
  const refreshed = await useAbmAirspaceStore.getState().refreshPalettes()
  if (!refreshed) {
    const err = useAbmAirspaceStore.getState().lastError
    return [err ? `REFRESH FAILED: ${err}` : 'REFRESH FAILED']
  }
  const palettes = useAbmAirspaceStore.getState().palettes
  const idx = palettes.findIndex((p) => p.name.toUpperCase() === name)
  if (idx < 0) return ['INVALID PALETTE']
  useDisplayStore.getState().updateWindow(WINDOW_ID, { aspColorIdx: idx })
  saveCatccPrefs({ aspColorIdx: idx })
  return [`ASP COLORS: ${palettes[idx].name.toUpperCase()}`]
})

// .REFRESH — re-fetch airspace_colors.json palettes without a full reload.
register('.REFRESH', async () => {
  const success = await useAbmAirspaceStore.getState().refreshPalettes()
  if (success) return ['PALETTES REFRESHED']
  const err = useAbmAirspaceStore.getState().lastError
  return [err ? `REFRESH FAILED: ${err}` : 'REFRESH FAILED']
})

// ── Dispatcher ────────────────────────────────────────────────────────────────
// Always returns a Promise (even for synchronous handlers) so the caller has
// one code path — some handlers (.ASPCOLORS/.REFRESH) hit the server.
export async function processOdsCommand(raw, context) {
  const parts = raw.trim().toUpperCase().split(/\s+/)
  const verb  = parts[0]
  if (!verb) return []
  const handler = COMMANDS[verb]
  if (!handler) return [`INVALID: ${verb}`]
  try {
    const result = await handler(parts, context)
    return result ?? []
  } catch (err) {
    return [`ERROR: ${err.message}`]
  }
}
