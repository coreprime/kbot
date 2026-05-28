// split-host.js
//
// Map-editor adapter for the generic split-host in
// /ui/common/split-host.js.  Map panes are symmetric (every leaf
// hosts its own MapPaneView with an independent canvas-scroll +
// canvas-stack + _EditorView), so the adapter is shaped like the
// sandbox one rather than the unit-editor one.  The asymmetry the
// map editor DOES have lives at the id-juggling layer: only the
// focused pane owns the bootstrap-DOM ids `#canvas-scroll` /
// `#canvas-stack`, which the ~20 querySelector('#canvas-scroll')
// call sites across /ui/map-editor/ implicitly read from.  When a
// new pane gains focus, the previously-focused pane drops the ids
// before the new one claims them.  This is what onPaneFocus does.
//
// The paint-every-pane loop lives in canvas/render.js's renderCanvas
// itself — wrapping the per-frame body in a focus-juggle loop so
// every pane's canvas gets a fresh frame on each call, with the
// original focused pane restored at the end.  Single-pane tabs are
// a no-op (the juggle is idempotent on a tab with one leaf).

import {
  mountSplit, detachSplit, disposeSplit, revivePanes as commonRevive,
  ensureSplitState as commonEnsure,
} from '../common/split-host.js'
import { hostCallbacks, state } from '../host-context.js'
import { MapPaneView } from './pane-view.js'
import { setActiveEditorView } from './editor-view.js'

const MAP_ADAPTER = {
  slotClass: 'mv-map-pane-slot',
  // Split menu opens on SHIFT+right-click, matching the sandbox's
  // gesture so the modifier is consistent across editors.  (Plain
  // right-click is left free for a future map-editor context menu —
  // e.g. tile/feature ops — without re-treading this decision.)
  contextMenuModifier: 'shift',
  async makeLeafView(_tab, _leafId) {
    return new MapPaneView()
  },
  onPaneFocus(tab, leafId) {
    _applyFocus(tab, leafId)
  },
  // onLeafMounted fires after the split-host has appended a pane's
  // root into its slot.  Map panes don't self-render (the editor
  // paints on demand through renderCanvas, not a per-pane rAF), so a
  // freshly-split pane stays blank until we (1) build its _EditorView
  // — without one, renderCanvas's pane loop skips it — and (2) fire a
  // repaint.  We also mirror the focused pane's scroll position so the
  // new pane opens looking at the same region instead of the corner.
  onLeafMounted(tab, _leafId, view) {
    if (!view) return
    if (!view.editorView && typeof view.attachEditorView === 'function') {
      view.attachEditorView()
    }
    const focused = tab.panes && tab.activePaneId && tab.panes.get(tab.activePaneId)
    if (focused && focused !== view && focused.scrollEl && view.scrollEl) {
      view.scrollEl.scrollLeft = focused.scrollEl.scrollLeft
      view.scrollEl.scrollTop = focused.scrollEl.scrollTop
    }
    // Seed this pane's zoom so it's never null once mounted — a null
    // zoom would fall back to the shared state.zoom in the render loop,
    // which leaks one pane's zoom changes onto the others.  A new split
    // pane inherits the splitting pane's zoom; the very first pane takes
    // the doc-level zoom.
    if (view.zoom == null) {
      view.zoom = (focused && focused !== view && focused.zoom != null)
        ? focused.zoom
        : (state.zoom != null ? state.zoom : 1)
    }
    // Re-assert the active pane's id ownership (the new pane's
    // attachEditorView briefly minted #canvas ids) then repaint every
    // pane via the focus-juggle loop in renderCanvas.
    if (tab.activePaneId) _applyFocus(tab, tab.activePaneId)
    hostCallbacks.renderCanvas?.()
  },
}

// _applyFocus — strip the bootstrap-DOM ids from every pane in the
// tab, hand them to the focused one, attach the focused pane's
// _EditorView on first focus, and promote it into the editor-view
// module-let so renderCanvas + viewport helpers + the rest of the
// querySelector('#canvas-scroll') call sites all read this pane.
//
// Defer the attachEditorView call until setFocused has placed the
// ids in the DOM — _EditorView's mount wires listeners that resolve
// querySelector calls during construction.
function _applyFocus(tab, leafId) {
  if (!tab || !tab.panes) return
  for (const v of tab.panes.values()) {
    if (v && typeof v.setFocused === 'function') v.setFocused(false)
  }
  const focused = tab.panes.get(leafId)
  if (!focused) return
  focused.setFocused(true)
  if (!focused.editorView) focused.attachEditorView()
  setActiveEditorView(focused.editorView)
}

export function mountMapSplit(tab, stage, cb = null) {
  const adapter = cb ? _wrapAdapter(MAP_ADAPTER, cb) : MAP_ADAPTER
  mountSplit(tab, stage, adapter)
}

export function detachMapSplit(tab) { detachSplit(tab) }

export function disposeMapSplit(tab) { disposeSplit(tab) }

export function ensureSplitState(tab) { commonEnsure(tab) }

export function revivePanes(tab) { commonRevive(tab, MAP_ADAPTER) }

// applyMapPaneFocus — promote the given pane (or tab.activePaneId if
// omitted) into the focused-pane slot.  Exposed so the activate path
// can fire the focus-attach sequence before the first renderCanvas
// runs (LeafSlot's effect is async + would otherwise leave editorView
// null on the very first paint).
export function applyMapPaneFocus(tab, leafId = null) {
  if (!tab) return
  const id = leafId || tab.activePaneId
  if (!id) return
  _applyFocus(tab, id)
}

function _wrapAdapter(base, cb) {
  return {
    ...base,
    onPaneFocus(tab, leafId) {
      try { base.onPaneFocus && base.onPaneFocus(tab, leafId) } catch { /* ignore */ }
      try { cb.onPaneFocus && cb.onPaneFocus(tab, leafId) } catch { /* ignore */ }
    },
    onTreeChange(tab, next) {
      try { base.onTreeChange && base.onTreeChange(tab, next) } catch { /* ignore */ }
      try { cb.onTreeChange && cb.onTreeChange(tab, next) } catch { /* ignore */ }
    },
  }
}
