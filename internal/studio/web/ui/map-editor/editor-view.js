// editor-view.js
//
// EditorView is the lifecycle owner for the map editor's canvas
// stack — the two stacked <canvas> elements (one for GL, one for
// the 2D overlay), every mouse / wheel / drag listener bound to
// them, and the ResizeObserver that keeps overscroll padding in
// sync with the scroll wrapper.
//
// recreateEditorView() is called on every map open / new and on
// every resize commit so no DOM, no event listeners, and no GL
// state from the previous map can survive the switch.  destroy()
// aborts every signal in one shot via AbortController + resets
// the GL context.
//
// Two utility helpers ride alongside:
//
//   - prepareCanvasDimensions: resize the canvas backing buffers
//     + CSS sizes (called from finishEditorBoot BEFORE the first
//     paint, so centerViewOnMap positions scrollLeft/scrollTop
//     against the FINAL dimensions instead of the previous map's
//     leftovers).
//   - centerViewOnMap: position the scroll viewport so the centre
//     of the map sits at the centre of the scroll wrapper.  Works
//     in stack-pixel space.
//
// Cross-module deps:
//   - render / scheduleRender hooks come through hostCallbacks
//   - mouse-router dispatchers + cursor helpers + paint helpers
//     are imported directly because they're already in modules

import { state, $, setStatus, hostCallbacks } from '../host-context.js'
import { TILE_PX } from './constants.js'
import {
  applyOverscrollPadding, overscrollPadding, zoomAtPointer,
} from './zoom-pan.js'
import { resetGL } from './canvas/webgl.js'
import { updateCameraInfoCursor } from './camera-info.js'
import { renderCanvas } from './canvas/render.js'
import { paintState } from './paint-state.js'
import { tryAutoRotatePlacement } from './canvas/placement.js'
import { pickCell, pickFeatureAttrCell } from './mouse-coords.js'
import { beginTransaction, commitTransaction } from './undo.js'
import {
  onCanvasMouseDown, onCanvasMouseMove, onCanvasMouseUp,
} from './mouse-router.js'
import { updateHoverLabel } from './cursor.js'
import { handlePaint } from './modes/paint.js'

// Module-level singleton.  Reassigned by recreateEditorView().
let _editorView = null

class _EditorView {
  // Accepts injected stack + scroll elements so the same view shell
  // can mount into either:
  //   - the bootstrap singletons #canvas-stack / #canvas-scroll
  //     (default — the path every existing call site uses)
  //   - per-pane elements created by MapPaneView for the split-pane
  //     layout (Phase 5)
  // querySelector fallback keeps backwards compatibility for the
  // single-pane callers; the split-host passes the per-pane refs.
  constructor({ stackEl = null, scrollEl = null } = {}) {
    this.stack = stackEl || document.querySelector('#canvas-stack')
    this.scroll = scrollEl || document.querySelector('#canvas-scroll')
    this.canvas = null
    this.glCanvas = null
    this.abort = null
    this.resizeObserver = null
  }

  mount() {
    if (!this.stack) return
    // Wipe any pre-existing canvases (initial HTML markup or a stale
    // mount that destroy() somehow missed).
    for (const c of Array.from(this.stack.querySelectorAll('canvas'))) {
      this.stack.removeChild(c)
    }
    // glCanvas first (sits under the 2D overlay).
    const glCanvas = document.createElement('canvas')
    glCanvas.id = 'canvas-gl'
    const canvas = document.createElement('canvas')
    canvas.id = 'canvas'
    this.stack.append(glCanvas, canvas)
    this.glCanvas = glCanvas
    this.canvas = canvas

    canvas.width = state.tileW * TILE_PX
    canvas.height = state.tileH * TILE_PX
    canvas.style.width = canvas.width * state.zoom + 'px'
    canvas.style.height = canvas.height * state.zoom + 'px'
    glCanvas.width = canvas.width
    glCanvas.height = canvas.height
    glCanvas.style.width = canvas.style.width
    glCanvas.style.height = canvas.style.height

    applyOverscrollPadding()
    this.abort = new AbortController()
    this._bindCanvasListeners()
    this._bindResizeObserver()
  }

