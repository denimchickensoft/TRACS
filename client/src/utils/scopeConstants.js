// Numpad direction code → canvas angle in degrees (Y-axis points down)
// Layout mirrors a numeric keypad: 7=NW 8=N 9=NE / 4=W 5=default 6=E / 1=SW 2=S 3=SE
export const DIR_TO_ANGLE = {
  '1': 135,   // SW
  '2': 90,    // S
  '3': 45,    // SE
  '4': 180,   // W
  '6': 0,     // E
  '7': 225,   // NW
  '8': 270,   // N
  '9': 315,   // NE
}

// Directions whose leader points into the left hemisphere — text right-aligns
// so it extends away from the contact symbol rather than back toward it.
export const RIGHT_ALIGN_ANGLES = new Set([90, 135, 180, 225]) // S, SW, W, NW

// Middle-click highlight color — shared between STARS (drawContacts.js/
// DatablockOverlay.jsx) and ABM (drawAbmContacts.js/drawAbmGroundContacts.js),
// overriding whatever declaration/ownership color a symbol or datablock
// would otherwise use while the contact is highlighted.
export const HIGHLIGHT_TEAL = '#00FFFF'

// ABM-only — a highlighted contact whose *effective* declaration
// is HOSTILE/BOGEY uses purple instead of teal (FRIENDLY/NEUTRAL stay teal).
// STARS has no declaration concept, so it always uses HIGHLIGHT_TEAL.
export const HIGHLIGHT_PURPLE = '#C000FF'

// Safety alert / special condition tag colors — blinks bright/dim red while
// unacknowledged, solid red once acked (STARS, ABM, CATCC).
export const ALERT_BRIGHT = '#FF3333'
export const ALERT_DIM    = '#7A1A1A'
