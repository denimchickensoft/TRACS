import { useState, memo } from 'react'
import { isValidTime, isValidDecimal } from './statusBoardColumns.js'

// ── Inline-editable cell ──────────────────────────────────────────────────────
export const EditableCell = memo(function EditableCell({
  value, onCommit, maxLen, readOnly, inputW,
  digitsOnly = false, padZero = 0, decimalFmt = false, timeValidate = false, decimalValidate = false,
  radialFmt = false,
  cellIdx, entryId, onInsertBelow,
}) {
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
    if (decimalFmt && v.length > 0) {
      if (!v.includes('.')) v = v + '.0'
      if (v.startsWith('.')) v = '0' + v
    }
    if (radialFmt && v === '000') v = '360'
    onCommit(v)
    setEditing(false)
  }
  const handleChange = (e) => {
    let v = e.target.value.toUpperCase()
    if (digitsOnly)  v = v.replace(/\D/g, '')
    if (decimalFmt)  v = v.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1')
    setDraft(v)
  }

  const navigateTab = (shiftKey) => {
    const idx = cellIdx
    setTimeout(() => {
      const cells = [...document.querySelectorAll('[data-sbcellidx]')]
        .sort((a, b) => +a.dataset.sbcellidx - +b.dataset.sbcellidx)
      const pos  = cells.findIndex(el => +el.dataset.sbcellidx === idx)
      if (pos === -1) return
      const next = cells[(pos + (shiftKey ? -1 : 1) + cells.length) % cells.length]
      next?.click()
    }, 0)
  }

  if (editing) {
    return (
      <input
        autoFocus
        className="sb-cell-input"
        style={{ width: inputW }}
        value={draft}
        maxLength={maxLen}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Tab')                 { e.preventDefault(); commit(); navigateTab(e.shiftKey); return }
          if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); commit(); onInsertBelow?.(); return }
          if (e.key === 'Enter')               { commit(); return }
          if (e.key === 'Escape')              { setEditing(false) }
        }}
      />
    )
  }

  const invalid = (timeValidate && !isValidTime(value)) || (decimalValidate && !isValidDecimal(value))
  const cls = ['sb-cell', readOnly ? 'readonly' : '', !value ? 'empty' : '', invalid ? 'invalid' : ''].join(' ').trim()
  return (
    <span
      className={cls}
      data-sbcellidx={readOnly ? undefined : cellIdx}
      data-sbentryid={readOnly ? undefined : entryId}
      onClick={start}
    >
      {value || ' '}
    </span>
  )
})
