import { create } from 'zustand'

// Multi-Service tactical brevity glossary (ATP 1-02.1, April 2025), transcribed
// from the published MTTP Brevity manual into client/public/brevity.json. Keys are the
// clean base word(s) with bracket fill-ins ([location], [direction], etc.)
// stripped out — e.g. "ANCHOR [location]" is stored under "ANCHOR". Values keep
// the original bracketed/parenthetical term as a "TERM — " prefix wherever that
// differs from the key, so usage syntax isn't lost.
//
// Fetched once and shared by AIC/ABM's .define command, rather than each scope
// fetching its own copy the way icaoMapping.json currently does.
export const useBrevityStore = create((set, get) => ({
  terms:  {},
  loaded: false,

  load: async () => {
    if (get().loaded) return
    try {
      const res  = await fetch('/brevity.json')
      const data = res.ok ? await res.json() : {}
      set({ terms: data, loaded: true })
    } catch {
      set({ terms: {}, loaded: true })
    }
  },

  // Case-insensitive lookup. Falls back to stripping one trailing "S" so
  // plural/verb-form input (BIRDS, CROWS) still matches the singular key.
  // Returns { term, text } or null.
  lookup: (query) => {
    const q = (query ?? '').trim().toUpperCase()
    if (!q) return null
    const { terms } = get()
    if (terms[q]) return { term: q, text: terms[q] }
    if (q.endsWith('S') && terms[q.slice(0, -1)]) {
      const term = q.slice(0, -1)
      return { term, text: terms[term] }
    }
    return null
  },

  // Alphabetically-adjacent term relative to `term`, wrapping at either end.
  // dir: -1 for previous, +1 for next. Backs the .define readout's ArrowUp/
  // ArrowDown browsing (see AIC/ABM handleKeyDown). Returns { term, text }.
  neighbor: (term, dir) => {
    const { terms } = get()
    const keys = Object.keys(terms).sort()
    if (!keys.length) return null
    const idx  = keys.indexOf(term)
    const from = idx === -1 ? 0 : idx
    const key  = keys[(from + dir + keys.length) % keys.length]
    return { term: key, text: terms[key] }
  },
}))
