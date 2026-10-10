import { memo, useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { useAtcStore, POINTOUT_STATE } from '../../../store/atc.js'
import { useStcaStore }        from '../../../store/stca.js'
import { useSessionStore }     from '../../../store/session.js'
import { useControllersStore } from '../../../store/controllers.js'
import { useDisplayStore }     from '../../../store/display.js'
import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { useAssociationStore } from '../../../store/association.js'
import { useOdsStore }         from '../../../store/ods.js'
import { useStarsAlertsStore } from '../../../store/starsAlerts.js'
import { latLngToCanvas }      from '../../../utils/projection.js'
import { resolveCallsign }     from '../../../utils/callsign.js'
import { hasLiveSquawk, normalizeCode } from '../../../utils/transponder.js'
import { spcForCode }          from '../../../utils/spc.js'
import { msawDisabledFor }     from '../../../utils/msaw.js'
import { caDisabledFor, mciSuppressedFor } from '../../../utils/conflictInhibit.js'
import { planAltDigits }       from './input/flightPlanFields.js'
import { DIR_TO_ANGLE, RIGHT_ALIGN_ANGLES, HIGHLIGHT_TEAL } from '../../../utils/scopeConstants.js'
import { placeDatablocks } from '../../../utils/datablockPlacement.js'
import { altHundreds, speedFromMs, speedTens, METRIC } from '../../../utils/units.js'

const WINDOW_ID        = 'atc-main'
// SVG text isn't measured against a canvas context here, so estimate width
// from Roboto Mono's monospace advance instead of ctx.measureText.
const MONO_CHAR_RATIO  = 0.6

const DEFAULT_SEQUENCE  = [1, 2, 1, 3]
const DEFAULT_INTERVALS = [3, 2, 3, 2]

// Safety alert (line 0) colors — blinks bright/dim red while
// unacknowledged, solid red once acked.
const ALERT_BRIGHT = '#FF3333'
const ALERT_DIM    = '#7A1A1A'
// Selected beacon code display (** + code) flashes yellow
const WARN_BRIGHT  = '#FFFF00'
const WARN_DIM     = '#808000'

const CA_INHIBIT_MARK = '▲' // triangle

const EMPTY_OBJECT  = {}

// ── Formatting ───────────────────────────────────────────────────────────────

// sys: the ATC unit system (view.unitSystem) — hundreds of ft/m, tens of
// kt/kmh. The 99 speed cap is imperial-only: tens of km/h passes 99 at
// ordinary jet speeds (1000 km/h ≈ 540 kt), so metric grows to 3 digits.
function fmtAlt(metres, sys) {
  if (metres == null) return '   '
  return altHundreds(metres, sys)
}

function fmtSpd(mps, sys) {
  if (mps == null) return '  '
  if (sys === METRIC) return speedTens(mps, sys)
  const tens = Math.round(speedFromMs(mps, sys) / 10)
  return String(Math.min(tens, 99)).padStart(2, '0')
}

// ── Clock phase ──────────────────────────────────────────────────────────────

function getClockPhase(sequence, intervals) {
  const totalMs = intervals.reduce((acc, d) => acc + d * 1000, 0)
  if (totalMs <= 0) return 1
  const posMs = Date.now() % totalMs
  let elapsed = 0
  for (let i = 0; i < intervals.length; i++) {
    elapsed += intervals[i] * 1000
    if (posMs < elapsed) return sequence[i]
  }
  return sequence[0]
}

// ── Datablock type ───────────────────────────────────────────────────────────

// assoc — true unless the unit is srsCapable and genuinely unassociated.
// Always true for non-srsCapable units, which preserves the !owner-only LDB
// behavior
// exactly — this only adds a new way to land on LDB, it never removes the
// old one.
function resolveDbType(uid, ownership, handoffs, pointOuts, quickLook, displayFdb, myId, assoc = true) {
  const owner = ownership[uid]
  if (!owner || !assoc) return 'LDB'
  if (owner === myId) return 'FDB'
  if (handoffs[uid]?.to === myId) return 'FDB'
  if (displayFdb[uid]) return 'FDB'
  if (pointOuts[uid]?.to === myId) return 'FDB'
  if (pointOuts[uid]?.from === myId) return 'FDB'
  if (quickLook.has(uid)) return 'FDB'
  return 'PDB'
}

// ── Handoff indicator ────────────────────────────────────────────────────────

function idLetter(id) {
  return id?.match(/[A-Z]/)?.[0] ?? '?'
}

function resolveHandoffId(uid, handoffs, myId) {
  const ho = handoffs[uid]
  if (!ho) return ' '
  if (ho.to === myId && ho.from) return idLetter(ho.from)
  if (ho.from === myId && ho.to) return idLetter(ho.to)
  return ' '
}

// The other position in a pending handoff, shown in full on FDB line 2
// during clock phase 3.
function resolveHandoffTcp(uid, handoffs, myId) {
  const ho = handoffs[uid]
  if (!ho) return ''
  if (ho.to === myId) return ho.from ?? ''
  return ho.to ?? ''
}

// ── Datablock content ────────────────────────────────────────────────────────
// A datablock is an optional alert line (line 0, drawn above the leader
// attach point) plus text lines. Each line is a list of segments:
//   { t: text, blink?: 'opacity' | 'warn', alert?: { acked } }
// 'opacity' blinks the segment's own opacity (IDENT, flashing codes),
// 'warn' blinks it yellow (selected beacon code display). The same content
// feeds both rendering and the collision-avoidance width estimate.

const seg = (t, extra) => ({ t, ...extra })
const lineText = (line) => line.map((s) => s.t).join('')

/**
 * Build one track's datablock content.
 * @returns {{ dbType, alerts: Array<{t, acked}>, lines: Array<Array<segment>>, color: 'ldb'|'pdb'|'fdb', fdbState }}
 */
function buildContent(uid, unit, S) {
  const { ownership, handoffs, pointOuts, quickLook, displayFdb, myId, scratchpads,
          plan, assoc, beaconReadout, isIdent, slewed, clockPhase, conflict,
          caInhibited, alerts, unitSystem } = S

  const live       = !!unit.srsCapable && hasLiveSquawk(unit)
  const code       = live ? normalizeCode(unit.transponder.mode3) : null
  const squawkSpc  = code ? spcForCode(code) : null
  const spcState   = alerts.spc[uid]
  const msawState  = alerts.msaw[uid]
  const msawOff    = msawDisabledFor(plan, alerts.trackMsawDisabled[uid]) || !!msawState?.inhibit
  const msawAlert  = !!msawState?.active && !msawOff
  const spcOverride = plan?.spcOverride || ''
  const selected   = !!code && alerts.selectedBeacon?.code === code

  // ── Type ──
  const rawDbType = resolveDbType(uid, ownership, handoffs, pointOuts, quickLook, displayFdb, myId, assoc)
  // An associated track with an active safety alert or special condition is
  // always a full datablock, as is every beacon track while the beaconator
  // (F1) is held.
  const forcedFdb = (beaconReadout && live) || !!conflict || !!squawkSpc || !!spcOverride || msawAlert
  const dbType = rawDbType === 'PDB' && forcedFdb ? 'FDB' : rawDbType

  const alt = fmtAlt(unit.position.alt, unitSystem)
  const gs  = fmtSpd(unit.speed, unitSystem)
  const cs  = resolveCallsign(unit).toUpperCase()
  const ident = isIdent ? [seg('ID', { blink: 'opacity' })] : []

  // ── Line 0: safety alerts and special conditions ──
  const line0 = []
  const pushAlert = (t, acked) => { if (!line0.some((a) => a.t === t)) line0.push({ t, acked }) }
  const spcAlert = () => { if (squawkSpc) pushAlert(squawkSpc, !!spcState?.acked && spcState.code === squawkSpc) }
  if (dbType === 'LDB' || dbType === 'FDB') {
    // MCI shows as CA in the datablock (the alert list keeps the MCI label)
    if (conflict?.type === 'MCI') pushAlert('CA', conflict.acked)
    spcAlert()
  }
  if (dbType === 'FDB') {
    if (msawAlert) pushAlert('LA', !!msawState.acked)
    if (spcOverride && !squawkSpc) pushAlert(spcOverride, true)  // controller-entered: steady, no flash
    if (conflict && conflict.type !== 'MCI') pushAlert(conflict.type, conflict.acked)
  }

  // ── LDB ──
  if (dbType === 'LDB') {
    if (!assoc) {
      // Unassociated: altitude only, unless something calls for the code.
      // A slew opens a full LDB for a few seconds (code, altitude + speed,
      // callsign); an SPC squawk holds it open.
      const extended = !!alerts.fullLdbUntil[uid] || !!squawkSpc
      const showCode = live && (beaconReadout || isIdent || extended || selected ||
                                alerts.ldbBeacons || !!alerts.ldbBeacon[uid])
      const lines = []
      if (showCode) lines.push([seg(code, selected ? { blink: 'warn' } : {}), ...ident])
      lines.push([seg(extended ? `${alt} ${gs}` : alt)])
      if ((extended || beaconReadout) && live) lines.push([seg(cs)])
      return { dbType, alerts: line0, lines, color: 'ldb' }
    }
    // Associated but unowned: altitude and speed, with the code above it
    // while IDENTing or under the beaconator.
    if (live && (isIdent || beaconReadout || selected)) {
      const lines = [[seg(code, selected ? { blink: 'warn' } : {}), ...ident], [seg(`${alt} ${gs}`)]]
      if (beaconReadout) lines.push([seg(cs)])
      return { dbType, alerts: line0, lines, color: 'ldb' }
    }
    return { dbType, alerts: line0, lines: [[seg(`${alt} ${gs}`), ...ident]], color: 'ldb' }
  }

  const handoffId = resolveHandoffId(uid, handoffs, myId)
  // A track's own scratchpad wins (even '' from a clear); otherwise the one
  // entered on its flight plan (FLT DATA) before the track existed.
  const sp1    = scratchpads[uid]?.sp1 ?? plan?.sp1 ?? ''
  const sp2    = scratchpads[uid]?.sp2 ?? plan?.sp2 ?? ''
  const actype = plan?.typ ?? ''
  const rules  = plan?.flightRules === 'VFR' ? 'V' : ' '
  const pad3   = (s) => s.slice(0, 3).padEnd(3)

  // Right side of line 2: ground speed, then the flight rules indicator —
  // or ID in its place while IDENTing.
  const gsRules = () => isIdent ? [seg(gs), seg('ID', { blink: 'opacity' })] : [seg(gs + rules)]

  // ── PDB ──
  if (dbType === 'PDB') {
    let left
    if (clockPhase === 3 && sp2) left = pad3(sp2) + '+'
    else if (clockPhase !== 1 && sp1) left = pad3(sp1) + handoffId
    else left = alt + handoffId
    const right = clockPhase === 2 && actype && !isIdent ? [seg(actype.slice(0, 4))] : gsRules()
    const line2 = [seg(left + ' '), ...right]
    return { dbType, alerts: line0, lines: slewed ? [[seg(cs)], line2] : [line2], color: 'pdb' }
  }

  // ── FDB ──
  // Line 1: ACID (or the code under the beaconator), inhibit marker, then
  // the point-out indicator.
  const po            = pointOuts[uid]
  const isPoReceiving = po?.state === POINTOUT_STATE.RECEIVING && po?.to   === myId
  const isPoSent      = po?.state === POINTOUT_STATE.SENT      && po?.from === myId
  const isPoRejected  = po?.state === POINTOUT_STATE.REJECTED  && po?.from === myId
  const caOff  = caDisabledFor(plan, caInhibited[uid])
  const mciSup = !!mciSuppressedFor(plan, alerts.trackMciSuppressed[uid])
  // * MSAW inhibited, + MSAW and CA inhibited, triangle CA inhibited or an
  // MCI code suppressed
  const mark = msawOff ? (caOff ? '+' : '*') : (caOff || mciSup) ? CA_INHIBIT_MARK : ''
  const poText = isPoReceiving ? 'PO' : isPoSent ? 'PO' + po.to : isPoRejected ? 'UN' : ''
  const acid = beaconReadout && live ? code : cs
  const line1 = [seg((acid + (mark || (poText ? ' ' : '')) + poText))]

  // Line 2, left: altitude / scratchpads / handoff position by clock phase.
  // An active CA or MSAW alert holds altitude in every phase.
  const altLeft = alt + handoffId
  const forceAlt = line0.some((a) => a.t === 'LA' || a.t === 'CA' || a.t === 'MCI')
  const handoffTcp = resolveHandoffTcp(uid, handoffs, myId)
  let left
  if (forceAlt || clockPhase === 1) left = altLeft
  else if (clockPhase === 2) left = sp1 ? pad3(sp1) + handoffId : sp2 ? pad3(sp2) + '+' : altLeft
  else if (clockPhase === 3) {
    left = handoffTcp ? pad3(handoffTcp) + handoffId
      : sp2 ? pad3(sp2) + '+'
      : sp1 ? pad3(sp1) + handoffId
      : altLeft
  } else left = '    '

  // Line 2, right: phase 1 speed + rules; 2 and 4 type; 3 requested
  // altitude, else type. IDENT holds speed + ID in every phase.
  const reqAlt = plan?.altAmended ? planAltDigits(plan.alt) : ''
  let right
  if (isIdent) right = gsRules()
  else if (clockPhase === 3 && reqAlt) right = [seg('R' + reqAlt)]
  else if (clockPhase !== 1 && actype) right = [seg(actype.slice(0, 4))]
  else right = gsRules()
  const line2 = [seg(left + ' '), ...right]

  // Line 3, left: the selected code (flashing), the reported code on a
  // mismatch, or DB for an unacknowledged duplicate code. Right: temporary
  // altitude, timeshared with the flashing assigned code on a mismatch.
  const assigned = plan?.bcn ? normalizeCode(plan.bcn) : null
  const mismatch = live && !!assigned && code !== assigned && !squawkSpc
  const duplicate = live && !!alerts.duplicates[code] && alerts.dupAck[uid] !== code
  const tempAlt = scratchpads[uid]?.tempAlt ?? ''
  const tempText = tempAlt ? 'A' + tempAlt : ''

  let l3left = null
  if (selected) l3left = seg(code, { blink: 'warn' })
  else if (mismatch) l3left = seg(code)
  else if (duplicate) l3left = seg('DB')

  let l3right = null
  const showAssigned = mismatch && (!tempText || clockPhase === 2 || clockPhase === 4)
  if (showAssigned) l3right = seg(assigned, { blink: 'opacity' })
  else if (tempText) l3right = seg(tempText)

  const lines = [line1, line2]
  if (l3left && l3right) lines.push([l3left, seg(' '), l3right])
  else if (l3left) lines.push([l3left])
  // A temporary altitude on its own is right-aligned under line 2 (the
  // flashing assigned code only ever appears beside a mismatch)
  else if (l3right) lines.push([seg(l3right.t.padStart(lineText(line2).length))])

  // A PDB promoted only by the beaconator keeps the PDB color: the readout
  // doesn't make the track mine.
  const promoted = rawDbType === 'PDB' && !(conflict || squawkSpc || spcOverride || msawAlert)

  return { dbType, alerts: line0, lines, color: 'fdb', isPoReceiving, isPoRejected, promoted }
}

// ── Per-unit datablock ───────────────────────────────────────────────────────

const Datablock = memo(function Datablock({
  unit, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks,
  unitLeaderDir, placement, content, isBlinking, isIncomingHo, blinkOn, isHighlighted,
  wingman,
}) {
  const pos = unit.position
  if (!pos || !content) return null

  // Simulated squawk-standby wingman — primary-only, no datablock at all.
  if (wingman) return null

  const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
  if (x < -100 || x > view.width + 100 || y < -100 || y > view.height + 100) return null

  const { colors, symbol, dataBlock } = visual

  const symR   = (symbol.diameter ?? 13) / 2
  const fontPx = 10 + (csDatablocks ?? 3) * 2
  const lh     = dataBlock.lineHeight ?? Math.round(fontPx * 1.2)
  const font   = `500 ${fontPx}px "Roboto Mono", monospace`

  // ── Leader geometry ─────────────────────────────────────────────────
  // With a placement (dbca on), placeDatablocks has resolved the direction
  // and both points, using the same geometry as the fixed-angle path below.
  const leaderLen = ldrLength ?? dataBlock.leaderLength ?? 40

  let lx0, ly0, lx1, ly1, tx, ty, anchor
  if (placement) {
    lx0 = placement.leaderStart.x; ly0 = placement.leaderStart.y
    lx1 = placement.leaderEnd.x;   ly1 = placement.leaderEnd.y
    tx  = placement.bbox.textX
    ty  = placement.bbox.ly1
    anchor = placement.bbox.align === 'right' ? 'end' : 'start'
  } else {
    const angleDeg = DIR_TO_ANGLE[unitLeaderDir] ?? ldrAngleDeg ?? dataBlock.leaderAngleDeg ?? -45

    const leaderAngle = angleDeg * Math.PI / 180
    const textDist    = Math.max(leaderLen, symR)

    lx0 = x + Math.cos(leaderAngle) * symR
    ly0 = y + Math.sin(leaderAngle) * symR
    lx1 = x + Math.cos(leaderAngle) * textDist
    ly1 = y + Math.sin(leaderAngle) * textDist

    // The DCB spinner stores NW as -135, RIGHT_ALIGN_ANGLES uses 0-360
    const rightAlign = RIGHT_ALIGN_ANGLES.has((angleDeg + 360) % 360)
    tx     = rightAlign ? lx1 - 2 : lx1 + 2
    ty     = ly1
    anchor = rightAlign ? 'end' : 'start'
  }
  const style = { font, dominantBaseline: 'alphabetic', whiteSpace: 'pre' }

  // ── Color ───────────────────────────────────────────────────────────
  // FDB blink states: incoming HO (continuous) or post-acceptance on sender
  // (5s), white/light gray — never invisible. A beaconator-promoted PDB
  // keeps the PDB color: the readout doesn't make the track mine.
  let fill, opacity
  if (content.color === 'ldb') {
    fill = isHighlighted ? HIGHLIGHT_TEAL : colors.ldbText
    opacity = briteLdb
  } else if (content.color === 'pdb') {
    fill = isHighlighted ? HIGHLIGHT_TEAL : colors.pdbText
    opacity = briteLdb
  } else {
    const shouldBlink = isBlinking || isIncomingHo || content.isPoReceiving || content.isPoRejected
    fill = isHighlighted ? HIGHLIGHT_TEAL
      : content.isPoReceiving ? (blinkOn ? '#FFFF00' : '#808000')
      : shouldBlink ? (blinkOn ? '#FFFFFF' : '#C0C0C0')
      : content.promoted ? colors.pdbText
      : colors.fdbText
    opacity = content.promoted ? briteLdb : briteFdb
  }

  const leader = leaderLen > 0
    ? <line x1={lx0} y1={ly0} x2={lx1} y2={ly1} stroke={colors.leaderLine} strokeWidth={0.8} />
    : null

  function renderSeg(s, i) {
    if (s.blink === 'opacity') return <tspan key={i} opacity={blinkOn ? 1 : 0.25}>{s.t}</tspan>
    if (s.blink === 'warn')    return <tspan key={i} fill={blinkOn ? WARN_BRIGHT : WARN_DIM}>{s.t}</tspan>
    return <tspan key={i}>{s.t}</tspan>
  }

  // ── Line 0: alerts, one line above line 1. Not accounted for in the dbca
  // bbox sizing (datablockPlacement.js) — alerts are rare, urgent and
  // transient, so this trades perfect collision avoidance for keeping that
  // pass unaware of per-tick alert state.
  const alertLine = content.alerts.length > 0 && (
    <text x={tx} y={ty - lh} opacity={opacity} textAnchor={anchor} style={style}>
      {content.alerts.map((a, i) => {
        const color = a.acked ? ALERT_BRIGHT : (blinkOn ? ALERT_BRIGHT : ALERT_DIM)
        return <tspan key={i} fill={color}>{(i > 0 ? '/' : '') + a.t}</tspan>
      })}
    </text>
  )

  return (
    <g>
      {leader}
      {alertLine}
      {content.lines.map((line, li) => (
        <text key={li} x={tx} y={ty + lh * li} fill={fill} opacity={opacity} textAnchor={anchor} style={style}>
          {line.map(renderSeg)}
        </text>
      ))}
    </g>
  )
})

// ── Overlay ──────────────────────────────────────────────────────────────────

export function DatablockOverlay({ units, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks, slewedPdbs, blinkOn, highlightedUids, wingmanIds, beaconReadout }) {
  const ownership   = useAtcStore((s) => s.ownership)
  const handoffs    = useAtcStore((s) => s.handoffs)
  const pointOuts   = useAtcStore((s) => s.pointOuts)
  const quickLook   = useAtcStore((s) => s.quickLook)
  const displayFdb  = useAtcStore((s) => s.displayFdb)
  const scratchpads = useAtcStore((s) => s.scratchpads)
  const blinkTracks = useAtcStore((s) => s.blinkTracks)
  const identUnacked = useAtcStore((s) => s.identUnacked)
  const conflictAcks = useAtcStore((s) => s.conflictAcks)
  const caInhibited  = useAtcStore((s) => s.caInhibited)
  const conflicts     = useStcaStore((s) => s.conflicts)

  const spcAlerts      = useStarsAlertsStore((s) => s.spc)
  const msawAlerts     = useStarsAlertsStore((s) => s.msaw)
  const duplicates     = useStarsAlertsStore((s) => s.duplicates)
  const dupAck         = useStarsAlertsStore((s) => s.dupAck)
  const fullLdbUntil   = useStarsAlertsStore((s) => s.fullLdbUntil)
  const ldbBeacon      = useStarsAlertsStore((s) => s.ldbBeacon)
  const ldbBeacons     = useStarsAlertsStore((s) => s.ldbBeacons)
  const selectedBeacon = useStarsAlertsStore((s) => s.selectedBeacon)
  const trackMsawDisabled = useStarsAlertsStore((s) => s.trackMsawDisabled)
  const trackMciSuppressed = useStarsAlertsStore((s) => s.trackMciSuppressed)

  // uid -> { type, acked } — first matching conflict wins if a track is
  // somehow part of more than one simultaneously (not modeled as multiple
  // stacked alerts, matching the single CA/MCI indicator).
  const conflictByUnit = useMemo(() => {
    const map = {}
    for (const c of conflicts) {
      const entry = { type: c.type, acked: !!conflictAcks[c.id] }
      if (!(c.unitAId in map)) map[c.unitAId] = entry
      if (!(c.unitBId in map)) map[c.unitBId] = entry
    }
    return map
  }, [conflicts, conflictAcks])

  const positionName    = useSessionStore((s) => s.positionName)
  const myId            = useControllersStore((s) => s.registry[positionName]?.controllerId ?? null)

  const leaderDirs      = useDisplayStore((s) => s.windows[WINDOW_ID]?.leaderDirs      ?? EMPTY_OBJECT)
  const dbca            = useDisplayStore((s) => s.windows[WINDOW_ID]?.dbca ?? false)

  const plans = useFlightPlansStore((s) => s.plans)

  // Reveal gate on top of ownership — see resolveDbType's comment. Always
  // true for any unit that isn't srsCapable.
  const associatedMap = useAssociationStore((s) => s.associated)
  const isAssociated = useCallback(
    (uid, unit) => !unit?.srsCapable || !!associatedMap[uid],
    [associatedMap]
  )

  const plansByUnit = useMemo(() => {
    const map = {}
    for (const p of Object.values(plans)) {
      if (p.unitId != null) map[String(p.unitId)] = p
    }
    // Backfill from the association engine's callsign+code match —
    // plan.unitId is only ever set
    // via the FPE's ctrl-click flow, so a StripBay-created plan would
    // otherwise never show Line 3 mismatch / actype despite being
    // correctly associated.
    for (const [uid, aid] of Object.entries(associatedMap)) {
      if (!map[uid] && plans[aid]) map[uid] = plans[aid]
    }
    return map
  }, [plans, associatedMap])

  const clockSeq  = useOdsStore((s) => s.activeProfile?.datablocks?.clockPhase?.sequence  ?? DEFAULT_SEQUENCE)
  const clockInts = useOdsStore((s) => s.activeProfile?.datablocks?.clockPhase?.intervals ?? DEFAULT_INTERVALS)

  // Tick every 200ms so clock phase stays current
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 200)
    return () => clearInterval(id)
  }, [])

  const clockPhase = getClockPhase(clockSeq, clockInts)
  const now        = Date.now()

  const entries = useMemo(() => Object.entries(units), [units])

  // ── Content for every unit, shared by rendering and dbca placement ──
  const alerts = {
    spc: spcAlerts, msaw: msawAlerts, duplicates, dupAck, fullLdbUntil, ldbBeacon, ldbBeacons, selectedBeacon,
    trackMsawDisabled, trackMciSuppressed,
  }
  const contents = {}
  for (const [id, unit] of entries) {
    if (!unit.position) continue
    const uid = String(id)
    const content = buildContent(uid, unit, {
      ownership, handoffs, pointOuts, quickLook, displayFdb, myId, scratchpads,
      plan: plansByUnit[uid] ?? null,
      assoc: isAssociated(uid, unit),
      beaconReadout,
      isIdent: !!identUnacked[uid],
      slewed: slewedPdbs?.has(uid) ?? false,
      clockPhase,
      conflict: conflictByUnit[uid] ?? null,
      caInhibited, alerts,
      unitSystem: view?.unitSystem,
    })
    contents[uid] = content
  }

  // ── Collision-avoidance placement (dbca on only) — one batch pass across
  //    every visible contact, resolved before any <Datablock> renders, since
  //    each contact's placement depends on where every other one landed.
  //    SVG text isn't measured, so widths use a monospace char-count
  //    estimate (MONO_CHAR_RATIO) rather than STARS' usual exact widths.
  //    Keyed on the text widths so it only reruns when a block's shape does.
  const contentsRef = useRef(contents)
  contentsRef.current = contents
  const layoutKey = dbca
    ? Object.entries(contents).map(([uid, c]) => uid + ':' + c.lines.map((l) => lineText(l).length).join(',')).join('|')
    : ''

  const placements = useMemo(() => {
    if (!dbca || !view) return null

    const fontPx = 10 + (csDatablocks ?? 3) * 2
    const generalAngleDeg = ldrAngleDeg ?? visual.dataBlock.leaderAngleDeg ?? -45
    const contacts = []
    for (const [id, unit] of entries) {
      const pos = unit.position
      if (!pos) continue
      const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
      if (x < -100 || x > view.width + 100 || y < -100 || y > view.height + 100) continue

      const uid     = String(id)
      const content = contentsRef.current[uid]
      if (!content) continue
      contacts.push({
        id: uid, x, y,
        lineWidths: content.lines.map((l) => lineText(l).length * fontPx * MONO_CHAR_RATIO),
        unitAngleDeg: DIR_TO_ANGLE[leaderDirs[uid]] ?? null,
        generalAngleDeg,
      })
    }
    if (contacts.length === 0) return {}

    const symR = (visual.symbol.diameter ?? 13) / 2
    const lh   = visual.dataBlock.lineHeight ?? Math.round(fontPx * 1.2)

    return placeDatablocks(contacts, {
      symbolRadius: symR,
      leaderLen: ldrLength ?? visual.dataBlock.leaderLength ?? 40,
      lineHeight: lh,
      ascent: Math.round(fontPx * 0.8),
      descent: Math.round(fontPx * 0.2),
      padding: 2,
    })
  // layoutKey stands in for contentsRef: rerun only when a block's line widths change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbca, view, entries, layoutKey, leaderDirs, ldrAngleDeg, ldrLength, csDatablocks, visual])

  if (!view) return null

  return (
    <svg
      className="atc-layer"
      style={{ pointerEvents: 'none' }}
      width={view.width}
      height={view.height}
    >
      {entries.map(([id, unit]) => (
        <Datablock
          key={id}
          unit={unit}
          view={view}
          visual={visual}
          ldrLength={ldrLength}
          ldrAngleDeg={ldrAngleDeg}
          briteFdb={briteFdb}
          briteLdb={briteLdb}
          csDatablocks={csDatablocks}
          unitLeaderDir={leaderDirs[String(id)] ?? null}
          placement={placements ? (placements[String(id)] ?? null) : null}
          content={contents[String(id)] ?? null}
          isBlinking={!!blinkTracks[String(id)] && now < blinkTracks[String(id)]}
          isIncomingHo={handoffs[String(id)]?.to === myId}
          blinkOn={blinkOn}
          isHighlighted={highlightedUids?.has(String(id)) ?? false}
          wingman={wingmanIds?.has(String(id)) ?? false}
        />
      ))}
    </svg>
  )
}
