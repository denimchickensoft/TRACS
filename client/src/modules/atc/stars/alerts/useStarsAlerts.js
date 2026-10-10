import { useEffect, useRef } from 'react'
import { useAtcStore }        from '../../../../store/atc.js'
import { useFlightPlansStore } from '../../../../store/flightPlans.js'
import { useAssociationStore } from '../../../../store/association.js'
import { useRunwaysStore, nmBetween } from '../../../../store/runways.js'
import { useStarsAlertsStore } from '../../../../store/starsAlerts.js'
import { startAlertTone, stopAlertTone } from '../../../../audio/alertTone.js'
import { hasLiveSquawk, normalizeCode } from '../../../../utils/transponder.js'
import { spcForCode, trackSpcAlerts, spcSounding, ALERT_AUDIO_MS } from '../../../../utils/spc.js'
import { msawDisabledFor, unitAltFt } from '../../../../utils/msaw.js'
import { M_TO_FT, MS_TO_KT } from '../../../../utils/units.js'
import { sendWebrtcEvent } from '../../../../webrtc/client.js'

const TICK_MS = 1000

// No MSAW processing within this distance of an airbase: traffic in the
// airport area is low by design. Carriers aren't exempt.
const AIRPORT_EXEMPT_NM = 3

// Low altitude warning (general terrain monitoring), against the highest
// terrain in each 2 NM bin (unit.terrainBinsM, metres MSL, at 0/10/.../60 s
// along the track):
//   - below MSAW_CLEARANCE_FT above the current bin, or
//   - projected below MSAW_LOOKAHEAD_CLEARANCE_FT at 10/20/30 s on the
//     current heading, speed and climb/descent rate, or
//   - unable to stay MSAW_LOOKAHEAD_CLEARANCE_FT clear at 40/50/60 s even
//     by starting a 5 degree climb at the 30 s point.
const MSAW_CLEARANCE_FT           = 500
const MSAW_LOOKAHEAD_CLEARANCE_FT = 300
const MSAW_LOOKAHEAD_S            = [10, 20, 30]
const MSAW_CLIMB_S                = [40, 50, 60]
const CLIMB_FT_PER_NM             = Math.tan(5 * Math.PI / 180) * 6076.12   // ~531.6

// The climb/descent rate is averaged over this window rather than taken
// between consecutive samples: position updates and this tick both run at
// about 1 Hz without being in step, so a single interval can see no change
// and the next two updates' worth. Below VS_MIN_SPAN_MS of history the rate
// is taken as level.
const VS_WINDOW_MS   = 10000
const VS_MIN_SPAN_MS = 5000

function smoothedVs(history, uid, altFt, now) {
  const samples = history.get(uid) ?? []
  samples.push({ t: now, altFt })
  while (samples.length > 1 && now - samples[0].t > VS_WINDOW_MS) samples.shift()
  history.set(uid, samples)
  const oldest = samples[0]
  const spanMs = now - oldest.t
  return spanMs >= VS_MIN_SPAN_MS ? (altFt - oldest.altFt) / (spanMs / 1000) : 0
}

// Without bin data (no elevation database), the terrain under the track
// (altitude minus AGL) stands in for every sample and the climb check is
// skipped.
function msawWarning(unit, altFt, vsFps) {
  const bins = unit.terrainBinsM
  const binFt = (i) => (bins?.[i] != null ? bins[i] * M_TO_FT : null)
  const terrainNowFt = binFt(0) ?? altFt - unit.agl * M_TO_FT
  if (altFt - terrainNowFt < MSAW_CLEARANCE_FT) return true

  const ahead = MSAW_LOOKAHEAD_S.some((t, i) =>
    altFt + vsFps * t - (binFt(i + 1) ?? terrainNowFt) < MSAW_LOOKAHEAD_CLEARANCE_FT)
  if (ahead || !bins) return ahead

  const alt30Ft = altFt + vsFps * 30
  const gsKt    = (unit.speed ?? 0) * MS_TO_KT
  return MSAW_CLIMB_S.some((t, i) => {
    const terrainFt = binFt(i + 4)
    if (terrainFt == null) return false
    const climbFt = alt30Ft + CLIMB_FT_PER_NM * gsKt * (t - 30) / 3600
    return climbFt - terrainFt < MSAW_LOOKAHEAD_CLEARANCE_FT
  })
}

/** The flight plan bound to a unit, by explicit unitId or association. */
export function planForUnit(uid, plans, associated) {
  for (const p of Object.values(plans)) {
    if (p.unitId != null && String(p.unitId) === uid) return p
  }
  const aid = associated[uid]
  return aid ? plans[aid] ?? null : null
}

// uid -> plan for every bound plan, with the same precedence as
// planForUnit (explicit unitId first, then association), built once per tick.
export function plansByUnit(plans, associated) {
  const map = {}
  for (const p of Object.values(plans)) {
    if (p.unitId == null) continue
    const uid = String(p.unitId)
    if (!(uid in map)) map[uid] = p
  }
  for (const [uid, aid] of Object.entries(associated)) {
    if (!(uid in map) && plans[aid]) map[uid] = plans[aid]
  }
  return map
}

// A MULTI FUNC V inhibit made on a track before it had a flight plan moves
// onto the plan once one is bound to the track, so it's shared and follows
// the track through handoffs like any other plan setting.
function carryTrackMsawToPlans(store, plans, associated) {
  const uids = Object.keys(store.trackMsawDisabled)
  if (!uids.length) return
  const planOf = plansByUnit(plans, associated)
  for (const uid of uids) {
    const plan = planOf[uid]
    if (!plan) continue
    if (plan.msawDisabled !== true) {
      useFlightPlansStore.getState().update(plan.aid, { msawDisabled: true })
      sendWebrtcEvent('FLIGHT_PLAN_AMEND', useFlightPlansStore.getState().plans[plan.aid])
    }
    store.clearTrackMsaw(uid)
  }
}

