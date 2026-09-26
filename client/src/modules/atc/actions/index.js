/**
 * STARS action library.
 *
 * Every controller action is implemented here, invoked identically
 * regardless of which interaction model triggered it.
 *
 * Each action receives one object: { captures, slewTarget, ...context }
 *   captures   — named captures from the command parser
 *   slewTarget — { unitId, unit } | null  (null for ENTER-triggered commands)
 *   context    — { positionName, canvasPos, canvasSize }, spread in by dispatch()
 *
 * Return values are ignored; actions report their result by writing the
 * preview area directly (usePreviewStore's setResponse/clearAfterCommand).
 */

import { useAtcStore, HANDOFF_STATE, POINTOUT_STATE } from '../../../store/atc.js'
import { usePreviewStore } from '../../../store/preview.js'
import { useDisplayStore } from '../../../store/display.js'
import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { useStripsStore, STRIP_HIGHLIGHT } from '../../../store/strips.js'
import { useFpeStore } from '../../../store/fpe.js'
import { useSessionStore } from '../../../store/session.js'
import { useControllersStore } from '../../../store/controllers.js'
import { useNavdataStore }    from '../../../store/navdata.js'
import { useMapsStore }        from '../../../store/maps.js'
import { useFixesStore }       from '../../../store/fixes.js'
import { useMsaStore }         from '../../../store/msa.js'
import { useHoldingsStore }    from '../../../store/holdings.js'
import { useReliefStore }      from '../../../store/relief.js'
import { useMvaStore }         from '../../../store/mva.js'
import { useRunwaysStore }     from '../../../store/runways.js'
import { useProceduresStore }  from '../../../store/procedures.js'
import { useUnitsStore }       from '../../../store/units.js'
import { useAssociationStore } from '../../../store/association.js'
import { computeWingmanIds }   from '../stars/stca/formations.js'
import { findFlightPlanAid, resolveCallsign, AID_MAX_LEN } from '../../../utils/callsign.js'
import { hasLiveSquawk, normalizeCode } from '../../../utils/transponder.js'
import { parseAbbreviatedFields, parseVfrFields } from '../stars/input/flightPlanFields.js'
import { WORD_VERBS } from '../stars/input/commandParser.js'
import { applyCallsignChange } from '../../../utils/callsignRename.js'
import { sendWebrtcEvent, sendWebrtcSessionEvent } from '../../../webrtc/client.js'
import { saveStarsPrefs } from '../../../store/starsPrefs.js'
import { navdataNotFound } from '../../../store/lnm.js'

const WINDOW_ID = 'atc-main'

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok()          { usePreviewStore.getState().clearAfterCommand() }
function err(msg)      { usePreviewStore.getState().setResponse(msg) }
function clearBuffer() { usePreviewStore.getState().clear() }

function getAtc()     { return useAtcStore.getState() }
function getDisplay() { return useDisplayStore.getState() }

function getMyControllerId() {
  const positionName = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[positionName]?.controllerId ?? null
}

// Resolve a typed FLID (AID, beacon code, or live callsign) to its flight
// plan and/or track. Any part may be null — a plan with no track yet, or a
// live track with no plan.
function resolveFlid(flid) {
  const key = flid?.trim().toUpperCase()
  if (!key) return { aid: null, unitId: null, unit: null }
  const plans = useFlightPlansStore.getState().plans
  const units = useUnitsStore.getState().units
  const associated = useAssociationStore.getState().associated

  const withUnit = (aid, unitId) => {
    const unit = unitId != null ? units[unitId] ?? null : null
    return { aid, unitId: unit ? String(unitId) : null, unit }
  }
  const unitForAid = (aid) =>
    plans[aid]?.unitId ?? Object.keys(associated).find((uid) => associated[uid] === aid) ?? null

  if (plans[key]) return withUnit(key, unitForAid(key))

  if (/^[0-7]{4}$/.test(key)) {
    const plan = Object.values(plans).find((p) => p.bcn === key)
    if (plan) return withUnit(plan.aid, unitForAid(plan.aid))
    // mode3 is numeric (e.g. 1200), so compare in padded 4-digit form.
    const uid = Object.keys(units).find(
      (id) => hasLiveSquawk(units[id]) && normalizeCode(units[id].transponder.mode3) === key
    )
    if (uid) {
      const aid = findFlightPlanAid(units[uid], plans)
      return withUnit(plans[aid] ? aid : null, uid)
    }
  }

  const uid = Object.keys(units).find(
    (id) => resolveCallsign(units[id])?.toUpperCase().slice(0, AID_MAX_LEN) === key
  )
  if (uid) return withUnit(null, uid)
  return { aid: null, unitId: null, unit: null }
}

// The track a command acts on: the slewed one, or the one named by the
// typed FLID (ENTER forms). null when neither resolves to a live track.
function targetOf({ slewTarget, captures }) {
  if (slewTarget) return slewTarget
  if (!captures?.flid) return null
  const { unitId, unit } = resolveFlid(captures.flid)
  return unitId ? { unitId, unit } : null
}

// ── Action handlers ───────────────────────────────────────────────────────────

export function INIT_CNTL({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const controllerId = getMyControllerId()
  if (!controllerId) return err('NO POSITION')
  const { ownership, claimTrack } = getAtc()
  if (ownership[slewTarget.unitId] !== undefined) return err('ILL TRK')
  // Simulated squawk-standby wingmen can't be initiated on control — a
  // primary-only contact has no reported Mode C, so there's nothing to
  // associate. See modules/atc/stars/stca/formations.js.
  const win = getDisplay().windows[WINDOW_ID]
  if (win?.simWingmenStandby) {
    const wingmen = computeWingmanIds(useUnitsStore.getState().units, ownership, win?.manualWingmen)
    if (wingmen.has(String(slewTarget.unitId))) return err('ILL TRK')
  }
  // Unassociated tracks can't be put under control either — real STARS:
  // "All unassociated tracks are unowned tracks." Only meaningful for
  // srsCapable units; unchanged for everything else.
  const targetUnit = useUnitsStore.getState().units[slewTarget.unitId]
  if (targetUnit?.srsCapable && !useAssociationStore.getState().associated[String(slewTarget.unitId)]) {
    return err('ILL TRK')
  }
  claimTrack(slewTarget.unitId, controllerId)
  sendWebrtcEvent('TRACK_CLAIMED', { unitId: slewTarget.unitId, controllerId })
  if (useSessionStore.getState().activeModule === 'ATC' && useStripsStore.getState().autoAddOnTrack) {
    const aid = findFlightPlanAid(slewTarget.unit, useFlightPlansStore.getState().plans)
    useStripsStore.getState().addStrip(aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED, unitId: slewTarget.unitId })
  }
  ok()
}

