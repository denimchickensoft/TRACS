// What the running mission (from the DCS exporter, via the relay) can load
// into TRACS - the same data each .miz importer reads, one area per store.
// Every area only adds what isn't there yet, worked out at the time it
// runs (diff), so loading again - after a restart, a reconnect, another
// window or another controller - adds nothing twice and never overwrites
// an edit. Shared areas (shared: true) are loaded through
// missionData/guard.js, one controller at a time.
//
// ctx: { id, text, mission, theatre, coalition } - the mission's id (its
// text's hash), its `mission` text and parsed table, the theatre TRACS is
// on, and this session's coalition.

import { findAtoFlights, findCarriersAndAircraft, extractWeather } from '../utils/parseMission.js'
import { mapMizFlightPlans } from '../utils/mizFlightPlans.js'
import { parseMiz } from '../utils/parseMiz.js'
import { missionMapRows, finalizeRow } from '../utils/userNavdataImport.js'
import { formatWind } from '../utils/liveWeather.js'
import { computeMagvar } from '../utils/magvar.js'
import { preloadOrdnanceDb } from '../utils/ordnance.js'
import { useFlightPlansStore } from '../store/flightPlans.js'
import { useStatusBoardStore } from '../store/statusBoard.js'
import { useAbmMissionStore } from '../store/abmMission.js'
import { useAbmDrawingsStore, drawingsReady } from '../store/abmDrawings.js'
import { useUserNavdataStore } from '../store/userNavdata.js'
import { useUnitsStore } from '../store/units.js'
import { useSessionStore } from '../store/session.js'
import { sendWebrtcEvent } from '../webrtc/client.js'

const NAME_PREFIX = 'MISSION'
const EMPTY = { count: 0 }

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// A blue/red session sees only its own side's flights, as the manual
// importers do (the relay already sends only that side; this also covers a
// mission from another source).
function ownFlights(ctx, flights) {
  return ctx.coalition === 'blue' || ctx.coalition === 'red'
    ? flights.filter((f) => f.coalition === ctx.coalition)
    : flights
}

// Marks a drawing layer / video map as this mission's group, so the same
// one is recognised however it has been renamed since.
const sourceKey = (ctx, group) => `mission:${ctx.id}:${group}`

