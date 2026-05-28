// zoom-pan.js
//
// Zoom + scroll-pan controls for the map canvas — the small set of
// functions every interaction path eventually hits: zoom button
// handlers, wheel zoom, fit-to-window, and the held-arrow-key
// continuous pan loop.
//
// state.zoom carries the user-facing zoom factor; setZoom resizes
// both CSS-sized canvases and the .canvas-stack overscroll
// container so the visible area can pan past either edge until the
// viewport centre hits a corner.  overscrollPadding tracks the
// half-viewport padding the stack currently applies — exported so
// the visible-bounds / camera-info / minimap / dev-stats consumers
// keep working without back-channel access.
//
// The continuous-pan loop (startMapPan / stopMapPan / mapPanTick)
// runs in its own rAF separate from the renderer.  Native scroll
// clamping handles edge cases at the map boundary; the rate ramps
// from MAP_PAN_RATE_PX_S up to MAP_PAN_ACCEL_MAX_MULT× over
// MAP_PAN_ACCEL_TIME_MS so a long hold accelerates.
//
// Cross-module deps via hostCallbacks:
//   - scheduleRenderCanvas()   — rAF-batched canvas redraw
//   - scheduleMinimapRender()  — rAF-batched minimap redraw

import { state, $, clamp, hostCallbacks, tabs, tabState } from '../host-context.js'
import {
  MAP_PAN_RATE_PX_S,
  MAP_PAN_ACCEL_MAX_MULT,
  MAP_PAN_ACCEL_TIME_MS,
} from './constants.js'

const MIN_ZOOM = 0.01
const MAX_ZOOM = 2

// overscrollPadding tracks the half-viewport padding currently
// applied to .canvas-stack so visibleTileBounds and the minimap
// viewport rectangle can convert scroll position back to canvas-
// pixel space.  Exported as a mutable object — readers reach
// .x / .y; this module is the sole writer.
export const overscrollPadding = { x: 0, y: 0 }

export function setZoom(z) {
  state.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM)
  // Persist the new zoom onto the FOCUSED pane so the per-pane render
  // loop keeps split panes independent — zoom acts on the current
  // pane, not both.  No-op on the bootstrap (un-split) path where the
  // tab has no panes.
  const _tab = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  const _pane = _tab && _tab.panes && _tab.activePaneId ? _tab.panes.get(_tab.activePaneId) : null
  if (_pane) _pane.zoom = state.zoom
  const canvas = $('#canvas')
  const w = canvas.width * state.zoom + 'px'
  const h = canvas.height * state.zoom + 'px'
  canvas.style.width = w
  canvas.style.height = h
  const glCanvas = $('#canvas-gl')
  if (glCanvas) {
    glCanvas.style.width = w
    glCanvas.style.height = h
  }
  applyOverscrollPadding()
  hostCallbacks.scheduleRenderCanvas?.()
  hostCallbacks.scheduleMinimapRender?.()
}

// applyOverscrollPadding resizes .canvas-stack to (map + viewport)
// and positions both canvases at the centre of that padded box, so
// the scroll container can pan the map past any edge until the
// centre of the viewport reaches a map corner.  Scroll position is
// adjusted by the padding delta so the rendered scene doesn't
// visibly jump when padding grows or shrinks (window resize, zoom
// change).
export function applyOverscrollPadding() {
  const wrap = $('#canvas-scroll')
  const stack = $('#canvas-stack')
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  if (!wrap || !stack || !canvas) return
  const padX = Math.max(0, Math.floor(wrap.clientWidth / 2))
  const padY = Math.max(0, Math.floor(wrap.clientHeight / 2))
  const canvasW = parseFloat(canvas.style.width) || canvas.width
  const canvasH = parseFloat(canvas.style.height) || canvas.height
  const stackW = canvasW + padX * 2
  const stackH = canvasH + padY * 2
  const stackWS = stackW + 'px'
  const stackHS = stackH + 'px'
  if (stack.style.width !== stackWS) stack.style.width = stackWS
  if (stack.style.height !== stackHS) stack.style.height = stackHS
  const padXS = padX + 'px'
  const padYS = padY + 'px'
  if (canvas.style.left !== padXS) canvas.style.left = padXS
  if (canvas.style.top !== padYS) canvas.style.top = padYS
  if (glCanvas) {
    if (glCanvas.style.left !== padXS) glCanvas.style.left = padXS
    if (glCanvas.style.top !== padYS) glCanvas.style.top = padYS
  }
  if (overscrollPadding.x !== padX) {
    wrap.scrollLeft += padX - overscrollPadding.x
    overscrollPadding.x = padX
  }
  if (overscrollPadding.y !== padY) {
    wrap.scrollTop += padY - overscrollPadding.y
    overscrollPadding.y = padY
  }
}

