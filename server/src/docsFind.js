'use strict'

// Ctrl+F for the docs pages, desktop app only. Electron has Chromium's page
// search but not Chrome's find bar, so the desktop app draws its own box over
// the window (electron/findBar.html) and does the searching; this page only
// asks for it. In a regular browser there's no electronAPI, so this does
// nothing and the browser keeps its own Ctrl+F. Served to the page by
// routes/docs.js.
;(() => {
  const api = window.electronAPI
  if (!api?.openFind) return

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); api.openFind() }
    else if (e.key === 'Escape') api.closeFind()
  })
})()