export const AREAS = [
  {
    key: 'flightplans',
    label: 'Flight Plans',
    modules: ['ATC'],
    shared: true,
    async diff(ctx) {
      const found = ownFlights(ctx, findAtoFlights(ctx.mission))
      if (!found.length) return EMPTY
      const plans = await mapMizFlightPlans(found, ctx.mission?.theatre ?? null)
      const filed = useFlightPlansStore.getState().plans
      const seen = new Set()
      const items = plans.filter((p) => {
        const aid = p.aid?.toUpperCase()
        if (!aid || filed[aid] || seen.has(aid)) return false
        seen.add(aid)
        return true
      })
      return { count: items.length, items, summary: plural(items.length, 'flight plan') }
    },
    apply(d) {
      for (const plan of d.items) {
        const aid = plan.aid.toUpperCase()
        if (useFlightPlansStore.getState().plans[aid]) continue
        useFlightPlansStore.getState().add(plan)
        // The record as this controller filed it, CID and beacon code
        // included, so every controller holds the same ones.
        sendWebrtcEvent('FLIGHT_PLAN_CREATE', useFlightPlansStore.getState().plans[aid])
      }
    },
  },
  {
    key: 'statusboard',
    label: 'Status Board',
    modules: ['CATCC'],
    shared: true,
    diff(ctx) {
      const { carriers, aircraft } = findCarriersAndAircraft(ctx.mission)
      if (!carriers.length) return EMPTY
      // The carrier this position works (as the manual import picks it),
      // and all its aircraft.
      const session = useSessionStore.getState()
      const active  = useUnitsStore.getState().units[session.carrierUnitId]
      const carrier = carriers.find((c) => c.type === active?.name) ?? carriers[0]
      const board   = useStatusBoardStore.getState()
      const onBoard = new Set(board.entries.map((e) => e.callsign).filter(Boolean))
      const items   = aircraft.filter((a) => a.carrierUnitId === carrier.unitId && !onBoard.has(a.callsign))

      const w = extractWeather(ctx.mission)
      const missionDate = session.mission?.mission?.dateAndTime?.date ?? undefined
      const pos = active?.position
      const values = {
        wnd: w?.wind ? formatWind(w.wind, pos ? computeMagvar(pos.lat, pos.lng, missionDate) : 0) : '',
        vis: w?.vis ?? '', clg: w?.clg ?? '', qnh: w?.qnh ?? '',
      }
      const weather = Object.fromEntries(Object.entries(values).filter(([field, v]) => v && !board[field]))
      const parts = []
      if (items.length) parts.push(`${plural(items.length, 'aircraft', 'aircraft')} (${carrier.display ?? carrier.type})`)
      if (Object.keys(weather).length) parts.push('weather')
      return { count: items.length + Object.keys(weather).length, items, weather, summary: parts.join(', ') }
    },
    apply(d) {
      useStatusBoardStore.getState().applyMissionLoad(d.items, d.weather)
    },
  },
  {
    key: 'ato',
    label: 'ATO / FRAG',
    modules: ['ABM'],
    shared: false,
    diff(ctx) {
      const all = ownFlights(ctx, findAtoFlights(ctx.mission))
      const s = useAbmMissionStore.getState()
      const have = new Set(s.flights.map((f) => f.groupId))
      // A different mission auto-loaded earlier is replaced as a whole.
      const items = s.missionId && s.missionId !== ctx.id ? all : all.filter((f) => !have.has(f.groupId))
      return { count: items.length, all, summary: plural(items.length, 'flight') }
    },
    apply(d, ctx) {
      preloadOrdnanceDb()
      useAbmMissionStore.getState().loadMissionFlights(d.all, ctx.id)
    },
  },
  {
    key: 'drawings',
    label: 'Drawings',
    modules: ['ABM'],
    shared: false,
    async diff(ctx) {
      if (!ctx.theatre) return EMPTY
      await drawingsReady
      const layers = useAbmDrawingsStore.getState().byTheatre[ctx.theatre] ?? []
      const have = new Set(layers.map((l) => l.source).filter(Boolean))
      const items = parseMiz(ctx.text, ctx.theatre).filter((g) => !have.has(sourceKey(ctx, g.name)))
      return { count: items.length, items, summary: plural(items.length, 'layer') }
    },
    apply(d, ctx) {
      for (const g of d.items) {
        const layers = useAbmDrawingsStore.getState().byTheatre[ctx.theatre] ?? []
        if (layers.some((l) => l.source === sourceKey(ctx, g.name))) continue
        useAbmDrawingsStore.getState().addLayer(ctx.theatre, `${NAME_PREFIX} ${g.name}`, g.features, sourceKey(ctx, g.name))
      }
    },
  },
  {
    key: 'navdata',
    label: 'User Navdata (Video Maps)',
    // Only STARS draws user video maps (its MAPS submenu).
    modules: ['ATC'],
    shared: false,
    async diff(ctx) {
      if (!ctx.theatre) return EMPTY
      const nav = useUserNavdataStore.getState()
      await nav.ensureTheatre(ctx.theatre)
      const maps = useUserNavdataStore.getState().byTheatre[ctx.theatre]?.maps ?? []
      const have = new Set(maps.map((m) => m.source).filter(Boolean))
      const items = missionMapRows(ctx.text, ctx.theatre, 'mission', NAME_PREFIX)
        .filter((r) => !r.error && !have.has(sourceKey(ctx, r.group)))
      return { count: items.length, items, summary: plural(items.length, 'video map') }
    },
    async apply(d, ctx) {
      for (const row of d.items) {
        const maps = useUserNavdataStore.getState().byTheatre[ctx.theatre]?.maps ?? []
        if (maps.some((m) => m.source === sourceKey(ctx, row.group))) continue
        const { features } = finalizeRow(row)
        if (features.length) await useUserNavdataStore.getState().addMap(ctx.theatre, { name: row.name, features, source: sourceKey(ctx, row.group) })
      }
    },
  },
]

export function areasForModule(module) {
  return AREAS.filter((a) => a.modules.includes(module))
}

// The areas with something to load for this position, each with its diff.
// An area that fails to read (e.g. a theatre TRACS has no projection for)
// is left out and logged.
export async function pendingAreas(module, ctx) {
  const out = []
  for (const area of areasForModule(module)) {
    try {
      const d = await area.diff(ctx)
      if (d.count > 0) out.push({ area, diff: d })
    } catch (err) {
      console.warn(`[missionData] ${area.key}: ${err?.message ?? err}`)
    }
  }
  return out
}
