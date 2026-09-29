import { useAbmFocusPanelsStore } from '../../store/abmFocusPanels.js'
import { useDisplayStore } from '../../store/display.js'
import { popOutAbmFocusPanel } from './actions/index.js'
import { sanitizeFocusToken, focusTitle } from '../../utils/callsign.js'
import { useDraggableWindow } from '../../utils/useDraggableWindow.js'
import AbmScope from './AbmScope.jsx'
import './AbmFocusPanel.css'

const DEFAULT_SIZE   = { w: 440, h: 480 }
const CASCADE_STEP   = 28
const DEFAULT_RANGE_NM = 20

// In-page floating focus panel — the default landing spot for .focus
// <callsign>/double-click-a-contact (see AbmScope.jsx / actions/index.js).
// Same floating-overlay shape as ControllerList/Messages, via the
// scoped-down useDraggableWindow hook, so it's trivially always-on-top of
// whichever module is active and has no browser chrome to fight. The ⬡
// button hands off to the real OS popup (AbmFocusWindow.jsx) for anyone who
// wants it on a separate monitor / actually always-on-top of the whole OS.
export function AbmFocusPanel({ callsign, zIndex, cascadeIndex }) {
  const windowId = `abm-focus-${sanitizeFocusToken(callsign)}`
  const initialRangeNm = useAbmFocusPanelsStore((s) => s.rangeByCallsign[callsign]) ?? null

  const { pos, size, opacity, opacityHint, windowRef, handleDragStart, handleOpacityWheel, resizers } =
    useDraggableWindow({
      defaultPos:  { x: 40 + cascadeIndex * CASCADE_STEP, y: 40 + cascadeIndex * CASCADE_STEP },
      defaultSize: DEFAULT_SIZE,
    })

  function handleClose() {
    useDisplayStore.getState().closeWindow(windowId)
    useAbmFocusPanelsStore.getState().closePanel(callsign)
  }

  function handlePopOut() {
    const rangeNm = useDisplayStore.getState().windows[windowId]?.rangeNm ?? initialRangeNm ?? DEFAULT_RANGE_NM
    popOutAbmFocusPanel(callsign, rangeNm)
    handleClose()
  }

  return (
    <div
      ref={windowRef}
      className="abm-focus-window"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, opacity, zIndex }}
      onMouseDownCapture={() => useAbmFocusPanelsStore.getState().bringToFront(callsign)}
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
        <span className="abm-focus-title">FOCUS {focusTitle(callsign)}</span>
        {opacityHint && <span className="abm-focus-opacity-hint">{Math.round(opacity * 100)}%</span>}
        <button className="abm-focus-btn" title="Pop out to new window" onMouseDown={(e) => e.stopPropagation()} onClick={handlePopOut}>⬡</button>
        <button className="abm-focus-btn" title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={handleClose}>×</button>
      </div>

      <div className="abm-focus-body">
        <AbmScope windowId={windowId} followCallsign={callsign} initialRangeNm={initialRangeNm} />
      </div>
    </div>
  )
}
