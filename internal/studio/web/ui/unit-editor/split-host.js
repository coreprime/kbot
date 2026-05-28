// split-host.js
//
// Unit-editor adapter for the generic split-host in
// /ui/common/split-host.js.  The unit editor's pane model is
// ASYMMETRIC: one PRIMARY leaf hosts the existing ModelViewer
// (the canvas + COB binding + runtime + MvControls), and N
// SECONDARY leaves host lightweight ModelObserverView instances
// that observe the primary's animated model from their own camera
// + GL context.  See observer-view.js for why the asymmetry exists
// (renderer-driven binding.tick would otherwise multiply with N
// panes).
//
// The adapter's makeLeafView branches on `leafId === tab._primaryLeafId`:
// the primary returns a thin wrapper view exposing the existing
// viewer's canvas + renderer; secondary leaves construct a fresh
// ModelObserverView, lazy-load the model into its own GL context,
// and bind the primary as its pose source.
//
// canCloseLeaf refuses the primary so the user can't accidentally
// orphan the COB-running ModelViewer from any visible cell — the
// only way to "close the primary" is to close the entire tab.

import {
  mountSplit, detachSplit, disposeSplit, revivePanes as commonRevive,
  startAllRenderers as commonStartAll, stopAllRenderers as commonStopAll,
  ensureSplitState as commonEnsure,
} from '../common/split-host.js'
import { newLeaf, isOnlyLeaf } from '../common/split-container.js'
import { ModelObserverView } from './observer-view.js'

// PrimaryViewerWrapper — a tiny adapter that lets the generic
// split-host treat the existing ModelViewer like any other
// pane-view.  tab.panes Map indexes both wrappers (for the primary)
// and real ModelObserverViews (for secondaries) under the same
// shape: `{ canvas, renderer?, start?(), stop?(), dispose?() }`.
// The wrapper's dispose is a no-op — the primary ModelViewer's
// lifecycle is owned by tab.dispose() (it predates the split mount).
class PrimaryViewerWrapper {
  constructor(viewer) {
    this.viewer = viewer
    // Live getters so a late-loading viewer (canvas + renderer arrive
    // after model load) doesn't get frozen with null fields.
  }
  get canvas()   { return this.viewer && this.viewer.canvas }
  get renderer() { return this.viewer && this.viewer.renderer }
  start() { try { this.renderer && this.renderer.start && this.renderer.start() } catch { /* ignore */ } }
  stop()  { try { this.renderer && this.renderer.stop  && this.renderer.stop()  } catch { /* ignore */ } }
  dispose() { /* primary lifecycle is owned by tab.dispose(); no-op here */ }
}

// UNIT_ADAPTER — the editor-static plug.  Branches in makeLeafView
// + canCloseLeaf encode the primary-vs-observer asymmetry.
const UNIT_ADAPTER = {
  slotClass: 'mv-unit-pane-slot',
  // Unit editor has no conflicting right-click gesture, so plain
  // right-click opens the menu (no modifier needed).
  contextMenuModifier: null,
  async makeLeafView(tab, leafId) {
    if (leafId === tab._primaryLeafId) {
      return new PrimaryViewerWrapper(tab.viewer)
    }
    const obs = new ModelObserverView({ primaryViewer: tab.viewer })
    const modelName = tab.viewer && tab.viewer.model && tab.viewer.model.name
    if (modelName) await obs.open(modelName)
    return obs
  },
  canCloseLeaf(tab, leafId) {
    // Refuse the primary leaf — that would orphan the ModelViewer's
    // canvas from any visible cell.  Otherwise honour the generic
    // last-pane-can't-close rule.
    if (leafId === tab._primaryLeafId) return false
    return !isOnlyLeaf(tab.split, leafId)
  },
}

// ── Public surface — unit-editor-flavoured names so the tab.js +
// register-tab.js callers don't have to change their imports.

// ensureSplitState — augments the common ensure with primary-leaf-
// id tracking (the unit editor needs a stable id for the leaf that
// hosts the existing ModelViewer's canvas).  Called from tab.js
// before mountUnitSplit so the primary leaf id is known when the
// activator wires the per-tab callbacks.
export function ensureSplitState(tab) {
  if (!tab._primaryLeafId) {
    // Seed BEFORE commonEnsure so tab.split's first leaf carries
    // our primary id.  Without this the generic ensure would mint
    // an unrelated id and our primary leaf id would never match.
    const primary = newLeaf()
    tab._primaryLeafId = primary.id
    tab.split = primary
  }
  if (!tab.observers) tab.observers = new Map()
  commonEnsure(tab)
}

export function mountUnitSplit(tab, stage, cb = null) {
  ensureSplitState(tab)
  const adapter = cb ? _wrapAdapter(UNIT_ADAPTER, cb) : UNIT_ADAPTER
  mountSplit(tab, stage, adapter)
}

export function detachUnitSplit(tab) { detachSplit(tab) }

export function disposeUnitSplit(tab) {
  // Observer-specific cleanup mirror of common dispose — observers
  // own their own GL contexts; the common dispose path calls
  // view.dispose() on each, which for ModelObserverView tears down
  // its renderer + local model + cameras.  The PrimaryViewerWrapper's
  // dispose is a no-op since the primary ModelViewer is owned by
  // the tab instance's dispose() path.
  disposeSplit(tab)
  if (tab.observers) tab.observers.clear()
  tab._primaryLeafId = null
}

export function revivePanes(tab) { commonRevive(tab, UNIT_ADAPTER) }
export function startAllRenderers(tab) { commonStartAll(tab) }
export function stopAllRenderers(tab)  { commonStopAll(tab) }

// wireSplitContextMenu — context menus are now wired automatically
// by the generic split-host's LeafSlot effect.  This shim stays as a
// no-op so the lone tab.js call site continues to lint clean until
// it's swept.  Will be removed in a follow-up.
export function wireSplitContextMenu(_opts) {
  return () => {}
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
