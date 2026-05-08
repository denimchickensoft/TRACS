import { ControllerList } from './ControllerList'

export function ControllerListWindow() {
  const params      = new URLSearchParams(window.location.search)
  const facilityId   = params.get('facilityId')   ?? ''
  const facilityName = params.get('facilityName')  ?? ''

  return (
    <ControllerList
      standalone
      visible
      facilityId={facilityId}
      facilityName={facilityName}
      onClose={() => window.close()}
    />
  )
}
