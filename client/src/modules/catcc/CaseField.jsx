import { useState } from 'react'

// ── CASE L / CASE R field: renders "CASE [1-char] LAUNCH/RECOVERY" ────────────
export function CaseField({ suffix, value, onChange, hdrIdx }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')

  const start = () => { setDraft(value); setEditing(true) }
  const commit = () => { onChange(draft); setEditing(false) }

  const navigateHdrTab = (shiftKey) => {
    const idx = hdrIdx
    setTimeout(() => {
      const fields = [...document.querySelectorAll('[data-sbhdridx]')]
        .sort((a, b) => +a.dataset.sbhdridx - +b.dataset.sbhdridx)
      const pos = fields.findIndex(el => +el.dataset.sbhdridx === idx)
      if (pos === -1) return
      fields[(pos + (shiftKey ? -1 : 1) + fields.length) % fields.length]?.click()
    }, 0)
  }

  return (
    <div className="sb-field">
      <span className="sb-label">CASE</span>
      {editing ? (
        <input
          autoFocus
          className="sb-case-input"
          value={draft}
          maxLength={1}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Tab')    { e.preventDefault(); commit(); navigateHdrTab(e.shiftKey); return }
            if (e.key === 'Enter')  { commit(); return }
            if (e.key === 'Escape') { setEditing(false) }
          }}
        />
      ) : (
        <span
          className={['sb-case-value', !value ? 'empty' : ''].join(' ').trim()}
          data-sbhdridx={hdrIdx}
          onClick={start}
        >
          {value || '_'}
        </span>
      )}
      <span className="sb-case-suffix">{suffix}</span>
    </div>
  )
}
