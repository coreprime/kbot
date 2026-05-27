// tab.js
//
// activateModelTab — the per-tab unit-editor lifecycle.  Each
// unit-editor tab owns its OWN ModelViewer + canvas + runtime +
// MvControls so swapping between unit tabs preserves per-unit state
// (live threads, weapon mid-fire, build progress).  The currently
// "active" tab's viewer + controls are still tracked by studio.js
// (the modelViewerInstance / _mvControls module-level lets the
// inspector + ribbon code reads from); we just promote whichever
// tab the user is switching INTO via setActiveModelViewer +
// setActiveMvControls callbacks.
//
// The onModelLoaded closure captures THIS tab's viewer so a
// fast tab swap during the async open() doesn't accidentally
// rewrite the wrong tab's controls.  Inspectors only refresh
// when this tab is the active one; the per-frame renderer hook
// still ticks the viewer's _mvControls even when backgrounded
// so weapon SM + audio scheduling stay coherent.

import { tabs, $, hostCallbacks } from '../host-context.js'
import { MvControls } from './mv-controls.js'

export async function activateModelTab(tab) {
  // Lazy-import the model3d module so users who never click a
  // model tab don't pay for the shader / matrix code.
  const mod = await import('../../model3d/index.js')
  // Stage all OTHER tabs' canvases out of the DOM so the GL surface
  // for an inactive tab can't bleed through to the active frame.
  // Same pattern activateSandboxTab uses; treats unit + sandbox
  // viewers uniformly.
  const stage = document.querySelector('.model-viewer-stage')
  if (stage) {
    for (const t of tabs) {
      if (t === tab) continue
      if (t.viewer && typeof t.viewer.detach === 'function') {
        try { t.viewer.detach() } catch { /* ignore */ }
      }
    }
    // The legacy shared `#model-viewer-canvas` from index.html is no
    // longer used by any tab — pull it out of the stage so it can't
    // overlay the active tab's per-tab canvas.
    const legacyCanvas = hostCallbacks.sharedModelViewerCanvas?.()
    if (legacyCanvas && legacyCanvas.parentNode === stage) {
      stage.removeChild(legacyCanvas)
    }
  }
  // Lazy-create this tab's viewer + canvas on first activation.
  // Subsequent activations just re-attach the existing canvas.
  if (!tab.viewer) {
    const canvas = document.createElement('canvas')
    canvas.className = 'model-viewer-canvas'
    // Each viewer captures `viewer` in its onModelLoaded closure so
    // the per-load setup writes through the LOCAL instance rather
    // than the global alias — important when the model finishes
    // loading while a different tab is already active (rare but
    // possible if the user clicks fast).
    let viewer  // forward-declared so the closure binds to the const below
    viewer = new mod.ModelViewer({
      canvas,
      statusEl: $('#status'),
      onModelLoaded: (model, cob) => {
        // Initial lifecycle state — units with a Create script
        // start 'unborn' (Action buttons gated until Create runs);
        // others start 'created'.
        if (cob) cob._lifecycle = (cob.hasScript && cob.hasScript('Create')) ? 'unborn' : 'created'
        // Per-viewer MvControls.  Dispose any previous instance
        // attached to THIS viewer (e.g. on a second open of the
        // same tab with a different unit).  Each unit tab keeps
        // its own MvControls so aim/move targets survive a tab
        // swap.
        if (viewer._mvControls) viewer._mvControls.dispose()
        const ctrls = new MvControls(viewer)
        viewer._mvControls = ctrls
        hostCallbacks.mvFetchUnitMeta?.(viewer)
        // Wire the per-frame inspector + auto-build hook.  Bind to
        // the viewer's controls explicitly so the closure stays
        // accurate even when a tab swap retargets _mvControls.
        if (viewer.renderer) {
          viewer.renderer.onAfterFrame = (dtMs) => {
            hostCallbacks.advanceMvAutoBuild?.(dtMs)
            // Only refresh inspectors when THIS viewer is the
            // active one — backgrounded tabs shouldn't shove their
            // signal updates into the React tree.
            if (hostCallbacks.getActiveModelViewer?.() === viewer) {
              hostCallbacks.refreshMvInspectors?.(dtMs)
            }
            ctrls.tick(dtMs)
          }
        }
        // Per-tab sidebar + COB panel only refresh when THIS viewer
        // is the front one.  Otherwise a delayed load (the user
        // clicked away mid-fetch) would clobber the active tab's
        // piece tree / textures / etc.
        if (hostCallbacks.getActiveModelViewer?.() === viewer) {
          hostCallbacks.renderPieceTree?.(model)
          hostCallbacks.renderTexturesTab?.(model)
          hostCallbacks.wireMvSidebarTabs?.()
          hostCallbacks.refreshCobPanel?.(cob)
          hostCallbacks.setActiveMvControls?.(ctrls)
        }
      },
    })
    tab.viewer = viewer
  }
  // Promote this tab's viewer to the global aliases the rest of the
  // studio reads (host bridges, panels, ribbon handlers, inspector
  // refresh).  Mirrors how sandboxViewInstance flips on each
  // activateSandboxTab.
  hostCallbacks.setActiveModelViewer?.(tab.viewer)
  hostCallbacks.setActiveMvControls?.(tab.viewer._mvControls || null)
  // Attach this tab's canvas into the stage so it's the visible
  // surface again.  Idempotent — re-attaching to the same parent
  // is a no-op.
  if (stage && typeof tab.viewer.attach === 'function') tab.viewer.attach(stage)
  // Wire the per-frame inspector refresh callback the first time
  // the renderer is alive (it might not be on the very first
  // activation if the network fetch lost a race).  Idempotent.
  if (tab.viewer.renderer && !tab.viewer.renderer.onAfterFrame) {
    tab.viewer.renderer.onAfterFrame = (dtMs) => {
      hostCallbacks.advanceMvAutoBuild?.(dtMs)
      if (hostCallbacks.getActiveModelViewer?.() === tab.viewer) {
        hostCallbacks.refreshMvInspectors?.(dtMs)
      }
      tab.viewer._mvControls?.tick(dtMs)
    }
  }
  // Carry the unit editor's persisted Auto-Rotate state into this
  // tab's viewer.  Per-tab — each tab can have its own rotate
  // state if you wanted, but the global cache means all tabs share
  // the user's last pick by default.
  const autoRot = hostCallbacks.getUnitEditorAutoRotate?.()
  if (typeof autoRot === 'boolean') tab.viewer.setAutoRotate(autoRot)
  // Open the unit IF this tab has never loaded one (first
  // activation).  Subsequent activations of the SAME tab skip the
  // load — the per-tab viewer already holds the model + cob and
  // restoring the paused state below is enough to bring it back
  // exactly as the user left it.  Different units in different
  // tabs each go through their own first-load path on their own
  // viewer; there's no shared open() destroying anything.
  const alreadyLoaded = (tab.viewer.model
    && tab.viewer.model.name === tab.name
    && tab.viewer.cob && tab.viewer.cob.unit)
  if (!alreadyLoaded) {
    await tab.viewer.open(tab.name)
    // Re-grab _mvControls — the onModelLoaded callback set
    // viewer._mvControls and the global alias only if the viewer
    // was already active when the await resolved.  If a fast tab
    // swap interleaved, mop up here.
    if (hostCallbacks.getActiveModelViewer?.() === tab.viewer && tab.viewer._mvControls) {
      hostCallbacks.setActiveMvControls?.(tab.viewer._mvControls)
    }
  }
  // Make sure the RAF loop is running — switchToTab stops it on the
  // way to map / sandbox tabs.  Renderer .start() is idempotent.
  try { tab.viewer.renderer?.start?.() } catch { /* ignore */ }
  // Un-silence the viewer's audio — switchToTab muted us on the way
  // out; coming back resets so weapon sounds + select acks play.
  if (tab.viewer._mvControls && typeof tab.viewer._mvControls.setSilenced === 'function') {
    try { tab.viewer._mvControls.setSilenced(false) } catch { /* ignore */ }
  }
  // Restore the runtime's pre-switch paused state.  Per-tab viewer
  // means per-tab runtime, so the resume is unconditionally tied
  // to this tab's _pausedBeforeSwitch.
  hostCallbacks.resumeIncomingTabRuntime?.(tab)
  if (!alreadyLoaded) {
    hostCallbacks.applyDefaultGroundFor?.(tab.meta)
    // Apply Unit Editor defaults from the persisted Settings the
    // first time we load this tab's unit.
    hostCallbacks.applyUnitEditorDefaults?.()
  }
}
