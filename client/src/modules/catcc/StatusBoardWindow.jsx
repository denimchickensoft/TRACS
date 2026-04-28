import { StatusBoard } from './StatusBoard.jsx'

export function StatusBoardWindow() {
  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#0A0A0A' }}>
      <StatusBoard docked={false} onDock={() => window.close()} />
    </div>
  )
}
