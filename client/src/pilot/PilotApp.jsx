import { useState, useRef } from 'react'
import { connectPilotSession, disconnectPilotSession, fileFlightPlan, isPilotSessionConnected } from '../webrtc/pilotClient.js'
import './pilot.css'

const BLANK_FIELDS = { typ: '', eq: '', dep: '', dest: '', spd: '', alt: '', rte: '', rmk: '' }

export function PilotApp() {
  const [olympusUrl, setOlympusUrl] = useState('')
  const [password,   setPassword]   = useState('')
  const [aid,         setAid]        = useState('')
  const [fields,       setFields]    = useState(BLANK_FIELDS)

  const [status,  setStatus]  = useState('idle') // idle | connecting | filing | success | error
  const [message, setMessage] = useState('')
  const [resolved, setResolved] = useState(null) // { cid, bcn } once filed

  const connectedRef = useRef(false)

  function setField(key) {
    return (e) => setFields((f) => ({ ...f, [key]: e.target.value.toUpperCase() }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const normalizedAid = aid.trim().toUpperCase()
    if (!normalizedAid || !olympusUrl.trim()) return

    setStatus('connecting')
    setMessage('Connecting…')
    setResolved(null)

    try {
      if (!connectedRef.current) {
        await connectPilotSession({ olympusUrl: olympusUrl.trim(), password: password.trim() })
        connectedRef.current = true
      }

      setStatus('filing')
      setMessage('Filing flight plan…')

      const plan = await fileFlightPlan({ aid: normalizedAid, ...fields })

      setResolved({ cid: plan.cid, bcn: plan.bcn })
      setStatus('success')
      setMessage('Flight plan filed.')
    } catch (err) {
      setStatus('error')
      setMessage(err.message || 'Something went wrong.')
    }
  }

  function handleReset() {
    disconnectPilotSession()
    connectedRef.current = false
    setStatus('idle')
    setMessage('')
    setResolved(null)
  }

  // Pilots may only create a plan, never amend one they already filed -- once
  // this AID has been accepted, lock the form. Filing a different aircraft
  // means clearing the AID/fields and filing fresh (still over the same
  // connection; no need to rejoin the room).
  function handleFileAnother() {
    setAid('')
    setFields(BLANK_FIELDS)
    setStatus('idle')
    setMessage('')
    setResolved(null)
  }

  const busy   = status === 'connecting' || status === 'filing'
  const locked = status === 'success'

  return (
    <div className="pilot-page">
      <div className="pilot-panel">
        <div className="pilot-titlebar">
          <span className="pilot-title">TRACS — File a Flight Plan</span>
        </div>

        <form className="pilot-body" onSubmit={handleSubmit}>
          <div className="pilot-field">
            <label className="pilot-label">Olympus Server Address</label>
            <input
              className="pilot-input"
              value={olympusUrl}
              onChange={(e) => setOlympusUrl(e.target.value)}
              placeholder="e.g. 12.34.56.78:3001"
              disabled={busy || connectedRef.current}
            />
          </div>

          <div className="pilot-field">
            <label className="pilot-label">Session Password (if set)</label>
            <input
              className="pilot-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || connectedRef.current}
            />
          </div>

          <div className="pilot-field">
            <label className="pilot-label">Callsign / AID</label>
            <input
              className="pilot-input"
              value={aid}
              onChange={(e) => setAid(e.target.value.toUpperCase())}
              placeholder="ACID"
              maxLength={8}
              disabled={busy || locked}
            />
          </div>

          <div className="pilot-fields-row">
            <div className="pilot-field pilot-f-sm">
              <label className="pilot-label">TYP</label>
              <input className="pilot-input" value={fields.typ} onChange={setField('typ')} placeholder="F16" maxLength={4} disabled={busy || locked} />
            </div>
            <div className="pilot-field pilot-f-sm">
              <label className="pilot-label">EQ</label>
              <input className="pilot-input" value={fields.eq} onChange={setField('eq')} placeholder="S" maxLength={1} disabled={busy || locked} />
            </div>
            <div className="pilot-field pilot-f-sm">
              <label className="pilot-label">DEP</label>
              <input className="pilot-input" value={fields.dep} onChange={setField('dep')} placeholder="KDEP" maxLength={4} disabled={busy || locked} />
            </div>
            <div className="pilot-field pilot-f-sm">
              <label className="pilot-label">DEST</label>
              <input className="pilot-input" value={fields.dest} onChange={setField('dest')} placeholder="KDST" maxLength={4} disabled={busy || locked} />
            </div>
            <div className="pilot-field pilot-f-sm">
              <label className="pilot-label">SPD</label>
              <input className="pilot-input" value={fields.spd} onChange={setField('spd')} placeholder="280" maxLength={3} disabled={busy || locked} />
            </div>
            <div className="pilot-field pilot-f-sm">
              <label className="pilot-label">ALT</label>
              <input className="pilot-input" value={fields.alt} onChange={setField('alt')} placeholder="350" maxLength={3} disabled={busy || locked} />
            </div>
          </div>

          <div className="pilot-field">
            <label className="pilot-label">Route</label>
            <textarea className="pilot-textarea" value={fields.rte} onChange={setField('rte')} placeholder="ROUTE" maxLength={120} disabled={busy || locked} />
          </div>

          <div className="pilot-field">
            <label className="pilot-label">Remarks</label>
            <textarea className="pilot-textarea" value={fields.rmk} onChange={setField('rmk')} placeholder="REMARKS" maxLength={120} disabled={busy || locked} />
          </div>

          {message && (
            <div className={`pilot-status pilot-status-${status}`}>
              {message}
              {resolved && status === 'success' && (
                <span className="pilot-status-detail"> — CID {resolved.cid}, BCN {resolved.bcn}</span>
              )}
            </div>
          )}

          <div className="pilot-actions">
            {locked ? (
              <button type="button" className="pilot-btn-submit" onClick={handleFileAnother}>
                File Another Flight Plan
              </button>
            ) : (
              <button type="submit" className="pilot-btn-submit" disabled={busy || !aid.trim() || !olympusUrl.trim()}>
                File Flight Plan
              </button>
            )}
            {connectedRef.current && (
              <button type="button" className="pilot-btn-reset" onClick={handleReset} disabled={busy}>
                Disconnect
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
