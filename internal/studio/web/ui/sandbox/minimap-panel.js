// minimap-panel.js
//
// Preact wrapper that hosts the sandbox mini-map canvas inside the
// standard FloatingPanel chrome (drag, persisted position, collapse) —
// with the close button removed: the mini-map is core battlefield UI,
// not an optional inspector. The canvas itself is drawn by minimap.js,
// which looks the element up by id on its shared refresh tick.

import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel } from '@kbot/ui/floating-panel'

export const MINIMAP_CANVAS_ID = 'sandbox-minimap-canvas'

export function SandboxMinimapPanel() {
  // Default to the bottom-right corner (where the legacy fixed mini-map
  // lived); FloatingPanel persists wherever the user drags it after.
  const defaultPos = {
    left: Math.max(12, (window.innerWidth || 1200) - 230),
    top: Math.max(12, (window.innerHeight || 800) - 330),
  }
  return html`
    <${FloatingPanel} id="sandbox-minimap" title="Mini-map" noClose
                      defaultPos=${defaultPos}>
      <canvas id=${MINIMAP_CANVAS_ID} width="184" height="184"
              style="display:block; width:184px; height:184px;"></canvas>
    <//>
  `
}
