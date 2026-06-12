// register-tab.js
//
// Registers the 'sandbox' tab type with the central tab registry.
// Mirror of /ui/unit-editor/register-tab.js; the only differences
// are that the activator routes through /ui/sandbox/tab.js and that
// the active SandboxView alias clears through
// clearActiveSandboxView instead of the modelViewer setter.

import { registerTabType } from '../tab-registry.js'
import { $ } from '../host-context.js'
import {
  activateSandboxTab,
  getActiveSandboxView,
  clearActiveSandboxView,
} from './tab.js'
import { disposeSandboxSplit, detachSandboxSplit } from './split-host.js'
import { stopTabTick } from '../common/tab-tick.js'

const MODEL_HINTS = 'Drag — orbit · Wheel — zoom · <kbd>Shift</kbd> / right-drag — pan · Click a piece to centre on it'
const SANDBOX_STATUS = 'Sandbox ready — click "Spawn Unit" to add a unit to the field.'

class SandboxTabInstance {
  constructor(spec) {
    // spec: { displayName? }
    this.spec = spec
    this._tabRef = null
  }

  // Same backward-compat shim as UnitEditorTabInstance — keep
  // legacy `tab.viewer` / `tab.name` / `tab.sandbox` fields populated
  // until every reader migrates to instance access.
  attachTabRef(tab) {
    this._tabRef = tab
    tab.name = this.spec.displayName || 'Sandbox'
    tab.displayName = this.spec.displayName || 'Sandbox'
    // Legacy boolean flag a handful of host helpers still read to
    // route pause/resume into scene.runtime rather than cob.runtime.
    tab.sandbox = true
    // Join mode — when the welcome dialog created this tab for a hosted
    // sandbox (New Hosted / Join Hosted), the spec carries the host
    // websocket URL.  activateSandboxTab reads it off the tab to back
    // the shared scene with a WsFrameSource.  Null for Local mode.
    tab._joinUrl = this.spec.joinUrl || null
    // Battlefield + faction choice from the welcome picker —
    // activateSandboxTab loads the map and spawns the leader on first
    // activation. Null mapPath = The Grid.
    tab._mapPath = this.spec.mapPath || null
    tab._faction = this.spec.faction || null
  }

  displayName() {
    return this.spec.displayName || 'Sandbox'
  }

  dirty() { return false }

  statusBar() {
    const meta = this.spec?.meta || this._tabRef?.meta
    const parts = [meta?.unitTitle, meta?.side, meta?.category, meta?.description].filter(Boolean)
    return {
      title: this.displayName(),
      meta: parts.join(' · '),
      hints: MODEL_HINTS,
      status: this._tabRef?._status != null ? this._tabRef._status : SANDBOX_STATUS,
    }
  }

  async activate(_ctx) {
    const tab = this._tabRef
    // Same DOM toggles as the unit editor — sandbox lives on the
    // model-viewer dialog's stage; the `sandbox-mode` class is added
    // by the activator itself.
    $('#app')?.classList.remove('hidden')
    $('#welcome-dialog')?.classList.add('hidden')
    $('#model-open-dialog')?.classList.add('hidden')
    $('#model-viewer-dialog')?.classList.remove('hidden')
    await activateSandboxTab(tab)
  }