// Strip Bay "On handoff acceptance" trigger — called from every path that
// accepts an incoming handoff.
function autoAddStripOnHandoffAccept(unitId) {
  if (useSessionStore.getState().activeModule !== 'ATC') return
  const strips = useStripsStore.getState()
  if (!strips.autoAddOnHandoff) return
  const unit = useUnitsStore.getState().units[unitId]
  if (!unit) return
  const aid = findFlightPlanAid(unit, useFlightPlansStore.getState().plans)
  if (aid) strips.addStrip(aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED, unitId })
}

// Acknowledge a conflict-alert pair — called directly from StarsScope.jsx's
// bare-click handler (not command-parsed, same as INIT_CNTL's direct-call
// usage from the Ctrl+Shift+click path).
export function ackConflict(pairId) {
  getAtc().ackConflict(pairId)
  sendWebrtcEvent('CONFLICT_ACK', { pairId })
}

export function OPEN_FPE({ captures, slewTarget }) {
  const aid = captures?.aid?.trim().toUpperCase() ?? null

  let unitId   = null
  let readOnly = false

  if (slewTarget) {
    unitId = slewTarget.unitId
  } else if (aid) {
    const plan = useFlightPlansStore.getState().plans[aid]
    if (plan?.unitId) unitId = String(plan.unitId)
  }

  if (unitId) {
    const owner = useAtcStore.getState().ownership[unitId]
    readOnly = !!(owner && owner !== getMyControllerId())
  }

  useFpeStore.getState().openFpe({ aid, unitId, readOnly, scope: 'atc' })
  ok()
}

export function INIT_CNTL_BY_ID({ captures: _captures, positionName: _positionName }) {
  // TODO: resolve unit by callsign/FLID when flight plan store exists
  err('NOT YET SUPPORTED')
}

