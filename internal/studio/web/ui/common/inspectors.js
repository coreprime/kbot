// inspectors.js
//
// Floating-panel chrome for the studio's inspector overlays — Scripts,
// Actions, Ports, Static Vars, Camera, Effects, Audio.  Each panel has
// the same drag/collapse/close/clamp + visibility-persist boilerplate,
// factored here so studio.js doesn't carry 280+ lines of vanilla DOM
// wiring.
//
// Lives in /ui/common/ because both the unit editor and the sandbox
// reach into the same panel set — the file used to live under
// /ui/unit-editor/ and was imported across the section boundary,
// which violated the no-peer-imports rule.  The `Mv` prefix in the
// export names is a historical relic from when the only consumer
// was the model viewer; the chrome itself is section-agnostic.
//
// What lives here:
//
//   - MV_INSPECTOR_IDS — the list the View menu + boot wiring iterate
//   - wireMvInspectors — bulk wire + ResizeObserver + Reset button +
//     visibility restore (called once at boot)
//   - wireMvInspector(panelId) — single-panel chrome (drag handler,
//     collapse/close buttons, position restore + post-restore clamp)
//   - setMvInspectorVisible(panelId, visible, opts) — toggle that
//     routes React-managed panels through the panel-store and legacy
//     panels through direct DOM
//   - clampMvInspectorIntoStage(panel) — rescue clamp that pulls a
//     panel whose persisted position fell off-screen back inside the
//     model-viewer stage on resize
//   - clampAllMvInspectors — bulk-clamp used by the stage resize
//     observer + the window resize hook
//
// The per-panel DATA refresh logic (refreshMvInspectors etc.) still
// lives in studio.js and will move out in a follow-up round once the
// debugger code it shares state with (R43c–e) has also been pulled.
//
// Cross-module deps come through host-context (state, clamp) +
// hostCallbacks (getActiveModelViewer for the Reset button + the
// React bridge accessor).  No imports from studio.js itself.

import { state, clamp, hostCallbacks, getReactUi } from '../host-context.js'
import { persistPrefs } from './prefs.js'

export const MV_INSPECTOR_IDS = [
  'mv-inspector-scripts',
  'mv-inspector-network',
  'mv-inspector-actions',
  'mv-inspector-ports',
  'mv-inspector-unit-ports',
  'mv-inspector-movement',
  'mv-inspector-staticvars',
  'mv-inspector-camera',
  'mv-inspector-effects',
  'mv-inspector-projectiles',
  'mv-inspector-audio',
]

// _mvInspectorHeaderHeight — returns the live height of the panel's
// drag-handle header (the .mv-inspector-header bar).  Used by both the
// drag clamp and the rescue clamp to enforce the "title bar must stay
// visible" rule independently of the panel's body height — the body
// can scroll off the bottom of the viewport, but the user has to be
// able to grab the title to drag the panel back.  Falls back to 32 px
// when the header element isn't there yet (panels in the middle of
// construction).
function _mvInspectorHeaderHeight(panel) {
  const hdr = panel?.querySelector?.('.mv-inspector-header')
  if (hdr) {
    const h = hdr.offsetHeight || hdr.getBoundingClientRect().height
    if (h > 0) return h
  }
  return 32
}

