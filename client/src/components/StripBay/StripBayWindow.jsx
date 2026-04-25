import { StripBay } from './StripBay'

export function StripBayWindow() {
  return <StripBay standalone onClose={() => window.close()} />
}
