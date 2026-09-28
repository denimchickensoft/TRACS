'use strict'

// Ctrl+F find box for the docs pages, desktop app only. Electron has
// Chromium's page search (findInPage, reached through the preload's
// electronAPI) but not Chrome's find bar, so this draws just the box; the
// searching, highlighting and match count are Electron's. In a regular
// browser there's no electronAPI, so this does nothing and the browser keeps
// its own Ctrl+F. Served to the page by routes/docs.js.
;(() => {
  const api = window.electronAPI
  if (!api?.findInPage) return

  const bar = document.createElement('div')
  bar.id = 'docs-find'
  bar.hidden = true
  bar.innerHTML = `
    <input type="text" aria-label="Find in page" spellcheck="false">
    <span class="docs-find-count"></span>
    <button type="button" data-action="prev" title="Previous (Shift+Enter)">▲</button>
    <button type="button" data-action="next" title="Next (Enter)">▼</button>
    <button type="button" data-action="close" title="Close (Esc)">×</button>`
  document.body.appendChild(bar)

  const input = bar.querySelector('input')
  const count = bar.querySelector('.docs-find-count')
  let searchedText = ''

  function search(forward) {
    const text = input.value
    if (!text) {
      api.stopFindInPage()
      count.textContent = ''
      searchedText = ''
      return
    }
    api.findInPage(text, { forward, newSearch: text !== searchedText })
    searchedText = text
  }

  function open() {
    bar.hidden = false
    input.focus()
    input.select()
  }

  function close() {
    bar.hidden = true
    api.stopFindInPage()
    count.textContent = ''
    searchedText = ''
  }

  api.onFindResult(({ activeMatchOrdinal, matches }) => {
    if (bar.hidden) return
    count.textContent = matches ? `${activeMatchOrdinal} / ${matches}` : 'No matches'
    // A search can move focus into the page; keep typing in the box.
    input.focus()
  })

  input.addEventListener('input', () => search(true))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); search(!e.shiftKey) }
  })
  bar.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action
    if (action === 'prev') search(false)
    else if (action === 'next') search(true)
    else if (action === 'close') close()
  })
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); open() }
    else if (e.key === 'Escape' && !bar.hidden) { e.preventDefault(); close() }
  })
})()
