import { memo, useMemo, useState, useEffect, useCallback } from 'react'
import { useAtcStore, POINTOUT_STATE } from '../../../store/atc.js'
import { useStcaStore }        from '../../../store/stca.js'
import { useSessionStore }     from '../../../store/session.js'
import { useControllersStore } from '../../../store/controllers.js'
import { useDisplayStore }     from '../../../store/display.js'
import { useFlightPlansStore } from '../../../store/flightPlans.js'
import { useAssociationStore } from '../../../store/association.js'
import { useOdsStore }         from '../../../store/ods.js'
import { latLngToCanvas }      from '../../../utils/projection.js'
import { resolveCallsign }     from '../../../utils/callsign.js'
import { hasLiveSquawk }       from '../../../utils/transponder.js'
import { DIR_TO_ANGLE, RIGHT_ALIGN_ANGLES, HIGHLIGHT_TEAL } from '../../../utils/scopeConstants.js'
import { placeDatablocks } from '../../../utils/datablockPlacement.js'
import { MS_TO_KT as M_PER_S_TO_KNOTS, M_TO_FT as METERS_TO_FEET } from '../../../utils/units.js'

const WINDOW_ID        = 'atc-main'
// SVG text isn't measured against a canvas context here, so estimate width
// from Roboto Mono's monospace advance instead of ctx.measureText.
const MONO_CHAR_RATIO  = 0.6

const DEFAULT_SEQUENCE  = [1, 2, 1, 3]
const DEFAULT_INTERVALS = [3, 2, 3, 2]

// Conflict alert (CA/MCI) indicator colors — blinks bright/dim red while
// unacknowledged, solid red once acked.
const CA_BLINK_BRIGHT = '#FF3333'
const CA_BLINK_DIM    = '#7A1A1A'
const CA_SOLID        = '#FF3333'

// ── Formatting ───────────────────────────────────────────────────────────────

function fmtAlt(metres) {
  if (metres == null) return '   '
  const hundreds = Math.round(metres * METERS_TO_FEET / 100)
  return String(hundreds).padStart(3, '0')
}

