'use strict'

// Renderer script for portConflict.html. Everything shown comes from main via
// the preload, and is set with textContent only.

const api = window.portConflict
const $   = (id) => document.getElementById(id)

function ownerText(port, owner) {
  return owner
    ? `Port ${port} is already in use by ${owner}.`
    : `Port ${port} is in use by another program, or reserved by the system.`
}

function render({ port, fallback, owner }) {
  $('title').textContent = `Port ${port} is in use`
  $('owner').textContent = ownerText(port, owner)
  if (fallback) {
    $('fallback-text').textContent = `Or use port ${fallback} for this session only. TRACS starts without your saved settings; they come back the next time port ${port} is free.`
    $('fallback').textContent = `Use port ${fallback} this session`
    $('fallback').hidden = false
  } else {
    $('fallback-text').textContent = 'No other nearby port is free either.'
    $('fallback').hidden = true
  }
}

function fit() {
  api.resize(Math.ceil(document.documentElement.getBoundingClientRect().height))
}

function setBusy(busy) {
  for (const id of ['quit', 'fallback', 'retry']) $(id).disabled = busy
}

async function start() {
  const info = await api.info()
  if (info.fontUrl) {
    try {
      const face = new FontFace('Roboto Mono', `url("${info.fontUrl}")`)
      document.fonts.add(await face.load())
    } catch { /* keep the monospace fallback */ }
  }
  render(info)
  fit()
}

$('retry').addEventListener('click', async () => {
  setBusy(true)
  const result = await api.retry()
  setBusy(false)
  if (result.free) return
  render(result)
  $('error').textContent = `Port ${result.port} is still in use.`
  $('error').hidden = false
  fit()
})
$('fallback').addEventListener('click', () => { setBusy(true); api.fallback() })
$('quit').addEventListener('click', () => { setBusy(true); api.quit() })

start()
