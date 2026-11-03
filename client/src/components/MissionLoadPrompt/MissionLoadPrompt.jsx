import { useState } from 'react'
import { loadArea, setIgnored } from '../../missionData/load.js'
import './MissionLoadPrompt.css'

// The one prompt per mission (Settings > Auto-load mission: Ask): the
// areas of this position with something new in the running mission, all
// ticked. Load adds the ticked ones; Ignore leaves this mission alone until
// a different one loads. Opened from Settings > Force Load
// (prompt.manual) it offers Cancel instead, which ignores nothing.
export function MissionLoadPrompt({ prompt, onClose }) {
  const [checked, setChecked] = useState(() => new Set(prompt.pending.map((p) => p.area.key)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const toggle = (key) => setChecked((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const load = async () => {
    setBusy(true)
    setError('')
    const failed = []
    for (const { area } of prompt.pending) {
      if (!checked.has(area.key)) continue
      try {
        await loadArea(area, prompt.ctx)
      } catch (err) {
        console.warn(`[missionData] ${area.key}: ${err?.message ?? err}`)
        failed.push(area.label)
      }
    }
    setBusy(false)
    if (failed.length) setError(`Could not load: ${failed.join(', ')}`)
    else onClose()
  }

  const ignore = () => {
    if (!prompt.manual) setIgnored(prompt.ctx.id)
    onClose()
  }

  return (
    <div className="mlp-overlay">
      <div className="mlp-modal" role="dialog" aria-label="Load mission data">
        <div className="mlp-header">LOAD MISSION DATA</div>
        <div className="mlp-body">
          <div className="mlp-intro">The running DCS mission has data for this position:</div>
          {prompt.pending.map(({ area, diff }) => (
            <label key={area.key} className="mlp-row">
              <input type="checkbox" checked={checked.has(area.key)} onChange={() => toggle(area.key)} disabled={busy} />
              <span className="mlp-label">{area.label}</span>
              <span className="mlp-summary">{diff.summary}</span>
            </label>
          ))}
          <div className="mlp-hint">Only adds what isn&apos;t loaded yet. Settings &gt; Auto-load mission changes whether this asks.</div>
          {error && <div className="mlp-error">{error}</div>}
        </div>
        <div className="mlp-actions">
          <button className="mlp-btn" onClick={ignore} disabled={busy}>{prompt.manual ? 'Cancel' : 'Ignore'}</button>
          <button className="mlp-btn primary" onClick={load} disabled={busy || checked.size === 0}>{busy ? 'Loading…' : 'Load'}</button>
        </div>
      </div>
    </div>
  )
}
