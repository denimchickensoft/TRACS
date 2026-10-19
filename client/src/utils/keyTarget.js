// Keystrokes aimed at a text field (or anything inside a modal dialog) belong
// to that element, not to a window-wide shortcut or scope command line.
export function isTextEntry(el) {
  return !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}

export function isInModal(el) {
  return !!el?.closest?.('[aria-modal="true"]')
}
