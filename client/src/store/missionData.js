import { create } from 'zustand'

// The running mission's file, as the DCS exporter's relay serves it to this
// coalition: data = { id, theatre, text } or null (no exporter, no mission, or
// the mission is changing). unavailable = 'no_track' when the relay found no
// multiplayer track file to read the mission from on a DCS client, else
// null. Set from the backend's 'missionData'
// message (ws/client.js); missionData/useMissionAutoLoad.js offers it to the
// stores.
export const useMissionDataStore = create((set) => ({
  data: null,
  unavailable: null,
  setData: (data) => set({
    data: data && typeof data.text === 'string' && data.id ? data : null,
    unavailable: data?.unavailable === 'no_track' ? 'no_track' : null,
  }),
}))
