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

import { tabs, tabState, $, hostCallbacks } from '../host-context.js'
import { WasmSandboxScene } from '../sandbox/wasm-scene.js'
import { MvControls } from './mv-controls.js'
import { findModelMeta } from '../pickers/model-catalog.js'
import { getModelOpenIntent, setModelOpenIntent } from './host-state.js'
import {
  mountUnitSplit,
  revivePanes,
  startAllRenderers,
} from './split-host.js'
import { startTabTick } from '../common/tab-tick.js'

export async function activateModelTab(tab) {
  // Lazy-import the game3d module so users who never click a
  // model tab don't pay for the shader / matrix code.
  const mod = await import('@kbot/game3d')
  // Stage all OTHER tabs' canvases / split mounts out of the DOM
  // so an inactive tab's surfaces can't bleed through.  Each tab
  // type owns its own attach style: sandbox + unit-editor (since
  // Phase 4) use _splitMount; legacy single-viewer fall-back uses
  // t.viewer.detach().
  const stage = document.querySelector('.model-viewer-stage')
  if (stage) {
    for (const t of tabs) {
      if (t === tab) continue
      if (t._splitMount && t._splitMount.parentNode) {
        try { t._splitMount.parentNode.removeChild(t._splitMount) } catch { /* ignore */ }
      } else if (t.viewer && typeof t.viewer.detach === 'function') {
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
      // Inject the wasm-backed scene so @kbot/game3d stays free of any
      // dependency back into the studio's ui layer.
      sceneFactory: (opts) => new WasmSandboxScene(opts),
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
        // Per-frame work (binding.tick, advanceMvAutoBuild,
        // refreshMvInspectors, ctrls.tick) lives on the tab-owned
        // tick loop since Stage B of the split refactor — see
        // tab-tick.js.  startTabTick is called below in the
        // activate path; nothing to wire on the renderer here.
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
  // Mount the per-tab split tree onto the stage + render its Preact
  // shell.  The PRIMARY pane hosts tab.viewer.canvas; subsequent
  // panes get ModelObserverView instances that share the primary's
  // binding + runtime (animation-driving) but own their own
  // camera / canvas / renderer.  See /ui/unit-editor/split-host.js.
  // The generic split-host wires the right-click context menu on
  // every pane's canvas (idempotent via the canvas._splitCtxWired
  // flag) so we don't have to call wireSplitContextMenu manually.
  if (stage) {
    mountUnitSplit(tab, stage)
    // Defensive canvas re-attach (Preact occasionally orphans a
    // canvas from its slot across tree changes) + start every
    // pane's renderer (deactivate stopped them all).
    revivePanes(tab)
    startAllRenderers(tab)
  }
  // Tab-owned tick loop — drives binding.tick (CobRuntime + _sync +
  // particles + audio) + MvControls.tick (aim / weapons / smoke
  // trails / projectiles) + advanceMvAutoBuild + per-active-tab
  // inspector refresh.  Pre-Stage-B this all lived on the primary
  // renderer's onAfterFrame; moving to the tab decouples timing
  // from the renderer so split-pane secondaries can't double-tick
  // the runtime and a backgrounded tab really does freeze.
  // startTabTick is idempotent (no-op if a loop is already running
  // on this tab).
  startTabTick(tab, (dtMs) => {
    hostCallbacks.advanceMvAutoBuild?.(dtMs)
    if (hostCallbacks.getActiveModelViewer?.() === tab.viewer) {
      hostCallbacks.refreshMvInspectors?.(dtMs)
    }
    // Drive the binding.  Was renderer-driven via setCobBinding's
    // default driveTick:true; ModelViewer now passes driveTick:false
    // so the renderer skips the tick and we own it here.
    const cob = tab.viewer && tab.viewer.cob
    if (cob && typeof cob.tick === 'function') {
      try { cob.tick(dtMs) } catch (err) { console.warn('[unit-editor:cob.tick]', err) }
    }
    // MvControls.tick still uses skipRuntime:true since cob.tick
    // above already advanced the runtime.  Movement / aim / weapon
    // / smoke-trail state lives here.
    const ctrls = tab.viewer && tab.viewer._mvControls
    if (ctrls && typeof ctrls.tick === 'function') {
      try { ctrls.tick(dtMs) } catch (err) { console.warn('[unit-editor:ctrls.tick]', err) }
    }
  })
  // Carry the unit editor's persisted Auto-Rotate state into this
  // tab's viewer ONLY on the very first activation (when the model
  // hasn't loaded yet).  On subsequent activations the tab's own
  // viewer.renderer.autoRotate has whatever the user last set it to
  // and re-applying the global would clobber it — flipping auto-
  // rotate off on tab A then switching to tab B used to turn B's
  // off too because the global was the source of truth.  Same logic
  // applies to camera yaw/pitch/distance/target/trackedTarget — all
  // of which live on the per-tab viewer + camera and survive the
  // tab swap unchanged.  We only seed the global on first activation
  // so the user's last pick carries into a NEW tab as the default,
  // without overriding existing tabs.
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
    const autoRot = hostCallbacks.getUnitEditorAutoRotate?.()
    if (typeof autoRot === 'boolean') tab.viewer.setAutoRotate(autoRot)
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

// resumeIncomingTabRuntime restores the paused state the user had
// before they switched away.  Called from activateModelTab /
// activateSandboxTab after the renderer is re-started so the very
// next tick lands the right paused/running state.  Safe to call
// when no prior snapshot exists (fresh tab) — leaves runtime as-is.
//
// Map tabs no-op (no runtime).  Unit-editor tabs route through the
// viewer's cob.runtime; sandbox tabs route through the per-tab scene
// runtime.  The registrar pattern stores the discriminator on
// tab.typeId; the legacy `tab.type === 'model'` guard never matched
// after Phase A and the resume was a silent no-op until this fix.
export function resumeIncomingTabRuntime(tab) {
  if (!tab) return
  const typeId = tab.typeId || tab.type
  if (typeId !== 'unit-editor' && typeId !== 'sandbox') return
  const wasPaused = tab._pausedBeforeSwitch
  tab._pausedBeforeSwitch = undefined
  const rt = typeId === 'sandbox'
    ? (tab.viewer && tab.viewer.scene && tab.viewer.scene.runtime)
    : (tab.viewer && tab.viewer.cob && tab.viewer.cob.runtime)
  if (!rt || typeof rt.setPaused !== 'function') return
  // If the user had it running before, un-pause now.  Explicitly
  // skipping the call when `wasPaused === undefined` keeps a freshly
  // loaded tab's default paused=false intact.
  if (wasPaused === false && rt.paused) rt.setPaused(false)
  else if (wasPaused === true && !rt.paused) rt.setPaused(true)
}

// openModelViewer pushes a model tab into the unified tab array (or
// mutates the active tab in-place when the React ribbon's "Open
// another model…" was routed with intent='replace' against a unit-
// editor tab).  Reads the FBI meta from the catalogue so the new
// tab carries the same metadata the picker grid showed; the
// descriptor's attachTabRef mirrors spec.name + spec.meta onto the
// legacy fields the viewer code reads.
export async function openModelViewer(name) {
  $('#model-open-dialog').classList.add('hidden')
  // Push a new model tab into the unified tab array so the map
  // editor's tab bar (and the viewer's mirrored tab bar) both show
  // the new entry.  switchToTab routes by type so the dialog mounts
  // automatically.
  const meta = findModelMeta(name)
  const activeTab = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  // Replace path: when the React ribbon's "Open another model..."
  // routed through with intent='replace' AND the active tab is a
  // unit-editor tab, mutate the existing spec/instance instead of
  // pushing a fresh tab.  Mutating spec.name + spec.meta is enough
  // because the descriptor's attachTabRef mirrors them back onto the
  // legacy fields the viewer code reads.
  if (getModelOpenIntent() === 'replace' && activeTab?.typeId === 'unit-editor') {
    activeTab.spec.name = name
    activeTab.spec.meta = meta
    activeTab.name = name
    activeTab.meta = meta
    setModelOpenIntent('add')
    hostCallbacks.switchToTab?.(tabState.activeIndex, { fresh: false, force: true })
    return
  }
  setModelOpenIntent('add')
  hostCallbacks.openTab?.('unit-editor', { name, meta })
}