// clampMvInspectorIntoStage forces a panel back into the model-viewer
// stage when a resize (window or stage) has pushed it off the edge.
// Guarantee: the panel's ENTIRE title bar (drag grip + name + collapse
// + close buttons) stays inside the viewport.  The body is allowed to
// overflow the bottom of the stage — the user can still grab the
// header to drag the panel back up.  Horizontal clamp keeps the whole
// panel width inside since the title bar spans the panel.
//
// Reload + resize semantics: load restores the panel's persisted
// top/left and immediately runs this rescue, so a layout previously
// saved at 1920×1080 doesn't strand the panel off-screen on a smaller
// viewport.  Resize re-runs the clamp on every dimension change.
export function clampMvInspectorIntoStage(panel) {
  if (!panel || panel.classList.contains('hidden')) return
  const stage = document.querySelector('.model-viewer-stage')
  if (!stage) return
  const sr = stage.getBoundingClientRect()
  const pr = panel.getBoundingClientRect()
  const w = pr.width  || panel.offsetWidth  || 220
  // Style left/top is relative to the stage (the positioning context).
  // Compute current position by subtracting the stage's top-left
  // from the panel's bounding-rect — works whether the panel's CSS
  // is using top/left or right/bottom defaults.
  let left = pr.left - sr.left
  let top  = pr.top  - sr.top
  const headerH = _mvInspectorHeaderHeight(panel)
  // Horizontal: the title bar spans the panel width, so the whole
  // panel has to fit horizontally for the entire bar to be on-screen.
  // Vertical: only the header has to fit; the body is free to spill
  // off the bottom (and the user can drag the title back up).
  const maxLeft = Math.max(0, sr.width  - w)
  const maxTop  = Math.max(0, sr.height - headerH)
  const clLeft = Math.max(0, Math.min(left, maxLeft))
  const clTop  = Math.max(0, Math.min(top,  maxTop))
  if (clLeft === left && clTop === top) return  // already inside — no-op
  panel.style.left = clLeft + 'px'
  panel.style.top  = clTop  + 'px'
  // Once we set left/top in px the CSS edge defaults have to go,
  // mirroring the drag handler's behaviour.
  panel.style.right     = 'auto'
  panel.style.bottom    = 'auto'
  panel.style.transform = 'none'
  // Persist the rescued position so a subsequent reload doesn't snap
  // back to the off-screen coordinate the user had saved.
  state.mvInspectorPos = state.mvInspectorPos || {}
  state.mvInspectorPos[panel.id] = { top: clTop, left: clLeft }
  persistPrefs()
}

// clampAllMvInspectors — bulk-apply the rescue clamp to every floating
// panel currently mounted in the stage.  Queried by .mv-inspector
// class rather than the MV_INSPECTOR_IDS list so the sandbox panel
// (which lives outside that list) and any other future panels picked
// up automatically.  Hidden panels are skipped (the per-panel guard
// inside clampMvInspectorIntoStage handles this).  Called from the
// stage ResizeObserver, the window resize hook, and once on initial
// load so a layout previously saved at a larger viewport doesn't
// strand panels off-screen on a smaller one.
export function clampAllMvInspectors() {
  for (const panel of document.querySelectorAll('.mv-inspector')) {
    clampMvInspectorIntoStage(panel)
  }
}

