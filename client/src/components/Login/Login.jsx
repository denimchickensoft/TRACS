import { useState, useEffect } from 'react'
import { useSessionStore } from '../../store/session'
import { ConnectPhase } from './ConnectPhase'
import { PositionPhase } from './PositionPhase'
import './Login.css'

// ── Root login shell ──────────────────────────────────────────────────────────
export function Login() {
  const connected   = useSessionStore((s) => s.connected)

  const [phase, setPhase] = useState(connected ? 'position' : 'connect')

  useEffect(() => {
    if (!connected) setPhase('connect')
  }, [connected])

  return (
    <div className="login-root">
      <div className="login-stack">
        <div className="login-panel">
          <header className="login-header">
            <h1>TRACS</h1>
            <p>Tactical Radar And Control Suite</p>
            {phase === 'position' && (
              <p className="login-phase-label">Sign In to Position</p>
            )}
          </header>

          {phase === 'connect'
            ? <ConnectPhase  onConnected={() => setPhase('position')} />
            : <PositionPhase onSignedIn={() => {}} />
          }
        </div>

        {/* OSM credit shown at startup, per the OSMF attribution guidelines;
            the full ODbL notice is on the Third-party notices page. Sits just
            under the login box, at its width. */}
        <p className="login-attribution">© OpenStreetMap data was harmed in the making of this app.</p>
      </div>
    </div>
  )
}
