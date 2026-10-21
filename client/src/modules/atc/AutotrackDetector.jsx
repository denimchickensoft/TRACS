import { useEffect, useMemo, useRef } from 'react'
import { useAutotrackStore } from '../../store/autotrack.js'
import { useUnitsStore }     from '../../store/units.js'
import { useSessionStore }   from '../../store/session.js'
import { useRunwaysStore }   from '../../store/runways.js'
import { getVisibleUnits, isOnGround } from '../../utils/visibleUnits.js'
import { trueBearingRangeNm } from '../../utils/bearing.js'
import { initControl }       from './actions/index.js'

// A departure is an aircraft seen on the ground within this range of an
// autotracked airport's runways, then airborne.
const DEPARTURE_RADIUS_NM = 3

/**
 * Claims departures from this position's .autotrack airports (see
 * autotrack.js). Renders nothing.
 *
 * Per unit: the airport it was last seen on the ground near, or null. An
 * aircraft first seen airborne never counts, and one that lands and takes off
 * again (touch-and-go) counts again. The claim follows INIT CNTL's rules,
 * so an owned, simulated-wingman or unassociated SRS track is skipped.
 */
export function AutotrackDetector() {
  const mine             = useAutotrackStore((s) => s.mine)
  const units            = useUnitsStore((s) => s.units)
  const coalition        = useSessionStore((s) => s.coalition)
  const airportPositions = useRunwaysStore((s) => s.airportPositions)

  const active = Object.keys(mine).length > 0
  const trackRef = useRef(new Map())
  useEffect(() => { trackRef.current = new Map() }, [mine])

  // Ground-inclusive: departures start on the ground, which the scope hides.
  const visibleUnits = useMemo(
    () => (active ? getVisibleUnits(units, coalition, true) : null),
    [active, units, coalition],
  )

  useEffect(() => {
    if (!visibleUnits) return
    const airports = Object.keys(mine).map((icao) => [icao, airportPositions[icao]]).filter(([, p]) => p)
    const track = trackRef.current
    const seen  = new Set()
    for (const [uid, unit] of Object.entries(visibleUnits)) {
      const pos = unit.position
      if (!pos) continue
      seen.add(uid)
      if (isOnGround(unit)) {
        const near = airports.find(([, p]) => trueBearingRangeNm(p.lat, p.lon, pos.lat, pos.lng).rangeNm <= DEPARTURE_RADIUS_NM)
        track.set(uid, near ? near[0] : null)
      } else {
        if (track.get(uid)) initControl(uid, unit)
        track.set(uid, null)
      }
    }
    for (const uid of track.keys()) if (!seen.has(uid)) track.delete(uid)
  }, [visibleUnits, mine, airportPositions])

  return null
}
