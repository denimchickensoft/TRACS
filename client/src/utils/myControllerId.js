import { useSessionStore }     from '../store/session.js'
import { useControllersStore } from '../store/controllers.js'

// This controller's own controller ID (e.g. "1A"), read fresh from the
// stores, or null before it's been assigned. For non-React code (actions,
// command tables, message handlers); components should subscribe with a
// store selector instead so they re-render when it changes.
export function getMyControllerId() {
  const positionName = useSessionStore.getState().positionName
  return useControllersStore.getState().registry[positionName]?.controllerId ?? null
}

// Every controller ID currently in the registry, for validating a typed or
// slewed handoff/point-out target position.
export function getKnownControllerIds() {
  return new Set(
    Object.values(useControllersStore.getState().registry)
      .map((e) => e.controllerId)
      .filter(Boolean)
  )
}
