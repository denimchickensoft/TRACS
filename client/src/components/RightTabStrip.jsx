import { useEffect, useRef } from 'react'

// The thin vertical tab strip on the right edge of each module's layout.
// Clicking a tab toggles its docked panel; while a panel is popped out into
// its own window, its label gains " ↗" and clicking it focuses that window.
// Ctrl+Shift+1/2/3 act as a click on the first/second/third tab.
//
// tabs: [{ key, name, docked, popupRef }]
export function RightTabStrip({ tabs, active, setActive, background = '#0a0a0a' }) {
  const activate = ({ key, docked, popupRef }) => {
    if (!docked && popupRef.current) popupRef.current.focus()
    else setActive((p) => (p === key ? null : key))
  }

  // Latest tabs/setActive for the window listener, which is bound once.
  const activateRef = useRef(null)
  activateRef.current = (n) => { if (tabs[n]) activate(tabs[n]) }

  // Capture phase, so a scope's own keydown handling (e.g. stopPropagation)
  // can't swallow it. e.code keeps it layout-independent: Shift+1 types "!"
  // on most layouts.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.repeat) return
      const m = /^Digit([1-9])$/.exec(e.code ?? '')
      if (!m) return
      e.preventDefault()
      activateRef.current(Number(m[1]) - 1)
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
            title={`${label} (Ctrl+Shift+${tabs.indexOf(tab) + 1})`}
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
