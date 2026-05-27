// camera-cursor-panel.js
//
// React-rendered Camera & Cursor HUD for the map editor.  Five rows:
//   Camera   — viewport-centre tile (host writes from renderCanvas)
//   Cursor   — tile the mouse is over
//   Sub-tile — 0/1 attribute sub-cell inside the tile (TA's 2×2 attr
//              grid per tile)
//   Height   — terrain height byte at the precise attribute cell
//   Zoom     — current zoom as a percentage
//
// The host publishes everything through publishMapCameraInfo on every
// canvas redraw + mousemove; this component re-renders on signal
// updates.  Distinct from the unit-editor's Renderer panel because
// the data sources + the framing (tile / attr-cell vs world-space
// camera pose) are fundamentally different — sharing chrome would
// force confusing labels in both directions.

import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { cameraInfo } from '/ui/map-editor/store.js'

const PANEL_ID = 'camera-info-panel'

function _Row({ label, value }) {
  return html`
    <div class="dev-stats-row">
      <span class="dev-stats-label">${label}</span>
      <span class="dev-stats-value">${value}</span>
    </div>
  `
}

// _format — null-safe coordinate formatter.  Cursor + sub-tile come
// through as null when the mouse leaves the canvas; the panel shows
// `—` in that case so the user can tell at a glance that the value
// is stale rather than a literal "0, 0".
function _format(tx, ty) {
  if (tx == null || ty == null) return '—'
  return `${tx}, ${ty}`
}

export function CameraCursorPanel() {
  const c = cameraInfo.value
  return html`
    <${FloatingPanel}
      id=${PANEL_ID}
      title="Camera & Cursor"
      rootClass="dev-stats camera-info"
      headerClass="dev-stats-header"
      bodyClass="dev-stats-body"
      stageSelector=".canvas-wrap"
      noClose=${true}>
      <${_Row} label="Camera"   value=${_format(c.cameraTx, c.cameraTy)} />
      <${_Row} label="Cursor"   value=${_format(c.cursorTx, c.cursorTy)} />
      <${_Row} label="Sub-tile" value=${_format(c.subTx, c.subTy)} />
      <${_Row} label="Height"   value=${c.height == null ? '—' : String(c.height)} />
      <${_Row} label="Zoom"     value=${`${c.zoomPct | 0}%`} />
    <//>
  `
}
