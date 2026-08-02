import { Ato } from './Ato.jsx'

export function AtoWindow() {
  return <Ato docked={false} onDock={() => window.close()} />
}
