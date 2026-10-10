import { create } from 'zustand'

// Display paradigms for the base layer
export const DISPLAY_PARADIGM = {
  SYNTHETIC: 'SYNTHETIC',
  GEOGRAPHIC: 'GEOGRAPHIC',
  HYBRID: 'HYBRID',
}

// STARS list and preview-area placement: top-left corner as a percentage of
// the scope canvas. List components fall back to these when a loaded preset
// predates a list.
export const DEFAULT_LISTS = {
  ssa:     {                  xPct:  5, yPct:  5 },
  preview: {                  xPct:  5, yPct: 20 },
  tower1:  { visible: false,  xPct:  5, yPct: 40, lines: 5 },
  tower2:  { visible: false,  xPct:  5, yPct: 60, lines: 5 },
  tower3:  { visible: false,  xPct:  5, yPct: 80, lines: 5 },
  signOn:  { visible: true,   xPct: 90, yPct:  5 },
  tab:     { visible: true,   xPct: 90, yPct: 40, lines: 5 },
  vfr:     { visible: true,   xPct: 90, yPct: 80, lines: 5 },
  coast:   { visible: false,  xPct: 90, yPct: 90, lines: 5 },
  alert:   { visible: true,   xPct: 65, yPct: 90, lines: 5 },
  mciSuppression: { visible: false, xPct: 75, yPct: 10, lines: 5 },
}

// Default scope settings — ODS profile defaults override these at session start
const SCOPE_DEFAULTS = {
  vol: 10,                // audio volume 1–10
  dcbPosition: 'top',    // 'top' | 'bottom' | 'left' | 'right'
  rangeNm: 60,            // nm from center to edge
  ringSpacingNm: 10,      // nm between range rings
  historyLength: 5,       // number of history dots (0–10)
  historyRate:   4.5,     // seconds between history captures (0–4.5)
  ptlLength: 2,           // minutes of predicted track line
  ptlMode: null,          // null | 'OWN' | 'ALL'
  ldrLength: null,        // leader line length 0–7 (null = use profile default → treated as 4)
  ldrAngleDeg: null,      // leader line angle override (null = use profile default)
  homeCenterLat: 0,       // facility-defined center (set on auto-center)
  homeCenterLng: 0,
  offCntr: false,         // true when panned away from home center
  rrCenterLat: null,      // custom ring center (null = use scope center)
  rrCenterLng: null,
  rrOffCenter: false,     // true when rings moved from scope center
  pendingAction: null,    // one-shot click mode: 'PLACE_RR' | 'RBL_P2' | 'MIN_P2' | null
  rbls: [],               // [{ p0, p1 }] each endpoint: { unitId } | { lat, lng }
  rblWip: null,           // { p0 } while awaiting second click for RBL
  minSep: null,           // { ac0: unitId, ac1: unitId } | null
  minWip: null,           // { ac0: unitId } while awaiting second click for MIN
  dcbActiveSpinner: null, // ID of the currently-selected DCB value spinner (inhibits scope zoom)
  // Character size settings (0–5 scale, null = profile default → treated as 3)
  csDatablocks: null,
  csLists: null,
  csDcb: null,
  csTools: null,
  csPos: null,
  csMap: null,
  dbSize: null,           // CATCC/ABM aircraft datablock size (0–5 scale, null = default → treated as 2)
  displayParadigm: DISPLAY_PARADIGM.SYNTHETIC,
  centerLat: 0,
  centerLng: 0,
  // Element brightness (0–100). null = use profile/code default.
  briteDcb:  null,   // DCB bar
  briteBkg:  null,   // scope background (0 = black, 100 = light gray)
  briteMapA: null,   // video map group A
  briteMapB: null,   // video map group B
  aspColorIdx: 0,    // index into airspace color palette array
  briteFdb:  null,   // full data block text
  briteLst:  null,   // list text
  britePos:  null,   // position character inside contact symbol
  briteLdb:  null,   // limited data block text
  briteRr:   null,   // range rings
  briteCmp:  null,   // compass rose brightness (0 = hidden); also ABM's .rose/.compass, per window
  briteHst:  null,   // history trails
  // Altitude filters — hundreds of feet (STARS 3-digit convention, e.g. 001 = 100ft).
  // U = unassociated tracks, A = associated tracks. Defaults show everything.
  altFilterLowU: 1,
  altFilterHighU: 600,
  altFilterLowA: 1,
  altFilterHighA: 600,
  qnh: '29.92',
  atis: null,
  giText: null,
  giAux: [],                // MF S1-9 auxiliary GI text lines (index 0 = line 1)
  tdmMode: false,
  // AIC-only session state —
  // present in every window's shape like STARS's rbls/minSep above, but only
  // read/written by AicScope.
  threatRings: [],          // unitId[] — .threat/Ctrl+Alt+click manual threat rings
  showCentroid: false,      // .centroid — debug: hostile-picture centroid dot
  showAxis: false,          // .axis — debug: dynamic threat axis line
  sector: null,             // { origin, fromBearing, toBearing, rangeNm, axisBearing } | null
  sectorVisible: true,      // whether the defined sector renders
  sectorPreviewOrigin: null, // { lat, lng } | null — live preview origin awaiting a click to complete .sector
  ackPicture: null,         // { labelKey, totalGroups } | null — PICTURE acknowledgment baseline
  rbl: null,                // AIC's own RBL line state (distinct from STARS's rbls[] list above)
  findMarker: null,         // { lat, lng, id } | null — .find fix marker
  defineEntry: null,        // { term, text } | null — .define brevity glossary readout
  bullseyeOverride: null,   // { lat, lng } | null — .be bullseye override
  // ABM-only session state — reuses
  // threatRings/rbl/bullseyeOverride/findMarker/defineEntry above (same
  // concept, independent per-window instance); only dbHiddenIds has no AIC
  // equivalent.
  dbHiddenIds: [],          // unitId[] — .db + click per-contact datablock hide override
  roeVisible: true,         // ABM-only — .roe bare-toggle, independent per window/focus panel
  // Click-completion state, deliberately kept bespoke (not generalized into a
  // parser-level "trigger" mechanism) —
  // migrated here only so actions/index.js-style handlers can read/write it.
  pendingDraw: null,          // in-progress .line/.rect/.circ/.poly/.sect/.race/.text — see draw/drawCommands.js
  pendingClearClick: false,   // bare `.clear`/click armed — next click hit-tests a drawing to remove
  pendingClearAllConfirm: false, // `.clear all` awaiting a y/n answer on the next submitted line
  lists: DEFAULT_LISTS,
}

