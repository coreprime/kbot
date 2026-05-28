// split-host.js
//
// Per-unit-editor-tab split layout mount.  Each unit-editor tab has:
//
//   tab.split        — recursive split tree (Node from split-container.js).
//                      Initially a single leaf with id tab._primaryLeafId,
//                      which hosts the original ModelViewer.  Every
//                      subsequent split adds a leaf hosting a
//                      ModelObserverView against the primary.
//   tab.viewer       — the primary ModelViewer (unchanged; owns the
//                      COB binding + runtime + MvControls).
//   tab.observers    — Map<leafId, ModelObserverView>.  Secondary
//                      panes only.  The primary is NOT in this map.
//   tab._splitMount  — the <div> child of .model-viewer-stage where
//                      the SplitContainer Preact tree is rendered.
//   tab._primaryLeafId — the leaf id whose slot the primary viewer's
//                      canvas mounts into.  Stable for the tab's
//                      lifetime so we always know which leaf is
//                      "the one with the real ModelViewer".
//
// Right-click gesture: the unit editor has NO conflicting right-
// click action, so plain right-click opens the split menu (Split H /
// Split V / Close Pane).  No shift modifier needed.

import { useEffect, useRef } from 'preact/hooks'
import { render } from 'preact'
import { htm as html } from '../common/htm-bind.js'
import {
  SplitContainer, newLeaf, splitLeaf, closeLeaf, isOnlyLeaf, leafIds,
} from '../common/split-container.js'
import { openContextMenu } from '../common/context-menu.js'
import { ModelObserverView } from './observer-view.js'

// ensureSplitState lazily initialises tab.split + observers Map +
// primary leaf id.  Called from tab.js before mountUnitSplit on
// every activation; idempotent.
export function ensureSplitState(tab) {
  if (!tab.split) {
    // Primary leaf id captured here so subsequent splits never
    // accidentally re-mint it (which would orphan the primary's
    // canvas from its slot).
    const primaryLeaf = newLeaf()
    tab._primaryLeafId = primaryLeaf.id
    tab.split = primaryLeaf
  }
  if (!tab.observers) tab.observers = new Map()
}

// LeafSlot — Preact component that hosts whichever viewport belongs
// to a given leaf id.  When leafId === tab._primaryLeafId we mount
// the primary ModelViewer's canvas; otherwise we lazy-create a
// ModelObserverView against the primary.
function LeafSlot({ tab, leafId, hostCallbacks }) {
  const mountRef = useRef(null)
  useEffect(() => {
    const slot = mountRef.current
    if (!slot) return
    let cancelled = false
    let canvas = null
    const ensure = async () => {
      if (leafId === tab._primaryLeafId) {
        // Primary slot — mount the original ModelViewer canvas.
        const viewer = tab.viewer
        if (!viewer || !viewer.canvas) return
        canvas = viewer.canvas
        if (canvas.parentNode !== slot) slot.appendChild(canvas)
      } else {
        // Secondary slot — lazy-create the observer.
        let obs = tab.observers.get(leafId)
        if (!obs) {
          obs = new ModelObserverView({ primaryViewer: tab.viewer })
          obs._leafId = leafId
          obs._isFocusedPane = () => tab.activePaneId === leafId
          tab.observers.set(leafId, obs)
          // Mount its canvas first so width/height can compute,
          // THEN open() which kicks off GL setup + model load.
          if (obs.canvas.parentNode !== slot) slot.appendChild(obs.canvas)
          canvas = obs.canvas
          const modelName = tab.viewer && tab.viewer.model && tab.viewer.model.name
          if (modelName) {
            await obs.open(modelName)
            if (cancelled) {
              try { obs.dispose() } catch { /* ignore */ }
              tab.observers.delete(leafId)
              return
            }
          }
        } else {
          canvas = obs.canvas
          if (canvas.parentNode !== slot) slot.appendChild(canvas)
        }
      }
      // Pointerdown on the canvas marks this pane active (focus
      // gate for hotkeys + future inspector follow).
      if (canvas && !canvas._splitFocusWired) {
        canvas._splitFocusWired = true
        canvas.addEventListener('pointerdown', () => {
          hostCallbacks.onPaneFocus?.(leafId)
        }, true)
      }
    }
    ensure()
    return () => {
      cancelled = true
      if (canvas && canvas.parentNode === slot) {
        try { slot.removeChild(canvas) } catch { /* ignore */ }
      }
    }
  }, [leafId])
  return html`<div class="mv-unit-pane-slot" ref=${mountRef} />`
}

// mountUnitSplit — entry point.  Called from activateModelTab each
// time the unit-editor tab becomes active.  Idempotent.
export function mountUnitSplit(tab, stage, hostCallbacks) {
  ensureSplitState(tab)
  if (!tab.activePaneId) tab.activePaneId = tab._primaryLeafId
  if (!tab._splitMount) {
    tab._splitMount = document.createElement('div')
    tab._splitMount.className = 'mv-split-mount'
  }
  if (tab._splitMount.parentNode !== stage) stage.appendChild(tab._splitMount)
  renderSplitTab(tab, hostCallbacks)
}

