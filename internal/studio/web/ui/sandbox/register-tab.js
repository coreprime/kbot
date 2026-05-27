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
  }

  displayName() {
    return this.spec.displayName || 'Sandbox'
  }

  dirty() { return false }

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
  // because each sandbox owns its own engine + scene.
  deactivate(_ctx) {
    const tab = this._tabRef
    if (!tab) return
    const v = tab.viewer
    if (!v) return
    const rt = v.scene && v.scene.runtime
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
      try { v.renderer.clearCanvas?.() } catch { /* ignore */ }
    }
  }

  async canClose(_ctx) { return true }

  dispose(_ctx) {
    const tab = this._tabRef
    if (!tab || !tab.viewer || typeof tab.viewer.dispose !== 'function') return
    const v = tab.viewer
    try {
      const rt = v.scene && v.scene.runtime
      if (rt && typeof rt.setPaused === 'function') rt.setPaused(true)
      if (typeof v.setSilenced === 'function') v.setSilenced(true)
      v.dispose()
    } catch { /* ignore */ }
    if (getActiveSandboxView() === v) clearActiveSandboxView()
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