export const useDisplayStore = create((set) => ({
  // Per-window settings keyed by window ID ('atc' | 'aic' | string)
  windows: {},

  initWindow: (windowId, overrides = {}) =>
    set((state) => ({
      windows: {
        ...state.windows,
        [windowId]: { ...SCOPE_DEFAULTS, ...overrides },
      },
    })),

  updateWindow: (windowId, patch) =>
    set((state) => ({
      windows: {
        ...state.windows,
        [windowId]: { ...state.windows[windowId], ...patch },
      },
    })),

  // Apply profile defaults to a window without touching pan/zoom position
  applyProfileDefaults: (windowId, profileDefaults) =>
    set((state) => {
      const win = state.windows[windowId]
      if (!win) return {}
      const { rangeNm, ringSpacingNm, historyLength, ptlLength } = profileDefaults
      return {
        windows: {
          ...state.windows,
          [windowId]: {
            ...win,
            ...(rangeNm       != null && { rangeNm }),
            ...(ringSpacingNm != null && { ringSpacingNm }),
            ...(historyLength != null && { historyLength }),
            ...(ptlLength     != null && { ptlLength }),
          },
        },
      }
    }),

  updateList: (windowId, listId, patch) =>
    set((state) => {
      const win = state.windows[windowId]
      if (!win) return {}
      return {
        windows: {
          ...state.windows,
          [windowId]: {
            ...win,
            lists: {
              ...win.lists,
              [listId]: { ...win.lists?.[listId], ...patch },
            },
          },
        },
      }
    }),

  closeWindow: (windowId) =>
    set((state) => {
      const next = { ...state.windows }
      delete next[windowId]
      return { windows: next }
    }),

  reset: () => set({ windows: {} }),
}))

