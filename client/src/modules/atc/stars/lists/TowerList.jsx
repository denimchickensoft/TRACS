import { useMemo }              from 'react'
import { useFlightPlansStore }  from '../../../../store/flightPlans.js'
import { useUnitsStore }        from '../../../../store/units.js'
import { useSessionStore }      from '../../../../store/session.js'
import { useDisplayStore }      from '../../../../store/display.js'
import { useOdsStore }          from '../../../../store/ods.js'
import { ListPanel }            from './ListPanel.jsx'

const WINDOW_ID = 'atc-main'

function distanceNm(lat1, lng1, lat2, lng2) {
  const R    = 3440.065  // nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function TowerListPanel({ idx }) {
  const plans          = useFlightPlansStore((s) => s.plans)
  const units          = useUnitsStore((s) => s.units)
  const airbases       = useSessionStore((s) => s.airbases)
  const facilityId     = useSessionStore((s) => s.facilityId)
  const windowSettings = useDisplayStore((s) => s.windows[WINDOW_ID])
  const activeProfile  = useOdsStore((s) => s.activeProfile)

  const listKey = `tower${idx}`

  // Determine airport for this tower slot: slot 1 = facility airport, 2-3 = TBD
  // For now all three default to the facility airport
  const raw     = airbases?.airbases ?? airbases ?? {}
  const airport = Object.values(raw).find((ab) => ab.callsign === facilityId)
  const airportId = facilityId || `TWR${idx}`

  const rows = useMemo(() => {
    if (!airport) return []
    return Object.values(plans)
      .filter((p) => p.unitId !== null && p.dest?.toUpperCase() === facilityId?.toUpperCase())
      .map((p) => {
        const unit = units[p.unitId]
        const dist = (unit?.position && airport)
          ? distanceNm(unit.position.lat, unit.position.lng, airport.latitude, airport.longitude)
          : Infinity
        return { p, dist }
      })
      .sort((a, b) => a.dist - b.dist)
      .map(({ p }) => `${p.aid.padEnd(10)} ${(p.typ || '----').padEnd(6)}`)
  }, [plans, units, airport, facilityId])

  if (!windowSettings || !activeProfile) return null

  const { lists, briteLst, csLists } = windowSettings
  const cfg = lists?.[listKey] ?? { visible: false, xPct: 2, yPct: 50, lines: 5 }
  if (!cfg.visible) return null

  const brite = (briteLst ?? 80) / 100
  const color = activeProfile.visual?.colors?.pdbText ?? '#00cc00'
  const title = `${airportId} TOWER (P${idx})`

  return (
    <ListPanel
      title={title}
      rows={rows}
      xPct={cfg.xPct}
      yPct={cfg.yPct}
      maxLines={cfg.lines ?? 5}
      brite={brite}
      csLists={csLists}
      color={color}
    />
  )
}

export function TowerLists() {
  return (
    <>
      <TowerListPanel idx={1} />
      <TowerListPanel idx={2} />
      <TowerListPanel idx={3} />
    </>
  )
}
