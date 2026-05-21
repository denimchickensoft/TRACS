import { create } from 'zustand'

// Display paradigms for the base layer
export const DISPLAY_PARADIGM = {
  SYNTHETIC: 'SYNTHETIC',
  GEOGRAPHIC: 'GEOGRAPHIC',
  HYBRID: 'HYBRID',
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
  displayParadigm: DISPLAY_PARADIGM.SYNTHETIC,
  centerLat: 0,
  centerLng: 0,
  // Element brightness (0–100). null = use profile/code default.
  briteDcb:  null,   // DCB bar
  briteBkg:  null,   // scope background (0 = black, 100 = light gray)
  briteMapA: null,   // video map group A
  briteMapB: null,   // video map group B
  briteFdb:  null,   // full data block text
  briteLst:  null,   // list text
  britePos:  null,   // position character inside contact symbol
  briteLdb:  null,   // limited data block text
  briteRr:   null,   // range rings
  briteCmp:  null,   // compass (not yet rendered)
  briteHst:  null,   // history trails
  // Altitude filters (ft)
  altFilterLow: null,
  altFilterHigh: null,
  qnh: '29.92',
  tdmMode: false,
  lists: {
    ssa:    {                   xPct:  2, yPct:  2 },
    signOn: { visible: true,   xPct: 88, yPct: 88 },
    tab:    { visible: true,   xPct:  2, yPct: 65, lines: 5 },
    tower1: { visible: false,  xPct:  2, yPct: 50, lines: 5 },
    tower2: { visible: false,  xPct: 20, yPct: 50, lines: 5 },
    tower3: { visible: false,  xPct: 38, yPct: 50, lines: 5 },
    coast:  { visible: false,  xPct: 78, yPct: 65, lines: 5 },
    alert:  { visible: true,   xPct: 78, yPct: 25, lines: 5 },
    vfr:    { visible: true,   xPct:  2, yPct: 20, lines: 5 },
  },
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
