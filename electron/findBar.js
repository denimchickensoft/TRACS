'use strict'

// Renderer script for findBar.html, the docs windows' Ctrl+F box. It lives
// in its own view over the docs page, not in the page, so Chromium's page
// search can't match, select or take focus from the box's own text.

const api   = window.findBar
const input = document.getElementById('query')
const count = document.getElementById('count')
let searchedText = ''

function search(forward) {
  const text = input.value
  if (!text) count.textContent = ''
  api.search(text, forward, text !== searchedText)
  searchedText = text
}

api.onResult(({ activeMatchOrdinal, matches }) => {
  count.textContent = matches ? `${activeMatchOrdinal} / ${matches}` : 'No matches'
})

// Opening (or Ctrl+F while open) selects the last query and searches it again.
api.onOpened(() => {
  input.focus()
  input.select()
  searchedText = ''
  if (input.value) search(true)
})

input.addEventListener('input', () => search(true))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); search(!e.shiftKey) }
  else if (e.key === 'Escape') { e.preventDefault(); api.close() }
  else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); input.select() }
})
document.getElementById('prev').addEventListener('click', () => search(false))
document.getElementById('next').addEventListener('click', () => search(true))
document.getElementById('close').addEventListener('click', () => api.close())

api.info().then(({ fontUrl }) => {
  if (!fontUrl) return
  new FontFace('Roboto Mono', `url("${fontUrl}")`).load()
    .then((face) => document.fonts.add(face))
    .catch(() => { /* keep the monospace fallback */ })
})
