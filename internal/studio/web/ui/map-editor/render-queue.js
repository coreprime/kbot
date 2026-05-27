// render-queue.js
//
// Tiny rAF-batched re-render queues for the main map canvas and
// the floating minimap.  Each scheduler dedupes within a single
// animation frame so a burst of scroll events (or any other
// per-frame caller) only fans out into one actual paint.
//
// Sits under map-editor so the imports stay in the same subtree as
// the renderers themselves; nothing in unit-editor / sandbox
// reaches these — both have their own rAF loops in the model3d /
// sandbox engines.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — still lives in studio.js; we reach it via
//     the callback so this module doesn't need a back-reference
//     into the legacy host file.

import { hostCallbacks } from '../host-context.js'
import { renderMinimap } from './minimap.js'

let minimapRenderQueued = false
export function scheduleMinimapRender() {
  if (minimapRenderQueued) return
  minimapRenderQueued = true
  requestAnimationFrame(() => {
    minimapRenderQueued = false
    renderMinimap()
  })
}

let canvasRenderQueued = false
export function scheduleRenderCanvas() {
  if (canvasRenderQueued) return
  canvasRenderQueued = true
  requestAnimationFrame(() => {
    canvasRenderQueued = false
    hostCallbacks.renderCanvas?.()
  })
}
