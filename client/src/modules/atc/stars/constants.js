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
