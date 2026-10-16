import { useEffect, useMemo, useRef } from 'react'
import { useUnitsStore }       from '../../store/units.js'
import { useSessionStore }     from '../../store/session.js'
import { useStatusBoardStore } from '../../store/statusBoard.js'
import { getVisibleUnits }     from '../../utils/visibleUnits.js'
import { resolveCallsign }     from '../../utils/callsign.js'
import { useMissionClock }     from '../../utils/useMissionClock.js'
import { CARRIER_TYPES, carrierDeckAltFt, projectOntoDeck } from '../../utils/carriers.js'
import { M_TO_FT, MS_TO_KT } from '../../utils/units.js'

// Same deck-level band as deckPosition() in utils/carriers.js.
const ALT_ABOVE_DECK_FT = 40
const ALT_BELOW_DECK_FT = 20
// "Settled" = on deck, on the ground and moving with the ship for SETTLE_MS.
// A trap decelerates to carrier speed within a couple of seconds; a bolter or
// touch-and-go crosses the deck at flying speed and never gets there.
const SETTLE_SPEED_KT = 10
const SETTLE_MS       = 3000

/**
 * .SBAUTOFILL — stamps the status board's ATD when an aircraft launches from
 * the signed-in carrier and ATA when it traps. Renders nothing; it's its own
 * component (mounted by CatccScope, which is always up in the main window,
 * unlike the dockable/poppable StatusBoard) so the per-second mission clock
 * re-renders only this, not the scope.
 *
 * Per unit: 'pending' (just seen on/near the deck, history unknown),
 * 'settled' (sat on deck), 'away' (off the deck). Only settled -> away
 * stamps ATD and only away -> settled stamps ATA, so an aircraft first seen
 * parked on deck or already airborne (spawn, reload, autofill switched on)
 * never stamps, and neither does a bolter. Leaving the deck downward inside
 * the hull footprint (elevator to the hangar) isn't a departure.
 */
export function StatusBoardAutofill({ enabled }) {
  const units         = useUnitsStore((s) => s.units)
  const coalition     = useSessionStore((s) => s.coalition)
  const carrierUnitId = useSessionStore((s) => s.carrierUnitId)
  const theatre       = useSessionStore((s) => s.mission?.mission?.theatre)
  const { utcSeconds } = useMissionClock()

  const utcRef = useRef(utcSeconds)
  useEffect(() => { utcRef.current = utcSeconds }, [utcSeconds])

  // unitId -> { phase, slowSince }
  const trackRef = useRef(new Map())
  useEffect(() => { trackRef.current = new Map() }, [enabled, carrierUnitId])

  // Deck-inclusive, same as the Deck tab: parked aircraft read as on-ground.
  const visibleUnits = useMemo(() => getVisibleUnits(units, coalition, true), [units, coalition])

  useEffect(() => {
    if (!enabled) return
    const carrier     = carrierUnitId != null ? units[carrierUnitId] : null
    const carrierType = CARRIER_TYPES[carrier?.name]
    if (!carrier?.position || !carrierType) return

    const track     = trackRef.current
    const now       = Date.now()
    const deckAltFt = carrierDeckAltFt(carrier, carrierType)
    const hdgDeg    = (carrier.heading ?? 0) * 180 / Math.PI
    const seen      = new Set()

    for (const [uid, unit] of Object.entries(visibleUnits)) {
      if (!unit.position) continue
      seen.add(uid)
      const relAltFt = (unit.position.alt ?? 0) * M_TO_FT - deckAltFt
      const { onDeck: inFootprint } = projectOntoDeck(
        unit.position, carrier.position.lat, carrier.position.lng,
        hdgDeg, carrierType.deckLoaFt, carrierType.deckBeamFt, theatre,
      )
      const onDeck   = inFootprint && relAltFt <= ALT_ABOVE_DECK_FT && relAltFt >= -ALT_BELOW_DECK_FT
      const departed = !inFootprint || relAltFt > ALT_ABOVE_DECK_FT
      const relSpeedKt = Math.abs((unit.speed ?? 0) - (carrier.speed ?? 0)) * MS_TO_KT
      const slow = onDeck && relSpeedKt < SETTLE_SPEED_KT && unit.airborne !== true

      let t = track.get(uid)
      if (!t) {
        t = { phase: departed ? 'away' : 'pending', slowSince: null }
        track.set(uid, t)
      }
      t.slowSince = slow ? (t.slowSince ?? now) : null

      if (t.phase !== 'settled' && t.slowSince != null && now - t.slowSince >= SETTLE_MS) {
        if (t.phase === 'away') stamp(uid, unit, 'arrival')
        t.phase = 'settled'
      } else if (t.phase !== 'away' && departed) {
        if (t.phase === 'settled') stamp(uid, unit, 'departure')
        t.phase = 'away'
      }
    }
    for (const uid of track.keys()) if (!seen.has(uid)) track.delete(uid)

    function stamp(uid, unit, kind) {
      const secs = utcRef.current
      if (secs == null) return
      const hhmm = `${String(Math.floor(secs / 3600)).padStart(2, '0')}${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`
      // Row match, same rule as correlationEngine.js: the row's own unit,
      // else callsign.
      const sb = useStatusBoardStore.getState()
      const cs = resolveCallsign(unit)
      const entry = sb.entries.find((e) => e.unitId != null && String(e.unitId) === uid)
                 ?? sb.entries.find((e) => e.callsign && e.callsign === cs)
      if (!entry) return
      if (kind === 'departure') sb.stampDeparture(entry.id, hhmm)
      else                      sb.stampArrival(entry.id, hhmm)
    }
  }, [enabled, visibleUnits, units, carrierUnitId, theatre])

  return null
}