export function wireMvInspectors() {
  // Wire drag + collapse + close on each panel + the View menu
  // toggle that brings the panel back when it was closed.  Order
  // matters: the drag handler reads from state.mvInspectorPos so
  // we restore positions FIRST, then attach listeners.
  for (const id of MV_INSPECTOR_IDS) wireMvInspector(id)
  // Resize rescue — re-clamp every visible inspector when the stage
  // or window changes size.  Without this, a panel docked near the
  // right/bottom edge ends up partly (or entirely) off-screen when
  // the user shrinks the window, and there's no way to grab it
  // back.  ResizeObserver on the stage covers the common case;
  // window-resize covers Safari's older ResizeObserver semantics +
  // any future cases where the stage size lags the window.
  const stage = document.querySelector('.model-viewer-stage')
  if (stage && typeof ResizeObserver !== 'undefined') {
    // rAF-batched so a continuous drag-resize of the window fires
    // the clamp once per frame instead of on every observer call.
    let pending = false
    const ro = new ResizeObserver(() => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => { pending = false; clampAllMvInspectors() })
    })
    ro.observe(stage)
  }
  window.addEventListener('resize', () => {
    // Same rAF guard so multi-fire resize events coalesce.  Cheap
    // when nothing's visible — clampMvInspectorIntoStage early-outs
    // on hidden panels.
    requestAnimationFrame(clampAllMvInspectors)
  })
  // View dropdown toggle rows are React-managed now — see the
  // ModelViewerRibbon's ViewDropdown which subscribes to panel-store
  // signals directly, so the row's onChange routes through
  // _bridge.setPanelVisible → setMvInspectorVisible without an
  // intermediate DOM click handler.
  // Controls panel "Reset" button — sibling of the Stop action.
  // Same handler as the historic Script Commands panel reset (full
  // COB + controller reset) but exposed beside Stop so the user can
  // revert without opening another inspector.
  const ctrlsReset = document.getElementById('mv-controls-reset-btn')
  if (ctrlsReset && ctrlsReset.dataset.wired !== '1') {
    ctrlsReset.dataset.wired = '1'
    ctrlsReset.addEventListener('click', (e) => {
      e.stopPropagation()
      hostCallbacks.getActiveModelViewer?.()?.resetState?.()
    })
    ctrlsReset.addEventListener('pointerdown', (e) => e.stopPropagation())
    ctrlsReset.addEventListener('mousedown', (e) => e.stopPropagation())
  }
  // Restore visibility prefs.  Default each panel to VISIBLE on
  // first open — the inspectors are the main way to inspect a
  // unit's COB state, so showing them by default avoids requiring
  // the user to dig into the View menu just to see anything.  Once
  // the user explicitly closes a panel that decision is persisted
  // (stored as `false` in state.mvInspectorVisible) and respected
  // on subsequent opens — only the never-toggled case defaults on.
  const vis = state.mvInspectorVisible || {}
  for (const id of MV_INSPECTOR_IDS) {
    const wasSet = Object.prototype.hasOwnProperty.call(vis, id)
    const visible = wasSet ? !!vis[id] : true
    setMvInspectorVisible(id, visible, { persist: false })
  }
  // Re-clamp after the visibility restore so a position saved at a
  // larger viewport (or under a now-narrower stage) doesn't strand
  // any panel off-screen on load.  Two RAFs deep — the first lets
  // the just-shown panels finish their layout pass so the rescue
  // clamp sees accurate offsetWidth / header height.
  requestAnimationFrame(() => requestAnimationFrame(clampAllMvInspectors))
}