  destroy() {
    if (this.abort) { this.abort.abort(); this.abort = null }
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null }
    resetGL()
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas)
    if (this.glCanvas?.parentNode) this.glCanvas.parentNode.removeChild(this.glCanvas)
    this.canvas = null
    this.glCanvas = null
  }

  _bindResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !this.scroll) return
    this.resizeObserver = new ResizeObserver(() => {
      applyOverscrollPadding()
      hostCallbacks.scheduleRenderCanvas?.()
      hostCallbacks.scheduleMinimapRender?.()
    })
    this.resizeObserver.observe(this.scroll)
  }

  _bindCanvasListeners() {
    const { canvas, scroll, abort } = this
    if (!canvas || !abort) return
    const sig = { signal: abort.signal }
    canvas.addEventListener('mousedown', (e) => onCanvasMouseDown(e), sig)
    window.addEventListener('mouseup', (e) => onCanvasMouseUp(e), sig)
    canvas.addEventListener('mousemove', (e) => onCanvasMouseMove(e), sig)
    canvas.addEventListener('mouseleave', () => {
      // #hover-cell (legacy canvas-toolbar) is gone — the Camera &
      // Cursor floating panel shows the hover info now.  Guarded
      // lookup so dev tools that still poke at the old span keep
      // working without throwing.
      const hc = document.getElementById('hover-cell')
      if (hc) hc.textContent = '—'
      updateCameraInfoCursor(null)
      if (state.eraseCursor) { state.eraseCursor = null; renderCanvas() }
      hostCallbacks.cursor.lastHover = null
    }, sig)

    // Wheel/trackpad routing:
    //   - Ctrl/Cmd + wheel → zoom (covers Mac pinch — Safari sends pinch
    //     as wheel-with-ctrlKey).
    //   - Any horizontal delta (deltaX) → pan horizontally.
    //   - Shift + wheel → pan vertically.
    //   - Otherwise → zoom anchored to the cursor.
    if (scroll) {
      scroll.addEventListener('wheel', (e) => {
        // Ignore wheel events while any modal dialog is showing — they
        // were sneaking past the dialog overlay and nudging zoom while
        // the user was scrolling dialog content.  Symptom: map switches
        // landed at zoom 1.0015 instead of 1.0.
        if (document.querySelector('.dialog:not(.hidden)')) return
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          zoomAtPointer(e.clientX, e.clientY, e.deltaY)
          return
        }
        if (e.deltaX !== 0) {
          e.preventDefault()
          scroll.scrollLeft += e.deltaX
          if (e.deltaY !== 0) scroll.scrollTop += e.deltaY
          return
        }
        if (e.shiftKey) {
          e.preventDefault()
          scroll.scrollTop += e.deltaY
          return
        }
        e.preventDefault()
        zoomAtPointer(e.clientX, e.clientY, e.deltaY)
      }, { passive: false, signal: abort.signal })
    }

    // Drag-and-drop from the sidebar drawer.  `dragover` only updates the
    // hover highlight; the actual stamp is committed once on `drop`.  This
    // avoids smearing the drag path across every cell the cursor passed.
    canvas.addEventListener('dragenter', (e) => { e.preventDefault() }, sig)
    canvas.addEventListener('dragover', (e) => {
      if (!state.dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      updateHoverLabel(e)
      const { tx, ty } = pickCell(e)
      let dirty = false
      if (state.dropPreview?.tx !== tx || state.dropPreview?.ty !== ty) {
        state.dropPreview = { tx, ty }
        dirty = true
      }
      // While dragging a section, also engage a full placement preview so
      // the user sees the section's pixels + rotation badge + edge hints
      // exactly like a click-to-place flow.  The section is centred on
      // the cursor (rather than top-left anchored) — matches what
      // setDragImage does for the drag ghost.
      if (state.dragging.type === 'section' && state.selected?.type === 'section') {
        if (!state.placement || state.placement.sectionPath !== state.selected.path) {
          state.placement = {
            sectionPath: state.selected.path,
            origW: state.selected.tileW,
            origH: state.selected.tileH,
            rotation: state.selected.rotation || 0,
            tx, ty,
          }
        }
        // selectSection seeds the placement with dormant=true so the
        // first cursor-follow paint waits until the cursor enters the
        // canvas.  When the user re-drags the SAME row immediately
        // after clicking it, the dragover handler above reuses that
        // existing placement — without this wake the dragover-driven
        // preview never paints because drawPlacementPreview early-
        // returns on the stale dormant flag, and the user only sees
        // the tile after the drop / final click.
        if (state.placement.dormant) {
          state.placement.dormant = false
          dirty = true
        }
        const anchor = hostCallbacks.placementAnchor?.(tx, ty, state.placement)
        if (anchor && (state.placement.tx !== anchor.tx || state.placement.ty !== anchor.ty)) {
          state.placement.tx = anchor.tx
          state.placement.ty = anchor.ty
          tryAutoRotatePlacement(state.placement)
          dirty = true
        }
      }
      if (dirty) renderCanvas()
    }, sig)
    canvas.addEventListener('dragleave', () => {
      state.dropPreview = null
      renderCanvas()
    }, sig)
    canvas.addEventListener('drop', (e) => {
      if (!state.dragging) return
      e.preventDefault()
      state.dropPreview = null
      paintState.paintedDuringStroke = false
      const wasFeature = state.dragging.type === 'feature'
      if (state.dragging.type === 'section' && state.placement) {
        // Anchor the section at the drop point instead of immediately
        // overwriting the tiles underneath — the user can then drag /
        // rotate it and only commit on the next click outside the
        // footprint (or Esc to cancel).  This way the original tiles at
        // the drop point are preserved until the user is happy.
        const { tx: cx, ty: cy } = pickCell(e)
        if (cx >= 0 && cx < state.tileW && cy >= 0 && cy < state.tileH) {
          // Force Paint mode so the anchored placement is interactive
          // regardless of what mode the drag started from (e.g., View).
          if (state.mode !== 'paint') hostCallbacks.setMode?.('paint')
          const anchor = hostCallbacks.placementAnchor?.(cx, cy, state.placement)
          if (anchor) {
            state.placement.tx = anchor.tx
            state.placement.ty = anchor.ty
          }
          state.placement.anchored = true
          setStatus('Section anchored — drag inside to reposition, Q / E to rotate, click outside to confirm, Esc to cancel.')
          renderCanvas()
        }
      } else if (wasFeature && state.selected?.type === 'feature') {
        // Features remain a one-shot drop — they have no anchored state
        // and the user can re-drag them in Place Features mode after.
        const { ax, ay } = pickFeatureAttrCell(e, state.selected)
        if (ax >= 0 && ax < state.tileW * 2 && ay >= 0 && ay < state.tileH * 2) {
          beginTransaction()
          hostCallbacks.placeFeature?.(ax, ay)
          commitTransaction('Place feature')
          paintState.paintedDuringStroke = true
        }
      } else {
        beginTransaction()
        handlePaint(e)
        commitTransaction('Place')
      }
      state.dragging = null
      if (wasFeature && state.selected?.type === 'feature') {
        hostCallbacks.showPlacementHint?.(`Placing ${state.selected.name}`, 'feature')
      }
      // Section placement hint stays visible from beginSectionDrag
      // (drawer.js) — no extra showPlacementHint here.
      paintState.paintedDuringStroke = false
    }, sig)
  }
}

