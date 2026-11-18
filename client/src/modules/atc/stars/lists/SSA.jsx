import { useSessionStore }  from '../../../../store/session.js'
import { useDisplayStore, DEFAULT_LISTS } from '../../../../store/display.js'
import { useOdsStore }      from '../../../../store/ods.js'
import { useMissionClock }  from '../../../../utils/useMissionClock.js'
import { ListPanel }        from './ListPanel.jsx'
import { useUnitSystem }    from '../../../../store/unitSystem.js'
import { formatDistance, METRIC } from '../../../../utils/units.js'
import { useEffect, useState } from 'react'
import { getIcaoMapping }   from '../../../../utils/icaoMapping.js'
import { computeMagvar }    from '../../../../utils/magvar.js'
import { findAirfieldWeather, findAirbase, icaoToAirbaseName, starsAltimeter, formatWind } from '../../../../utils/liveWeather.js'
import { useMissionWeather } from '../../../../utils/useMissionWeather.js'
import { fmtAltFilterLimit } from '../starsScopeHelpers.js'

const WINDOW_ID = 'atc-main'

function formatMissionTime(totalSeconds) {
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0')
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0')
  const ss = String(totalSeconds % 60).padStart(2, '0')
  return `${hh}${mm}/${ss}`
}

// One SSA weather line's wind and altimeter: the manual entry where there
// is one, else the DCS exporter's live weather for the field, else the
// mission file's (one wind and QNH for the whole map); '' where none exists.
// Wind is magnetic at the field (its airbase position where there's no live
// sample), shown as 'DDDSS'.
function fieldWeather(airfield, airbase, fromMission, manualWind, missionDate, metric) {
  const at = airfield ?? airbase
  const declination = at ? computeMagvar(at.latitude ?? 0, at.longitude ?? 0, missionDate ?? undefined) : 0
  const wind = airfield?.wind ?? fromMission?.wind
  const qnhHpa = airfield?.qnhHpa ?? fromMission?.qnhHpa
  return {
    wind: manualWind ?? (wind ? formatWind(wind, declination) : ''),
    alt: qnhHpa != null ? starsAltimeter(qnhHpa, metric) : '',
  }
}

const joinParts = (...parts) => parts.filter(Boolean).join(' ')

export function SSA() {
  const connected      = useSessionStore((s) => s.connected)
  const facilityId     = useSessionStore((s) => s.facilityId)
  const facilityDcsName = useSessionStore((s) => s.facilityDcsName)
  const weather        = useSessionStore((s) => s.weather)
  const airbases       = useSessionStore((s) => s.airbases)
  const fromMission    = useMissionWeather()
  const theatre        = useSessionStore((s) => s.mission?.mission?.theatre)
  const missionDate    = useSessionStore((s) => s.mission?.mission?.dateAndTime?.date ?? null)
  const [icaoMapping, setIcaoMapping] = useState(null)
  useEffect(() => { getIcaoMapping().then(setIcaoMapping) }, [])
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const unitSystem     = useUnitSystem('atc')
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  // STARS SSA time is always UTC — real ATC scopes never show theatre-local time.
  const { utcSeconds } = useMissionClock()
  const displayTime = utcSeconds == null ? '--:--/--' : formatMissionTime(utcSeconds)

  if (!windowSettings || !activeProfile) return null

  const {
    rangeNm, ptlLength, qnh, windManual, wxFields, atis, giText, giAux, lists, briteLst, csLists, tdmMode,
    altFilterLowU, altFilterHighU, altFilterLowA, altFilterHighA,
  } = windowSettings
  const pos    = lists?.ssa ?? DEFAULT_LISTS.ssa
  const brite  = (briteLst ?? 80) / 100
  const color  = activeProfile.visual?.colors?.pdbText ?? '#00cc00'

  const metric = unitSystem === METRIC
  const facilityWx = fieldWeather(
    findAirfieldWeather(weather, { callsign: facilityDcsName }), findAirbase(airbases, facilityDcsName),
    fromMission, windManual?.[''], missionDate, metric)
  const qnhStr = qnh ?? (facilityWx.alt || '29.92')
  const wxLines = (wxFields ?? []).map((icao) => {
    const name = icaoToAirbaseName(icaoMapping, theatre, icao)
    const wx = fieldWeather(name ? findAirfieldWeather(weather, { callsign: name }) : null, findAirbase(airbases, name),
      // An ICAO outside this theatre gets no mission weather either.
      name ? fromMission : null, windManual?.[icao], missionDate, metric)
    return joinParts(icao, wx.alt, wx.wind)
  })

  const statusBase = connected ? 'OK/OK/NA' : 'NA/NA/NA'
  const statusLine = (
    <>
      <span style={{ color: connected ? color : '#ff3333' }}>{statusBase} </span>
      <span style={{ color }}>{`FUSED${tdmMode ? ' TDM' : ''}`}</span>
    </>
  )

  const altFilterLine =
    `${fmtAltFilterLimit(altFilterLowU, true)} ${fmtAltFilterLimit(altFilterHighU, false)} U ${fmtAltFilterLimit(altFilterLowA, true)} ${fmtAltFilterLimit(altFilterHighA, false)} A`

  const rows = [
    `${displayTime} ${qnhStr}`,
    ...(atis || giText ? [`${atis ?? ''} ${giText ?? ''}`] : []),
    ...(giAux ?? []).filter(Boolean),
    statusLine,
    `${formatDistance(rangeNm, unitSystem)} PTL: ${Number(ptlLength).toFixed(1)}`,
    altFilterLine,
    joinParts(facilityId || '----', qnhStr, facilityWx.wind),
    ...wxLines,
  ]

  return (
    <ListPanel
      rows={rows}
      xPct={pos.xPct}
      yPct={pos.yPct}
      maxLines={rows.length}
      brite={brite}
      csLists={csLists}
      color={color}
    />
  )
}
