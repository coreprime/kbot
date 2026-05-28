// pane-view.js
//
// MapPaneView — wraps the per-pane DOM (canvas-scroll + canvas-stack
// + the two canvases inside) and a per-pane _EditorView instance for
// the map-editor's split layout.  Each pane owns:
//
//   .root         — the top-level <div> the split-host's LeafSlot
//                   appends into its slot cell.  Used as `view.canvas`
//                   in the split-host's view-shape contract (which
//                   only requires an HTMLElement, not literally a
//                   canvas).
//   .scrollEl     — the canvas-scroll wrapper (native browser scroll).
//                   Has `.canvas-scroll` class always; conditionally
//                   gets `id="canvas-scroll"` when this is the
//                   focused pane (so existing querySelector('#canvas-
//                   scroll') call sites — there are ~20 across
//                   /ui/map-editor/ — read from the focused pane).
//   .stackEl      — the canvas-stack inside scrollEl.  Same
//                   id-juggling treatment: classed always, IDed when
//                   focused.
//   .editorView   — a per-pane _EditorView constructed with the
//                   stack + scroll elements via the injection refactor
//                   from Stage 1.  Owns the two child canvases +
//                   event listeners.
//
// Per-pane scroll position is naturally independent — each scrollEl
// is its own browser scroll container.  Per-pane zoom + per-pane
// view-mode are NOT supported in this MVP; both come from the shared
// MapDoc (state.zoom / state.viewMode) since they're MapDoc-scoped
// concerns.  Independent zoom can come in a follow-up by promoting
// zoom from MapDoc to per-pane state.
//
// renderCanvas iterates `iterateMapPanes()` (exposed via split-host)
// to repaint every pane on state mutation.  Each iteration adopts
// the pane as the focused-id holder long enough to render, then
// restores.  See render.js's pane-iteration wrapper.

import { recreateEditorViewFor, destroyEditorView } from './editor-view.js'

// _paneIdSeq — local counter so per-pane DOM ids (data-pane-id
// attribute) are unique within a tab.  Module-level so DOM debugging
// reads stable values across re-mounts.
let _paneIdSeq = 1

export class MapPaneView {
  constructor() {
    this._localPaneId = _paneIdSeq++
    // Root container — opaque to the host; the split-host appends
    // this into the leaf slot.  position:absolute;inset:0 via CSS
    // class so the canvas-scroll inside fills it.
    this.root = document.createElement('div')
    this.root.className = 'mv-map-pane-root'
    this.root.dataset.mapPane = String(this._localPaneId)
    // canvas-scroll wrapper — native scroll container.  Class only;
    // ID set/cleared by setFocused().
    this.scrollEl = document.createElement('div')
    this.scrollEl.className = 'canvas-scroll'
    // canvas-stack inside scroll — holds the two canvases the
    // _EditorView mounts.
    this.stackEl = document.createElement('div')
    this.stackEl.className = 'canvas-stack'
    this.scrollEl.appendChild(this.stackEl)
    this.root.appendChild(this.scrollEl)
    // Per-pane _EditorView — created when this pane is first
    // focused (so the bootstrap singleton can be replaced on the
    // initial activation).  See recreateEditorViewFor.
    this.editorView = null
    // _focused tracks whether this pane currently holds the
    // #canvas-scroll / #canvas-stack IDs.  Used by setFocused to
    // avoid no-op churn.
    this._focused = false
  }

  // canvas — the split-host's view-shape contract wants a `.canvas`
  // field it can appendChild into the slot.  We expose root as the
  // mount-able element; the split-host doesn't care that it's a div
  // rather than an HTMLCanvasElement (appendChild works on any node).
  get canvas() { return this.root }

  // setFocused gives or removes the focused-pane IDs on this pane's
  // scroll + stack elements.  When focused, existing querySelector
  // ('#canvas-scroll') / ('#canvas-stack') call sites read this
  // pane.  When un-focused, the IDs are stripped so they can move
  // to a sibling.  Idempotent.
  setFocused(focused) {
    const want = !!focused
    if (this._focused === want) return
    this._focused = want
    if (want) {
      this.scrollEl.id = 'canvas-scroll'
      this.stackEl.id = 'canvas-stack'
    } else {
      // Only strip if we still own the id (defensive — sibling
      // mounts may have already claimed it).
      if (this.scrollEl.id === 'canvas-scroll') this.scrollEl.id = ''
      if (this.stackEl.id === 'canvas-stack') this.stackEl.id = ''
    }
  }

  // attachEditorView — call once after this pane is in the DOM + has
  // the focused-pane IDs (so _EditorView's mount can attach listeners
  // bound to elements that resolve cleanly via querySelector).
  // Idempotent: subsequent calls are no-ops if already attached.
  attachEditorView() {
    if (this.editorView) return this.editorView
    this.editorView = recreateEditorViewFor({
      stackEl: this.stackEl,
      scrollEl: this.scrollEl,
    })
    return this.editorView
  }

  // dispose tears down the per-pane _EditorView (drops canvas + GL
  // context + event listeners) and removes the root from its parent.
  // Called by split-host when this pane's leaf is closed.
  dispose() {
    if (this.editorView) {
      try { destroyEditorView(this.editorView) } catch { /* ignore */ }
      this.editorView = null
    }
    if (this.root.parentNode) {
      try { this.root.parentNode.removeChild(this.root) } catch { /* ignore */ }
    }
  }
}
