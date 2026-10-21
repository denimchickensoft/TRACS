import { create } from 'zustand'

// .autotrack (STARS): the airports this position auto-claims departures from,
// and the ones other positions hold, so each airport has one autotracker (see
// modules/atc/autotrack.js). Not persisted: autotrack is off after a reload.
//
// mine:   { ICAO: since }  since = ms when this position turned it on
// others: { positionName: { airports: { ICAO: since }, heardAt } }
export const useAutotrackStore = create((set) => ({
  mine:   {},
  others: {},

  setMine: (mine) => set({ mine }),

  setOther: (positionName, airports) =>
    set((s) => {
      const others = { ...s.others }
      if (Object.keys(airports).length) others[positionName] = { airports, heardAt: Date.now() }
      else delete others[positionName]
      return { others }
    }),
}))
