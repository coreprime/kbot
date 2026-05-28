// split-host.js
//
// Sandbox-tab adapter for the generic split-host in
// /ui/common/split-host.js.  Re-exports the host's public surface
// so existing call sites in /ui/sandbox/tab.js + register-tab.js
// don't have to change their imports — they get the same
// mountSandboxSplit / detachSandboxSplit / disposeSandboxSplit /
// revivePanes / ensureSplitState / wireSplitContextMenu / createSharedScene
// API the per-editor module exported before the generic refactor.
//
// All editor-specific knobs live in the adapter object below:
// the slot CSS class, the shift-modifier requirement (because plain
// right-click is already the RTS move/attack gesture in the
// sandbox), and a makeLeafView that constructs a SandboxView wired
// against the shared scene.

import {
  mountSplit, detachSplit, disposeSplit, revivePanes as commonRevive,
  startAllRenderers as commonStartAll, stopAllRenderers as commonStopAll,
  ensureSplitState as commonEnsure,
} from '../common/split-host.js'
import { SandboxScene } from './scene.js'
import { SandboxView } from './view.js'
import { $ } from '../host-context.js'

// SANDBOX_ADAPTER — the per-editor plug for the generic split-host.
// Every leaf hosts a peer SandboxView against the shared scene; the
// first pane (created in tab.js before mount) sets up tab.scene,
// subsequent panes observe it.  All panes are equal — there's no
// "primary" leaf in the sandbox the way there is in the unit editor
// (the unit editor's primary owns the COB binding; the sandbox's
// engine subscriptions live at scene level so panes are symmetric).
const SANDBOX_ADAPTER = {
  slotClass: 'mv-sandbox-pane-slot',
  // Sandbox already binds plain right-click to "Move here / Attack
  // this unit" (the classic TA RTS gesture).  Split menu opens on
  // SHIFT+right-click so the gameplay path stays one-click.
  contextMenuModifier: 'shift',
  async makeLeafView(tab, _leafId) {
    if (!tab.scene) tab.scene = new SandboxScene({ palette: null })
    const v = new SandboxView({
      canvas: null,
      scene: tab.scene,
      statusEl: $('#status'),
    })
    await v.open()
    return v
  },
  // Sandbox uses the default canCloseLeaf (disabled only when this
  // is the only leaf in the tree).
  onPaneFocus(tab, _leafId) {
    // The active pane drives the "legacy tab.viewer" alias the rest
    // of the studio reads through hostBridge + getActiveSandboxView.
    tab.viewer = tab.panes.get(tab.activePaneId) || tab.viewer
  },
}

// ── Public surface — re-exported with sandbox-flavoured names so
// the tab.js / register-tab.js callers keep their existing imports.

export function mountSandboxSplit(tab, stage, cb = null) {
  // Per-tab adapter — merge editor-static adapter (SANDBOX_ADAPTER)
  // with caller-supplied per-tab callbacks so tab.js can update its
  // own module-let aliases on pane focus / tree change without the
  // adapter having to know about them.
  const adapter = cb ? _wrapAdapter(SANDBOX_ADAPTER, cb) : SANDBOX_ADAPTER
  mountSplit(tab, stage, adapter)
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

export function detachSandboxSplit(tab) { detachSplit(tab) }

export function disposeSandboxSplit(tab) { disposeSplit(tab) }

export function ensureSplitState(tab) { commonEnsure(tab) }

export function revivePanes(tab) { commonRevive(tab, SANDBOX_ADAPTER) }

// startAllRenderers / stopAllRenderers — sandbox uses the common
// implementation that walks tab.panes and calls view.renderer.start
// / .stop on each.
export function startAllRenderers(tab) { commonStartAll(tab) }
export function stopAllRenderers(tab)  { commonStopAll(tab) }

// createSharedScene — kept for tab.js compatibility.  Pure
// re-export so the scene module isn't pulled in by callers that
// don't need it.
export function createSharedScene(opts) {
  return new SandboxScene(opts)
}

// wireSplitContextMenu — historically a separately-exported helper
// the tab wired onto each pane's canvas manually.  The generic
// split-host now handles context-menu wiring inside its LeafSlot
// effect (idempotent via the canvas._splitCtxWired flag), so this
// stays as a no-op shim for backward compatibility.  Will be
// removed once the lone tab.js call site is cleaned up.
export function wireSplitContextMenu(_opts) {
  return () => {}
}
