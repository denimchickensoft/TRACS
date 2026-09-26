/**
 * StarsScope's reactive store subscriptions, grouped by domain. Each hook is
 * just the same individual per-field `useXStore(s => s.field)` selectors
 * StarsScope.jsx called directly before, composed into one return value —
 * no change in subscription granularity or re-render behavior. Store
 * imports also used for `.getState()` calls elsewhere in StarsScope.jsx
 * stay imported there too; this file only owns the reactive read side.
 */

import { useUnitsStore }       from '../../../store/units.js'
import { useAtcStore }         from '../../../store/atc.js'
import { useSessionStore }     from '../../../store/session.js'
import { useControllersStore } from '../../../store/controllers.js'
import { useStcaStore }        from '../../../store/stca.js'
import { useMapsStore }        from '../../../store/maps.js'
import { useRunwaysStore }     from '../../../store/runways.js'
import { useHoldingsStore }    from '../../../store/holdings.js'
import { useAirwaysStore }     from '../../../store/airways.js'
import { useMsaStore }         from '../../../store/msa.js'
import { useMoraStore }        from '../../../store/mora.js'
import { useReliefStore }      from '../../../store/relief.js'
import { useMvaStore }         from '../../../store/mva.js'
import { useGeoStore }         from '../../../store/geo.js'
import { useFixesStore }       from '../../../store/fixes.js'
import { useProceduresStore }  from '../../../store/procedures.js'
import { useNavdataStore }     from '../../../store/navdata.js'

// ATC ownership/ident state + this position's identity.
export function useStarsAtcData() {
  const units        = useUnitsStore((s) => s.units)
  const ownership    = useAtcStore((s) => s.ownership)
  const handoffs     = useAtcStore((s) => s.handoffs)
  const pointOuts    = useAtcStore((s) => s.pointOuts)
  const blinkTracks  = useAtcStore((s) => s.blinkTracks)
  const displayFdb   = useAtcStore((s) => s.displayFdb)
  const conflictAcks = useAtcStore((s) => s.conflictAcks)
  const scratchpads  = useAtcStore((s) => s.scratchpads)
  const conflicts    = useStcaStore((s) => s.conflicts)
  const coalition    = useSessionStore((s) => s.coalition)
  const positionName = useSessionStore((s) => s.positionName)
  const myControllerId = useControllersStore((s) => s.registry[positionName]?.controllerId ?? null)
  return {
    units, ownership, handoffs, pointOuts, blinkTracks, displayFdb, conflictAcks,
    scratchpads, conflicts, coalition, positionName, myControllerId,
  }
}

// Session/facility identity.
export function useStarsFacilityData() {
  const mission         = useSessionStore((s) => s.mission)
  const airbases        = useSessionStore((s) => s.airbases)
  const facilityDcsName = useSessionStore((s) => s.facilityDcsName)
  const facilityType    = useSessionStore((s) => s.facilityType)
  const positionSuffix  = useSessionStore((s) => s.positionSuffix)
  const facilityId      = useSessionStore((s) => s.facilityId)
  return { mission, airbases, facilityDcsName, facilityType, positionSuffix, facilityId }
}

// Navdata/map layer data + their visibility toggles.
export function useStarsNavdataLayers() {
  const maps        = useMapsStore((s) => s.maps)
  const mapPalettes = useMapsStore((s) => s.palettes)
  const mapVisible  = useMapsStore((s) => s.visible)

  const holdings       = useHoldingsStore((s) => s.holdings)
  const holdsVisible   = useHoldingsStore((s) => s.visible)
  const airways        = useAirwaysStore((s) => s.airways)
  const airwaysVisible = useAirwaysStore((s) => s.visible)
  const msa            = useMsaStore((s) => s.msa)
  const msaVisible     = useMsaStore((s) => s.visible)
  const mora           = useMoraStore((s) => s.mora)
  const moraVisible    = useMoraStore((s) => s.visible)
  const relief         = useReliefStore((s) => s.relief)
  const reliefVisible  = useReliefStore((s) => s.visible)
  const mva            = useMvaStore((s) => s.mva)
  const mvaVisible     = useMvaStore((s) => s.visible)
  const geoBoundaries  = useGeoStore((s) => s.boundaries)
  const geoCoastlines  = useGeoStore((s) => s.coastlines)
  const geoVisible     = useGeoStore((s) => s.visible)
  const fixes          = useNavdataStore((s) => s.fixes)
  const fixesVisible   = useFixesStore((s) => s.visible)

  const procRaw            = useProceduresStore((s) => s.raw)
  const procSidGroups      = useProceduresStore((s) => s.sidGroups)
  const procStarGroups     = useProceduresStore((s) => s.starGroups)
  const procAppchGroups    = useProceduresStore((s) => s.appchGroups)
  const procVisible        = useProceduresStore((s) => s.visible)
  const procCommandVisible = useProceduresStore((s) => s.commandVisible)

  const centerlines  = useRunwaysStore((s) => s.centerlines)
  const cltrVisible  = useRunwaysStore((s) => s.cltrVisible)

  return {
    maps, mapPalettes, mapVisible,
    holdings, holdsVisible, airways, airwaysVisible, msa, msaVisible,
    mora, moraVisible, relief, reliefVisible, mva, mvaVisible,
    geoBoundaries, geoCoastlines, geoVisible, fixes, fixesVisible,
    procRaw, procSidGroups, procStarGroups, procAppchGroups, procVisible, procCommandVisible,
    centerlines, cltrVisible,
  }
}