export function TERM_CNTL({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { ownership, dropTrack, clearHandoff } = getAtc()
  if (ownership[slewTarget.unitId] !== getMyControllerId()) return err('ILL TRK')
  clearHandoff(slewTarget.unitId)
  dropTrack(slewTarget.unitId)
  sendWebrtcEvent('TRACK_DROPPED', { unitId: slewTarget.unitId })
  if (useSessionStore.getState().activeModule === 'ATC') {
    const { deleteOnDropTrack, deleteByAid } = useStripsStore.getState()
    if (deleteOnDropTrack) {
      const aid = findFlightPlanAid(slewTarget.unit, useFlightPlansStore.getState().plans)
      if (aid) deleteByAid(aid)
    }
  }
  ok()
}

export function TERM_CNTL_ALL() {
  const { ownership, dropTrack, clearHandoff } = getAtc()
  const controllerId = getMyControllerId()
  const { deleteOnDropTrack, deleteByAid } = useStripsStore.getState()
  const plans = useFlightPlansStore.getState().plans
  for (const [id, owner] of Object.entries(ownership)) {
    if (owner === controllerId) {
      clearHandoff(id)
      dropTrack(id)
      sendWebrtcEvent('TRACK_DROPPED', { unitId: id })
      if (deleteOnDropTrack) {
        const plan = Object.values(plans).find((p) => p.unitId === Number(id))
        if (plan) deleteByAid(plan.aid)
      }
    }
  }
  ok()
}

export function HND_OFF({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { ownership, handoffs, setHandoff } = getAtc()
  const controllerId = getMyControllerId()

  // Bare HO + slew on a track with outgoing handoff = recall
  const existing = handoffs[slewTarget.unitId]
  if (existing?.state === HANDOFF_STATE.INITIATED && existing.from === controllerId) {
    getAtc().clearHandoff(slewTarget.unitId)
    return ok()
  }

  const tcp = captures?.tcp
  if (!tcp) return err('ILL POS')
  if (tcp === controllerId) return err('ILL POS')
  const knownIds = new Set(Object.values(useControllersStore.getState().registry).map((e) => e.controllerId).filter(Boolean))
  if (!knownIds.has(tcp)) return err('ILL POS')
  if (ownership[slewTarget.unitId] !== controllerId) return err('ILL TRK')
  setHandoff(slewTarget.unitId, { state: HANDOFF_STATE.INITIATED, from: controllerId, to: tcp })
  sendWebrtcEvent('HANDOFF_INITIATED', { unitId: slewTarget.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

export function HND_OFF_BARE({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { handoffs, clearHandoff, claimTrack } = getAtc()
  const controllerId = getMyControllerId()
  const ho = handoffs[slewTarget.unitId]

  if (!ho) return err('ILL POS')

  if (ho.state === HANDOFF_STATE.INITIATED && ho.from === controllerId) {
    clearHandoff(slewTarget.unitId)
    sendWebrtcEvent('HANDOFF_RECALLED', { unitId: slewTarget.unitId, fromControllerId: controllerId, toControllerId: ho.to })
    return ok()
  }

  if (ho.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
    // claimTrack already unconditionally overwrites the ownership map entry —
    // a preceding dropTrack for the same unit is redundant and is the same
    // shape of two-step "reassign" anti-pattern that causes intermediate
    // states to reach live subscribers elsewhere in this subsystem.
    claimTrack(slewTarget.unitId, controllerId)
    clearHandoff(slewTarget.unitId)
    sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: slewTarget.unitId, fromControllerId: ho.from, toControllerId: controllerId })
    autoAddStripOnHandoffAccept(slewTarget.unitId)
    return ok()
  }

  err('INVALID HANDOFF STATE')
}

export function HND_OFF_ACCEPT_NEAR() {
  // Accept the handoff nearest range rings center (simplification: first incoming)
  const { handoffs, claimTrack, clearHandoff } = getAtc()
  const controllerId = getMyControllerId()
  for (const [id, ho] of Object.entries(handoffs)) {
    if (ho.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
      claimTrack(id, controllerId)
      clearHandoff(id)
      sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: id, fromControllerId: ho.from, toControllerId: controllerId })
      autoAddStripOnHandoffAccept(id)
      return ok()
    }
  }
  err('NO INCOMING HANDOFF')
}

export function POINT_OUT({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const tcp = captures?.tcp
  if (!tcp) return err('ILL POS')
  const controllerId = getMyControllerId()
  if (tcp === controllerId) return err('ILL POS')
  const knownIds = new Set(Object.values(useControllersStore.getState().registry).map((e) => e.controllerId).filter(Boolean))
  if (!knownIds.has(tcp)) return err('ILL POS')
  getAtc().setPointOut(slewTarget.unitId, { state: POINTOUT_STATE.SENT, from: controllerId, to: tcp })
  sendWebrtcEvent('POINT_OUT_SENT', { unitId: slewTarget.unitId, fromControllerId: controllerId, toControllerId: tcp })
  ok()
}

export function REJECT_POINT_OUT({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const controllerId = getMyControllerId()
  const po = getAtc().pointOuts[slewTarget.unitId]
  if (po?.state !== POINTOUT_STATE.RECEIVING || po.to !== controllerId) return err('ILL TRK')
  getAtc().clearPointOut(slewTarget.unitId)
  sendWebrtcEvent('POINT_OUT_REJECTED', { unitId: slewTarget.unitId, fromControllerId: po.from, toControllerId: controllerId })
  ok()
}

export function CONVERT_POINT_OUT({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { pointOuts, clearPointOut, claimTrack } = getAtc()
  const controllerId = getMyControllerId()
  const po = pointOuts[slewTarget.unitId]
  if (po?.state !== POINTOUT_STATE.RECEIVING || po.to !== controllerId) return err('ILL TRK')
  clearPointOut(slewTarget.unitId)
  claimTrack(slewTarget.unitId, controllerId)
  sendWebrtcEvent('POINT_OUT_CONVERTED', { unitId: slewTarget.unitId, fromControllerId: po.from, toControllerId: controllerId })
  ok()
}

export function SET_SP1({ captures, slewTarget }) {
  const target = targetOf({ slewTarget, captures })
  if (!target) return err(captures?.flid ? 'ILL FLID' : 'NO TARGET')
  if (getAtc().ownership[target.unitId] !== getMyControllerId()) return err('ILL TRK')
  const sp = captures?.sp ?? ''
  getAtc().setScratchpad(target.unitId, 'sp1', sp)
  ok()
}

export function CLEAR_SP1({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  if (getAtc().ownership[slewTarget.unitId] !== getMyControllerId()) return err('ILL TRK')
  getAtc().setScratchpad(slewTarget.unitId, 'sp1', '')
  ok()
}

export function SET_SP2({ captures, slewTarget }) {
  const target = targetOf({ slewTarget, captures })
  if (!target) return err(captures?.flid ? 'ILL FLID' : 'NO TARGET')
  if (getAtc().ownership[target.unitId] !== getMyControllerId()) return err('ILL TRK')
  const sp = captures?.sp ?? ''
  getAtc().setScratchpad(target.unitId, 'sp2', sp)
  ok()
}

export function CLEAR_SP2({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  if (getAtc().ownership[slewTarget.unitId] !== getMyControllerId()) return err('ILL TRK')
  getAtc().setScratchpad(slewTarget.unitId, 'sp2', '')
  ok()
}

export function SET_LEADER_SHORT({ captures, slewTarget, windowId }) {
  if (!slewTarget) return err('NO TARGET')
  const wid = windowId ?? WINDOW_ID
  const dir = captures.dir
  const current = getDisplay().windows[wid]?.leaderDirs ?? {}
  if (dir === '5') {
    const next = { ...current }
    delete next[slewTarget.unitId]
    getDisplay().updateWindow(wid, { leaderDirs: next })
  } else {
    getDisplay().updateWindow(wid, { leaderDirs: { ...current, [slewTarget.unitId]: dir } })
  }
  ok()
}

export function SET_LEADER_MF({ captures, slewTarget, windowId }) {
  return SET_LEADER_SHORT({ captures, slewTarget, windowId })
}

export function SET_LEADER_GLOBAL({ captures, windowId }) {
  const dir = captures.dir
  getDisplay().updateWindow(windowId ?? WINDOW_ID, { globalLeaderDir: dir === '5' ? null : dir })
  ok()
}

// MF R + SLEW — per-track PTL, drawn regardless of the DCB's PTL OWN/ALL
// mode (see drawContacts.js).
export function TOGGLE_PTL({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const current = getAtc().scratchpads[slewTarget.unitId]?._ptl ?? false
  getAtc().setScratchpad(slewTarget.unitId, '_ptl', !current)
  ok()
}

// LD (0-7) + ENTER — same window setting as the DCB LDR LEN spinner.
export function SET_LEADER_LEN({ captures, windowId }) {
  getDisplay().updateWindow(windowId ?? WINDOW_ID, { ldrLength: parseInt(captures.len, 10) })
  ok()
}

// +(###) + SLEW — temporary assigned altitude, shown as A### on FDB line 3.
// +000 clears it.
export function SET_ALT_ASSIGNED({ captures, slewTarget }) {
  const target = targetOf({ slewTarget, captures })
  if (!target) return err(captures?.flid ? 'ILL FLID' : 'NO TARGET')
  if (getAtc().ownership[target.unitId] !== getMyControllerId()) return err('ILL TRK')
  const alt = captures.alt
  getAtc().setScratchpad(target.unitId, 'tempAlt', alt === '000' ? '' : alt)
  ok()
}

// ++(###) + SLEW — amend the linked flight plan's requested (filed)
// altitude. altAmended drives the time-shared R### on FDB line 2.
// Also MF M(###) + SLEW and MF M<FLID> (###) + ENTER; the FLID form works on
// a plan with no track yet.
export function SET_ALT_REQUESTED({ captures, slewTarget }) {
  const fps = useFlightPlansStore.getState()
  let aid
  if (!slewTarget && captures?.flid) {
    const r = resolveFlid(captures.flid)
    if (!r.aid) return err('NO FLIGHT PLAN')
    if (r.unitId && getAtc().ownership[r.unitId] !== getMyControllerId()) return err('ILL TRK')
    aid = r.aid
  } else {
    if (!slewTarget) return err('NO TARGET')
    if (getAtc().ownership[slewTarget.unitId] !== getMyControllerId()) return err('ILL TRK')
    aid = findFlightPlanAid(slewTarget.unit, fps.plans)
  }
  if (!aid || !fps.plans[aid]) return err('NO FLIGHT PLAN')
  fps.amend(aid, { alt: captures.alt, altAmended: true })
  useStripsStore.getState().setHighlight(aid, STRIP_HIGHLIGHT.AMENDED)
  sendWebrtcEvent('FLIGHT_PLAN_AMEND', useFlightPlansStore.getState().plans[aid])
  ok()
}

// MF M(####) + SLEW / MF M<FLID> (####) + ENTER — assign a specific beacon
// code to the flight plan. The FLID form works on a plan with no track yet.
export function SET_BEACON({ captures, slewTarget }) {
  const fps = useFlightPlansStore.getState()
  if (slewTarget && getAtc().ownership[slewTarget.unitId] !== getMyControllerId()) return err('ILL TRK')
  const aid = slewTarget
    ? findFlightPlanAid(slewTarget.unit, fps.plans)
    : resolveFlid(captures?.flid).aid
  if (!aid || !fps.plans[aid]) return err('NO FLIGHT PLAN')
  const bcn = captures.bcn
  if (Object.values(fps.plans).some((p) => p.aid !== aid && p.bcn === bcn)) return err('DUP BCN')
  fps.amend(aid, { bcn })
  useStripsStore.getState().setHighlight(aid, STRIP_HIGHLIGHT.AMENDED)
  sendWebrtcEvent('FLIGHT_PLAN_AMEND', useFlightPlansStore.getState().plans[aid])
  ok()
}

// MF D + SLEW / MF D<FLID> + ENTER — flight plan readout in the preview area.
export function SHOW_FP({ captures, slewTarget }) {
  const plans = useFlightPlansStore.getState().plans
  const aid = slewTarget
    ? findFlightPlanAid(slewTarget.unit, plans)
    : resolveFlid(captures?.flid).aid
  const p = aid ? plans[aid] : null
  if (!p) return err('NO FLIGHT PLAN')
  const typ   = [p.typ, p.eq].filter(Boolean).join('/')
  const route = p.dep || p.dest ? `${p.dep ?? ''}-${p.dest ?? ''}` : ''
  usePreviewStore.getState().showInfo(
    [p.aid, typ, p.bcn, p.alt, route, p.flightRules].filter(Boolean).join(' ')
  )
}

// CA K + SLEW / CA K <FLID> + ENTER — toggle conflict alerts for one track.
export function CA_INHIBIT({ captures, slewTarget }) {
  const target = targetOf({ slewTarget, captures })
  if (!target) return err(captures?.flid ? 'ILL FLID' : 'NO TARGET')
  getAtc().toggleCaInhibit(target.unitId)
  const inhibited = !!getAtc().caInhibited[target.unitId]
  usePreviewStore.getState().showInfo(inhibited ? 'CA INHIBITED' : 'CA ENABLED')
}

// Create a flight plan, or amend it if the AID already exists — same
// create/amend + broadcast flow as the FPE's handleAmend. Shows the AID and
// (possibly auto-assigned) beacon code in the preview area.
function createOrAmendPlan(aid, fields) {
  const fps = useFlightPlansStore.getState()
  if (fields.bcn && Object.values(fps.plans).some((p) => p.aid !== aid && p.bcn === fields.bcn)) {
    return err('DUP BCN')
  }
  if (fps.plans[aid]) {
    fps.amend(aid, fields)
    useStripsStore.getState().setHighlight(aid, STRIP_HIGHLIGHT.AMENDED)
    sendWebrtcEvent('FLIGHT_PLAN_AMEND', useFlightPlansStore.getState().plans[aid])
  } else {
    // New plans from these commands are VFR unless the entry says otherwise.
    fps.add({ aid, source: 'manual', flightRules: 'VFR', ...fields })
    useStripsStore.getState().addStrip(aid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED })
    sendWebrtcEvent('FLIGHT_PLAN_CREATE', useFlightPlansStore.getState().plans[aid])
  }
  const plan = useFlightPlansStore.getState().plans[aid]
  usePreviewStore.getState().showInfo(`${aid} ${plan?.bcn ?? ''}`.trim())
}

const splitFields = (rest) => (rest ?? '').trim().split(/\s+/).filter(Boolean)

// FLT DATA (F6) <AID>(OPTIONAL FIELDS) + ENTER — abbreviated flight plan.
export function CREATE_FP_ABBREV({ captures }) {
  const fields = parseAbbreviatedFields(splitFields(captures.rest))
  if (!fields) return err('FORMAT')
  createOrAmendPlan(captures.aid, fields)
}

// VFR PLAN (F9) <AID> [DEP*] DEST TYPE[/EQ] [###] + ENTER.
export function CREATE_VFR_FP({ captures }) {
  const fields = parseVfrFields(splitFields(captures.rest))
  if (!fields) return err('FORMAT')
  createOrAmendPlan(captures.aid, fields)
}

// Implied form: <AID>(fields) + ENTER with no function key. Command verbs
// are never AIDs; FLT DATA fields are tried before VFR PLAN fields.
export function CREATE_FP_IMPLIED({ captures }) {
  if (WORD_VERBS.includes(captures.aid)) return err('FORMAT')
  const tokens = splitFields(captures.rest)
  const fields = parseAbbreviatedFields(tokens) ?? parseVfrFields(tokens)
  if (!fields) return err('INVALID INPUT')
  createOrAmendPlan(captures.aid, fields)
}

// .CENTER + ENTER / Ctrl+F1 — back to the scope's original center, same as
// the DCB's OFF CNTR.
export function RECENTER({ windowId }) {
  recenterScope(windowId ?? WINDOW_ID)
  ok()
}

export function recenterScope(windowId) {
  const win = getDisplay().windows[windowId]
  getDisplay().updateWindow(windowId, {
    centerLat: win?.homeCenterLat ?? 0,
    centerLng: win?.homeCenterLng ?? 0,
    offCntr:   false,
  })
}

// ── Minimum separation ────────────────────────────────────────────────────────

export function MIN_INIT({ slewTarget }) {
  if (!slewTarget) return err('NO TRACK')
  getDisplay().updateWindow(WINDOW_ID, {
    pendingAction: 'MIN_P2',
    minWip: { ac0: String(slewTarget.unitId) },
  })
  ok()
}

export function MIN_CLEAR() {
  getDisplay().updateWindow(WINDOW_ID, { minSep: null, minWip: null, pendingAction: null })
  ok()
}

// ── Manual wingman pairing ──────────────────────────────────────────────────
// .WNG + click lead + click wingman — see StarsScope.jsx's WNG_P2 handling,
// which completes the pairing on the second click (toggling that unit's
// entry in windowSettings.manualWingmen).
export function WNG_PAIR_INIT({ slewTarget }) {
  if (!slewTarget) return err('NO TRACK')
  getDisplay().updateWindow(WINDOW_ID, {
    pendingAction: 'WNG_P2',
    wngWip: { leadId: String(slewTarget.unitId) },
  })
  ok()
}

// ── Range bearing line ────────────────────────────────────────────────────────

export function RBL_INIT({ slewTarget, canvasLatLng }) {
  const p0 = slewTarget
    ? { unitId: String(slewTarget.unitId) }
    : canvasLatLng
      ? { lat: canvasLatLng.lat, lng: canvasLatLng.lng }
      : null
  if (!p0) return err('NO POSITION')
  getDisplay().updateWindow(WINDOW_ID, { pendingAction: 'RBL_P2', rblWip: { p0 } })
  ok()
}

export function RBL_CLEAR_ALL() {
  getDisplay().updateWindow(WINDOW_ID, { rbls: [], rblWip: null, pendingAction: null })
  ok()
}

export function RBL_CLEAR_N({ captures }) {
  const n = parseInt(captures.n, 10)
  const win = getDisplay().windows[WINDOW_ID]
  const rbls = win?.rbls ?? []
  if (n < 1 || n > rbls.length) return err('INVALID')
  getDisplay().updateWindow(WINDOW_ID, { rbls: rbls.filter((_, i) => i !== n - 1) })
  ok()
}

export function SET_ALTIM({ captures }) {
  const raw = captures.value
  let display
  if (raw.includes('.')) {
    const val = parseFloat(raw)
    if (val < 26 || val > 32) return err('FORMAT')
    display = val.toFixed(2)
  } else {
    const n = parseInt(raw, 10)
    if (n >= 2000) {
      const val = n / 100
      if (val < 26 || val > 32) return err('FORMAT')
      display = val.toFixed(2)
    } else {
      if (n < 800 || n > 1100) return err('FORMAT')
      display = String(n)
    }
  }
  getDisplay().updateWindow(WINDOW_ID, { qnh: display })
  ok()
}

export function SET_ATIS({ captures }) {
  getDisplay().updateWindow(WINDOW_ID, { atis: captures.atis })
  ok()
}

export function SET_ATIS_GI({ captures }) {
  getDisplay().updateWindow(WINDOW_ID, { atis: captures.atis, giText: captures.giText })
  ok()
}

// MF S* — delete the ATIS code, keep GI text
export function CLEAR_ATIS() {
  getDisplay().updateWindow(WINDOW_ID, { atis: null })
  ok()
}

// MF S*(GI TEXT) — delete the ATIS code, set GI line 1
export function CLEAR_ATIS_SET_GI({ captures }) {
  getDisplay().updateWindow(WINDOW_ID, { atis: null, giText: captures.giText })
  ok()
}

// MF S(ATIS)* — set the ATIS code, delete GI line 1
export function SET_ATIS_CLEAR_GI({ captures }) {
  getDisplay().updateWindow(WINDOW_ID, { atis: captures.atis, giText: null })
  ok()
}

// MF S(1-9) (GI TEXT) / MF S(1-9) — set/clear an auxiliary GI line
function setGiAux(line, text) {
  const next = [...(getDisplay().windows[WINDOW_ID]?.giAux ?? [])]
  next[Number(line) - 1] = text
  getDisplay().updateWindow(WINDOW_ID, { giAux: next })
  ok()
}
export function SET_GI_AUX({ captures })   { setGiAux(captures.line, captures.text) }
export function CLEAR_GI_AUX({ captures }) { setGiAux(captures.line, null) }

export function CLEAR_ATIS_GI() {
  getDisplay().updateWindow(WINDOW_ID, { atis: null, giText: null })
  ok()
}

// ── Altitude filters (Table 29) ─────────────────────────────────────────────
// Values are hundreds of feet (3-digit STARS convention, e.g. "001" = 100ft).
// U = unassociated tracks, A = associated tracks. Persisted locally like other
// facility-wide display settings, and applied live to which tracks draw on
// scope (see the filteredUnits memo in StarsScope.jsx).
function fmtAltFilterPair(lo, hi) {
  return `${String(lo).padStart(3, '0')} ${String(hi).padStart(3, '0')}`
}

export function SHOW_ALT_FILTER() {
  const win = getDisplay().windows[WINDOW_ID]
  const loU = win?.altFilterLowU ?? 1,   hiU = win?.altFilterHighU ?? 600
  const loA = win?.altFilterLowA ?? 1,   hiA = win?.altFilterHighA ?? 600
  usePreviewStore.getState().showInfo(
    `${fmtAltFilterPair(loU, hiU)}\n${fmtAltFilterPair(loA, hiA)}`
  )
}

export function SET_ALT_FILTER({ captures }) {
  const loU = parseInt(captures.loU, 10), hiU = parseInt(captures.hiU, 10)
  const loA = parseInt(captures.loA, 10), hiA = parseInt(captures.hiA, 10)
  if (loU > hiU || loA > hiA) return err('FORMAT')
  const patch = { altFilterLowU: loU, altFilterHighU: hiU, altFilterLowA: loA, altFilterHighA: hiA }
  getDisplay().updateWindow(WINDOW_ID, patch)
  saveStarsPrefs(patch)
  ok()
}

export function SET_ALT_FILTER_ASSOC({ captures }) {
  const loA = parseInt(captures.loA, 10), hiA = parseInt(captures.hiA, 10)
  if (loA > hiA) return err('FORMAT')
  const patch = { altFilterLowA: loA, altFilterHighA: hiA }
  getDisplay().updateWindow(WINDOW_ID, patch)
  saveStarsPrefs(patch)
  ok()
}

export function SET_RANGE({ captures }) {
  const range = parseInt(captures.range, 10)
  if (range < 6 || range > 256) return err('INVALID RANGE')
  getDisplay().updateWindow(WINDOW_ID, { rangeNm: range })
  ok()
}

export function SET_RNG_RING({ captures }) {
  const spacing = parseInt(captures.spacing, 10)
  getDisplay().updateWindow(WINDOW_ID, { ringSpacingNm: spacing })
  ok()
}

export function RELOCATE_PREVIEW({ canvasPos }) {
  if (!canvasPos) return err('NO POSITION')
  usePreviewStore.getState().setPosition(canvasPos)
  ok()
}

export function QUICK_LOOK_TCP({ captures: _captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  // TODO: implement quicklook
  ok()
}

export function QUICK_LOOK_ALL() {
  // TODO
  ok()
}

export function BARE_SLEW({ slewTarget }) {
  if (!slewTarget) return clearBuffer()

  const { handoffs, pointOuts } = getAtc()
  const id = slewTarget.unitId
  const ho = handoffs[id]
  const po = pointOuts[id]
  const controllerId = getMyControllerId()

  // Incoming handoff to accept
  if (ho?.state === HANDOFF_STATE.RECEIVING && ho.to === controllerId) {
    getAtc().claimTrack(id, controllerId)
    getAtc().clearHandoff(id)
    sendWebrtcEvent('HANDOFF_ACCEPTED', { unitId: id, fromControllerId: ho.from, toControllerId: controllerId })
    autoAddStripOnHandoffAccept(id)
    return ok()
  }

  // Outgoing handoff to recall
  if (ho?.state === HANDOFF_STATE.INITIATED && ho.from === controllerId) {
    getAtc().clearHandoff(id)
    sendWebrtcEvent('HANDOFF_RECALLED', { unitId: id, fromControllerId: controllerId, toControllerId: ho.to })
    return ok()
  }

  // Outgoing point out to recall
  if (po?.state === POINTOUT_STATE.SENT && po.from === controllerId) {
    getAtc().clearPointOut(id)
    sendWebrtcEvent('POINT_OUT_RECALLED', { unitId: id, fromControllerId: controllerId, toControllerId: po.to })
    return ok()
  }

  // Incoming point out to acknowledge
  if (po?.state === POINTOUT_STATE.RECEIVING && po.to === controllerId) {
    getAtc().clearPointOut(id)
    sendWebrtcEvent('POINT_OUT_ACCEPTED', { unitId: id, fromControllerId: po.from, toControllerId: controllerId })
    return ok()
  }

  // Rejected point out — sender dismisses the UN indicator
  if (po?.state === POINTOUT_STATE.REJECTED && po.from === controllerId) {
    getAtc().clearPointOut(id)
    return ok()
  }

  // Otherwise: clear buffer (more behaviors will be added — PTL toggle, FDB query, etc.)
  clearBuffer()
}

// ── Callsign rename ───────────────────────────────────────────────────────────

export function RENAME_CALLSIGN({ captures, slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const newCallsign = captures?.newCallsign?.trim().toUpperCase()
  if (!newCallsign) return err('NO CALLSIGN')
  const { oldCallsign } = applyCallsignChange(slewTarget.unitId, slewTarget.unit, newCallsign)
  sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(slewTarget.unitId), oldCallsign, newCallsign })
  ok()
}

export function RESET_CALLSIGN({ slewTarget }) {
  if (!slewTarget) return err('NO TARGET')
  const { oldCallsign } = applyCallsignChange(slewTarget.unitId, slewTarget.unit, null)
  sendWebrtcSessionEvent('CALLSIGN_RENAME', { unitId: String(slewTarget.unitId), oldCallsign, newCallsign: null })
  ok()
}

// ── List management helpers ───────────────────────────────────────────────────

function toggleList(listId) {
  const win = getDisplay().windows[WINDOW_ID]
  const current = win?.lists?.[listId]?.visible ?? true
  getDisplay().updateList(WINDOW_ID, listId, { visible: !current })
  ok()
}

function relocateList(listId, canvasPos, canvasSize) {
  if (!canvasPos || !canvasSize?.w) return err('NO POSITION')
  const xPct = (canvasPos.x / canvasSize.w) * 100
  const yPct = (canvasPos.y / canvasSize.h) * 100
  getDisplay().updateList(WINDOW_ID, listId, { xPct, yPct })
  ok()
}

function resizeList(listId, lines) {
  const n = parseInt(lines, 10)
  if (isNaN(n) || n < 1 || n > 100) return err('INVALID SIZE')
  getDisplay().updateList(WINDOW_ID, listId, { lines: n })
  ok()
}

// ── List actions ──────────────────────────────────────────────────────────────

export function RELOCATE_SSA({ canvasPos, canvasSize }) {
  relocateList('ssa', canvasPos, canvasSize)
}

export function TOGGLE_SIGNON()                        { toggleList('signOn') }
export function RELOCATE_SIGNON({ canvasPos, canvasSize }) {
  relocateList('signOn', canvasPos, canvasSize)
}

export function TOGGLE_TAB()                           { toggleList('tab') }
export function RELOCATE_TAB({ canvasPos, canvasSize })  { relocateList('tab', canvasPos, canvasSize) }
export function RESIZE_TAB({ captures })                 { resizeList('tab', captures.lines) }

export function TOGGLE_TOWER({ captures }) {
  const id = `tower${captures.idx}`
  toggleList(id)
}
export function RELOCATE_TOWER({ captures, canvasPos, canvasSize }) {
  relocateList(`tower${captures.idx}`, canvasPos, canvasSize)
}
export function RESIZE_TOWER({ captures }) {
  resizeList(`tower${captures.idx}`, captures.lines)
}

export function TOGGLE_COAST()                           { toggleList('coast') }
export function RELOCATE_COAST({ canvasPos, canvasSize }) { relocateList('coast', canvasPos, canvasSize) }
export function RESIZE_COAST({ captures })                { resizeList('coast', captures.lines) }

export function TOGGLE_ALERT()                           { toggleList('alert') }
export function RELOCATE_ALERT({ canvasPos, canvasSize }) { relocateList('alert', canvasPos, canvasSize) }

export function TOGGLE_VFR()                             { toggleList('vfr') }
export function RELOCATE_VFR({ canvasPos, canvasSize })  { relocateList('vfr', canvasPos, canvasSize) }
export function RESIZE_VFR({ captures })                 { resizeList('vfr', captures.lines) }

// ── Airspace color palette ────────────────────────────────────────────────────

export async function SET_ASP_COLORS({ captures, windowId }) {
  const name = captures.name.trim().toUpperCase()
  await useMapsStore.getState().refreshPalettes()
  const palettes = useMapsStore.getState().palettes
  const idx      = palettes.findIndex(p => p.name.toUpperCase() === name)
  if (idx < 0) return err('INVALID')
  getDisplay().updateWindow(windowId ?? WINDOW_ID, { aspColorIdx: idx })
  ok()
}

export async function REFRESH_ASP_COLORS() {
  const success = await useMapsStore.getState().refreshPalettes()
  if (success) ok()
  else err('REFRESH FAILED')
}

// ── Debug ─────────────────────────────────────────────────────────────────────

export function TOGGLE_COORDS() {
  const win = getDisplay().windows[WINDOW_ID]
  getDisplay().updateWindow(WINDOW_ID, { coordsVisible: !(win?.coordsVisible ?? false) })
  ok()
}

// Datablock collision avoidance — shared algorithm w/ CATCC/ABM, see
// utils/datablockPlacement.js. Off by default for STARS, persisted locally.
export function TOGGLE_DBCA() {
  const win  = getDisplay().windows[WINDOW_ID]
  const next = !(win?.dbca ?? false)
  getDisplay().updateWindow(WINDOW_ID, { dbca: next })
  saveStarsPrefs({ dbca: next })
  ok()
}

// Airspace polygon fill — shared CATCC/ABM concept (drawAbmAirspace.js), here
// against drawMaps.js's polygonFill pass. `.fill` toggles on/off remembering
// the last percentage; `.fill <n>` sets the percentage and always turns it on.
export function TOGGLE_FILL() {
  const win  = getDisplay().windows[WINDOW_ID]
  const next = !(win?.fillVisible ?? false)
  getDisplay().updateWindow(WINDOW_ID, { fillVisible: next })
  saveStarsPrefs({ fillVisible: next })
  ok()
}

export function SET_FILL({ captures }) {
  const pct = parseInt(captures?.pct, 10)
  if (isNaN(pct) || pct < 1 || pct > 100) return err('ILL VAL')
  getDisplay().updateWindow(WINDOW_ID, { fillVisible: true, fillPct: pct })
  saveStarsPrefs({ fillVisible: true, fillPct: pct })
  ok()
}

// .LABELSIZE [0-5] — text-command alias for the CHAR SIZE > MAP DCB spinner (csMap)
export function SHOW_LABELSIZE() {
  const win = getDisplay().windows[WINDOW_ID]
  usePreviewStore.getState().showInfo(`LABELSIZE: ${win?.csMap ?? 2}`)
}

export function SET_LABELSIZE({ captures }) {
  const n = parseInt(captures?.n, 10)
  if (isNaN(n) || n < 0 || n > 5) return err('ILL VAL')
  getDisplay().updateWindow(WINDOW_ID, { csMap: n })
  ok()
}

// Conflict alert (STCA) processing on/off — facility-wide, persisted locally.
export function TOGGLE_STCA() {
  const win  = getDisplay().windows[WINDOW_ID]
  const next = !(win?.stcaEnabled ?? false)
  getDisplay().updateWindow(WINDOW_ID, { stcaEnabled: next })
  saveStarsPrefs({ stcaEnabled: next })
  ok()
}

// Simulated squawk-standby wingmen — only the flight lead of each DCS group
// gets a real datablock; see modules/atc/stars/stca/formations.js.
export function TOGGLE_WINGMEN() {
  const win  = getDisplay().windows[WINDOW_ID]
  const next = !(win?.simWingmenStandby ?? false)
  getDisplay().updateWindow(WINDOW_ID, { simWingmenStandby: next })
  saveStarsPrefs({ simWingmenStandby: next })
  ok()
}

// ── Find fix / navaid / airport ───────────────────────────────────────────────

export function FIND_FIX({ captures }) {
  const result = useNavdataStore.getState().lookupFix(captures?.query)
  if (!result) return err(navdataNotFound())
  getDisplay().updateWindow(WINDOW_ID, { findMarker: result })
  ok()
}

export function RBL_INIT_FIX({ captures }) {
  const result = useNavdataStore.getState().lookupFix(captures?.query)
  if (!result) return err(navdataNotFound())
  getDisplay().updateWindow(WINDOW_ID, {
    pendingAction: 'RBL_P2',
    rblWip: { p0: { lat: result.lat, lng: result.lon } },
  })
  ok()
}

// .FIX <name...> — force-show specific fixes regardless of the FIXES DCB
// toggle (store/fixes.js). Each name toggles independently and is persisted
// per-theatre (store/starsPrefs.js), same override CATCC/ABM's own .fix
// command gives their .fixes toggle.
export function TOGGLE_FIX({ captures }) {
  const theatre = useSessionStore.getState().mission?.mission?.theatre
  if (!theatre) return err('NO THEATRE')
  const names = (captures?.names ?? '').trim().split(/\s+/).filter(Boolean)
  if (!names.length) return err('ILL VAL')
  // Pinning only affects rendering of store/navdata.js's `fixes` layer (see
  // StarsScope.jsx pinnedIds filter), so validate against that list rather
  // than lookupFix's broader fix/navaid/runway/airport search — a navaid or
  // airport name would resolve there but never actually draw as pinned.
  const knownIds = new Set(useNavdataStore.getState().fixes.map(f => f.id.toUpperCase()))
  const notFound = names.filter(n => !knownIds.has(n))
  if (notFound.length) return err(navdataNotFound(`${notFound.join(' ')} NOT FOUND`))
  const win      = getDisplay().windows[WINDOW_ID]
  const byTheatre = win?.pinnedFixes ?? {}
  const current  = new Set(byTheatre[theatre] ?? [])
  for (const name of names) {
    if (current.has(name)) current.delete(name)
    else current.add(name)
  }
  const merged = { ...byTheatre, [theatre]: [...current] }
  getDisplay().updateWindow(WINDOW_ID, { pinnedFixes: merged })
  saveStarsPrefs({ pinnedFixes: merged })
  ok()
}

// .FIX with no argument — clears all pinned fixes for this theatre.
export function CLEAR_FIX() {
  const theatre = useSessionStore.getState().mission?.mission?.theatre
  if (!theatre) return err('NO THEATRE')
  const win      = getDisplay().windows[WINDOW_ID]
  const byTheatre = win?.pinnedFixes ?? {}
  const merged = { ...byTheatre, [theatre]: [] }
  getDisplay().updateWindow(WINDOW_ID, { pinnedFixes: merged })
  saveStarsPrefs({ pinnedFixes: merged })
  ok()
}

// .LABELS/.LBL/.LABEL — toggles the LBL DCB MAP button (store/maps.js
// visible.lbl), same store-driven persistence useMapsStore.toggleMap already
// gives every other map-category toggle.
export function TOGGLE_LABELS() {
  useMapsStore.getState().toggleMap('lbl')
  ok()
}

// .FIXES — same theatre fix-points layer as the FIXES DCB button
// (store/fixes.js), just reachable from the command line like CATCC/ABM's
// own .fixes/.FIXES commands.
export function TOGGLE_FIXES() {
  useFixesStore.getState().toggleVisible()
  ok()
}

// ── Airspace category bulk toggles ────────────────────────────────────────────
// CATCC/ABM keep one flat `asVisible[displayCategory]` boolean per category, so
// .tma/.ctr/etc there is a single flip. STARS' MAPS DCB (store/maps.js) instead
// assigns each category's features to one or more discrete map-slot indices
// (main-bar + overflow, "real" envelope group + "ADJ <cat>" leftovers can both
// share the same displayCategory) — so the equivalent here has to gather every
// index for that category and flip them together, same any-on/all-off bulk
// convention CATCC's .ASP already uses for "every category at once".
const AIRSPACE_CMD_CATEGORY = {
  TMA: 'TMA', CTR: 'CTR', CTA: 'CTA', FIR: 'FIR', UIR: 'UIR',
  SUA: 'SUA', MIL: 'MIL', TRSA: 'TRSA',
  CLASSA: 'CLASS A', CLASSB: 'CLASS B', CLASSC: 'CLASS C', CLASSD: 'CLASS D',
  CLASSE: 'CLASS E', CLASSF: 'CLASS F', CLASSG: 'CLASS G',
}

function mapIndicesForCategory(cat) {
  const { maps } = useMapsStore.getState()
  const indices = []
  maps.forEach((m, i) => { if (m?.displayCategory === cat) indices.push(i) })
  return indices
}

// Every non-null slot in `maps` is itself an airspace category group (MVA
// occupies its own null gap in the array, outside this scheme entirely), so
// "every category" is just every populated index.
function allAirspaceIndices() {
  const { maps } = useMapsStore.getState()
  const indices = []
  maps.forEach((m, i) => { if (m != null) indices.push(i) })
  return indices
}

function toggleMapIndices(indices) {
  const { visible } = useMapsStore.getState()
  const anyOn = indices.some((i) => visible[i])
  const next  = { ...visible }
  for (const i of indices) next[i] = !anyOn
  useMapsStore.getState().setVisible(next)
}

export function TOGGLE_AIRSPACE_CAT({ captures }) {
  const cat = AIRSPACE_CMD_CATEGORY[captures?.cat]
  const indices = cat ? mapIndicesForCategory(cat) : []
  if (!indices.length) return err('NOT FOUND')
  toggleMapIndices(indices)
  ok()
}

export function TOGGLE_ASP() {
  const indices = allAirspaceIndices()
  if (!indices.length) return err('NOT FOUND')
  toggleMapIndices(indices)
  ok()
}

// ── MAPS submenu single-store toggles ─────────────────────────────────────────
// Same stores/buttons as Dcb.jsx's MSA/HOLDS/RELIEF/MVA toggle handling, just
// reachable from the command line.

export function TOGGLE_MSA() {
  useMsaStore.getState().toggleVisible()
  ok()
}

export function TOGGLE_HOLDS() {
  useHoldingsStore.getState().toggleVisible()
  ok()
}

export function TOGGLE_RELIEF() {
  useReliefStore.getState().toggleVisible()
  ok()
}

export function TOGGLE_MVA() {
  useMvaStore.getState().toggleVisible()
  ok()
}

// .SAT <label> — satellite flow bucket toggle (store/runways.js), same
// SAT_<label> DCB button Dcb.jsx builds per facility (labels are derived
// per-theatre from the facility's runway flow heading, e.g. "W"/"E" or
// "NW"/"SE" — not fixed, so this matches whatever's actually in satBuckets).
export function TOGGLE_SAT({ captures }) {
  const label  = captures?.label
  const bucket = useRunwaysStore.getState().satBuckets.find((b) => b.label === label)
  if (!bucket) return err('NOT FOUND')
  useRunwaysStore.getState().toggleSatBucket(label)
  ok()
}

// ── Procedure display ─────────────────────────────────────────────────────────

export function SHOW_PROC({ captures }) {
  const name = captures?.name?.trim().toUpperCase()
  if (!name) return err('INVALID')
  const { raw } = useProceduresStore.getState()
  if (!raw) return err(navdataNotFound('NO PROC DATA'))
  const found = raw.SID?.[name] || raw.STAR?.[name] || raw.APPCH?.[name]
  if (!found) return err(navdataNotFound())
  useProceduresStore.getState().toggleProc(name)
  ok()
}

export function CLEAR_PROCS() {
  useProceduresStore.getState().clearCommandProcs()
  ok()
}

// .RCLEAR — clears every route currently shown on the scope (toggled via
// Ctrl+right-click, see StarsScope.jsx's handleMouseDown). Same "hide all
// routes" convention as ABM's own .rclear (actions/index.js RCLEAR there).
export function RCLEAR() {
  getDisplay().updateWindow(WINDOW_ID, { routeDisplayedUids: [] })
  ok()
}

// ── Dispatch table ────────────────────────────────────────────────────────────

const ACTION_MAP = {
  OPEN_FPE,
  SET_ASP_COLORS,
  REFRESH_ASP_COLORS,
  TOGGLE_COORDS,
  TOGGLE_DBCA,
  TOGGLE_LABELS,
  TOGGLE_FIXES,
  TOGGLE_ASP,
  TOGGLE_AIRSPACE_CAT,
  TOGGLE_MSA,
  TOGGLE_HOLDS,
  TOGGLE_RELIEF,
  TOGGLE_MVA,
  TOGGLE_SAT,
  TOGGLE_STCA,
  TOGGLE_WINGMEN,
  TOGGLE_FILL,
  SET_FILL,
  SHOW_LABELSIZE,
  SET_LABELSIZE,
  FIND_FIX,
  TOGGLE_FIX,
  CLEAR_FIX,
  RENAME_CALLSIGN,
  RESET_CALLSIGN,
  INIT_CNTL,
  INIT_CNTL_BY_ID,
  TERM_CNTL,
  TERM_CNTL_ALL,
  HND_OFF,
  HND_OFF_SHORT: HND_OFF,
  HND_OFF_BARE,
  HND_OFF_ACCEPT_NEAR,
  POINT_OUT,
  REJECT_POINT_OUT,
  CONVERT_POINT_OUT,
  SET_SP1,       SET_SP1_MF: SET_SP1,  MF_M_SP1: SET_SP1,
  CLEAR_SP1,     CLEAR_SP1_MF: CLEAR_SP1,
  SET_SP2,       MF_M_SP2: SET_SP2,
  CLEAR_SP2,
  MF_M_TEMP_ALT: SET_ALT_ASSIGNED,
  MF_M_REQ_ALT:  SET_ALT_REQUESTED,
  SET_BEACON,
  SHOW_FP,
  CA_INHIBIT,
  CREATE_FP_ABBREV,
  CREATE_VFR_FP,
  CREATE_FP_IMPLIED,
  SET_ALT_ASSIGNED,
  SET_ALT_REQUESTED,
  SET_LEADER_LEN,
  RECENTER,
  SET_LEADER_SHORT,
  SET_LEADER_MF,
  SET_LEADER_GLOBAL,
  TOGGLE_PTL,
  SET_ALTIM,
  SET_ATIS,
  SET_ATIS_GI,
  CLEAR_ATIS_GI,
  CLEAR_ATIS,
  CLEAR_ATIS_SET_GI,
  SET_ATIS_CLEAR_GI,
  SET_GI_AUX,
  CLEAR_GI_AUX,
  SHOW_ALT_FILTER,
  SET_ALT_FILTER,
  SET_ALT_FILTER_ASSOC,
  SET_RANGE,
  SET_RNG_RING,
  RELOCATE_PREVIEW,
  QUICK_LOOK_TCP,
  QUICK_LOOK_ALL,
  BARE_SLEW,
  MIN_INIT,
  MIN_CLEAR,
  WNG_PAIR_INIT,
  RBL_INIT,
  RBL_INIT_FIX,
  RBL_CLEAR_ALL,
  RBL_CLEAR_N,
  SHOW_PROC,
  CLEAR_PROCS,
  RCLEAR,
  // List management
  RELOCATE_SSA,
  TOGGLE_SIGNON, RELOCATE_SIGNON,
  TOGGLE_TAB,    RELOCATE_TAB,    RESIZE_TAB,
  TOGGLE_TOWER,  RELOCATE_TOWER,  RESIZE_TOWER,
  TOGGLE_COAST,  RELOCATE_COAST,  RESIZE_COAST,
  TOGGLE_ALERT,  RELOCATE_ALERT,
  TOGGLE_VFR,    RELOCATE_VFR,    RESIZE_VFR,
}

/**
 * Dispatch a parsed command to its action handler.
 *
 * @param {object} parsed      { command, captures }
 * @param {object} slewTarget  { unitId, unit } | null
 * @param {object} context     { positionName, canvasPos, canvasSize }
 */
export function dispatch(parsed, slewTarget, context) {
  const handler = ACTION_MAP[parsed.command.id]
  if (!handler) {
    usePreviewStore.getState().setResponse(`UNIMPLEMENTED: ${parsed.command.id}`)
    return
  }
  handler({ captures: parsed.captures, slewTarget, ...context })
}
