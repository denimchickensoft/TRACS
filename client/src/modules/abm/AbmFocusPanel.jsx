import { useAbmFocusPanelsStore } from '../../store/abmFocusPanels.js'
import { useDisplayStore } from '../../store/display.js'
import { popOutAbmFocusPanel } from './actions/index.js'
import { sanitizeFocusToken, focusTitle, isLocationFocusKey } from '../../utils/callsign.js'
import { useDraggableWindow } from '../../utils/useDraggableWindow.js'
import AbmScope from './AbmScope.jsx'
import './AbmFocusPanel.css'

const DEFAULT_SIZE   = { w: 440, h: 480 }
const CASCADE_STEP   = 28
const DEFAULT_RANGE_NM = 20

// In-page floating focus panel — the default landing spot for .focus
// <callsign|ICAO> and double-clicking a contact, airfield or map point (see
// AbmScope.jsx / actions/index.js).
// Same floating-overlay shape as ControllerList/Messages, via the
// scoped-down useDraggableWindow hook, so it's trivially always-on-top of
// whichever module is active and has no browser chrome to fight. The ⬡
// button hands off to the real OS popup (AbmFocusWindow.jsx) for anyone who
// wants it on a separate monitor / actually always-on-top of the whole OS.
export function AbmFocusPanel({ focusKey, zIndex, cascadeIndex }) {
  const windowId = `abm-focus-${sanitizeFocusToken(focusKey)}`
  const initialRangeNm = useAbmFocusPanelsStore((s) => s.rangeByKey[focusKey]) ?? null
  const initialCenter  = useAbmFocusPanelsStore((s) => s.centerByKey[focusKey]) ?? null

  const { pos, size, opacity, opacityHint, windowRef, handleDragStart, handleOpacityWheel, resizers } =
    useDraggableWindow({
      defaultPos:  { x: 40 + cascadeIndex * CASCADE_STEP, y: 40 + cascadeIndex * CASCADE_STEP },
      defaultSize: DEFAULT_SIZE,
    })

  function handleClose() {
    useDisplayStore.getState().closeWindow(windowId)
    useAbmFocusPanelsStore.getState().closePanel(focusKey)
  }

  function handlePopOut() {
    const win = useDisplayStore.getState().windows[windowId]
    const rangeNm = win?.rangeNm ?? initialRangeNm ?? DEFAULT_RANGE_NM
    // A location panel pans freely, so pop it out wherever it's been panned
    // to rather than where it first opened.
    const center = isLocationFocusKey(focusKey) && win?.centerLat != null
      ? { lat: win.centerLat, lng: win.centerLng }
      : initialCenter
    popOutAbmFocusPanel(focusKey, rangeNm, center)
    handleClose()
  }

  return (
    <div
      ref={windowRef}
      className="abm-focus-window"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, opacity, zIndex }}
      onMouseDownCapture={() => useAbmFocusPanelsStore.getState().bringToFront(focusKey)}
    >
      <div className="abm-focus-resize abm-focus-resize--n"  onMouseDown={resizers.n}  />
      <div className="abm-focus-resize abm-focus-resize--s"  onMouseDown={resizers.s}  />
      <div className="abm-focus-resize abm-focus-resize--e"  onMouseDown={resizers.e}  />
      <div className="abm-focus-resize abm-focus-resize--w"  onMouseDown={resizers.w}  />
      <div className="abm-focus-resize abm-focus-resize--ne" onMouseDown={resizers.ne} />
      <div className="abm-focus-resize abm-focus-resize--nw" onMouseDown={resizers.nw} />
      <div className="abm-focus-resize abm-focus-resize--se" onMouseDown={resizers.se} />
      <div className="abm-focus-resize abm-focus-resize--sw" onMouseDown={resizers.sw} />

      <div className="abm-focus-titlebar" onMouseDown={handleDragStart} onWheel={handleOpacityWheel}>
        <span className="abm-focus-title">FOCUS {focusTitle(focusKey)}</span>
        {opacityHint && <span className="abm-focus-opacity-hint">{Math.round(opacity * 100)}%</span>}
        <button className="abm-focus-btn" title="Pop out to new window" onMouseDown={(e) => e.stopPropagation()} onClick={handlePopOut}>⬡</button>
        <button className="abm-focus-btn" title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={handleClose}>×</button>
      </div>

      <div className="abm-focus-body">
        <AbmScope windowId={windowId} focusKey={focusKey} initialRangeNm={initialRangeNm} initialCenter={initialCenter} />
      </div>
    </div>
  )
}
