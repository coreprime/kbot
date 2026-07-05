// minimap-panel.js
//
// The sandbox mini-map as a fixed game-UI element (top-right), NOT a
// draggable inspector panel — it's core battlefield UI, framed like the
// economy bar / unit HUD rather than the FloatingPanel chrome. The canvas
// is drawn by minimap.js, which looks it up by id on the shared refresh
// tick and toggles the frame's visibility with sandbox mode.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'

export const MINIMAP_CANVAS_ID = 'sandbox-minimap-canvas'

export function SandboxMinimapPanel() {
  return html`
    <div id="sandbox-minimap" class="sandbox-minimap-hud">
      <canvas id=${MINIMAP_CANVAS_ID} width="184" height="184"></canvas>
    </div>
  `
}
