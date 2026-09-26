import { useLnmStore, dismissLnmPrompt } from '../../store/lnm.js'

const buttonStyle = {
  background:   '#222',
  border:       '1px solid #444',
  borderRadius: '3px',
  color:        '#ccc',
  padding:      '5px 12px',
  cursor:       'pointer',
  fontFamily:   'inherit',
  fontSize:     '0.75rem',
}

// Explains what the LittleNavMap database is and lets the operator pick it,
// skip for now, or stop being asked. Shows extraction progress and the
// server's real error message. Desktop app only (needs the native file
// picker). `firstRun` adds the "don't ask again" choice.
export function LnmSetupDialog({ firstRun, onClose }) {
  const lnmDbPath  = useLnmStore((s) => s.lnmDbPath)
  const busy       = useLnmStore((s) => s.busy)
  const error      = useLnmStore((s) => s.error)
  const setDbPath  = useLnmStore((s) => s.setDbPath)
  const configured = typeof lnmDbPath === 'string'

  async function chooseFile() {
    const path = await window.electronAPI.pickLnmDatabase()
    if (path) await setDbPath(path)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1a1a1a', border: '1px solid #333', borderRadius: '4px',
        padding: '18px 22px', maxWidth: '520px', color: '#aaa', fontSize: '0.8rem', lineHeight: 1.5,
      }}>
        <div style={{ color: '#ddd', fontSize: '0.9rem', marginBottom: '10px' }}>Navigation data</div>

        <p style={{ margin: '0 0 8px' }}>
          Fixes, navaids, airways and procedures come from your own LittleNavMap
          Navigraph database (a <code>.sqlite</code> file). TRACS reads it locally and
          never uploads or redistributes it. Without it, those layers are unavailable
          and everything else still works.
        </p>
        <p style={{ margin: '0 0 12px' }}>
          LittleNavMap usually keeps it at<br />
          <code style={{ color: '#ccc', wordBreak: 'break-all' }}>
            %APPDATA%\ABarthel\little_navmap_db\little_navmap_navigraph.sqlite
          </code>
        </p>

        {configured && !busy && !error && (
          <p style={{ margin: '0 0 12px', color: '#8c8' }}>
            Using <code style={{ wordBreak: 'break-all' }}>{lnmDbPath}</code>.
            {' '}A change takes effect the next time you sign in to a position.
          </p>
        )}
        {busy && (
          <p style={{ margin: '0 0 12px', color: '#cc8' }}>
            Extracting navigation data… this can take a minute.
          </p>
        )}
        {error && !busy && (
          <p style={{ margin: '0 0 12px', color: '#e77' }}>Couldn’t use that file: {error}</p>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          {firstRun && !configured && (
            <button
              style={buttonStyle}
              disabled={busy}
              onClick={() => { dismissLnmPrompt(); onClose() }}
            >
              Don’t ask again
            </button>
          )}
          <button style={buttonStyle} disabled={busy} onClick={onClose}>
            {configured ? 'Close' : 'Not now'}
          </button>
          <button style={{ ...buttonStyle, borderColor: '#4488cc' }} disabled={busy} onClick={chooseFile}>
            {configured ? 'Choose a different file…' : 'Choose file…'}
          </button>
        </div>
      </div>
    </div>
  )
}
