// camera-info.js
//
// The "Camera & Cursor" floating panel — viewport-centre tile, zoom
// percentage, cursor tile / sub-tile / height-byte readout.  The
// panel itself lives in the React tree (CameraCursorPanel); this
// module just owns the visibility flag + the two publish-to-store
// helpers that feed it.
//
// setCameraInfoVisible flips the View-menu / Settings toggle and
// flushes prefs + the map ribbon so the menu tick stays in sync.
// updateCameraInfoPanel runs from the canvas renderer after pan /
// zoom; updateCameraInfoCursor runs from the hover-label path with
// the current tile + attribute cell.
//
// Cross-module deps via hostCallbacks:
//   - viewportCellCenter()       — scroll-aware centre tile lookup
//   - publishMapRibbonState()    — keep the View-menu tick in sync
// Direct imports:
//   - persistPrefs               — /ui/common/prefs.js
//   - getReactUi                 — host-context

import { state, hostCallbacks, getReactUi } from '../host-context.js'
import { persistPrefs } from '../common/prefs.js'

// setCameraInfoVisible toggles the Camera & Cursor panel.  Mirrors
// the View-menu Minimap toggle so users get a familiar pattern.
export function setCameraInfoVisible(visible) {
  state.showCameraInfo = !!visible
  const ui = getReactUi()
  if (ui && typeof ui.setPanelVisible === 'function') {
    ui.setPanelVisible('camera-info-panel', !!visible)
  }
  if (visible) updateCameraInfoPanel()
  persistPrefs()
  hostCallbacks.publishMapRibbonState?.()
}

// updateCameraInfoPanel publishes the viewport-centre tile + zoom
// to the React store.  Called from renderCanvas after a pan / zoom;
// the React CameraCursorPanel re-renders on the next signal commit.
export function updateCameraInfoPanel() {
  const ui = getReactUi()
  if (!ui || typeof ui.publishMapCameraInfo !== 'function') return
  const cam = hostCallbacks.viewportCellCenter?.()
  if (!cam) return
  ui.publishMapCameraInfo({
    cameraTx: cam.tx,
    cameraTy: cam.ty,
    zoomPct: Math.round((state.zoom || 1) * 100),
  })
}

// updateCameraInfoCursor publishes the cursor tile + sub-tile + the
// height byte at the precise attribute cell under the cursor.
// Called from updateHoverLabel; null tx clears the readout when the
// mouse leaves the canvas.
export function updateCameraInfoCursor(tx, ty, ax, ay) {
  const ui = getReactUi()
  if (!ui || typeof ui.publishMapCameraInfo !== 'function') return
  if (tx == null) {
    ui.publishMapCameraInfo({
      cursorTx: null, cursorTy: null,
      subTx: null, subTy: null,
      height: null,
    })
    return
  }
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const height = (ax >= 0 && ay >= 0 && ax < aw && ay < ah && state.heights)
    ? (state.heights[ay * aw + ax] | 0)
    : null
  ui.publishMapCameraInfo({
    cursorTx: tx, cursorTy: ty,
    subTx: ax & 1, subTy: ay & 1,
    height,
  })
}
