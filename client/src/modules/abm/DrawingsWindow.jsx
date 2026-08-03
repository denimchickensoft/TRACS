import { Drawings } from './Drawings.jsx'

export function DrawingsWindow() {
  return <Drawings docked={false} onDock={() => window.close()} />
}
