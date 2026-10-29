import { useEffect } from 'react'
import { useSessionStore } from '../../store/session.js'
import { useStatusBoardStore } from '../../store/statusBoard.js'
import { extractWeather } from '../../utils/parseMission.js'
import { findAirfieldWeather, catccQnh, formatWind } from '../../utils/liveWeather.js'
import { computeMagvar } from '../../utils/magvar.js'

// The values this controller last filled in from live weather. A field
// holding anything else was typed by someone and is left alone until it's
// emptied. Kept out of the board's own state, which other controllers share:
// their fills come from the same live data, so they match this record too.
const LIVE_KEY = 'tracs.catcc.sbLiveWx'
const FIELDS = ['wnd', 'vis', 'clg', 'qnh']

function loadLive() {
  try { return JSON.parse(localStorage.getItem(LIVE_KEY) ?? 'null') ?? {} } catch { return {} }
}

function saveLive(live) {
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(live)) } catch { /* quota/private mode */ }
}

// Records values just written to the board by something other than a person
// (the .miz import), so live weather may replace them like its own fills.
export function markBoardAutoFill(values) {
  const live = loadLive()
  for (const field of FIELDS) if (values[field]) live[field] = values[field]
  saveLive(live)
}

// Fills the status board's WND, VIS, CLG and QNH from the DCS exporter's
// live weather, as mission import does from a .miz: wind (magnetic) and QNH
// from the carrier's live sample (the mission's QNH if the carrier has none),
// visibility and ceiling from the mission's weather. A field is only filled
// while it's empty or still shows this controller's last fill.
export function useLiveBoardWeather(carrierUnitId) {
  const weather = useSessionStore((s) => s.weather)
  const missionDate = useSessionStore((s) => s.mission?.mission?.dateAndTime?.date ?? null)
  // Re-run on board edits too, so a field someone empties fills again.
  const wnd = useStatusBoardStore((s) => s.wnd)
  const vis = useStatusBoardStore((s) => s.vis)
  const clg = useStatusBoardStore((s) => s.clg)
  const qnh = useStatusBoardStore((s) => s.qnh)

  useEffect(() => {
    const fromMission = weather?.mission ? extractWeather({ weather: weather.mission }) : null
    const carrier = findAirfieldWeather(weather, { unitId: carrierUnitId })
    if (!fromMission && !carrier) return
    const declination = carrier ? computeMagvar(carrier.latitude ?? 0, carrier.longitude ?? 0, missionDate ?? undefined) : 0
    const values = {
      wnd: carrier ? formatWind(carrier.wind, declination) : '',
      vis: fromMission?.vis ?? '',
      clg: fromMission?.clg ?? '',
      qnh: carrier?.qnhHpa != null ? catccQnh(carrier.qnhHpa) : (fromMission?.qnh ?? ''),
    }

    const board = useStatusBoardStore.getState()
    const live = loadLive()
    const patch = {}
    for (const field of FIELDS) {
      const value = values[field]
      if (!value || board[field] === value) {
        if (value) live[field] = value
        continue
      }
      if (board[field] && board[field] !== live[field]) continue
      patch[field] = value
      live[field] = value
    }
    saveLive(live)
    if (Object.keys(patch).length) useStatusBoardStore.setState(patch)
  }, [weather, carrierUnitId, missionDate, wnd, vis, clg, qnh])
}