// zoomAtPointer scales around a screen-space point (typically the
// cursor during a wheel event) so the map pixel under that point
// stays anchored.  `deltaY` follows the WheelEvent convention:
// positive = zoom out.
export function zoomAtPointer(clientX, clientY, deltaY) {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  if (!wrap || !canvas) return

  const rect = canvas.getBoundingClientRect()
  // Map-pixel coords under the cursor before the zoom change.
  const mapX = (clientX - rect.left) / state.zoom
  const mapY = (clientY - rect.top) / state.zoom

  // Pinch trackpads emit very small deltas; mouse wheels emit large
  // ones.  Normalise so a single wheel click is ~1.1×.
  const step = Math.exp(-deltaY * 0.0015)
  const newZoom = clamp(state.zoom * step, MIN_ZOOM, MAX_ZOOM)
  if (newZoom === state.zoom) return
  setZoom(newZoom)

  // Re-anchor the cursor: after the canvas size changes, the same
  // map pixel should appear under the same client point.  The
  // canvas sits at overscrollPadding inside .canvas-stack, so the
  // scroll position that puts map pixel (mapX, mapY) under the
  // cursor is offset by the same padding.
  const wrapRect = wrap.getBoundingClientRect()
  wrap.scrollLeft = mapX * newZoom - (clientX - wrapRect.left) + overscrollPadding.x
  wrap.scrollTop = mapY * newZoom - (clientY - wrapRect.top) + overscrollPadding.y
}

export function fitZoom() {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  const zx = wrap.clientWidth / canvas.width
  const zy = wrap.clientHeight / canvas.height
  setZoom(Math.min(zx, zy) * 0.95)
}

// Continuous pan via held arrow keys.  startMapPan / stopMapPan
// register a direction in heldPanKeys; mapPanRAF drives a rAF loop
// that scrolls every frame at MAP_PAN_RATE_PX_S, ramping the speed
// up to MAP_PAN_ACCEL_MAX_MULT over MAP_PAN_ACCEL_TIME_MS.  Native
// scrollLeft / Top clamping handles edge cases at the map boundary.
const heldPanKeys = new Map() // key -> { dx, dy, pressedAt }
let mapPanRAF = 0
let mapPanLastT = 0

export function startMapPan(key, dx, dy) {
  if (heldPanKeys.has(key)) return
  heldPanKeys.set(key, { dx, dy, pressedAt: performance.now() })
  if (mapPanRAF) return
  mapPanLastT = performance.now()
  mapPanRAF = requestAnimationFrame(mapPanTick)
}

export function stopMapPan(key) {
  heldPanKeys.delete(key)
  if (heldPanKeys.size === 0 && mapPanRAF) {
    cancelAnimationFrame(mapPanRAF)
    mapPanRAF = 0
  }
}

function mapPanTick(now) {
  mapPanRAF = 0
  const wrap = $('#canvas-scroll')
  if (!wrap || heldPanKeys.size === 0) return
  const dt = Math.min(0.1, (now - mapPanLastT) / 1000 || 0)
  mapPanLastT = now
  let dxSum = 0, dySum = 0
  for (const entry of heldPanKeys.values()) {
    const heldMs = now - entry.pressedAt
    const ramp = Math.min(1, heldMs / MAP_PAN_ACCEL_TIME_MS)
    const mult = 1 + ramp * (MAP_PAN_ACCEL_MAX_MULT - 1)
    const px = MAP_PAN_RATE_PX_S * mult * (state.zoom || 1) * dt
    dxSum += entry.dx * px
    dySum += entry.dy * px
  }
  if (dxSum) wrap.scrollLeft += dxSum
  if (dySum) wrap.scrollTop  += dySum
  mapPanRAF = requestAnimationFrame(mapPanTick)
}

export function stopAllMapPan() {
  heldPanKeys.clear()
  if (mapPanRAF) { cancelAnimationFrame(mapPanRAF); mapPanRAF = 0 }
}
