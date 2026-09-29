import { useEffect, useRef } from 'react'

// The thin vertical tab strip on the right edge of each module's layout.
// Clicking a tab toggles its docked panel; while a panel is popped out into
// its own window, its label gains " ↗" and clicking it focuses that window.
//
// Keyboard (ignored while typing in a text box):
//   Ctrl+Left   reopen the last-used panel, or bring its window to the front
//               if it's popped out
//   Ctrl+Right  close the open panel
//   Ctrl+Up/Down  switch to the previous/next docked panel, wrapping at the
//               ends; with no panel open, reopen the last-used one
//
// tabs: [{ key, name, docked, popupRef }]

// Last-used tab per module for this session, keyed by the module's tab
// names so it survives switching modules (which remounts the strip).
const lastUsedByStrip = new Map()

function isTextEntry(el) {
  return !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}

export function RightTabStrip({ tabs, active, setActive, background = '#0a0a0a' }) {
  const stripId = tabs.map((t) => t.name).join('|')
  if (active != null) lastUsedByStrip.set(stripId, active)

  const activate = ({ key, docked, popupRef }) => {
    if (!docked && popupRef.current) popupRef.current.focus()
    else setActive((p) => (p === key ? null : key))
  }

  const lastUsed = () => tabs.find((t) => t.key === lastUsedByStrip.get(stripId))

  // Latest tabs/active for the window listener, which is bound once.
  const arrowRef = useRef(null)
  arrowRef.current = (key) => {
    if (key === 'ArrowRight') { setActive(null); return }
    if (key === 'ArrowLeft') {
      const last = lastUsed() ?? tabs[0]
      if (!last.docked && last.popupRef.current) last.popupRef.current.focus()
      else setActive(last.key)
      return
    }
    const step = key === 'ArrowDown' ? 1 : -1
    let from = tabs.findIndex((t) => t.key === active)
    if (from === -1) {
      const last = lastUsed()
      if (last?.docked) { setActive(last.key); return }
      if (!last) {
        const first = step === 1 ? tabs.find((t) => t.docked) : tabs.findLast((t) => t.docked)
        if (first) setActive(first.key)
        return
      }
      from = tabs.indexOf(last) // popped out: carry on to the next docked one
    }
    for (let i = 1; i < tabs.length; i++) {
      const t = tabs[(from + step * i + tabs.length) % tabs.length]
      if (t.docked) { setActive(t.key); return }
    }
  }

  // Capture phase, so a scope's own keydown handling (e.g. stopPropagation)
  // can't swallow it.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.repeat) return
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
      if (isTextEntry(e.target)) return
      e.preventDefault()
      arrowRef.current(e.key)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background, borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
      {tabs.map((tab) => {
        const { key, name, docked } = tab
        const label = docked ? name : `${name} ↗`
        return (
          <div
            key={key}
            title={`${label} (Ctrl+↑/↓ to cycle)`}
            onClick={() => activate(tab)}
            style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #1a1a1a', background: active === key ? '#141414' : 'transparent' }}
          >
            <span style={{ writingMode: 'vertical-rl', fontSize: '10px', letterSpacing: '0.1em', color: active === key ? '#ccc' : '#777', textTransform: 'uppercase', userSelect: 'none' }}>{label}</span>
          </div>
        )
      })}
    </div>
  )
}
