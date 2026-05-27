// minimap-panel.js
//
// React-rendered Minimap panel.  The actual image is drawn by the
// legacy renderMinimap() / rebuildMinimapBase() in studio.js — those
// touch a fairly intricate dirty-tracking pipeline that's not worth
// porting wholesale.  This component owns the chrome (FloatingPanel
// header + drag + collapse + close + position persistence) AND
// renders the canvas + viewport overlay elements at the same ids the
// host wires its draw/scroll listeners to.
//
// Mouse panning is delegated to the host via the map-ribbon bridge:
//   minimapBeginPan / minimapPan / minimapEndPan
// fire in mouse-down/move/up so the host can translate the click
// coordinates to canvas-scroll positions exactly as the legacy
// wireMinimap did.
//
// Re-renders on `minimapTick` so the host can force a layout pass
// (e.g. after a resize / a tab swap with a freshly-loaded map).

import { useEffect, useRef } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { mapRibbonBridge, minimapTick } from '/ui/map-editor/store.js'

const PANEL_ID = 'minimap-panel'

export function MinimapPanel() {
  // Subscribe so a host bumpMinimapTick() re-renders the chrome (lets
  // the host invalidate when the panel was hidden and then shown).
  void minimapTick.value
  const canvasRef = useRef(null)
  // Wire the canvas-level mouse handlers ONCE per mount.  The
  // listeners route through the bridge so the host's pan logic stays
  // in studio.js (it needs access to `state.zoom`, the canvas-scroll
  // element, and the overscroll padding).
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return undefined
    const onDown = (e) => {
      e.preventDefault()
      mapRibbonBridge.minimapBeginPan(e.clientX, e.clientY, c)
    }
    const onMove = (e) => mapRibbonBridge.minimapPan(e.clientX, e.clientY, c)
    const onUp   = ()  => mapRibbonBridge.minimapEndPan()
    c.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      c.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])
  return html`
    <${FloatingPanel}
      id=${PANEL_ID}
      title="Map preview"
      rootClass="minimap"
      headerClass="minimap-header"
      bodyClass="minimap-body"
      stageSelector=".canvas-wrap">
      <canvas ref=${canvasRef} id="minimap" width="200" height="200"></canvas>
      <div class="minimap-viewport" id="minimap-viewport"></div>
    <//>
  `
}