// recreateEditorView tears down any previously-mounted EditorView and
// mounts a fresh one.  Called from finishEditorBoot (on every map open
// or new) and applyResize so no DOM nodes, event listeners, or GL
// state from the previous map survive the switch.
export function recreateEditorView() {
  if (_editorView) _editorView.destroy()
  _editorView = new _EditorView()
  _editorView.mount()
}

// prepareCanvasDimensions resizes the canvas backing buffers
// (canvas.width / canvas.height) + the CSS style sizes for both
// the 2D canvas and the underlying GL canvas to match the active
// map's tile dimensions × the active zoom.  Extracted from
// renderCanvas so finishEditorBoot can size everything before the
// first paint runs, which lets centerViewOnMap position
// scrollLeft / scrollTop against the FINAL dimensions instead of
// the previous map's leftovers.
export function prepareCanvasDimensions() {
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  if (!canvas) return
  const wantW = state.tileW * TILE_PX
  const wantH = state.tileH * TILE_PX
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW
    canvas.height = wantH
    if (glCanvas) {
      glCanvas.width = wantW
      glCanvas.height = wantH
    }
  }
  const wantStyleW = wantW * state.zoom + 'px'
  const wantStyleH = wantH * state.zoom + 'px'
  if (canvas.style.width !== wantStyleW) canvas.style.width = wantStyleW
  if (canvas.style.height !== wantStyleH) canvas.style.height = wantStyleH
  if (glCanvas) {
    if (glCanvas.style.width !== wantStyleW) glCanvas.style.width = wantStyleW
    if (glCanvas.style.height !== wantStyleH) glCanvas.style.height = wantStyleH
  }
  applyOverscrollPadding()
}

// centerViewOnMap places the centre of the map at the centre of the
// scroll viewport.  Called on every map load (initial and switch) so
// the user always lands looking at the middle of the map, not the
// top-left corner.  Works in stack-pixel space — the canvas sits at
// overscrollPadding.{x,y} inside .canvas-stack, so the world centre's
// stack-pixel position is overscrollPadding + (mapPixels * zoom / 2).
export function centerViewOnMap() {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  if (!wrap || !canvas) return
  const z = state.zoom || 1
  const midX = overscrollPadding.x + (canvas.width * z) / 2
  const midY = overscrollPadding.y + (canvas.height * z) / 2
  wrap.scrollLeft = midX - wrap.clientWidth / 2
  wrap.scrollTop = midY - wrap.clientHeight / 2
}

// destroyEditorView lets the closeTab/closeAll paths tear down
// the EditorView explicitly without going through a full
// recreateEditorView cycle.  Idempotent on a null singleton.
export function destroyEditorView() {
  if (_editorView) { _editorView.destroy(); _editorView = null }
}