function fmtSpd(mps) {
  if (mps == null) return '  '
  const kt = Math.round(mps * M_PER_S_TO_KNOTS / 10)
  return String(Math.min(kt, 99)).padStart(2, '0')
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

// ── Line 2 content ───────────────────────────────────────────────────────────
// Returns a single string: "[left 4 chars] [right 2-4 chars]"
// Left: altitude (3) + handoffId (1); phases 2-3 swap in scratchpad if set.
// Right: GS (2); phases 2-3 swap in actype if set.
// Empty substitution: if the phase-specific data is absent, falls back to the
// phase-1 value — the field never goes blank.

// Right side of line 2 rotates on its own clock, independent of the
// left-side SP phases: gs -> type -> gs -> R### -> gs ... An empty slot
// (no type, or no amended requested altitude) falls back to gs.
const RIGHT_SLOT_MS = 2000
const RIGHT_SLOTS   = ['gs', 'type', 'gs', 'req']
const EMPTY_OBJECT  = {}

function getRightSlot() {
  return RIGHT_SLOTS[Math.floor(Date.now() / RIGHT_SLOT_MS) % RIGHT_SLOTS.length]
}

function computeLine2(phase, rightSlot, alt, sp1, sp2, handoffId, gs, actype, reqAlt) {
  const hid    = handoffId
  const sp1Set = sp1 && sp1.trim() !== ''
  const sp2Set = sp2 && sp2.trim() !== ''

  let left
  if (phase === 3 && sp2Set) {
    left = sp2.slice(0, 3).padEnd(3) + hid
  } else if (phase !== 1 && sp1Set) {
    left = sp1.slice(0, 3).padEnd(3) + hid
  } else {
    left = alt + hid
  }

  let right = gs
  if (rightSlot === 'type' && actype && actype.trim() !== '') right = actype.slice(0, 4)
  else if (rightSlot === 'req' && reqAlt) right = 'R' + reqAlt

  return left + ' ' + right.padStart(4)
}

// FDB line 3: beacon-code mismatch on the left, temporary assigned altitude
// (A###) right-aligned with line 2's right edge. Rendered with
// white-space: pre so the padding survives.
function computeLine3(codeMismatchText, tempAlt, line2Len) {
  const a = tempAlt ? 'A' + tempAlt : ''
  if (codeMismatchText && a) return codeMismatchText + ' ' + a
  if (codeMismatchText) return codeMismatchText
  if (a) return a.padStart(line2Len)
  return null
}

// ── Per-unit datablock ───────────────────────────────────────────────────────

const Datablock = memo(function Datablock({
  id, unit, view, visual, ldrLength, ldrAngleDeg, briteFdb, briteLdb, csDatablocks,
  ownership, handoffs, pointOuts, quickLook, displayFdb, scratchpads,
  myId, unitLeaderDir, placement,
  clockPhase, rightSlot, actype, reqAlt, planSp1, planSp2, slewed, isBlinking, blinkOn, isHighlighted,
  conflict, wingman, assoc, assignedBcn, isIdent, beaconReadout,
}) {
  const pos = unit.position
  if (!pos) return null

  // Simulated squawk-standby wingman — primary-only, no datablock at all.
  if (wingman) return null

  const { x, y } = latLngToCanvas(pos.lat, pos.lng, view)
  if (x < -100 || x > view.width + 100 || y < -100 || y > view.height + 100) return null

  const uid = String(id)
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
  const style = { font, dominantBaseline: 'alphabetic' }

  // ── Data ────────────────────────────────────────────────────────────
  const rawDbType = resolveDbType(uid, ownership, handoffs, pointOuts, quickLook, displayFdb, myId, assoc)
  // Beacon code readout ("Beaconator", press-and-hold F1) — real STARS
  // forces PDB up to FDB and swaps the callsign for the code. An FDB
  // already shows everything needed — regardless of *why* it's FDB
  // (owned, handoff, point-out, quick look, displayFdb) — so this must
  // only ever touch a track that was genuinely PDB to begin with.
  // A genuinely-unassociated LDB already shows the code by default (no
  // override needed), but an associated-but-untracked LDB (no owner, real
  // flight-plan match) normally shows alt/gs instead — that one DOES need
  // an override, ldbReadoutActive below, or F1 does nothing for it.
  const isBeaconTrack = !!unit.srsCapable && hasLiveSquawk(unit)
  const readoutActive = !!beaconReadout && isBeaconTrack && rawDbType === 'PDB'
  const ldbReadoutActive = !!beaconReadout && isBeaconTrack && rawDbType === 'LDB'
  // A PDB that's IDENTing temporarily displays as an LDB for as long as the
  // IDENT is unacknowledged (not just the "on" half of the blink cycle) —
  // takes priority over Beaconator's PDB->FDB promotion if both apply.
  // Only the datablock type/content changes; the contact symbol/position
  // letter is untouched.
  const identForcesLdb = isIdent && rawDbType === 'PDB'
  const dbType    = identForcesLdb ? 'LDB' : readoutActive ? 'FDB' : rawDbType
  const beaconLine1 = (readoutActive && unit.transponder?.mode3 != null)
    ? String(unit.transponder.mode3).padStart(4, '0') : null
  // IDENT — only the "ID" suffix itself blinks (its own tspan opacity),
  // never the whole line/color scheme. Appended to line 2 (groundspeed) for
  // FDB/PDB (both share that layout), or to the squawk code for LDB — see
  // the LDB block below.
  const identTspan = isIdent ? <tspan opacity={blinkOn ? 1 : 0.25}>ID</tspan> : null
  const alt       = fmtAlt(pos.alt)
  const gs        = fmtSpd(unit.speed)
  // A track's own scratchpad wins (even '' from a clear); otherwise the one
  // entered on its flight plan (FLT DATA) before the track existed.
  const sp1       = scratchpads[uid]?.sp1 ?? planSp1 ?? ''
  const sp2       = scratchpads[uid]?.sp2 ?? planSp2 ?? ''
  const handoffId = resolveHandoffId(uid, handoffs, myId)
  const cs        = resolveCallsign(unit).toUpperCase()
  const po            = pointOuts[uid]
  const isPoReceiving = po?.state === POINTOUT_STATE.RECEIVING && po?.to   === myId
  const isPoSent      = po?.state === POINTOUT_STATE.SENT      && po?.from === myId
  const isPoRejected  = po?.state === POINTOUT_STATE.REJECTED  && po?.from === myId
  const line2     = computeLine2(clockPhase, rightSlot, alt, sp1, sp2, handoffId, gs, actype ?? '', '')
  // R### (amended requested altitude) time-shares on FDB line 2 only
  const fdbLine2  = computeLine2(clockPhase, rightSlot, alt, sp1, sp2, handoffId, gs, actype ?? '', reqAlt)
  const tempAlt   = scratchpads[uid]?.tempAlt ?? ''

  const leader = leaderLen > 0
    ? <line x1={lx0} y1={ly0} x2={lx1} y2={ly1} stroke={colors.leaderLine} strokeWidth={0.8} />
    : null

  // ── Conflict alert (CA/MCI) — renders one line above line 1, blinking
  // red while unacknowledged, solid red once acked. Not accounted for in
  // the dbca collision-avoidance bbox sizing (datablockPlacement.js) — a
  // conflict is a rare, urgent, transient state, so this trades perfect
  // collision avoidance for keeping that pass unaware of per-tick alert
  // state. FDB/PDB only; LDBs have no callsign line to attach one above.
  const conflictColor = conflict
    ? (conflict.acked ? CA_SOLID : (blinkOn ? CA_BLINK_BRIGHT : CA_BLINK_DIM))
    : null
  function conflictEl(opacity) {
    if (!conflict) return null
    return (
      <text x={tx} y={ty - lh} fill={conflictColor} opacity={opacity} textAnchor={anchor} style={style}>
        {conflict.type}
      </text>
    )
  }

  // ── LDB ─────────────────────────────────────────────────────────────
  if (dbType === 'LDB') {
    const ldbColor = isHighlighted ? HIGHLIGHT_TEAL : colors.ldbText
    // Genuinely unassociated (real transponder data, no flight-plan match
    // yet): CRC's actual LDB layout is beacon code on line 1, altitude on
    // line 2 by default — ground speed appears alongside it (same position
    // as FDB's line 2, "alt gs") temporarily while slewed, not in place of
    // altitude (same slewedPdbs toggle every other track already uses on
    // click — see StarsScope.jsx's bare-slew handler). Otherwise this is
    // the pre-existing unowned-but-associated case — unchanged, single line.
    // IDENT appends "ID" to the squawk code (line 1) here — LDBs have no
    // callsign — via its own blinking tspan, not the whole line. Any
    // associated-but-LDB track that's IDENTing (whether it's an unowned
    // track via the legacy !owner path, or a PDB forced here by
    // identForcesLdb) shows the real squawk-code layout too, not the
    // legacy single alt/gs line — "turns into an LDB" means it actually
    // looks like one, code and all.
    if (!assoc || isIdent || ldbReadoutActive) {
      const beacon = String(unit.transponder?.mode3 ?? '').padStart(4, '0')
      return (
        <g>
          {leader}
          <text x={tx} y={ty}      fill={ldbColor} opacity={briteLdb} textAnchor={anchor} style={style}>
            <tspan>{beacon}</tspan>{identTspan}
          </text>
          <text x={tx} y={ty + lh} fill={ldbColor} opacity={briteLdb} textAnchor={anchor} style={style}>
            {slewed ? `${alt} ${gs}` : alt}
          </text>
        </g>
      )
    }
    return (
      <g>
        {leader}
        <text x={tx} y={ty} fill={ldbColor} opacity={briteLdb} textAnchor={anchor} style={style}>
          <tspan>{`${alt} ${gs}`}</tspan>{identTspan}
        </text>
      </g>
    )
  }

  // ── PDB ─────────────────────────────────────────────────────────────
  // Unslewed: leader attaches at the data line (single line).
  // Slewed: leader attaches at ACID line; data line drops below — same layout as FDB.
  // IDENT appends "ID" to line 2 (the groundspeed) here, same as FDB, not
  // the callsign — via its own blinking tspan, not the whole line/color.
  if (dbType === 'PDB') {
    const pdbColor = isHighlighted ? HIGHLIGHT_TEAL : colors.pdbText
    if (slewed) {
      return (
        <g>
          {leader}
          {conflictEl(briteLdb)}
          <text x={tx} y={ty}      fill={pdbColor} opacity={briteLdb} textAnchor={anchor} style={style}>
            {cs}
          </text>
          <text x={tx} y={ty + lh} fill={pdbColor} opacity={briteLdb} textAnchor={anchor} style={style}>
            <tspan>{line2}</tspan>{identTspan}
          </text>
        </g>
      )
    }
    return (
      <g>
        {leader}
        {conflictEl(briteLdb)}
        <text x={tx} y={ty} fill={pdbColor} opacity={briteLdb} textAnchor={anchor} style={style}>
          <tspan>{line2}</tspan>{identTspan}
        </text>
      </g>
    )
  }

  // ── FDB ─────────────────────────────────────────────────────────────
  // Leader attaches at the ACID line. Data line is one line below.
  // Blink states: incoming HO (continuous) or post-acceptance on sender (5s).
  // Both blink between white and light gray — never go invisible.
  const isIncomingHo  = handoffs[uid]?.to === myId
  const shouldBlink   = isBlinking || isIncomingHo || isPoReceiving || isPoRejected
  // readoutActive means this FDB is a Beaconator (F1) promotion of a track
  // that was genuinely a plain PDB (owner !== myId, no handoff/point-out/
  // quick-look reason to see it) — see the readoutActive comment above.
  // Beaconator forces FDB-level *content* but must not repaint the track as
  // if it were now mine; it stays in the other-controller-owned (PDB) color.
  const fdbColor      = isHighlighted ? HIGHLIGHT_TEAL
    : isPoReceiving
    ? (blinkOn ? '#FFFF00' : '#808000')
    : shouldBlink ? (blinkOn ? '#FFFFFF' : '#C0C0C0')
    : readoutActive ? colors.pdbText
    : colors.fdbText
  const acidLine      = beaconLine1 ??
                      ( isPoReceiving ? cs + ' PO'
                      : isPoSent      ? cs + ' PO' + po.to
                      : isPoRejected  ? cs + ' UN'
                      : cs )

  // ── Line 3: reported vs. assigned beacon code, shown only on mismatch ──
  // Association is sticky (see associationEngine.js) — a live code drifting
  // from the assigned one doesn't drop the association, it just surfaces
  // here, matching real STARS Line 3 verbatim (a deliberate VATSIMism).
  const reportedCode = unit.transponder?.mode3 != null ? String(unit.transponder.mode3).padStart(4, '0') : null
  const assignedCode = assignedBcn != null ? String(assignedBcn).padStart(4, '0') : null
  const codeMismatch = reportedCode != null && assignedCode != null && reportedCode !== assignedCode
  const line3 = computeLine3(codeMismatch ? `${reportedCode} ${assignedCode}` : null, tempAlt, fdbLine2.length)

  return (
    <g>
      {leader}
      {conflictEl(briteFdb)}
      <text x={tx} y={ty}      fill={fdbColor} opacity={briteFdb} textAnchor={anchor} style={style}>
        {acidLine}
      </text>
      <text x={tx} y={ty + lh} fill={fdbColor} opacity={briteFdb} textAnchor={anchor} style={style}>
        <tspan>{fdbLine2}</tspan>{identTspan}
      </text>
      {line3 && (
        <text x={tx} y={ty + lh * 2} fill={fdbColor} opacity={briteFdb} textAnchor={anchor} style={{ ...style, whiteSpace: 'pre' }}>
          {line3}
        </text>
      )}
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
  const conflicts     = useStcaStore((s) => s.conflicts)

  // uid -> { type, acked } — first matching conflict wins if a track is
  // somehow part of more than one simultaneously (not modeled as multiple
  // stacked alerts, matching the reference app's single CA/MCI indicator).
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
  const rightSlot  = getRightSlot()
  const now        = Date.now()

  const entries = useMemo(() => Object.entries(units), [units])

  // ── Collision-avoidance placement (dbca on only) — one batch pass across
  //    every visible contact, resolved before any <Datablock> renders, since
  //    each contact's placement depends on where every other one landed.
  //    SVG text isn't measured, so widths use a monospace char-count
  //    estimate (MONO_CHAR_RATIO) rather than STARS' usual exact widths.
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

      const uid    = String(id)
      const assoc  = isAssociated(uid, unit)
      const rawDbType = resolveDbType(uid, ownership, handoffs, pointOuts, quickLook, displayFdb, myId, assoc)
      const isBeaconTrack = !!unit.srsCapable && hasLiveSquawk(unit)
      // Only a genuinely-PDB track gets promoted+swapped — see the matching
      // comment in Datablock above.
      const readoutActive = !!beaconReadout && isBeaconTrack && rawDbType === 'PDB'
      const ldbReadoutActive = !!beaconReadout && isBeaconTrack && rawDbType === 'LDB'
      const identForcesLdb = !!identUnacked[uid] && rawDbType === 'PDB'
      const dbType = identForcesLdb ? 'LDB' : readoutActive ? 'FDB' : rawDbType
      const cs     = (readoutActive && unit.transponder?.mode3 != null)
        ? String(unit.transponder.mode3).padStart(4, '0')
        : resolveCallsign(unit).toUpperCase()
      const alt    = fmtAlt(pos.alt)
      const gs     = fmtSpd(unit.speed)
      const sp1    = scratchpads[uid]?.sp1 ?? plansByUnit[uid]?.sp1 ?? ''
      const sp2    = scratchpads[uid]?.sp2 ?? plansByUnit[uid]?.sp2 ?? ''
      const handoffId = resolveHandoffId(uid, handoffs, myId)
      const actype = plansByUnit[uid]?.typ ?? ''
      const plan   = plansByUnit[uid]
      const reqAlt = plan?.altAmended ? (plan.alt ?? '') : ''
      const line2  = computeLine2(clockPhase, rightSlot, alt, sp1, sp2, handoffId, gs, actype, dbType === 'FDB' ? reqAlt : '')
      const tempAlt = scratchpads[uid]?.tempAlt ?? ''

      let lines
      if (dbType === 'LDB') {
        if (!assoc || identUnacked[uid] || ldbReadoutActive) {
          const beacon = String(unit.transponder?.mode3 ?? '').padStart(4, '0')
          lines = [beacon, slewedPdbs?.has(uid) ? `${alt} ${gs}` : alt]
        } else {
          lines = [`${alt} ${gs}`]
        }
      }
      else if (dbType === 'PDB') lines = slewedPdbs?.has(uid) ? [cs, line2] : [line2]
      // FDB — Line 3 beacon mismatch (rare) isn't accounted for in bbox
      // sizing, same tradeoff as the conflict indicator above; a temporary
      // altitude is, since it stays up for as long as it's assigned
      else lines = tempAlt ? [cs, line2, ('A' + tempAlt).padStart(line2.length)] : [cs, line2]

      contacts.push({
        id: uid, x, y,
        lineWidths: lines.map((t) => t.length * fontPx * MONO_CHAR_RATIO),
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
  }, [dbca, view, entries, ownership, handoffs, pointOuts, quickLook, displayFdb, myId,
      scratchpads, clockPhase, rightSlot, plansByUnit, slewedPdbs, leaderDirs, ldrAngleDeg,
      ldrLength, csDatablocks, visual, isAssociated, beaconReadout, identUnacked])

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
          id={id}
          unit={unit}
          view={view}
          visual={visual}
          ldrLength={ldrLength}
          ldrAngleDeg={ldrAngleDeg}
          briteFdb={briteFdb}
          briteLdb={briteLdb}
          csDatablocks={csDatablocks}
          ownership={ownership}
          handoffs={handoffs}
          pointOuts={pointOuts}
          quickLook={quickLook}
          displayFdb={displayFdb}
          assoc={isAssociated(String(id), unit)}
          assignedBcn={plansByUnit[String(id)]?.bcn ?? null}
          scratchpads={scratchpads}
          myId={myId}
          unitLeaderDir={leaderDirs[String(id)] ?? null}
          placement={placements ? (placements[String(id)] ?? null) : null}
          clockPhase={clockPhase}
          rightSlot={rightSlot}
          actype={plansByUnit[String(id)]?.typ ?? ''}
          reqAlt={plansByUnit[String(id)]?.altAmended ? (plansByUnit[String(id)]?.alt ?? '') : ''}
          planSp1={plansByUnit[String(id)]?.sp1 ?? null}
          planSp2={plansByUnit[String(id)]?.sp2 ?? null}
          slewed={slewedPdbs?.has(String(id)) ?? false}
          isBlinking={!!blinkTracks[String(id)] && now < blinkTracks[String(id)]}
          isIdent={!!identUnacked[String(id)]}
          blinkOn={blinkOn}
          isHighlighted={highlightedUids?.has(String(id)) ?? false}
          conflict={conflictByUnit[String(id)] ?? null}
          wingman={wingmanIds?.has(String(id)) ?? false}
          beaconReadout={beaconReadout}
        />
      ))}
    </svg>
  )
}
