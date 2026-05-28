// split-host.js
//
// Generic per-tab split layout mount.  Owns the Preact tree that
// renders a SplitContainer over .model-viewer-stage, the per-leaf
// canvas mounting via LeafSlot, the divider drag plumbing, and the
// right-click context menu that drives Split H / Split V / Close
// Pane.  Each editor (sandbox / unit-editor / map-editor) plugs in
// through an `adapter` object that supplies the editor-specific
// pieces — what to render in each leaf, which leaves can be closed,
// whether the context menu needs a modifier — and inherits all the
// rest from here.
//
// The host's per-tab state lives in these fields on the `tab`:
//
//   tab.split          — recursive split tree (Node from split-container.js).
//   tab.panes          — Map<leafId, view>.  The view is whatever the
//                        adapter's makeLeafView returns; must expose
//                        `canvas` (DOM element); optionally `renderer`,
//                        `dispose()`, `start()`, `stop()`, `clearCanvas()`.
//   tab.activePaneId   — leafId of the pane the user last pointer-down'd
//                        on.  Read by the per-pane focus gates the
//                        editors install on hotkeys + camera controls.
//   tab._splitMount    — the <div> child of .model-viewer-stage that
//                        Preact renders into.  Survives tab swaps so
//                        re-activation rehydrates instantly.
//
// Adapter shape:
//
//   slotClass: string
//     CSS class for the per-leaf wrapper div LeafSlot creates.  Each
//     editor uses its own class so it can target per-cell chrome
//     without affecting siblings (e.g. .mv-sandbox-pane-slot vs
//     .mv-unit-pane-slot).
//
//   contextMenuModifier: 'shift' | null
//     When 'shift', plain right-click falls through (so the editor
//     can use it for an existing gesture, e.g. the sandbox's RTS
//     move-to / attack-here) and SHIFT+right-click opens the split
//     menu.  When null, plain right-click opens the menu.
//
//   async makeLeafView(tab, leafId) → view
//     Construct (or look up) the view for this leaf.  The host
//     awaits this once per leaf-first-mount; cached in tab.panes for
//     subsequent re-mounts of the same leaf (Preact reconciliation,
//     tab swaps).  Required.  The returned object MUST expose:
//       canvas:    HTMLCanvasElement (mounted into the leaf cell)
//     OPTIONAL:
//       renderer:  { start?(), stop?(), clearCanvas?() }
//       dispose(): called when the leaf is removed from the tree
//       start(),
//       stop():    called on tab activate / deactivate (renderer
//                  RAF wake-up / sleep)
//
//   canCloseLeaf(tab, leafId) → boolean
//     Optional.  When omitted, defaults to `!isOnlyLeaf(tab.split,
//     leafId)` — close is allowed unless this is the last pane.
//     Editors that need to protect a particular leaf (e.g. the
//     unit-editor's primary, which owns the COB binding) override.
//
//   onPaneFocus(tab, leafId)
//     Optional notification fired when pointerdown lands in a pane.
//     The host has already updated tab.activePaneId by the time the
//     callback fires.
//
//   onTreeChange(tab, newTree)
//     Optional.  Fired after every successful split / close / divider
//     drag commit.  Use for persistence or live-panel re-rendering.

import { useEffect, useRef } from 'preact/hooks'
import { render } from 'preact'
import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import {
  SplitContainer, newLeaf, splitLeaf, closeLeaf, isOnlyLeaf, leafIds,
} from '/ui/common/split-container.js'
import { openContextMenu } from '/ui/common/context-menu.js'
import { MenuRow, MenuSubmenuRow } from '/ui/common/ribbon.js'

// splitTreeVersion bumps on every applyTreeChange so menu components
// (SplitMenuItems below) re-evaluate the focused pane's close
// eligibility the instant any pane is split / closed — without each
// editor's ribbon having to thread split state through its own signal.
export const splitTreeVersion = signal(0)

// ensureSplitState lazily initialises the per-tab split tree + pane
// registry + active pane id.  Editors call this BEFORE mountSplit
// when they need the active leaf id to construct the first view
// out-of-band (e.g. the unit editor needs tab._primaryLeafId to
// know which leaf hosts the ModelViewer's existing canvas).
export function ensureSplitState(tab) {
  if (!tab.split) tab.split = newLeaf()
  if (!tab.panes) tab.panes = new Map()
  if (!tab.activePaneId) tab.activePaneId = tab.split.id
}

