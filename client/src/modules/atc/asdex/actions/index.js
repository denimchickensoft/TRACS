/**
 * ASDE-X action library — the ASDE-X counterpart of atc/actions.
 *
 * Each action receives one object: { captures, slewTarget, ...context }
 *   captures   — named captures from asdexCommandParser.js
 *   slewTarget — { unitId, unit } | null  (null for ENTER-triggered commands)
 *   context    — AsdexScope's component-local state the actions need:
 *                { profiles, setCenterlineVisible, setCoordsVisible }
 *
 * Actions report their result by writing the ASDE-X preview area directly.
 */

import { useDisplayStore }         from '../../../../store/display.js'
import { useFpeStore }             from '../../../../store/fpe.js'
import { useAsdexPreviewStore }    from '../../../../store/asdexPreview.js'
import { useAsdexManualTagsStore } from '../../../../store/asdexManualTags.js'
import { saveAsdexPrefs }          from '../../../../store/asdexPrefs.js'
import { resolveCallsign }         from '../../../../utils/callsign.js'
import { ASDEX_WINDOW_ID }         from '../AsdexDcb.jsx'
import { setUnitSystem }           from '../../../../store/unitSystem.js'
import { METRIC, IMPERIAL }        from '../../../../utils/units.js'

const preview = () => useAsdexPreviewStore.getState()

// ── ENTER commands ────────────────────────────────────────────────────────────

function OPEN_FPE({ captures }) {
  useFpeStore.getState().openFpe({ aid: captures.aid ?? null, scope: 'asdex' })
  preview().clearAfterCommand()
}

function TOGGLE_CENTERLINE({ setCenterlineVisible }) {
  setCenterlineVisible(v => { saveAsdexPrefs({ centerlineVisible: !v }); return !v })
  preview().clearAfterCommand()
}

function TOGGLE_COORDS({ setCoordsVisible }) {
  setCoordsVisible(v => { saveAsdexPrefs({ coordsVisible: !v }); return !v })
  preview().clearAfterCommand()
}

// .METRIC / .IMPERIAL — shared with STARS/PAR (the ATC module's units).
function METRIC_UNITS() {
  setUnitSystem('atc', METRIC)
  preview().clearAfterCommand()
}

function IMPERIAL_UNITS() {
  setUnitSystem('atc', IMPERIAL)
  preview().clearAfterCommand()
}

function SET_COLORS({ captures, profiles }) {
  const name = captures.name.trim()
  const idx = profiles.findIndex(p => p.name.toUpperCase() === name.toUpperCase())
  if (idx >= 0) {
    useDisplayStore.getState().updateWindow(ASDEX_WINDOW_ID, { colorIdx: idx })
    saveAsdexPrefs({ colorProfile: profiles[idx].name })
    preview().setResponse(`COLORS ${profiles[idx].name.toUpperCase()}`)
  } else {
    preview().setResponse('INVALID PROFILE')
  }
  preview().clearAfterCommand()
}

// ── SLEW commands ─────────────────────────────────────────────────────────────

function SET_LEADER_SHORT({ captures, slewTarget }) {
  const dir     = captures.dir
  const current = useDisplayStore.getState().windows[ASDEX_WINDOW_ID]?.leaderDirs ?? {}
  const next    = { ...current }
  if (dir === '5') delete next[slewTarget.unitId]
  else next[slewTarget.unitId] = dir
  useDisplayStore.getState().updateWindow(ASDEX_WINDOW_ID, { leaderDirs: next })
  preview().clearAfterCommand()
}

// TRACS already knows the truth (Olympus ground-truth callsign) — unlike
// CRC/VATSIM this isn't a guess needing a guardrail, it's a correctness
// check: a mismatch just fails.
function TAG_TARGET({ captures, slewTarget }) {
  const typedAid = captures.aid?.trim().toUpperCase()
  const trueAid  = resolveCallsign(slewTarget.unit).toUpperCase()
  if (typedAid === trueAid) {
    useAsdexManualTagsStore.getState().tag(slewTarget.unitId)
    preview().clearAfterCommand()
  } else {
    preview().setResponse('ILL TRK')
  }
}

const ACTION_MAP = {
  OPEN_FPE, TOGGLE_CENTERLINE, TOGGLE_COORDS, METRIC_UNITS, IMPERIAL_UNITS, SET_COLORS,
  SET_LEADER_SHORT, TAG_TARGET,
}

/**
 * Dispatch a parsed command to its action handler.
 *
 * @param {object} parsed      { command, captures }
 * @param {object} slewTarget  { unitId, unit } | null
 * @param {object} context     { profiles, setCenterlineVisible, setCoordsVisible }
 */
export function dispatch(parsed, slewTarget, context) {
  const handler = ACTION_MAP[parsed.command.id]
  if (!handler) return
  handler({ captures: parsed.captures, slewTarget, ...context })
}
