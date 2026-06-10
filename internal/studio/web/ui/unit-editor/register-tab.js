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
import { detachUnitSplit, disposeUnitSplit, stopAllRenderers } from './split-host.js'
import { stopTabTick } from '../common/tab-tick.js'
import { closeAllMvThreadCodePanels } from './debugger/modal.js'

const MODEL_HINTS = 'Drag — orbit · Wheel — zoom · <kbd>Shift</kbd> / right-drag — pan · Click a piece to centre on it'
const UNIT_STATUS = 'Unit viewer ready.'

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
    return this.spec.meta?.unitTitle || this.spec.displayName || this.spec.name || 'Unit'
  }

  // No dirty concept on model tabs (yet).
  dirty() { return false }

  statusBar() {
    const meta = this.spec?.meta || this._tabRef?.meta
    const parts = [meta?.unitTitle, meta?.side, meta?.category, meta?.description].filter(Boolean)
    return {
      title: this.displayName(),
      meta: parts.join(' · '),
      hints: MODEL_HINTS,
      status: this._tabRef?._status != null ? this._tabRef._status : UNIT_STATUS,
    }
  }

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

  // Focus lost — pause the runtime, silence audio, stop EVERY pane's
  // renderer (primary + observers) so backgrounded RAF loops + audio
  // contexts release.  Pull the per-tab split mount out of the stage
  // so an incoming sandbox / map / sibling unit-editor tab doesn't
  // see a stale unit-editor surface overlaid on its own content.
  // Idempotent.
  deactivate(_ctx) {
    // Close any open thread-debugger panels — they point at this unit's COB
    // binding, which is about to be hidden/replaced.
    closeAllMvThreadCodePanels()
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
    // Stop every pane's renderer (primary + observers).  Pre-split
    // there was only one renderer per tab; now multi-pane unit-editor
    // tabs have a primary + N observers each with their own RAF loop.
    stopAllRenderers(tab)
    try { v.renderer && v.renderer.clearCanvas?.() } catch { /* ignore */ }
    // Stop the tab-owned tick loop (binding.tick + ctrls.tick +
    // inspector refresh + auto-build).  Without this a backgrounded
    // tab keeps advancing its runtime on rAF — Pause from the panel
    // would freeze the binding's `paused` flag, but unrelated tabs
    // would still chew CPU on each frame.
    stopTabTick(tab)
    // Pull the split mount out of the stage.  Pre-Phase-4 the canvas
    // sat directly on the stage; with the split mount in place the
    // mount is what an incoming activator needs to detach (the
    // canvas inside the mount stays where it is).
    detachUnitSplit(tab)
  }

  // Model tabs have no save / dirty workflow — closing is always OK.
  async canClose(_ctx) { return true }

  // Final teardown — dispose every observer pane + the primary
  // viewer + its audio/runtime/controls, then drop the host's
  // active-viewer aliases if this tab was foregrounded.
  dispose(_ctx) {
    const tab = this._tabRef
    if (!tab || !tab.viewer || typeof tab.viewer.dispose !== 'function') return
    const v = tab.viewer
    // Stop the tab-owned tick loop FIRST — otherwise the loop's
    // captured tab.viewer reference would keep dereferencing into
    // structures we're about to dispose.
    stopTabTick(tab)
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
      // Pull the canvas OUT of the stage before dispose tears down its
      // GL context.  Without this, the disposed canvas stays in the DOM
      // as an orphan; because every .model-viewer-canvas is block-
      // layout with width/height 100%, the orphan pushes the surviving
      // tab's canvas below the stage's overflow-clip — visually the
      // surviving tab "stops rendering".
      if (typeof v.detach === 'function') {
        try { v.detach() } catch { /* ignore */ }
      }
      v.dispose()
    } catch { /* ignore */ }
    // Dispose every observer pane (each owns its own GL context +
    // local model copy) + tear down the split mount Preact tree.
    disposeUnitSplit(tab)
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
