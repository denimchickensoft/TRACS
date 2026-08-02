import { Frag } from './Frag.jsx'

export function FragWindow() {
  return <Frag docked={false} onDock={() => window.close()} />
}