function nearAirbase(lat, lng, airbases) {
  // Degree box around the exemption radius rules out most thresholds before
  // the exact distance check.
  const dLatMax = AIRPORT_EXEMPT_NM / 60
  const dLngMax = AIRPORT_EXEMPT_NM / (60 * Math.cos(lat * Math.PI / 180))
  for (const a of airbases) {
    if (Math.abs(a.lat - lat) > dLatMax || Math.abs(a.lon - lng) > dLngMax) continue
    if (nmBetween(lat, lng, a.lat, a.lon) <= AIRPORT_EXEMPT_NM) return true
  }
  return false
}

/**
 * Special condition code, MSAW, and duplicate beacon detection for this
 * scope, plus their alert tones. Each tone sounds for 5 seconds from the
 * start of a new alert, or until it's acknowledged.
 *
 * MSAW only checks tracks this controller owns that report a height above
 * terrain: within MSAW_CLEARANCE_FT of the terrain now, or
 * MSAW_LOOKAHEAD_CLEARANCE_FT over the look-ahead (see msawWarning),
 * outside the airbase exemption, and not inhibited.
 *
 * @param {{ current: object }} visibleUnitsRef  this scope's visible units
 */
export function useStarsAlerts({ visibleUnitsRef, myControllerId, vol }) {
  const altHistoryRef = useRef(new Map())
  useEffect(() => {
    const tick = () => {
      const now       = Date.now()
      const units     = visibleUnitsRef.current ?? {}
      const associated = useAssociationStore.getState().associated
      carryTrackMsawToPlans(useStarsAlertsStore.getState(), useFlightPlansStore.getState().plans, associated)
      const store     = useStarsAlertsStore.getState()
      const ownership = useAtcStore.getState().ownership
      const plans     = useFlightPlansStore.getState().plans
      const planOf    = plansByUnit(plans, associated)
      const airbases  = useRunwaysStore.getState().airbasePositions

      // SPC: armed the first time the track squawks one
      const spc  = trackSpcAlerts(store.spc, units, now)
      const msaw = {}
      const codeCount = {}

      for (const [id, unit] of Object.entries(units)) {
        const uid = String(id)
        const live = !!unit?.srsCapable && hasLiveSquawk(unit)
        const code = live ? normalizeCode(unit.transponder.mode3) : null
        const spcCode = code ? spcForCode(code) : null

        // ── Duplicate beacon: VFR and SPC codes never count ──
        if (code && code !== '1200' && !spcCode) codeCount[code] = (codeCount[code] ?? 0) + 1

        // ── MSAW ──
        const prev = store.msaw[uid]
        let warn = false
        const altFt = unitAltFt(unit)
        // Climb/descent rate is tracked for every visible unit so it's
        // already settled when a track is taken under control.
        const vsFps = altFt != null ? smoothedVs(altHistoryRef.current, uid, altFt, now) : 0
        if (!store.msawDisabled && myControllerId && ownership[uid] === myControllerId &&
            unit.airborne !== false && altFt != null && unit.agl != null) {
          const plan = planOf[uid] ?? null
          if (!msawDisabledFor(plan, store.trackMsawDisabled[uid]) &&
              !nearAirbase(unit.position.lat, unit.position.lng, airbases)) {
            warn = msawWarning(unit, altFt, vsFps)
          }
        }
        if (warn) {
          msaw[uid] = prev?.active
            ? prev
            : { active: true, acked: false, start: now, soundEnd: now + ALERT_AUDIO_MS, inhibit: false }
        }
        // No warning: the entry (and with it any MULTI FUNC Q inhibit) goes away
      }

      const duplicates = {}
      for (const [code, n] of Object.entries(codeCount)) if (n > 1) duplicates[code] = true

      // Expired one-shot display windows
      const fullLdbUntil = {}
      for (const [uid, until] of Object.entries(store.fullLdbUntil)) if (until > now && units[uid]) fullLdbUntil[uid] = until
      const selectedBeacon = store.selectedBeacon && store.selectedBeacon.until > now ? store.selectedBeacon : null

      for (const id of altHistoryRef.current.keys()) if (!units[id]) altHistoryRef.current.delete(id)

      store.setComputed({ spc, msaw, duplicates, fullLdbUntil, selectedBeacon })
    }
    tick()
    const id = setInterval(tick, TICK_MS)
    return () => clearInterval(id)
  }, [visibleUnitsRef, myControllerId])

  // ── Alert tones ──
  const spc  = useStarsAlertsStore((s) => s.spc)
  const msaw = useStarsAlertsStore((s) => s.msaw)
  useEffect(() => {
    const now = Date.now()
    const getVolume = () => (vol ?? 10) / 10
    const spcOn        = spcSounding(spc, now)
    const msawSounding = Object.values(msaw).some((a) => !a.acked && !a.inhibit && now < a.soundEnd)
    if (spcOn)        startAlertTone('stars-spc',  { frequency: 1250, onMs: 300, offMs: 200, getVolume })
    else              stopAlertTone('stars-spc')
    if (msawSounding) startAlertTone('stars-msaw', { frequency: 650,  onMs: 500, offMs: 250, getVolume })
    else              stopAlertTone('stars-msaw')
  }, [spc, msaw, vol])

  useEffect(() => () => { stopAlertTone('stars-spc'); stopAlertTone('stars-msaw') }, [])
}
