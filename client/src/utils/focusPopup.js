// Bring a popped-out window forward. In the desktop app the page's own
// popup.focus() is ignored on Windows, so the main process focuses it by the
// popup's window name instead; a browser uses popup.focus().
export function focusPopup(popup) {
  if (!popup || popup.closed) return
  let name = ''
  try { name = popup.name } catch { /* not readable - fall back to focus() */ }
  if (name && window.electronAPI?.focusPopup) {
    window.electronAPI.focusPopup(name).then((ok) => { if (!ok) popup.focus() }, () => popup.focus())
    return
  }
  popup.focus()
}
