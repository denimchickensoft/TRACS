import { useState, useRef, memo } from 'react'
import { isValidTime, isValidDecimal } from './statusBoardColumns.js'

// Set just before an arrow key click()s the next cell, so that cell opens with
// its text selected (Excel-style): the next Left/Right jumps straight on, and
// typing replaces the value. Click and Tab entry leave it unset.
let arrivedByArrow = false

// ── Inline-editable cell ──────────────────────────────────────────────────────
export const EditableCell = memo(function EditableCell({
  value, onCommit, maxLen, readOnly, inputW,
  digitsOnly = false, padZero = 0, decimalFmt = false, timeValidate = false, decimalValidate = false,
  radialFmt = false,
  cellIdx, entryId, onInsertBelow, rowStride, colIdx,
  alert = false, onDoubleClick,
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const selectOnOpenRef = useRef(false)

  const start = () => {
    if (readOnly) return
    selectOnOpenRef.current = arrivedByArrow
    arrivedByArrow = false
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
    // Unchanged values aren't committed: every commit re-saves and re-broadcasts
    // the whole board, which moving through cells would otherwise spam.
    if (v !== value) onCommit(v)
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

  // Arrow-key move to an exact cell index. Returns false at the table's edge
  // (no such cell) so the caller can leave this cell open instead.
  const navigateTo = (targetIdx) => {
    if (!document.querySelector(`[data-sbcellidx="${targetIdx}"]`)) return false
    commit()
    setTimeout(() => {
      arrivedByArrow = true
      document.querySelector(`[data-sbcellidx="${targetIdx}"]`)?.click()
      arrivedByArrow = false
    }, 0)
    return true
  }

  const handleArrow = (e) => {
    const { selectionStart: s0, selectionEnd: s1, value: text } = e.target
    const allSelected = s0 === 0 && s1 === text.length
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      navigateTo(cellIdx + (e.key === 'ArrowUp' ? -rowStride : rowStride))
      return
    }
    // Left/Right move the caret, and only leave the cell from its start/end
    // (or when the whole text is selected), stopping at the row's ends.
    if (e.key === 'ArrowLeft' && colIdx > 0 && (allSelected || (s0 === 0 && s1 === 0))) {
      e.preventDefault()
      navigateTo(cellIdx - 1)
    } else if (e.key === 'ArrowRight' && colIdx < rowStride - 1 && (allSelected || (s0 === text.length && s1 === text.length))) {
      e.preventDefault()
      navigateTo(cellIdx + 1)
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        ref={(el) => {
          if (el && selectOnOpenRef.current) { selectOnOpenRef.current = false; el.select() }
        }}
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
          if (e.key === 'Escape')              { setEditing(false); return }
          if (rowStride && e.key.startsWith('Arrow')) handleArrow(e)
        }}
      />
    )
  }

  const invalid = (timeValidate && !isValidTime(value)) || (decimalValidate && !isValidDecimal(value))
  const cls = [
    'sb-cell', readOnly ? 'readonly' : '', !value ? 'empty' : '',
    invalid ? 'invalid' : alert ? 'alert' : '', onDoubleClick ? 'dblclick' : '',
  ].join(' ').replace(/\s+/g, ' ').trim()
  return (
    <span
      className={cls}
      data-sbcellidx={readOnly ? undefined : cellIdx}
      data-sbentryid={readOnly ? undefined : entryId}
      onClick={start}
      onDoubleClick={onDoubleClick}
    >
      {value || ' '}
    </span>
  )
})
