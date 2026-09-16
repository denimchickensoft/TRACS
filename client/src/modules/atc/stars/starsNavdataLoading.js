import { useEffect } from 'react'
import { useNavdataStore }    from '../../../store/navdata.js'
import { useRunwaysStore }    from '../../../store/runways.js'
import { useMapsStore }       from '../../../store/maps.js'
import { useHoldingsStore }   from '../../../store/holdings.js'
import { useAirwaysStore }    from '../../../store/airways.js'
import { useMsaStore }        from '../../../store/msa.js'
import { useMoraStore }       from '../../../store/mora.js'
import { useReliefStore }     from '../../../store/relief.js'
import { useGeoStore }        from '../../../store/geo.js'
import { useProceduresStore } from '../../../store/procedures.js'
import { useMvaStore }        from '../../../store/mva.js'

/**
 * StarsScope's theatre/facility-driven navdata-loading effects. Each effect
 * body and dependency array is moved verbatim from StarsScope.jsx — no
 * behavior change, including the pre-existing redundant re-derivation of
 * `mission?.mission?.theatre` inside effects 2-4 rather than reusing the
 * `theatre` param (kept as-is rather than "fixed" during this mechanical move).
 */
export function useStarsNavdataLoading({ theatre, mission, airbases, facilityDcsName, facilityId, positionSuffix, positionName }) {
  // Load fixes + navaids for the current theatre so .FIND lookups work
  useEffect(() => {
    if (theatre) useNavdataStore.getState().loadForTheatre(theatre)
  }, [theatre])

  // Load runway data when theatre or facility changes
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    const raw    = airbases?.airbases ?? airbases ?? {}
    const match  = facilityDcsName ? Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName) : null
    const facLat = match?.latitude  ?? null
    const facLng = match?.longitude ?? null
    const missionDate = mission?.mission?.dateAndTime?.date ?? null
    useRunwaysStore.getState().loadForTheatre(theatre, positionSuffix, facLat, facLng, facilityDcsName, missionDate)
  }, [mission?.mission?.theatre, mission?.mission?.dateAndTime?.date, facilityDcsName, positionSuffix, airbases])

  // Load airspace maps when theatre or facility changes
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    const raw    = airbases?.airbases ?? airbases ?? {}
    const match  = facilityDcsName ? Object.values(raw).find((ab) => (ab.callsign || '') === facilityDcsName) : null
    const facLat = match?.latitude  ?? null
    const facLng = match?.longitude ?? null
    useMapsStore.getState().loadForTheatre(theatre, positionSuffix, facLat, facLng, positionName)
  }, [mission?.mission?.theatre, facilityDcsName, positionSuffix, airbases, positionName])

  // Load new overlays when theatre changes
  useEffect(() => {
    const theatre = mission?.mission?.theatre
    if (!theatre) return
    useHoldingsStore.getState().loadForTheatre(theatre)
    useAirwaysStore.getState().loadForTheatre(theatre)
    useMsaStore.getState().loadForTheatre(theatre)
    useMoraStore.getState().loadForTheatre(theatre)
    useReliefStore.getState().loadForTheatre(theatre)
    useGeoStore.getState().loadForTheatre(theatre)
  }, [mission?.mission?.theatre])

  // Load procedures + MVA when facility ICAO changes
  useEffect(() => {
    if (!facilityId) return
    useProceduresStore.getState().loadForIcao(facilityId)
    useMvaStore.getState().loadForFacility(facilityId)
  }, [facilityId])
}
