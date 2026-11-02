import { create } from 'zustand'

// The running mission's file, as the DCS exporter's relay serves it to this
// coalition: { id, theatre, text } or null (no exporter, no mission, or the
// mission is changing). Set from the backend's 'missionData' message
// (ws/client.js); missionData/useMissionAutoLoad.js offers it to the stores.
export const useMissionDataStore = create((set) => ({
  data: null,
  setData: (data) => set({ data: data && typeof data.text === 'string' && data.id ? data : null }),
}))
