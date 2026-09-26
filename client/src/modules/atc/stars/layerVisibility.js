import { useMapsStore }       from '../../../store/maps.js'
import { useHoldingsStore }   from '../../../store/holdings.js'
import { useAirwaysStore }    from '../../../store/airways.js'
import { useMsaStore }        from '../../../store/msa.js'
import { useMoraStore }       from '../../../store/mora.js'
import { useReliefStore }     from '../../../store/relief.js'
import { useMvaStore }        from '../../../store/mva.js'
import { useGeoStore }        from '../../../store/geo.js'
import { useFixesStore }      from '../../../store/fixes.js'
import { useProceduresStore } from '../../../store/procedures.js'

// STARS map/navdata layer visibility lives in the shared layer stores, not in
// the display window, so presets (PREF SAVE / SAVE AS / default slot) and
// scope bookmarks capture and restore it through this one pair. Keeping every
// site on the same list is what stops one of them silently saving fewer
// layers than the others.

export function snapshotLayerVisibility() {
  return {
    mapsVisible:    useMapsStore.getState().visible,
    reliefVisible:  useReliefStore.getState().visible,
    geoVisible:     useGeoStore.getState().visible,
    fixesVisible:   useFixesStore.getState().visible,
    mvaVisible:     useMvaStore.getState().visible,
    msaVisible:     useMsaStore.getState().visible,
    moraVisible:    useMoraStore.getState().visible,
    holdsVisible:   useHoldingsStore.getState().visible,
    airwaysVisible: useAirwaysStore.getState().visible,
    procVisible:    [...useProceduresStore.getState().visible],
  }
}

// Applies whatever layers `settings` contains; layers missing from an older
// saved preset or bookmark are left as they are.
export function applyLayerVisibility(settings) {
  if (!settings) return
  if (settings.mapsVisible)             useMapsStore.getState().setVisible(settings.mapsVisible)
  if (settings.reliefVisible  != null)  useReliefStore.getState().setVisible(settings.reliefVisible)
  if (settings.geoVisible     != null)  useGeoStore.getState().setVisible(settings.geoVisible)
  if (settings.fixesVisible   != null)  useFixesStore.getState().setVisible(settings.fixesVisible)
  if (settings.mvaVisible     != null)  useMvaStore.getState().setVisible(settings.mvaVisible)
  if (settings.msaVisible     != null)  useMsaStore.getState().setVisible(settings.msaVisible)
  if (settings.moraVisible    != null)  useMoraStore.getState().setVisible(settings.moraVisible)
  if (settings.holdsVisible   != null)  useHoldingsStore.getState().setVisible(settings.holdsVisible)
  if (settings.airwaysVisible != null)  useAirwaysStore.getState().setVisible(settings.airwaysVisible)
  if (settings.procVisible    != null)  useProceduresStore.getState().setVisible(settings.procVisible)
}
