import { create } from 'zustand'

export const useOdsStore = create((set, get) => ({
  activeProfile:    null,   // full loaded profile object
  activeProfileId:  null,
  availableProfiles: [],    // [{ id, name }, ...]
  loading: false,
  error: null,

  loadManifest: async () => {
    try {
      const res = await fetch('/profiles/index.json')
      if (!res.ok) throw new Error(`Failed to load profile manifest (${res.status})`)
      const manifest = await res.json()
      set({ availableProfiles: manifest })
    } catch (err) {
      console.error('[ods] manifest load error:', err.message)
      set({ error: err.message })
    }
  },

  loadProfile: async (id) => {
    if (get().activeProfileId === id) return get().activeProfile
    set({ loading: true, error: null })
    try {
      const res = await fetch(`/profiles/${id}.json`)
      if (!res.ok) throw new Error(`Profile "${id}" not found (${res.status})`)
      const profile = await res.json()
      set({ activeProfile: profile, activeProfileId: id, loading: false })
      return profile
    } catch (err) {
      console.error('[ods] profile load error:', err.message)
      set({ loading: false, error: err.message })
      return null
    }
  },
}))
