/**
 * Shared DCB spinner math — used by STARS' Dcb.jsx and ASDE-X's AsdexDcb.jsx.
 * Menu structure, buttons, and colors stay independent per scope; only the
 * genuinely identical value-spinner mechanics live here.
 */

// LDR direction spinner — clockwise from N. Index corresponds to bearing
// (N=0°, E=90°, etc.); canvas angles differ because canvas 0° is right (+x)
// and y increases downward.
export const LDR_DIR_SEQUENCE = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
export const LDR_DIR_CANVAS_ANGLES = [-90, -45, 0, 45, 90, 135, 180, -135]

// LDR_DIR wraps around (circular) rather than clamping like every other spinner.
export function ldrDirWraparound(curIndex, delta) {
  return ((curIndex - delta) % 8 + 8) % 8
}

// Generic clamped-step delta shared by every value spinner except LDR_DIR
// (circular) and RANGE (ASDE-X's own non-integer-step scaling).
export function clampValueDelta(cur, delta, cfg) {
  return Math.max(cfg.min, Math.min(cfg.max,
    parseFloat((cur + delta * cfg.step * (cfg.dir ?? -1)).toFixed(3))
  ))
}
