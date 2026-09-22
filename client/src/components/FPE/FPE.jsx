import { useState, useEffect, useRef, useCallback } from 'react'
import { useFpeStore }          from '../../store/fpe.js'
import { useFlightPlansStore }  from '../../store/flightPlans.js'
import { useStripsStore, STRIP_HIGHLIGHT } from '../../store/strips.js'
import { sendWebrtcEvent }      from '../../webrtc/client.js'
import { AID_MAX_LEN }          from '../../utils/callsign.js'
import './FPE.css'

// 4 octal digits (0-7) — matches utils/bcn.js's generateBcn() output shape.
// A partial code (e.g. "634") or one containing 8/9 is never a valid squawk.
const BCN_RE = /^[0-7]{4}$/

// Aircraft type designators are plain alphanumeric (e.g. F16, FA18, A10) --
// strip hyphens/slashes/etc a controller might type from the in-sim name
// (F-15, F/A-18C) rather than the ICAO-style designator.
function sanitizeTyp(value) {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// ── Draggable panel ───────────────────────────────────────────────────────────
function useDrag(panelRef) {
  const dragState = useRef({ dragging: false, ox: 0, oy: 0 })
  const [pos, setPos] = useState(null)  // null = CSS-centered default

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const panel = panelRef.current
    if (!panel) return
    const panelRect   = panel.getBoundingClientRect()
    const overlayRect = panel.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
    dragState.current = {
      dragging: true,
      ox: e.clientX - (panelRect.left - overlayRect.left),
      oy: e.clientY - (panelRect.top  - overlayRect.top),
    }
  }, [panelRef])

  useEffect(() => {
    function onMouseMove(e) {
      if (!dragState.current.dragging) return
      setPos({ x: e.clientX - dragState.current.ox, y: e.clientY - dragState.current.oy })
    }
    function onMouseUp() { dragState.current.dragging = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup',   onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup',   onMouseUp)
    }
  }, [])

  return { pos, onMouseDown }
}