export function wireMvInspector(panelId) {
  const panel = document.getElementById(panelId)
  if (!panel) return
  const header = document.getElementById(panelId + '-header')
  // Restore saved position if any.
  const savedPos = (state.mvInspectorPos || {})[panelId]
  if (savedPos) {
    panel.style.top = savedPos.top + 'px'
    panel.style.left = savedPos.left + 'px'
    // Clear the right/bottom defaults the CSS sets for the
    // right-column anchored panels — without this a previously-
    // dragged Camera or StaticVars panel would still get pulled
    // back to the right/bottom edge by the unfired CSS rule.
    // Same goes for `transform: translateY(-50%)` on the Scripts
    // panel's vertical-centre default — leaving it in place after
    // restore offsets the saved top by half the panel's height.
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
    panel.style.transform = 'none'
  }
  const savedCollapsed = (state.mvInspectorCollapsed || {})[panelId]
  if (savedCollapsed) panel.classList.add('collapsed')
  // Collapse / close buttons.
  for (const btn of panel.querySelectorAll('.mv-inspector-toggle')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      panel.classList.toggle('collapsed')
      btn.textContent = panel.classList.contains('collapsed') ? '+' : '−'
      state.mvInspectorCollapsed = state.mvInspectorCollapsed || {}
      state.mvInspectorCollapsed[panelId] = panel.classList.contains('collapsed')
      persistPrefs()
    })
  }
  for (const btn of panel.querySelectorAll('.mv-inspector-close')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      setMvInspectorVisible(panelId, false)
    })
  }
  // Drag via header.  Constrained to the .model-viewer-shell so
  // panels can't be flung over the ribbon / sidebar / footer.
  if (header) {
    let dragOff = null
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return
      e.preventDefault()
      const r = panel.getBoundingClientRect()
      dragOff = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      header.classList.add('dragging')
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragOff) return
      // Clamp to the stage (canvas area), not the whole shell — the
      // shell includes the ribbon, and a panel dragged into that row
      // would overlap the toolbar.  Stage is also the panel's
      // positioning context, so its rect's top/left match the
      // coordinate origin we're writing into style.top / style.left.
      //
      // Vertical bound matches the rescue clamp: only the title bar
      // has to stay on-screen, so the panel's bottom can run off the
      // stage edge.  Useful for tall inspectors (Threads, Effects)
      // where the user wants the header parked near the bottom of
      // the canvas but doesn't care about the lower rows being
      // visible — they can drag the bar back up to peek at them.
      const stage = document.querySelector('.model-viewer-stage')
      if (!stage) return
      const sr = stage.getBoundingClientRect()
      const w = panel.offsetWidth || 220
      const headerH = _mvInspectorHeaderHeight(panel)
      const left = clamp(e.clientX - dragOff.dx - sr.left, 4, Math.max(4, sr.width - w - 4))
      const top = clamp(e.clientY - dragOff.dy - sr.top, 4, Math.max(4, sr.height - headerH - 4))
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
      // Clear right/bottom/transform — panels whose default position
      // is right/bottom-anchored (Camera/StaticVars) or transform-
      // centred (Scripts) carry CSS rules for those edges; once the
      // user drags them we pin to top/left in px and need to unstick
      // the original edge rules so the panel actually follows the
      // cursor instead of being yanked back to its CSS default.
      panel.style.right = 'auto'
      panel.style.bottom = 'auto'
      panel.style.transform = 'none'
    })
    window.addEventListener('mouseup', () => {
      if (!dragOff) return
      dragOff = null
      header.classList.remove('dragging')
      const left = parseInt(panel.style.left, 10) || 0
      const top = parseInt(panel.style.top, 10) || 0
      state.mvInspectorPos = state.mvInspectorPos || {}
      state.mvInspectorPos[panelId] = { top, left }
      persistPrefs()
    })
  }
  // Post-restore rescue clamp.  Panels wired AFTER the wireMvInspectors
  // bulk sweep (e.g. the sandbox panel, created on first sandbox tab
  // activation) wouldn't otherwise get a load-time clamp pass — a
  // saved layout from a wider stage could strand them off-screen.
  // Two RAFs deep so the just-shown panel has a chance to lay out its
  // header before the clamp reads its offsetWidth.
  requestAnimationFrame(() => requestAnimationFrame(() => clampMvInspectorIntoStage(panel)))
}

export function setMvInspectorVisible(panelId, visible, opts = {}) {
  // React-managed panels route through the panel-store so the Preact
  // tree re-renders with the right .hidden class.  Writing straight
  // into the DOM here would survive only until the next Preact diff
  // and then snap back to whatever the store says.  Legacy panels
  // still take the direct-DOM path below.
  const ui = getReactUi()
  if (ui && ui.isInspectorMounted && ui.isInspectorMounted(panelId)) {
    ui.setPanelVisible(panelId, !!visible)
  } else {
    const panel = document.getElementById(panelId)
    if (!panel) return
    panel.classList.toggle('hidden', !visible)
    // If we're SHOWING a panel whose persisted position fell off-screen
    // (e.g. saved at 1920×1080, reopened at 1280×720), rescue it now so
    // the user doesn't have to wait for the next resize event to drag
    // it back.  Run after the next paint so the panel's bounding rect
    // reflects its visible dimensions.
    if (visible) requestAnimationFrame(() => clampMvInspectorIntoStage(panel))
  }
  // Mirror the toggle state into BOTH the unit-editor View menu and
  // the sandbox Developer Tools dropdown — the two menus list the
  // same panel IDs, so toggling visibility from any source updates
  // The View dropdown + sandbox Developer Tools dropdown are React
  // now and subscribe to panel-store signals directly, so a panel
  // visibility flip re-renders both check-marks automatically — no
  // extra sync call needed.
  if (opts.persist !== false) {
    state.mvInspectorVisible = state.mvInspectorVisible || {}
    state.mvInspectorVisible[panelId] = !!visible
    persistPrefs()
  }
}
