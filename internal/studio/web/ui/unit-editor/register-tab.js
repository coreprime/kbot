// register-tab.js
//
// Registers the 'unit-editor' tab type with the central tab registry.
// The descriptor is the unit editor's full public interface to the
// host — the host never reaches into per-unit state, only through the
// instance methods the descriptor returns.
//
// Lifecycle delegated to /ui/unit-editor/tab.js (activator) and the
// per-tab ModelViewer's dispose path.  Eventually the activator's
// body collapses into the instance's activate() — for now we keep
// the delegation thin so the registrar swap doesn't depend on every
// downstream module change landing first.

import { registerTabType } from '../tab-registry.js'
import { $, hostCallbacks } from '../host-context.js'
import { activateModelTab } from './tab.js'

// Per-tab record kept on the instance.  The host's tabs[] entry still
// carries `name`, `meta`, `viewer`, `_pausedBeforeSwitch` for
// backward-compat with code that hasn't migrated yet; the instance
// reads them through `_tabRef` and writes back to the same object so
// both shapes stay in lockstep until the legacy fields fully drain.
class UnitEditorTabInstance {
  constructor(spec) {
    // spec: { name, meta, displayName? }
    this.spec = spec
    // _tabRef is set by the host immediately after createTab so we
    // can keep mutating the shared record (tab.viewer = ...) until
    // every reader is migrated to instance-only access.
    this._tabRef = null
  }

  // Bind a host-side tab record so this instance can keep the legacy
  // `tab.viewer` / `tab._pausedBeforeSwitch` fields in sync.  Called
  // by studio.js's openTab path right after createTab.
  attachTabRef(tab) {
    this._tabRef = tab
    // Mirror spec fields onto the legacy record for back-compat.
    tab.name = this.spec.name
    tab.meta = this.spec.meta
    if (this.spec.displayName) tab.displayName = this.spec.displayName
  }

  displayName() {
    return this.spec.displayName || this.spec.name || 'Unit'
  }

  // No dirty concept on model tabs (yet).
  dirty() { return false }

  // Focus gained — bring the unit editor's DOM surface up + run the
  // per-tab activator (canvas attach, viewer construction, ribbon
  // sync).  activateModelTab reads the same `_tabRef` legacy fields
  // so we hand it the record directly.
  async activate(_ctx) {
    const tab = this._tabRef
    // Show the unit editor's surface, hide the map editor's.  The
    // welcome modal + the model-open dialog are dismissed on every
    // activation so the user lands cleanly on the canvas.
    $('#app')?.classList.remove('hidden')
    $('#welcome-dialog')?.classList.add('hidden')
    $('#model-open-dialog')?.classList.add('hidden')
    $('#model-viewer-dialog')?.classList.remove('hidden')
    // Drop the sandbox-mode tag in case the outgoing tab was a
    // sandbox — keeps the unit-editor sidebar (Pieces / Textures /
    // Weapons) visible.
    $('#model-viewer-dialog')?.classList.remove('sandbox-mode')
    // Hide the sandbox panel if the outgoing tab left it visible.
    document.getElementById('sandbox-panel')?.classList.add('hidden')
    await activateModelTab(tab)
  }

  // Focus lost — pause the runtime, silence audio, stop the renderer
  // so the RAF loop and audio context release.  Idempotent so the
  // framework can call this on every non-active tab when it wants to
  // guarantee a quiescent background.
  deactivate(_ctx) {
    const tab = this._tabRef
    if (!tab) return
    const v = tab.viewer
    if (!v) return
    // Stash the pre-switch paused state so the next activate restores
    // the user's prior intent (Pause click survives tab swaps).
    const rt = v.cob && v.cob.runtime
    if (rt && typeof rt.setPaused === 'function') {
      if (tab._pausedBeforeSwitch === undefined) {
        tab._pausedBeforeSwitch = !!rt.paused
      }
      if (!rt.paused) {
        try { rt.setPaused(true) } catch { /* ignore */ }
      }
    }
    if (typeof v.setSilenced === 'function') {
      try { v.setSilenced(true) } catch { /* ignore */ }
    }
    if (v.renderer && typeof v.renderer.stop === 'function') {
      try { v.renderer.stop() } catch { /* ignore */ }
      // Clear the canvas so a quick re-focus doesn't bleed the last
      // frame of the OUTGOING tab over the incoming one.
      try { v.renderer.clearCanvas?.() } catch { /* ignore */ }
    }
  }

  // Model tabs have no save / dirty workflow — closing is always OK.
  async canClose(_ctx) { return true }

  // Final teardown — dispose viewer + its audio/runtime/controls,
  // then drop the host's active-viewer aliases if this tab was
  // foregrounded.
  dispose(_ctx) {
    const tab = this._tabRef
    if (!tab || !tab.viewer || typeof tab.viewer.dispose !== 'function') return
    const v = tab.viewer
    try {
      const rt = v.cob && v.cob.runtime
      if (rt && typeof rt.setPaused === 'function') rt.setPaused(true)
      if (v.cob && v.cob.audio && typeof v.cob.audio.dispose === 'function') {
        v.cob.audio.dispose()
      }
      if (typeof v.setSilenced === 'function') v.setSilenced(true)
      if (v._mvControls && typeof v._mvControls.dispose === 'function') {
        v._mvControls.dispose()
        v._mvControls = null
      }
      v.dispose()
    } catch { /* ignore */ }
    // Drop host's active-viewer alias when the disposed view was
    // foregrounded — switchToTab will promote a sibling on the next
    // activation.
    if (hostCallbacks.getActiveModelViewer?.() === v) {
      hostCallbacks.setActiveModelViewer?.(null)
      hostCallbacks.setActiveMvControls?.(null)
    }
    tab.viewer = null
  }
}

// Boot-side registration.  Studio.js calls this once during the
// configureReactUi cold-path.  Idempotent registration would throw —
// the host owns the boot order so a duplicate call is a programming
// error worth surfacing.
export function registerUnitEditorTabType() {
  registerTabType({
    typeId: 'unit-editor',
    label: 'Unit',
    glyph: '🛠',
    create(spec) { return new UnitEditorTabInstance(spec) },
  })
}
