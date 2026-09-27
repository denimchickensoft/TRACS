import { create } from 'zustand'

const SLOT_COUNT = 12

// Fields captured into a preset snapshot
const PRESET_FIELDS = [
  'rangeNm', 'ringSpacingNm', 'historyLength', 'historyRate',
  'ptlLength', 'ptlMode',
  'ldrLength', 'ldrAngleDeg',
  'briteDcb', 'briteBkg', 'briteMapA', 'briteMapB', 'aspColorIdx',
  'briteFdb', 'briteLst', 'britePos', 'briteLdb', 'briteRr', 'briteCmp', 'briteHst',
  'csDatablocks', 'csLists', 'csDcb', 'csTools', 'csPos', 'csMap',
  'altFilterLowU', 'altFilterHighU', 'altFilterLowA', 'altFilterHighA',
  'qnh',
  'lists',
  'mapsVisible',
  'reliefVisible', 'geoVisible', 'mvaVisible', 'msaVisible', 'moraVisible', 'holdsVisible',
  'airwaysVisible',
  'procVisible',
]

function extractSettings(win) {
  const out = {}
  for (const k of PRESET_FIELDS) {
    if (win[k] !== undefined) out[k] = win[k]
  }
  return out
}

export const usePresetsStore = create((set, get) => ({
  slots:            Array(SLOT_COUNT).fill(null), // null | { name, settings, bookmarks }
  activeSlot:       null,   // number | null — currently loaded preset index
  defaultSlot:      null,   // number | null — auto-loaded on session start
  pendingMode:      null,   // null | { type: 'pick' } | { type: 'name', slotIndex: number }
  pendingBookmarks: Array(10).fill(null), // bookmark slots when no preset is active

  // True once the defaultSlot's settings have been applied to a window this
  // session. This store is module-level and survives StarsScope remounting
  // (e.g. the STARS<->ASDE-X toggle is a real unmount/remount) — without this
  // guard, "auto-loaded on session start" above would really mean "reapplied
  // on every remount", stomping live rangeNm/center/etc. back to the saved
  // default every time.
  defaultAppliedThisSession: false,

  load: async () => {
    try {
      const res = await fetch('/api/presets')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({
        slots:       data.slots       ?? Array(SLOT_COUNT).fill(null),
        defaultSlot: data.defaultSlot ?? null,
      })
    } catch (err) {
      console.error('[presets] load error:', err.message)
    }
  },

  _persist: async (slots, defaultSlot) => {
    const state = get()
    try {
      await fetch('/api/presets', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          slots,
          defaultSlot: defaultSlot !== undefined ? defaultSlot : state.defaultSlot,
        }),
      })
    } catch (err) {
      console.error('[presets] save error:', err.message)
    }
  },

  // Save current window settings to a specific slot with a given name
  saveToSlot: (slotIndex, name, win) => {
    const { activeSlot, slots, pendingBookmarks } = get()
    const bookmarks = activeSlot !== null
      ? (slots[activeSlot]?.bookmarks ?? Array(10).fill(null))
      : pendingBookmarks
    const next = [...slots]
    next[slotIndex] = { name: name.toUpperCase(), settings: extractSettings(win), bookmarks }
    set({ slots: next, activeSlot: slotIndex, pendingMode: null })
    get()._persist(next)
  },

  // Overwrite the currently active slot (SAVE)
  saveActive: (win) => {
    const { activeSlot, slots } = get()
    if (activeSlot === null) return false
    const slot = slots[activeSlot]
    const next = [...slots]
    next[activeSlot] = { name: slot?.name ?? 'PRESET', settings: extractSettings(win), bookmarks: slot?.bookmarks ?? Array(10).fill(null) }
    set({ slots: next })
    get()._persist(next)
    return true
  },

  // Set bookmark n in the active preset slot (or pendingBookmarks if none loaded)
  setBookmark: (n, data) => {
    const { activeSlot, slots } = get()
    if (activeSlot !== null && slots[activeSlot]) {
      const next = [...slots]
      const bms = [...(next[activeSlot].bookmarks ?? Array(10).fill(null))]
      bms[n] = data
      next[activeSlot] = { ...next[activeSlot], bookmarks: bms }
      set({ slots: next })
    } else {
      const bms = [...get().pendingBookmarks]
      bms[n] = data
      set({ pendingBookmarks: bms })
    }
  },

  // Get bookmark n from the active preset slot (or pendingBookmarks if none loaded)
  getBookmark: (n) => {
    const { activeSlot, slots, pendingBookmarks } = get()
    if (activeSlot !== null && slots[activeSlot]) {
      return slots[activeSlot].bookmarks?.[n] ?? null
    }
    return pendingBookmarks[n] ?? null
  },

  deleteSlot: (slotIndex) => {
    const slots = [...get().slots]
    slots[slotIndex] = null
    const activeSlot    = get().activeSlot   === slotIndex ? null : get().activeSlot
    const defaultSlot   = get().defaultSlot  === slotIndex ? null : get().defaultSlot
    set({ slots, activeSlot, defaultSlot, pendingMode: null })
    get()._persist(slots, defaultSlot)
  },

  setDefaultSlot: (index) => {
    const next = get().defaultSlot === index ? null : index
    set({ defaultSlot: next })
    get()._persist(get().slots, next)
  },

  setActiveSlot:  (index) => set({ activeSlot: index }),
  setPendingMode: (mode)  => set({ pendingMode: mode }),

  markDefaultApplied: () => set({ defaultAppliedThisSession: true }),
}))

