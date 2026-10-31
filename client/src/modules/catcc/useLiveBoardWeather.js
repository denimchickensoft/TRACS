import { useEffect } from 'react'
import { useSessionStore } from '../../store/session.js'
import { useStatusBoardStore } from '../../store/statusBoard.js'
import { extractWeather } from '../../utils/parseMission.js'
import { findAirfieldWeather, catccQnh, formatWind } from '../../utils/liveWeather.js'
import { computeMagvar } from '../../utils/magvar.js'

const FIELDS = ['wnd', 'vis', 'clg', 'qnh']

// Fills the status board's WND, VIS, CLG and QNH from the DCS exporter's
// live weather, as mission import does from a .miz: wind (magnetic) and QNH
// from the carrier's live sample (the mission's QNH if the carrier has none),
// visibility and ceiling from the mission's weather. A field is only filled
// while it's empty or still automatic (board wxAuto): a typed value stays
// until someone clears it.
export function useLiveBoardWeather(carrierUnitId) {
  const weather = useSessionStore((s) => s.weather)
  const missionDate = useSessionStore((s) => s.mission?.mission?.dateAndTime?.date ?? null)
  // Re-run on board edits too, so a field someone empties fills again.
  const wnd = useStatusBoardStore((s) => s.wnd)
  const vis = useStatusBoardStore((s) => s.vis)
  const clg = useStatusBoardStore((s) => s.clg)
  const qnh = useStatusBoardStore((s) => s.qnh)
  const wxAuto = useStatusBoardStore((s) => s.wxAuto)

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
    const patch = {}
    for (const field of FIELDS) {
      const value = values[field]
      if (!value || board[field] === value) continue
      if (board[field] && !board.wxAuto?.[field]) continue
      patch[field] = value
    }
    if (Object.keys(patch).length === 0) return
    const auto = { ...board.wxAuto }
    for (const field of Object.keys(patch)) auto[field] = true
    useStatusBoardStore.setState({ ...patch, wxAuto: auto })
  }, [weather, carrierUnitId, missionDate, wnd, vis, clg, qnh, wxAuto])
}