  // Pause runtime + silence audio + stop renderer.  Sandbox tabs
  // route the pause through scene.runtime rather than cob.runtime
  // because each sandbox owns its own engine + scene.  Since Phase 3
  // tabs can host N panes; we pause via the SHARED scene runtime
  // (one per tab), silence + stop every pane's renderer.
  deactivate(_ctx) {
    const tab = this._tabRef
    if (!tab) return
    const scene = tab.scene
    const rt = scene && scene.runtime
    if (rt && typeof rt.setPaused === 'function') {
      if (tab._pausedBeforeSwitch === undefined) {
        tab._pausedBeforeSwitch = !!rt.paused
      }
      if (!rt.paused) {
        try { rt.setPaused(true) } catch { /* ignore */ }
      }
    }
    if (scene && typeof scene.setSilenced === 'function') {
      try { scene.setSilenced(true) } catch { /* ignore */ }
    }
    // Stop EVERY pane's renderer (multi-pane case).  Fall back to the
    // legacy single-viewer path when panes isn't populated (defensive).
    const panes = tab.panes
    if (panes && panes.size > 0) {
      for (const v of panes.values()) {
        if (v && v.renderer && typeof v.renderer.stop === 'function') {
          try { v.renderer.stop() } catch { /* ignore */ }
          try { v.renderer.clearCanvas?.() } catch { /* ignore */ }
        }
      }
    } else {
      const v = tab.viewer
      if (v && v.renderer && typeof v.renderer.stop === 'function') {
        try { v.renderer.stop() } catch { /* ignore */ }
        try { v.renderer.clearCanvas?.() } catch { /* ignore */ }
      }
    }
    // Stop the tab-owned tick loop (scene.tick + cob-lifecycle +
    // inspector refresh).  Without this a backgrounded sandbox tab
    // would keep ticking — runtime time + smoke trails + projectile
    // age would all advance even though the tab is invisible.
    stopTabTick(tab)
    // Pull the per-tab split mount OUT of the stage so an incoming
    // unit-editor or map tab doesn't see a stale sandbox surface
    // overlaid on its own content.  Pre-split the legacy single
    // viewer's v.detach() did this implicitly via the activator's
    // sweep; with splits the activator's sweep only knows about
    // tab.viewer (the active pane), not the whole mount.  Owning the
    // detach here keeps the responsibility on the tab type that
    // attached the mount in the first place.
    detachSandboxSplit(tab)
  }

  async canClose(_ctx) { return true }

  dispose(_ctx) {
    const tab = this._tabRef
    if (!tab) return
    // Stop the tab-owned tick loop first so it can't fire mid-
    // teardown and dereference structures we're about to dispose.
    stopTabTick(tab)
    // Silence + pause the shared scene first so nothing keeps ticking
    // mid-teardown.  Then sweep every pane's view (renderer + GL
    // context + canvas), then drop the scene + split mount.
    try {
      const rt = tab.scene && tab.scene.runtime
      if (rt && typeof rt.setPaused === 'function') rt.setPaused(true)
      if (tab.scene && typeof tab.scene.setSilenced === 'function') tab.scene.setSilenced(true)
      // Release every unit's AudioPool nodes back to the browser.
      // setSilenced only PAUSES the `<audio>` elements; without an
      // explicit dispose they stay rooted (and leak) while paused.
      // This used to live in SandboxView.dispose(), but that now skips
      // shared-scene teardown so a per-pane close doesn't mute the
      // survivors — so the once-per-tab release moves here.
      const engine = tab.scene && tab.scene.engine
      if (engine && engine._units && typeof engine._units.values === 'function') {
        for (const u of engine._units.values()) {
          if (u && u.binding && u.binding.audio
              && typeof u.binding.audio.dispose === 'function') {
            try { u.binding.audio.dispose() } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    if (tab.panes && tab.panes.size > 0) {
      for (const v of tab.panes.values()) {
        try {
          if (v._splitCtxDetach) v._splitCtxDetach()
          if (typeof v.detach === 'function') v.detach()
          if (typeof v.dispose === 'function') v.dispose()
        } catch { /* ignore */ }
      }
    } else if (tab.viewer && typeof tab.viewer.dispose === 'function') {
      const v = tab.viewer
      try {
        if (typeof v.detach === 'function') v.detach()
        v.dispose()
      } catch { /* ignore */ }
    }
    disposeSandboxSplit(tab)
    // Drop the module-level active-view reference when it pointed into THIS
    // tab — otherwise the refresh tick, ribbon orders, and Runtime panel
    // keep reading the disposed view (frozen counters, Select All routed to
    // a dead scene). Note tab.panes maps paneId → view, so ownership is a
    // values() scan, not .has().
    const active = getActiveSandboxView()
    if (active) {
      const ownsActive = tab.panes
        ? [...tab.panes.values()].includes(active)
        : tab.viewer === active
      if (ownsActive) clearActiveSandboxView()
    }
    tab.viewer = null
  }
}

export function registerSandboxTabType() {
  registerTabType({
    typeId: 'sandbox',
    label: 'Sandbox',
    glyph: '🪖',
    create(spec) { return new SandboxTabInstance(spec) },
  })
}
