import { BraaList } from './BraaList.jsx'

export function BraaListWindow() {
  return <BraaList docked={false} onDock={() => window.close()} />
}
