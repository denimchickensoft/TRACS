import { useEffect } from 'react'
import { useSessionStore } from '../../../store/session'
import CabScope            from './CabScope'

export function CabOdsWindow() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    useSessionStore.setState({
      facilityDcsName: params.get('facilityDcsName') ?? '',
      positionSuffix:  params.get('positionSuffix')  ?? '',
    })
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <CabScope />
    </div>
  )
}