// detachUnitSplit — pull this tab's mount root out of the stage on
// deactivate / when switching to another tab.  Keeps the Preact
// tree, observers Map, and split tree alive in memory for fast
// re-activation.
export function detachUnitSplit(tab) {
  const mount = tab._splitMount
  if (mount && mount.parentNode) {
    try { mount.parentNode.removeChild(mount) } catch { /* ignore */ }
  }
}

// disposeUnitSplit — full teardown on tab close.  Disposes every
// observer + drops the Preact mount.  The primary ModelViewer is
// disposed by the tab instance's dispose() path; we just clear our
// own references.
export function disposeUnitSplit(tab) {
  if (tab.observers) {
    for (const obs of tab.observers.values()) {
      try { obs.dispose() } catch { /* ignore */ }
    }
    tab.observers.clear()
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
  tab._primaryLeafId = null
}

// revivePanes — defensive canvas re-attach pass for re-activation.
// Mirrors sandbox/split-host.js's revivePanes.  Walks every leaf in
// the current tree, finds its slot in the DOM, and re-appends the
// primary canvas or observer canvas if Preact reconciliation has
// orphaned it.
export function revivePanes(tab) {
  if (!tab || !tab._splitMount) return
  const ids = leafIds(tab.split)
  for (const id of ids) {
    const leafEl = tab._splitMount.querySelector(`.mv-split-leaf[data-leaf-id="${id}"]`)
    if (!leafEl) continue
    const slot = leafEl.querySelector('.mv-unit-pane-slot')
    if (!slot) continue
    let canvas
    if (id === tab._primaryLeafId) {
      canvas = tab.viewer && tab.viewer.canvas
    } else {
      const obs = tab.observers.get(id)
      canvas = obs && obs.canvas
    }
    if (canvas && canvas.parentNode !== slot) {
      try { slot.appendChild(canvas) } catch { /* ignore */ }
    }
  }
}

// startAllRenderers — restart every pane's renderer on activate.
// The deactivate path stops them so background tabs don't burn
// frames; activate must wake them all up.  Idempotent (renderer.start
// guards re-entry).
export function startAllRenderers(tab) {
  if (!tab) return
  try { tab.viewer && tab.viewer.renderer && tab.viewer.renderer.start && tab.viewer.renderer.start() } catch { /* ignore */ }
  if (tab.observers) {
    for (const obs of tab.observers.values()) {
      try { obs.start() } catch { /* ignore */ }
    }
  }
}

// stopAllRenderers — stop every pane's renderer on deactivate so a
// backgrounded tab doesn't tick its RAF loops.
export function stopAllRenderers(tab) {
  if (!tab) return
  try { tab.viewer && tab.viewer.renderer && tab.viewer.renderer.stop && tab.viewer.renderer.stop() } catch { /* ignore */ }
  if (tab.observers) {
    for (const obs of tab.observers.values()) {
      try { obs.stop() } catch { /* ignore */ }
    }
  }
}

// renderSplitTab — re-render the SplitContainer with the tab's
// current tree.  Called after every tree mutation.
function renderSplitTab(tab, hostCallbacks) {
  const onTreeChange = (next) => {
    tab.split = next
    // Garbage-collect observers whose leaves no longer exist.
    const live = new Set(leafIds(next))
    for (const [id, obs] of tab.observers) {
      if (!live.has(id)) {
        try { obs.dispose() } catch { /* ignore */ }
        tab.observers.delete(id)
      }
    }
    // If the active pane closed, fall back to the first surviving.
    if (!live.has(tab.activePaneId)) {
      tab.activePaneId = [...live][0] || null
    }
    renderSplitTab(tab, hostCallbacks)
  }
  const renderLeaf = (leafId) => html`
    <${LeafSlot}
      key=${leafId}
      tab=${tab}
      leafId=${leafId}
      hostCallbacks=${hostCallbacks} />
  `
  render(
    html`<${SplitContainer}
            tree=${tab.split}
            onTreeChange=${onTreeChange}
            renderLeaf=${renderLeaf} />`,
    tab._splitMount,
  )
}

// wireSplitContextMenu — attach the right-click handler that pops
// the Split H / Split V / Close Pane menu.  Unit editor has no
// conflicting right-click gesture so plain right-click (no shift
// modifier) drives the menu.  Returns a detach() closure.
export function wireSplitContextMenu({ canvas, getTab, leafId, hostCallbacks }) {
  if (!canvas) return () => {}
  const onContext = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    const tab = getTab()
    if (!tab) return
    const items = [
      { id: 'split-h', label: 'Split Horizontal' },
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
      // Refuse to close the primary leaf — that would orphan the
      // ModelViewer's canvas + COB binding from any visible cell.
      // We allow closing other panes (observers) freely.  If the
      // user really wants to "close the primary" they can close
      // the tab itself.
      if (leafId === tab._primaryLeafId) return
      tab.split = closeLeaf(tab.split, leafId)
    }
    renderSplitTab(tab, hostCallbacks)
  }
  canvas.addEventListener('contextmenu', onContext, true)
  return () => canvas.removeEventListener('contextmenu', onContext, true)
}
