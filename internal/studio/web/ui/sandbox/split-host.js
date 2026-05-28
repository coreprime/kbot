// split-host.js
//
// Per-sandbox-tab split layout mount.  Each sandbox tab has:
//
//   tab.split   — recursive split tree (Node from split-container.js).
//                 Initially a single leaf; grows when the user picks
//                 Split H / Split V from the right-click menu.
//   tab.scene   — the shared SandboxScene every pane observes.
//                 Lazy-created when the first pane opens.  Engine event
//                 subscriptions, smoke trails, and audio debounce all
//                 live on the scene so multi-pane doesn't double-emit.
//   tab.panes   — Map<leafId, SandboxView>.  One view per leaf — own
//                 canvas, own renderer, own OrbitCamera, own per-pane
//                 selection set.  Views observe the SHARED scene.
//   tab.activePaneId — which pane drives the panel inspectors + the
//                 _sandboxViewInstance global.  Set on canvas
//                 pointerdown; Phase 6 will wire window-level hotkeys
//                 to this.
//   tab._splitMount — the <div> child of .model-viewer-stage where
//                 the SplitContainer Preact tree is rendered.
//
// The view's canvas is mounted into its leaf cell via a LeafSlot
// component that uses a ref + useEffect to appendChild after Preact
// has placed the cell in the DOM.  Detach on leaf close so the
// renderer can be disposed cleanly.
//
// Right-click on a pane's canvas opens a context menu with:
//   Split Horizontal / Split Vertical / Close Pane
// The sandbox already uses plain right-click for the RTS gesture
// (move-to / attack-here), so the split menu opens on SHIFT+Right-
// click.  Unit-editor / map-editor splits in later phases can use
// plain right-click since they have no conflicting gesture.

import { useEffect, useRef } from 'preact/hooks'
import { render } from 'preact'
import { htm as html } from '../common/htm-bind.js'
import {
  SplitContainer, newLeaf, splitLeaf, closeLeaf, isOnlyLeaf, leafIds,
} from '../common/split-container.js'
import { openContextMenu } from '../common/context-menu.js'
import { SandboxScene } from './scene.js'

// _activePaneCallback — host-supplied notification fired when the
// user clicks into a pane.  Wired by mountSandboxSplit; lets the tab
// swap the _sandboxViewInstance global + republish panels' mv proxy.
// One per tab so two tabs' click handlers don't fight.

// ensureSplitState lazily initialises the tab's split tree + pane
// registry.  Called from tab.js before mountSandboxSplit so the
// active pane can be made BEFORE the Preact tree renders (otherwise
// the LeafSlot effect races the activation's downstream tab.viewer
// reads).  Idempotent; safe to call repeatedly.
export function ensureSplitState(tab) {
  if (!tab.split) tab.split = newLeaf()
  if (!tab.panes) tab.panes = new Map()
  if (!tab.activePaneId) tab.activePaneId = tab.split.id
}

// LeafSlot — Preact wrapper that mounts a sandbox pane's canvas into
// its leaf cell.  The leaf cell is created by SplitContainer; LeafSlot
// is its content.  The ref+useEffect pattern lets us appendChild the
// (non-Preact-owned) canvas into the cell AFTER Preact places the
// cell in the DOM, and detach on unmount so disposing a pane cleanly
// pulls its GL surface out.
function LeafSlot({ tab, leafId, hostCallbacks, viewFactory }) {
  const mountRef = useRef(null)
  useEffect(() => {
    const slot = mountRef.current
    if (!slot) return
    let cancelled = false
    let view = tab.panes.get(leafId)
    let canvas = view ? view.canvas : null
    // Lazy-create the view + open() it on first mount.
    const ensure = async () => {
      if (!view) {
        view = await viewFactory(leafId)
        if (cancelled) {
          // Tab switched away before the view finished loading — drop
          // the half-built view rather than leak it into the registry.
          try { view.dispose?.() } catch { /* ignore */ }
          return
        }
        tab.panes.set(leafId, view)
        canvas = view.canvas
      }
      if (canvas && canvas.parentNode !== slot) slot.appendChild(canvas)
      // Pointerdown on the canvas marks this pane active so panels
      // follow focus.  We attach once per view-canvas pair (idempotent
      // via _splitFocusWired).
      if (canvas && !canvas._splitFocusWired) {
        canvas._splitFocusWired = true
        canvas.addEventListener('pointerdown', () => {
          hostCallbacks.onPaneFocus?.(leafId)
        }, true)  // capture so we beat the view's own click handler
      }
    }
    ensure()
    return () => {
      cancelled = true
      // On leaf unmount (close pane or tab close), pull the canvas
      // out but keep the view alive if the leaf is just re-rendering
      // (which Preact does on tree change).  The garbage-collect pass
      // in onTreeChange decides whether to dispose() the view.
      if (canvas && canvas.parentNode === slot) {
        try { slot.removeChild(canvas) } catch { /* ignore */ }
      }
    }
  }, [leafId])
  return html`<div class="mv-sandbox-pane-slot" ref=${mountRef} />`
}

// mountSandboxSplit — main entry point.  Called by activateSandboxTab
// each time the tab becomes active.  Idempotent: initial call mounts
// the SplitContainer into the stage; later calls re-render with the
// current tree.
//
// hostCallbacks shape:
//   makeView(leafId)    → async (leafId) => SandboxView for that leaf
//   onPaneFocus(leafId) → notification that a pane was clicked
//   onActiveViewChange(view) → emitted when the active pane changes
//                              (so the tab can swap _sandboxViewInstance)
//   onTreeChange(tree)  → optional; called after a divider drag or
//                         a split/close mutates the tree
export function mountSandboxSplit(tab, stage, hostCallbacks) {
  ensureSplitState(tab)
  // Mount root — a per-tab <div> that hosts the SplitContainer.  We
  // create it once and reuse so a tab swap can simply re-attach it
  // to the stage without rebuilding the Preact tree.
  if (!tab._splitMount) {
    tab._splitMount = document.createElement('div')
    tab._splitMount.className = 'mv-split-mount'
  }
  if (tab._splitMount.parentNode !== stage) stage.appendChild(tab._splitMount)
  renderSplitTab(tab, hostCallbacks)
}

