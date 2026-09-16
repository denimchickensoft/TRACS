import { useState } from 'react'
import { isValidTime } from './statusBoardColumns.js'

// ── Inline-editable header field ──────────────────────────────────────────────
export function HeaderField({ label, value, onChange, inputW = 40, readOnly = false, maxLen, digitsOnly = false, padZero = 0, timeValidate = false, flash = false, hdrIdx }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')

  const start = () => {
    if (readOnly) return
    setDraft(value)
    setEditing(true)
  }
  const commit = () => {
    let v = draft
    if (padZero && v.length > 0) v = v.padStart(padZero, '0')
    onChange(v)
    setEditing(false)
  }

  const handleChange = (e) => {
    let v = e.target.value.toUpperCase()
    if (digitsOnly) v = v.replace(/\D/g, '')
    setDraft(v)
  }

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
    <div className={['sb-field', flash ? 'sb-field--alert' : ''].filter(Boolean).join(' ')}>
      <span className="sb-label">{label}</span>
      {editing ? (
        <input
          autoFocus
          className="sb-input"
          style={{ '--input-w': `${inputW}px` }}
          value={draft}
          maxLength={maxLen}
          onChange={handleChange}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Tab')    { e.preventDefault(); commit(); navigateHdrTab(e.shiftKey); return }
            if (e.key === 'Enter')  { commit(); return }
            if (e.key === 'Escape') { setEditing(false) }
          }}
        />
      ) : (
        <span
          className={['sb-value', readOnly ? 'readonly' : '', !value ? 'empty' : '', (timeValidate && !isValidTime(value)) ? 'invalid' : '', flash ? 'alert' : ''].join(' ').trim()}
          data-sbhdridx={readOnly ? undefined : hdrIdx}
          onClick={start}
        >
          {value || '——'}
        </span>
      )}
    </div>
  )
}
