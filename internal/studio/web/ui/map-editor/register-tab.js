// register-tab.js
//
// Registers the 'map' tab type with the central tab registry.
// Map tabs are special among the three sections: the editor's
// state lives in module-level lets on the host (undoStack /
// redoStack / pendingTransaction / minimap base + scroll position),
// so the instance has to snapshot those lets into spec on focus
// loss and restore them on focus gain.  Every other state field is
// already per-tab via the MapDoc proxy.

import { registerTabType } from '../tab-registry.js'
import { $, state, hostCallbacks } from '../host-context.js'
import {
  mountMapSplit,
  detachMapSplit,
  disposeMapSplit,
  ensureSplitState,
  revivePanes,
  applyMapPaneFocus,
} from './split-host.js'
import { destroyEditorView } from './editor-view.js'
import { MapPaneView } from './pane-view.js'

class MapEditorTabInstance {
  constructor(spec) {
    // spec: { map }  — `map` is the MapDoc this tab edits.  The
    // MapDoc itself holds all per-tab state (tiles, features,
    // schemas, scroll position, undo stack snapshot, etc).
    this.spec = spec
    this._tabRef = null
  }

  // Mirror map onto the legacy tab record so existing code paths
  // that walk tabs[].map keep working until they migrate.
  attachTabRef(tab) {
    this._tabRef = tab
    tab.map = this.spec.map
    tab.displayName = this.displayName()
  }

  displayName() {
    const name = hostCallbacks.mapDisplayName?.(this.spec.map)
    return name || 'Map'
  }

  // dirty drives the × indicator AND the canClose prompt.  Reads
  // the MapDoc directly so a save() that mutates `dirty = false`
  // shows up on the next signal commit.
  dirty() { return !!this.spec.map?.dirty }

  // Focus gained — hide the model overlay, run the map editor's
  // mount path (canvas + drawer + ribbon + scroll restore).  Every
  // other tab's deactivate has already shut down its renderer and
  // silenced its audio; this path just brings the editor surface
  // up and pulls the active-tab module-let state out of the MapDoc.
  async activate(_ctx) {
    $('#model-viewer-dialog')?.classList.add('hidden')
    $('#welcome-dialog')?.classList.add('hidden')
    $('#model-open-dialog')?.classList.add('hidden')
    // Pull the per-tab module-let state (undo/redo/minimap/scroll)
    // out of the MapDoc.  Without this the previous tab's stacks
    // would still be in scope after the swap.
    hostCallbacks.restoreActiveTabModuleLets?.()
    // The .app container holds the editor surface.  Make sure it's
    // visible before the split tree mounts into it.
    $('#app')?.classList.remove('hidden')
    hostCallbacks.updateTopbarDocInfo?.(this._tabRef)
    // Mount the per-tab split tree onto .canvas-wrap.  The map editor
    // lives in `.canvas-wrap` (NOT `.model-viewer-stage` — that's
    // the 3D editor surface).  Each leaf is a MapPaneView, and the
    // focused pane owns the bootstrap-DOM ids `#canvas-scroll` /
    // `#canvas-stack` so every existing querySelector('#canvas-…')
    // call site reads the focused pane's surface.  Before the first
    // setFocused runs we strip those ids off the bootstrap elements
    // — they remain as orphans inside .canvas-wrap but harmless once
    // the focused pane has claimed the ids.
    const stage = document.querySelector('.canvas-wrap')
    if (stage) {
      // Tear down the singleton _EditorView (the bootstrap path
      // finishEditorBoot mounted on first New / Open).  Idempotent —
      // a no-op once the active view is a per-pane instance.  Without
      // this, the singleton's listeners + ResizeObserver leak across
      // the first tab swap into the split-pane world.
      if (this._tabRef && (!this._tabRef.panes || this._tabRef.panes.size === 0)) {
        destroyEditorView()
      }
      _stripBootstrapCanvasIds()
      ensureSplitState(this._tabRef)
      // Pre-construct the focused pane's MapPaneView SYNCHRONOUSLY so
      // the activation path can hand the pane its focus + ids + an
      // _EditorView before mountMapSplit returns.  The generic split
      // host's LeafSlot uses an async useEffect to call makeLeafView,
      // so without this pre-seed the very first renderCanvas — fired
      // sync below — sees `tab.panes.get(activePaneId)` === undefined
      // and the bootstrap-id strip leaves nothing in the DOM to query.
      const tab = this._tabRef
      if (tab.activePaneId && !tab.panes.has(tab.activePaneId)) {
        const pane = new MapPaneView()
        pane._leafId = tab.activePaneId
        pane._isFocusedPane = () => tab.activePaneId === pane._leafId
        tab.panes.set(tab.activePaneId, pane)
      }
      mountMapSplit(tab, stage)
      // Attach every pane's root into its slot BEFORE focus +
      // editor-view setup.  LeafSlot's useEffect normally does the
      // appendChild asynchronously after Preact commits, but the
      // focus path below + the renderCanvas call later in activate
      // both need `document.querySelector('#canvas-stack')` to
      // resolve to the focused pane — and that only works once the
      // pane's root is in the document.  revivePanes is idempotent
      // and is the canonical place this defensive append lives.
      revivePanes(tab)
      // Drive onPaneFocus synchronously for the active pane so its
      // _EditorView is attached + promoted into the editor-view
      // module-let BEFORE renderCanvas runs.
      applyMapPaneFocus(tab)
    }
    hostCallbacks.updateUndoButtons?.()
    hostCallbacks.bumpContentVersion?.()
    // Sync the React drawer filter input + drawer body to the
    // restored MapDoc's drawer/filter state.
    const filterInput = document.querySelector('#filter')
    if (filterInput) {
      const drawer = state.drawer
      filterInput.value = state.drawerFilters?.[drawer] || ''
    }
    hostCallbacks.renderDrawer?.()
    // Restore the saved mode (paint / select-features / heightmap /
    // voids / etc).  Reads off the activeMap() result so the
    // dropdown reflects this tab's choice.
    hostCallbacks.setMode?.(this.spec.map?.mode || 'select-terrain')
    hostCallbacks.renderCanvas?.()
    // Scroll restored AFTER recreateEditorView so the canvas
    // wrapper's scrollWidth/Height has been laid out (clamping
    // depends on the live dimensions).
    const scroll = document.querySelector('#canvas-scroll')
    if (scroll) {
      scroll.scrollLeft = this.spec.map?.scrollLeft || 0
      scroll.scrollTop = this.spec.map?.scrollTop || 0
    }
  }

