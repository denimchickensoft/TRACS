import { create } from 'zustand'

const SLOT_COUNT = 12

// Fields captured into a preset snapshot
const PRESET_FIELDS = [
  'rangeNm', 'ringSpacingNm', 'historyLength', 'historyRate',
  'ptlLength', 'ptlMode',
  'ldrLength', 'ldrAngleDeg',
  'briteDcb', 'briteBkg', 'briteMapA', 'briteMapB',
  'briteFdb', 'briteLst', 'britePos', 'briteLdb', 'briteRr', 'briteCmp', 'briteHst',
  'csDatablocks', 'csLists', 'csDcb', 'csTools', 'csPos', 'csMap',
  'altFilterLow', 'altFilterHigh',
  'qnh',
  'lists',
  'mapsVisible',
  'previewPosition',
]

function extractSettings(win) {
  const out = {}
  for (const k of PRESET_FIELDS) {
    if (win[k] !== undefined) out[k] = win[k]
  }
  return out
}

export const usePresetsStore = create((set, get) => ({
  slots:        Array(SLOT_COUNT).fill(null), // null | { name, settings }
  activeSlot:   null,   // number | null — currently loaded preset index
  defaultSlot:  null,   // number | null — auto-loaded on session start
  pendingMode:  null,   // null | { type: 'pick' } | { type: 'name', slotIndex: number }

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
    const slots = [...get().slots]
    slots[slotIndex] = { name: name.toUpperCase(), settings: extractSettings(win) }
    set({ slots, activeSlot: slotIndex, pendingMode: null })
    get()._persist(slots)
  },

  // Overwrite the currently active slot (SAVE)
  saveActive: (win) => {
    const { activeSlot, slots } = get()
    if (activeSlot === null) return false
    const name = slots[activeSlot]?.name ?? 'PRESET'
    const next = [...slots]
    next[activeSlot] = { name, settings: extractSettings(win) }
    set({ slots: next })
    get()._persist(next)
    return true
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
}))