// ── FPE component ─────────────────────────────────────────────────────────────
export function FPE({ scope = null }) {
  const { open, scope: storeScope, aid: prefillAid, unitId, readOnly, closeFpe } = useFpeStore()
  const { plans, add, amend, recycleBcn, remove } = useFlightPlansStore()
  const { addStrip, setHighlight } = useStripsStore()

  const panelRef = useRef(null)
  const { pos, onMouseDown } = useDrag(panelRef)
  const aidInputRef = useRef(null)

  // ── Form state ────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [aid,  setAid]  = useState('')
  const [cid,  setCid]  = useState('')
  const [bcn,  setBcn]  = useState('')
  const [typ,  setTyp]  = useState('')
  const [eq,   setEq]   = useState('')
  const [dep,  setDep]  = useState('')
  const [dest, setDest] = useState('')
  const [spd,  setSpd]  = useState('')
  const [alt,  setAlt]  = useState('')
  const [rte,  setRte]  = useState('')
  const [rmk,  setRmk]  = useState('')

  const isExisting = !!(aid && plans[aid])

  // Populate form when FPE opens or when the plan changes externally
  useEffect(() => {
    if (!open) return
    setConfirmDelete(false)
    // Match the AID field's own maxLength (AID_MAX_LEN) — otherwise a ctrl-click
    // prefill (which sets this state programmatically, bypassing the
    // input's typing limit) can produce a longer AID than a controller
    // could ever type by hand for the same aircraft, silently diverging
    // into two different flight plans for one contact.
    const upperAid = (prefillAid?.toUpperCase() ?? '').slice(0, AID_MAX_LEN)
    const plan = plans[upperAid]

    setAid(upperAid)
    if (plan) {
      setCid(plan.cid   ?? '')
      setBcn(plan.bcn   ?? '')
      setTyp(sanitizeTyp(plan.typ))
      setEq(plan.eq     ?? '')
      setDep(plan.dep   ?? '')
      setDest(plan.dest ?? '')
      setSpd(plan.spd   ?? '')
      setAlt(plan.alt   ?? '')
      setRte(plan.rte   ?? '')
      setRmk(plan.rmk   ?? '')
    } else {
      setCid(''); setBcn(''); setTyp(''); setEq('')
      setDep(''); setDest(''); setSpd(''); setAlt(''); setRte(''); setRmk('')
    }

    setTimeout(() => {
      aidInputRef.current?.focus()
    }, 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally not watching plans, live update handled below
  }, [open, prefillAid])

  // Close on Escape
  useEffect(() => {
    if (!open || scope !== storeScope) return
    function onKeyDown(e) {
      if (e.key === 'Escape') closeFpe()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, storeScope, scope, closeFpe])

  // Live update: if plan changes externally while FPE is open, refresh fields.
  // Deliberately omits 'open' from deps — on-open init is handled by the populate
  // effect above. Including 'open' causes a race where this effect fires with the
  // stale 'aid' from the previous session and repopulates fields from the wrong plan.
  useEffect(() => {
    if (!open || !aid) return
    const plan = plans[aid]
    if (!plan) return
    setCid(plan.cid   ?? '')
    setBcn(plan.bcn   ?? '')
    setTyp(sanitizeTyp(plan.typ))
    setEq(plan.eq     ?? '')
    setDep(plan.dep   ?? '')
    setDest(plan.dest ?? '')
    setSpd(plan.spd   ?? '')
    setAlt(plan.alt   ?? '')
    setRte(plan.rte   ?? '')
    setRmk(plan.rmk   ?? '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, aid])

  // Explicit, rather than relying on the browser's implicit form-submission
  // behavior (which button it picks can be inconsistent when a form has
  // several type="button" siblings, e.g. BCN's Recycle button) — Enter here
  // always amends, never anything else, matching textareaKeyDown below.
  function inputKeyDown(setter) {
    return (e) => {
      // stopPropagation, not just preventDefault: handleAmend closes the FPE
      // (useFpeStore's open -> false) before this event finishes bubbling to
      // InputHandler.jsx's document-level listener, so its "FPE takes
      // precedence while open" guard no longer holds by the time it checks —
      // without this the same Enter gets re-evaluated as a STARS command.
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleAmend(e); return }
      // Escape deliberately does NOT stopPropagation — it's meant to both
      // clear this field and (via bubbling to the document-level "Close on
      // Escape" listener below) close the whole FPE in the same keypress.
      if (e.key === 'Escape') { e.preventDefault(); setter('') }
    }
  }

  function textareaKeyDown(setter) {
    return (e) => {
      if (e.key === 'Enter') { e.stopPropagation(); handleAmend(e); return }
      // No stopPropagation — same dual clear-and-close as inputKeyDown's Escape.
      if (e.key === 'Escape') { e.preventDefault(); setter('') }
    }
  }

  function handleAltBlur() {
    if (!alt) return
    const num = parseInt(alt, 10)
    if (!isNaN(num)) setAlt(String(num).padStart(3, '0'))
  }

  function handleRteBlur() {
    setRte((v) => v.replace(/\bDCT\b/g, '').replace(/\s{2,}/g, ' ').trim())
  }

  function handleRecycle() {
    if (!aid || !plans[aid]) return
    recycleBcn(aid)
  }

  function handleDelete() {
    remove(aid)
    sendWebrtcEvent('FLIGHT_PLAN_DELETE', { aid })
    closeFpe()
  }

  function handleAmend(e) {
    e.preventDefault()
    const normalizedAid = aid.trim().toUpperCase()
    if (!normalizedAid) return
    // Empty is fine (auto-generates on create, leaves it unchanged on
    // amend) — anything else must be a complete, valid code. A partial
    // digit count or an 8/9 sneaking in some other way (e.g. a synced
    // value) must never be saved.
    if (bcn && !BCN_RE.test(bcn)) return

    const cleanRte = rte.replace(/\s+DCT\s+/g, ' ').trim()

    if (plans[normalizedAid]) {
      // Backfill/update unitId when the FPE was opened via ctrl-click on a
      // specific contact — otherwise a plan filed without a unit link (e.g.
      // entered manually before radar correlation) never gains one just by a
      // controller later ctrl-clicking the matching target into an amend.
      // A hand-edited ALT supersedes a ++### scope amendment, so the
      // datablock's R### readout goes away with it.
      const altChanged = alt !== (plans[normalizedAid].alt ?? '')
      amend(normalizedAid, { typ, eq, dep, dest, spd, alt, rte: cleanRte, rmk, bcn,
             ...(altChanged ? { altAmended: false } : {}),
             ...(unitId ? { unitId } : {}) })
      setHighlight(normalizedAid, STRIP_HIGHLIGHT.AMENDED)
      // Broadcast the resolved plan (not the raw form fields) so every peer
      // converges on the same object rather than each applying its own patch.
      sendWebrtcEvent('FLIGHT_PLAN_AMEND', useFlightPlansStore.getState().plans[normalizedAid])
    } else {
      // bcn included so a controller's typed code on a brand-new plan isn't
      // silently discarded in favor of add()'s auto-generated one.
      add({ aid: normalizedAid, typ, eq, dep, dest, spd, alt, rte: cleanRte, rmk,
            ...(bcn ? { bcn } : {}),
            ...(unitId ? { unitId } : {}) })
      addStrip(normalizedAid, { highlight: STRIP_HIGHLIGHT.AUTO_ADDED, unitId: unitId ?? null })
      // Broadcast the resolved plan so receivers reuse this instance's
      // generated CID/BCN instead of minting their own via fps.add().
      sendWebrtcEvent('FLIGHT_PLAN_CREATE', useFlightPlansStore.getState().plans[normalizedAid])
    }

    closeFpe()
  }

  if (!open || scope !== storeScope) return null

  const panelStyle = pos
    ? { left: pos.x, top: pos.y, transform: 'none' }
    : {}

  const disabled = readOnly

  return (
    <div className="fpe-overlay">
      <div className="fpe-panel" ref={panelRef} style={panelStyle}>

        {/* Title bar */}
        <div className="fpe-titlebar" onMouseDown={onMouseDown}>
          <span className="fpe-title">Flight Plan Editor</span>
          {readOnly && <span className="fpe-readonly-badge">READ ONLY</span>}
          <button className="fpe-close" onClick={closeFpe} onMouseDown={(e) => e.stopPropagation()}>×</button>
        </div>

        <form className="fpe-body" onSubmit={handleAmend}>

          {/* Single row: AID CID BCN TYP EQ DEP DEST SPD ALT */}
          <div className="fpe-fields-row">

            <div className="fpe-f fpe-f-aid">
              <label className="fpe-label">AID</label>
              <input
                ref={aidInputRef}
                className="fpe-input"
                value={aid}
                onChange={(e) => setAid(e.target.value.toUpperCase())}
                onKeyDown={inputKeyDown(setAid)}
                readOnly={isExisting || disabled}
                placeholder="ACID"
                maxLength={AID_MAX_LEN}
              />
            </div>

            <div className="fpe-f fpe-f-cid">
              <label className="fpe-label">CID</label>
              <input className="fpe-input" value={cid} readOnly placeholder="—" />
            </div>

            <div className="fpe-f fpe-f-bcn">
              <label className="fpe-label">BCN</label>
              <div className="fpe-bcn-wrap">
                <input
                  className="fpe-input"
                  value={bcn}
                  onChange={(e) => setBcn(e.target.value.replace(/[^0-7]/g, '').slice(0, 4))}
                  onKeyDown={inputKeyDown(setBcn)}
                  readOnly={disabled}
                  placeholder="----"
                  maxLength={4}
                />
                <button
                  type="button"
                  className="fpe-recycle"
                  onClick={handleRecycle}
                  disabled={disabled || !isExisting}
                  title="Recycle BCN"
                >↻</button>
              </div>
            </div>

            <div className="fpe-f fpe-f-typ">
              <label className="fpe-label">TYP</label>
              <input
                className="fpe-input"
                value={typ}
                onChange={(e) => setTyp(sanitizeTyp(e.target.value))}
                onKeyDown={inputKeyDown(setTyp)}
                readOnly={disabled}
                placeholder="F16"
                maxLength={4}
              />
            </div>

            <div className="fpe-f fpe-f-eq">
              <label className="fpe-label">EQ</label>
              <input
                className="fpe-input"
                value={eq}
                onChange={(e) => setEq(e.target.value.toUpperCase())}
                onKeyDown={inputKeyDown(setEq)}
                readOnly={disabled}
                placeholder="S"
                maxLength={1}
              />
            </div>

            <div className="fpe-f fpe-f-dep">
              <label className="fpe-label">DEP</label>
              <input
                className="fpe-input"
                value={dep}
                onChange={(e) => setDep(e.target.value.toUpperCase())}
                onKeyDown={inputKeyDown(setDep)}
                readOnly={disabled}
                placeholder="KDEP"
                maxLength={4}
              />
            </div>

            <div className="fpe-f fpe-f-dest">
              <label className="fpe-label">DEST</label>
              <input
                className="fpe-input"
                value={dest}
                onChange={(e) => setDest(e.target.value.toUpperCase())}
                onKeyDown={inputKeyDown(setDest)}
                readOnly={disabled}
                placeholder="KDST"
                maxLength={4}
              />
            </div>

            <div className="fpe-f fpe-f-spd">
              <label className="fpe-label">SPD</label>
              <input
                className="fpe-input"
                value={spd}
                onChange={(e) => setSpd(e.target.value.toUpperCase())}
                onKeyDown={inputKeyDown(setSpd)}
                readOnly={disabled}
                placeholder="280"
                maxLength={3}
              />
            </div>

            <div className="fpe-f fpe-f-alt">
              <label className="fpe-label">ALT</label>
              <input
                className="fpe-input"
                value={alt}
                onChange={(e) => setAlt(e.target.value.toUpperCase())}
                onKeyDown={inputKeyDown(setAlt)}
                onBlur={handleAltBlur}
                readOnly={disabled}
                placeholder="350"
                maxLength={3}
              />
            </div>

          </div>

          {/* RTE */}
          <div className="fpe-textarea-row">
            <label className="fpe-label">RTE</label>
            <textarea
              className="fpe-textarea"
              value={rte}
              onChange={(e) => setRte(e.target.value.toUpperCase())}
              onKeyDown={textareaKeyDown(setRte)}
              onBlur={handleRteBlur}
              readOnly={disabled}
              placeholder="ROUTE"
              maxLength={120}
            />
          </div>

          {/* RMK */}
          <div className="fpe-textarea-row">
            <label className="fpe-label">RMK</label>
            <textarea
              className="fpe-textarea"
              value={rmk}
              onChange={(e) => setRmk(e.target.value.toUpperCase())}
              onKeyDown={textareaKeyDown(setRmk)}
              readOnly={disabled}
              placeholder="REMARKS"
              maxLength={120}
            />
          </div>

          <hr className="fpe-divider" />

          <div className="fpe-actions">
            {confirmDelete ? (
              <>
                <button type="button" className="fpe-btn-cancel" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button type="button" className="fpe-btn-confirm" onClick={handleDelete}>Confirm Delete</button>
              </>
            ) : (
              <>
                <button type="button" className="fpe-btn-cancel" onClick={closeFpe}>Cancel</button>
                <button type="submit" className="fpe-btn-amend" disabled={disabled || !aid.trim() || (bcn && !BCN_RE.test(bcn))}>
                  {isExisting ? 'Amend' : 'Create'}
                </button>
                {isExisting && !disabled && (
                  <button type="button" className="fpe-btn-delete" onClick={() => setConfirmDelete(true)}>Delete</button>
                )}
              </>
            )}
          </div>

        </form>
      </div>
    </div>
  )
}
