import { useCallback, useEffect, useState } from 'react'
import { useMissionDataStore } from '../store/missionData.js'
import { useSessionStore } from '../store/session.js'
import { pendingAreas } from './areas.js'
import { buildContext, getAutoLoadMode, isIgnored, loadArea } from './load.js'

// Offers the running mission to this position's stores whenever a mission
// loads (or the position changes): only the areas with something new, once
// the room's module state has arrived (session.moduleSyncReady) so nothing
// is loaded into a store the room is about to replace. "Always" loads them
// straight away; "Ask" returns a prompt for MissionLoadPrompt.
// Returns [prompt, close, offerNow, canOffer]: prompt is { ctx, pending: [{ area, diff }],
// manual } or null; offerNow (Settings > Force Load) opens the
// prompt whatever the mode or an earlier Ignore, resolving to the number of
// areas offered (0 = nothing new), or null when no mission can be offered.
export function useMissionAutoLoad() {
  const data   = useMissionDataStore((s) => s.data)
  const ready  = useSessionStore((s) => s.moduleSyncReady)
  const module = useSessionStore((s) => s.activeModule)
  const [prompt, setPrompt] = useState(null)

  useEffect(() => {
    setPrompt(null)
    if (!data || !ready || !module) return
    const mode = getAutoLoadMode()
    if (mode === 'never' || (mode === 'ask' && isIgnored(data.id))) return
    let cancelled = false
    ;(async () => {
      const ctx = buildContext(data)
      const pending = await pendingAreas(module, ctx)
      if (cancelled || !pending.length) return
      if (mode === 'always') {
        for (const { area } of pending) await loadArea(area, ctx)
        return
      }
      setPrompt({ ctx, pending })
    })().catch((err) => console.warn(`[missionData] could not read the mission - ${err?.message ?? err}`))
    return () => { cancelled = true }
  }, [data, ready, module])

  const offerNow = useCallback(async () => {
    if (!data || !ready || !module) return null
    const ctx = buildContext(data)
    const pending = await pendingAreas(module, ctx)
    if (pending.length) setPrompt({ ctx, pending, manual: true })
    return pending.length
  }, [data, ready, module])

  const canOffer = !!(data && ready && module)

  return [prompt, () => setPrompt(null), offerNow, canOffer]
}
