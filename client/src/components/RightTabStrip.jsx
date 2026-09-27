// The thin vertical tab strip on the right edge of each module's layout.
// Clicking a tab toggles its docked panel; while a panel is popped out into
// its own window, its label gains " ↗" and clicking it focuses that window.
//
// tabs: [{ key, name, docked, popupRef }]
export function RightTabStrip({ tabs, active, setActive, background = '#0a0a0a' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '18px', background, borderLeft: '1px solid #1a1a1a', flexShrink: 0 }}>
      {tabs.map(({ key, name, docked, popupRef }) => {
        const label = docked ? name : `${name} ↗`
        const onClick = () => {
          if (!docked && popupRef.current) popupRef.current.focus()
          else setActive((p) => (p === key ? null : key))
        }
        return (
          <div
            key={key}
            title={label}
            onClick={onClick}
            style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', borderBottom: '1px solid #1a1a1a', background: active === key ? '#141414' : 'transparent' }}
          >
            <span style={{ writingMode: 'vertical-rl', fontSize: '8px', letterSpacing: '0.1em', color: active === key ? '#555' : '#2a2a2a', textTransform: 'uppercase', userSelect: 'none' }}>{label}</span>
          </div>
        )
      })}
    </div>
  )
}