// detachSandboxSplit — pull this tab's mount root out of the stage.
// Called by activateSandboxTab on every OTHER tab during a switch so
// the incoming tab's mount is the only one in the DOM.  The Preact
// tree, the panes Map, and the scene all stay alive in memory so
// re-activation rehydrates them instantly.
export function detachSandboxSplit(tab) {
  const mount = tab._splitMount
  if (mount && mount.parentNode) {
    try { mount.parentNode.removeChild(mount) } catch { /* ignore */ }
  }
}

// disposeSandboxSplit — full teardown on tab close.  Stops every
// pane's renderer, drops their canvases, disposes the view objects,
// disposes the scene, unmounts the Preact tree.
export function disposeSandboxSplit(tab) {
  if (tab.panes) {
    for (const view of tab.panes.values()) {
      try { view.dispose?.() } catch { /* ignore */ }
    }
    tab.panes.clear()
  }
  if (tab.scene) {
    try { tab.scene.dispose?.() } catch { /* ignore */ }
    tab.scene = null
  }
  if (tab._splitMount) {
    try { render(null, tab._splitMount) } catch { /* ignore */ }
    if (tab._splitMount.parentNode) {
      try { tab._splitMount.parentNode.removeChild(tab._splitMount) } catch { /* ignore */ }
    }
    tab._splitMount = null
  }
  tab.split = null
  tab.activePaneId = null
}

// renderSplitTab — re-render the SplitContainer with the tab's
// current tree.  Called after every tree mutation (split / close /
// divider drag commit).  Idempotent.
function renderSplitTab(tab, hostCallbacks) {
  const onTreeChange = (next) => {
    tab.split = next
    // Garbage-collect panes whose leaves no longer exist.  Splits +
    // divider drags preserve all leaves; close-pane removes one.
    const liveIds = new Set(leafIds(next))
    for (const [id, view] of tab.panes) {
      if (!liveIds.has(id)) {
        try { view.dispose?.() } catch { /* ignore */ }
        tab.panes.delete(id)
      }
    }
    // If the active pane was the one closed, fall back to the first
    // surviving leaf.  Panels follow focus, so this keeps the
    // inspector chrome populated.
    if (!liveIds.has(tab.activePaneId)) {
      tab.activePaneId = [...liveIds][0] || null
      const view = tab.activePaneId ? tab.panes.get(tab.activePaneId) : null
      if (view) hostCallbacks.onActiveViewChange?.(view)
    }
    renderSplitTab(tab, hostCallbacks)
    hostCallbacks.onTreeChange?.(next)
  }
  const renderLeaf = (leafId) => html`
    <${LeafSlot}
      key=${leafId}
      tab=${tab}
      leafId=${leafId}
      hostCallbacks=${hostCallbacks}
      viewFactory=${hostCallbacks.makeView} />
  `
  render(
    html`<${SplitContainer}
            tree=${tab.split}
            onTreeChange=${onTreeChange}
            renderLeaf=${renderLeaf} />`,
    tab._splitMount,
  )
}

// wireSplitContextMenu — attach the shift+right-click handler that
// pops the Split H / Split V / Close Pane menu.  Caller hands us:
//   canvas      — the pane's <canvas>
//   getTab()    — returns the tab the canvas belongs to (lets the
//                 menu close-pane re-render the right tab)
//   leafId      — this pane's id in the split tree
//   hostCallbacks — same shape as mountSandboxSplit's
//
// Returns a detach() closure for view dispose.
//
// Why shift+right-click instead of plain right-click: the sandbox
// already binds plain right-click to "Move here / Attack this unit"
// (TA RTS convention).  The split menu is a power-user gesture so it
// gets the modifier.
export function wireSplitContextMenu({ canvas, getTab, leafId, hostCallbacks }) {
  if (!canvas) return () => {}
  const onContext = async (e) => {
    if (!e.shiftKey) return                 // not the split gesture
    e.preventDefault()
    e.stopPropagation()                     // beat the view's own ctxmenu
    const tab = getTab()
    if (!tab) return
    const items = [
      { id: 'split-h', label: 'Split Horizontal', hint: '⇧RClick' },
      { id: 'split-v', label: 'Split Vertical' },
      { divider: true },
      { id: 'close', label: 'Close Pane', disabled: isOnlyLeaf(tab.split, leafId) },
    ]
    const choice = await openContextMenu({ x: e.clientX, y: e.clientY, items })
    if (!choice) return
    if (choice === 'split-h') {
      tab.split = splitLeaf(tab.split, leafId, 'h')
    } else if (choice === 'split-v') {
      tab.split = splitLeaf(tab.split, leafId, 'v')
    } else if (choice === 'close') {
      tab.split = closeLeaf(tab.split, leafId)
    }
    renderSplitTab(tab, hostCallbacks)
  }
  canvas.addEventListener('contextmenu', onContext, true)  // capture
  return () => canvas.removeEventListener('contextmenu', onContext, true)
}

// createSharedScene — convenience to lazily create the per-tab
// SandboxScene.  Hosted here (not in tab.js) so the scene+view
// creation pair lives together.
export function createSharedScene({ palette = null } = {}) {
  return new SandboxScene({ palette })
}