// mountSplit creates the per-tab mount root if needed, appends it to
// the stage, and renders the SplitContainer Preact tree.  Idempotent
// — repeated calls on the same tab re-render with the current tree.
export function mountSplit(tab, stage, adapter) {
  ensureSplitState(tab)
  // Stash the (possibly per-tab-wrapped) adapter so the programmatic
  // split API below can drive splits/closes through the SAME adapter
  // the right-click menu uses — i.e. firing the tab's onPaneFocus /
  // onTreeChange callbacks (active-view aliases etc), not just the
  // editor-static base adapter.
  tab._splitAdapter = adapter
  if (!tab._splitMount) {
    tab._splitMount = document.createElement('div')
    tab._splitMount.className = 'mv-split-mount'
  }
  if (tab._splitMount.parentNode !== stage) stage.appendChild(tab._splitMount)
  renderSplitTab(tab, adapter)
}

// detachSplit pulls the mount root out of the stage on tab deactivate.
// The Preact tree, panes Map, and split tree all stay alive in memory
// so re-activation rehydrates instantly.
export function detachSplit(tab) {
  const mount = tab._splitMount
  if (mount && mount.parentNode) {
    try { mount.parentNode.removeChild(mount) } catch { /* ignore */ }
  }
}

// disposeSplit tears down every pane's view, unmounts the Preact
// tree, drops the mount root.  Called by tab.dispose().
export function disposeSplit(tab) {
  if (tab.panes) {
    for (const view of tab.panes.values()) {
      try { view && view.dispose && view.dispose() } catch { /* ignore */ }
    }
    tab.panes.clear()
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

// revivePanes is the defensive canvas re-attach pass.  Preact's
// reconciliation around tree changes occasionally orphans a pane's
// canvas from its slot DOM element; we walk every live leaf and
// re-appendChild the canvas if needed.  Idempotent.
export function revivePanes(tab, adapter) {
  if (!tab || !tab._splitMount || !tab.panes) return
  for (const [leafId, view] of tab.panes) {
    if (!view || !view.canvas) continue
    const leafEl = tab._splitMount.querySelector(`.mv-split-leaf[data-leaf-id="${leafId}"]`)
    if (!leafEl) continue
    const slot = leafEl.querySelector(`.${adapter.slotClass}`)
    if (!slot) continue
    if (view.canvas.parentNode !== slot) {
      try { slot.appendChild(view.canvas) } catch { /* ignore */ }
    }
  }
}

// startAllRenderers wakes every pane's renderer on tab activate.
// Walks tab.panes and calls view.start() (or view.renderer.start()
// when view itself exposes no start) on each.  Idempotent.
export function startAllRenderers(tab) {
  if (!tab || !tab.panes) return
  for (const view of tab.panes.values()) {
    try {
      if (view && typeof view.start === 'function') view.start()
      else if (view && view.renderer && typeof view.renderer.start === 'function') view.renderer.start()
    } catch { /* ignore */ }
  }
}

// stopAllRenderers puts every pane's renderer to sleep on tab
// deactivate so a backgrounded tab doesn't burn RAF frames.
// Also calls clearCanvas (when supported) so a quick re-focus
// doesn't show the last frame of the outgoing tab.
export function stopAllRenderers(tab) {
  if (!tab || !tab.panes) return
  for (const view of tab.panes.values()) {
    try {
      if (view && typeof view.stop === 'function') view.stop()
      else if (view && view.renderer && typeof view.renderer.stop === 'function') view.renderer.stop()
    } catch { /* ignore */ }
    try {
      if (view && view.renderer && typeof view.renderer.clearCanvas === 'function') {
        view.renderer.clearCanvas()
      }
    } catch { /* ignore */ }
  }
}

// renderSplitTab — re-render the SplitContainer with the tab's
// current tree.  Called from mountSplit + after every tree mutation
// (split / close / divider drag commit).
function renderSplitTab(tab, adapter) {
  const renderLeaf = (leafId) => html`
    <${LeafSlot}
      key=${leafId}
      tab=${tab}
      leafId=${leafId}
      adapter=${adapter} />
  `
  render(
    html`<${SplitContainer}
            tree=${tab.split}
            onTreeChange=${(next) => applyTreeChange(tab, next, adapter)}
            renderLeaf=${renderLeaf} />`,
    tab._splitMount,
  )
}

// applyTreeChange is the single funnel for every tree mutation —
// divider-drag ratio commits (via SplitContainer's onTreeChange),
// context-menu Split / Close, and the programmatic splitActivePane /
// closeActivePane below.  It writes the new tree, garbage-collects
// panes whose leaves vanished (disposing their views so GL contexts
// + canvases release — closing a pane used to leak the view because
// the context-menu path re-rendered without this GC), reseats the
// active pane if it was the one closed, re-renders, and fires the
// adapter's onTreeChange.
function applyTreeChange(tab, next, adapter) {
  tab.split = next
  const live = new Set(leafIds(next))
  for (const [id, view] of tab.panes) {
    if (!live.has(id)) {
      try { view && view.dispose && view.dispose() } catch { /* ignore */ }
      tab.panes.delete(id)
    }
  }
  if (!live.has(tab.activePaneId)) {
    tab.activePaneId = [...live][0] || null
    if (tab.activePaneId) {
      try { adapter.onPaneFocus && adapter.onPaneFocus(tab, tab.activePaneId) } catch { /* ignore */ }
    }
  }
  renderSplitTab(tab, adapter)
  _applyFocusClass(tab)
  try { adapter.onTreeChange && adapter.onTreeChange(tab, next) } catch { /* ignore */ }
  // Tell any open View ▸ Split menu the tree changed so its Close row
  // re-evaluates close eligibility against the new active pane.
  splitTreeVersion.value++
}

// LeafSlot — Preact wrapper that mounts a leaf's view-canvas into
// the slot DOM element.  Uses ref + useEffect so the imperatively-
// owned canvas is appendChild'd AFTER Preact places the slot in the
// DOM, and detached on unmount.  Wires the per-pane focus gate
// (pointerdown → tab.activePaneId) + the context menu the first
// time the canvas is mounted.
function LeafSlot({ tab, leafId, adapter }) {
  const mountRef = useRef(null)
  useEffect(() => {
    const slot = mountRef.current
    if (!slot) return
    let cancelled = false
    let view = tab.panes.get(leafId)
    let canvas = view ? view.canvas : null
    const ensure = async () => {
      if (!view) {
        view = await adapter.makeLeafView(tab, leafId)
        if (cancelled) {
          try { view && view.dispose && view.dispose() } catch { /* ignore */ }
          return
        }
        // Per-pane focus gate, shared across every editor — observer
        // / SandboxView / etc check this in their wireHotkeys +
        // attachOrbitControls callbacks so window-level keys only
        // affect the focused pane.
        view._leafId = leafId
        view._isFocusedPane = () => tab.activePaneId === leafId
        tab.panes.set(leafId, view)
        canvas = view.canvas
      }
      if (canvas && canvas.parentNode !== slot) slot.appendChild(canvas)
      if (canvas && !canvas._splitFocusWired) {
        canvas._splitFocusWired = true
        canvas.addEventListener('pointerdown', () => {
          if (tab.activePaneId !== leafId) {
            tab.activePaneId = leafId
            try { adapter.onPaneFocus && adapter.onPaneFocus(tab, leafId) } catch { /* ignore */ }
            _applyFocusClass(tab)
          }
        }, true)
      }
      _applyFocusClass(tab)
      if (canvas && !canvas._splitCtxWired) {
        canvas._splitCtxWired = true
        _wireSplitContextMenu(canvas, tab, leafId, adapter)
      }
      // Post-mount hook — fires once the pane's view exists AND its
      // canvas is in the slot DOM.  Editors whose panes don't self-
      // render (the map editor paints on demand via renderCanvas, not a
      // per-pane rAF) use this to attach the pane's renderer + trigger
      // the first paint.  Optional + idempotent: views that self-render
      // (sandbox / unit observers) simply don't define it.
      try { adapter.onLeafMounted && adapter.onLeafMounted(tab, leafId, view) } catch { /* ignore */ }
    }
    ensure()
    return () => {
      cancelled = true
      if (canvas && canvas.parentNode === slot) {
        try { slot.removeChild(canvas) } catch { /* ignore */ }
      }
    }
  }, [leafId])
  return html`<div class=${adapter.slotClass} ref=${mountRef} />`
}

// _applyFocusClass toggles `.is-focused` on every `.mv-split-leaf`
// in the tab's mount tree, putting it on whichever leaf id matches
// tab.activePaneId.  Used by LeafSlot's effect (on initial mount +
// re-mount) and by the pointerdown focus handler.  CSS in studio.css
// styles `.mv-split-leaf.is-focused` with a subtle accent border so
// the user has visual feedback for which pane will receive the next
// hotkey + which one's camera is reflected in the Renderer panel.
function _applyFocusClass(tab) {
  if (!tab || !tab._splitMount) return
  const leaves = tab._splitMount.querySelectorAll('.mv-split-leaf')
  for (const el of leaves) {
    const id = el.dataset.leafId
    if (id === tab.activePaneId) el.classList.add('is-focused')
    else el.classList.remove('is-focused')
  }
}

// _wireSplitContextMenu attaches the right-click handler that pops
// the Split H / Split V / Close Pane menu.  Modifier gating + per-
// leaf close eligibility come from the adapter.
function _wireSplitContextMenu(canvas, tab, leafId, adapter) {
  const onContext = async (e) => {
    if (adapter.contextMenuModifier === 'shift' && !e.shiftKey) return
    e.preventDefault()
    e.stopPropagation()
    const canClose = (typeof adapter.canCloseLeaf === 'function')
      ? !!adapter.canCloseLeaf(tab, leafId)
      : !isOnlyLeaf(tab.split, leafId)
    const items = [
      { id: 'split-h', label: 'Split Horizontal' },
      { id: 'split-v', label: 'Split Vertical' },
      { divider: true },
      { id: 'close', label: 'Close Pane', disabled: !canClose },
    ]
    const choice = await openContextMenu({ x: e.clientX, y: e.clientY, items })
    if (!choice) return
    if (choice === 'split-h') {
      applyTreeChange(tab, splitLeaf(tab.split, leafId, 'h'), adapter)
    } else if (choice === 'split-v') {
      applyTreeChange(tab, splitLeaf(tab.split, leafId, 'v'), adapter)
    } else if (choice === 'close') {
      if (!canClose) return
      applyTreeChange(tab, closeLeaf(tab.split, leafId), adapter)
    }
  }
  canvas.addEventListener('contextmenu', onContext, true)
}

// ── Programmatic split API ───────────────────────────────────────────
//
// Menu-driven entry points that mirror the right-click context menu
// but act on tab.activePaneId.  Editors wire these to a "View ▸ Split"
// menu so the gesture is discoverable without the right-click.  The
// adapter (per editor) supplies the same slotClass / makeLeafView /
// canCloseLeaf behaviour the context menu uses.

// splitActivePane splits the focused pane in the given orientation
// ('h' = side-by-side, 'v' = stacked).  No-op when there's no active
// pane.  The new pane is created lazily by the LeafSlot effect, same
// as a right-click split.  `adapter` defaults to the wrapped adapter
// stashed by mountSplit so the tab's per-tab callbacks fire.
export function splitActivePane(tab, orient, adapter = null) {
  if (!tab || !tab.split || !tab.activePaneId) return
  if (orient !== 'h' && orient !== 'v') return
  applyTreeChange(tab, splitLeaf(tab.split, tab.activePaneId, orient), adapter || tab._splitAdapter)
}

// closeActivePane collapses the focused pane into its sibling.  Honours
// the adapter's canCloseLeaf gate (e.g. the unit editor refuses to
// close its primary leaf) and the universal last-pane-can't-close
// rule.  No-op when closing isn't allowed.
export function closeActivePane(tab, adapter = null) {
  const a = adapter || tab?._splitAdapter
  if (!canCloseActivePane(tab, a)) return
  applyTreeChange(tab, closeLeaf(tab.split, tab.activePaneId), a)
}

// canCloseActivePane reports whether closeActivePane would do
// anything — used by menus to enable / disable the Close item.
export function canCloseActivePane(tab, adapter = null) {
  if (!tab || !tab.split || !tab.activePaneId) return false
  const a = adapter || tab._splitAdapter
  if (a && typeof a.canCloseLeaf === 'function') {
    return !!a.canCloseLeaf(tab, tab.activePaneId)
  }
  return !isOnlyLeaf(tab.split, tab.activePaneId)
}

// ── Shared View-menu items ───────────────────────────────────────────
//
// SplitMenuItems renders the "Split ▸ Horizontal / Vertical" cascade
// plus a "Close Pane" row, the discoverable counterpart to the right-
// click Split menu.  Every editor's View menu drops this in so the
// gesture + wording stay identical across sandbox / unit / map.
//
//   dropdownId — the parent Dropdown's id, so the rows dismiss it on click
//   onSplitH / onSplitV — fire a split in that orientation
//   onClose    — close the focused pane
//   canClose   — boolean OR a live () => boolean.  When false the Close
//                row is omitted (it's meaningless on the last pane).
//
// Reads splitTreeVersion so a split / close performed elsewhere
// re-renders the Close row's presence without the host re-publishing.
export function SplitMenuItems({ dropdownId, onSplitH, onSplitV, onClose, canClose }) {
  void splitTreeVersion.value
  const closeable = typeof canClose === 'function' ? !!canClose() : !!canClose
  return html`
    <${MenuSubmenuRow} icon="⊞" label="Split" title="Split this view into two panes">
      <${MenuRow} icon="▥" label="Split Horizontal"
                  title="Split into side-by-side panes"
                  dropdownId=${dropdownId} onClick=${onSplitH} />
      <${MenuRow} icon="▤" label="Split Vertical"
                  title="Split into stacked panes"
                  dropdownId=${dropdownId} onClick=${onSplitV} />
    <//>
    ${closeable ? html`
      <${MenuRow} icon="✖" label="Close Pane"
                  title="Close the focused pane and grow its sibling"
                  dropdownId=${dropdownId} onClick=${onClose} />
    ` : null}
  `
}