  // Focus lost — snapshot the live module-let state INTO the
  // MapDoc so the next activate's restore picks up exactly where
  // the user left off (undo history, pending transaction, etc).
  // The framework calls this on every focus loss so we don't need
  // to gate on outgoing vs incoming.
  deactivate(_ctx) {
    hostCallbacks.snapshotActiveTabModuleLets?.()
    // Hide map-editor floating chrome that lives at viewport scope —
    // .placement-hint and #rotation-badge are `position: fixed`
    // overlays with z-index 9000, ABOVE the model-viewer-dialog.
    // Without an explicit hide they leak over the incoming sandbox
    // or unit-editor tab if the user was mid-placement when they
    // switched.  Map editor's own activate path drives the next
    // visibility so a tab-return doesn't lose any in-flight hints.
    document.getElementById('placement-hint')?.classList.add('hidden')
    document.getElementById('rotation-badge')?.classList.add('hidden')
    // Pull the per-tab split mount OUT of .canvas-wrap so an incoming
    // tab doesn't see a stale map surface overlaid on its own content.
    // Pane state (split tree + panes + editorViews) survives in memory
    // so re-activation rehydrates instantly.
    if (this._tabRef) detachMapSplit(this._tabRef)
  }

  // Dirty tabs prompt the user before they close.  React modal
  // resolves to 'save' | 'discard' | 'cancel'; 'cancel' aborts
  // the close.
  async canClose(_ctx) {
    if (!this.dirty()) return true
    const choice = await hostCallbacks.unsavedChangesDialog?.({
      mapName: this.displayName(),
    })
    if (choice === 'cancel') return false
    if (choice === 'save') {
      const ok = await hostCallbacks.saveActiveMap?.()
      // Failed save leaves the tab open so the user can retry.
      if (!ok) return false
    }
    return true
  }

  // Map tabs have no GPU resources to release — the MapDoc itself
  // is plain data the host can garbage-collect.  The active MapDoc
  // gets snapshot one last time so a re-open from history would
  // see the final state.
  dispose(_ctx) {
    // Tear down every pane's _EditorView + the Preact mount.  The
    // MapDoc itself is plain data the host can garbage-collect.
    if (this._tabRef) disposeMapSplit(this._tabRef)
  }
}

// _stripBootstrapCanvasIds removes `id="canvas-scroll"` /
// `id="canvas-stack"` from the static elements baked into
// index.html so the first MapPaneView.setFocused(true) doesn't
// create duplicate ids in the DOM.  Idempotent — once stripped on
// the first activation the bootstrap elements remain id-less for
// the rest of the session (the panes own the ids from then on).
function _stripBootstrapCanvasIds() {
  for (const el of document.querySelectorAll('#canvas-scroll')) {
    if (!el.classList.contains('canvas-scroll')) continue
    if (el.closest('.mv-map-pane-root')) continue
    el.id = ''
  }
  for (const el of document.querySelectorAll('#canvas-stack')) {
    if (!el.classList.contains('canvas-stack')) continue
    if (el.closest('.mv-map-pane-root')) continue
    el.id = ''
  }
}

export function registerMapTabType() {
  registerTabType({
    typeId: 'map',
    label: 'Map',
    glyph: '🗺',
    create(spec) { return new MapEditorTabInstance(spec) },
  })
}
