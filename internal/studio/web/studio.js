// Shared COB tokenisers + jump-arrow helpers — same algorithm the
// explorer's BOSHighlighter/COBAHighlighter components run, factored
// out so both tools render identically.  Pure functions, no DOM.
import {
  highlightBosLine as sharedHighlightBosLine,
  cobaOpCategory,
  computeJumps as sharedComputeJumps,
} from './cob-highlight.js'

// Controls overlay — Move + Aim/Fire scheduler.  Lives in its own
// module so studio.js doesn't sprout another inline subsystem.
import { MvControls } from './mv-controls.js'
let _mvControls = null

// Map-editor-only literals + pure helpers — extracted into the
// /ui/map-editor/ subfolder so other React components can pick them
// up without dragging studio.js's runtime state along.  These are
// strictly map-scoped: nothing here is referenced by the unit editor
// or sandbox views.
import {
  TILE_PX,
  VOID_COLOR,
  MAX_START_POSITIONS,
  QUALITY_CHECK_MIN_MS,
  QUALITY_WINDOW_MIN_MS,
  BUILDABLE_MAX_SLOPE,
  BUILDABLE_FILL,
  MAP_PAN_RATE_PX_S,
  MAP_PAN_ACCEL_MAX_MULT,
  MAP_PAN_ACCEL_TIME_MS,
  WORLDS,
  DRAWER_ITEM_HEIGHT,
  DRAWER_OBSERVER_MARGIN,
  FEATURE_HIT_SEARCH_TILES,
  START_POS_RADIUS,
  HM_HOLD_INTERVAL_MS,
  SCHEMA_PLAYER_COUNTS,
} from './ui/map-editor/constants.js'
import {
  worldFor,
  activeWorldsFor,
  featureWorldMatches,
  isWreckageFeature,
  normalizedRect,
  mulberry32,
  defaultOTAState,
  playerCountLabel,
} from './ui/map-editor/helpers.js'

// Host context — shared module-level state for every /ui/* subsystem.
// MapDoc, the `state` Proxy, the tab registry, the DOM helpers and
// the tiny utilities (setStatus / clamp / escapeHTML / …) all live
// in one module so map-editor / unit-editor / sandbox code can import
// them without dragging studio.js along.  See ./ui/host-context.js
// for the rules — anything mutable across modules goes on a plain
// object (`tabState.activeIndex`) because ES-module `let` exports
// are read-only on the import side.
import {
  MapDoc,
  tabs,
  tabState,
  activeMap,
  state,
  hostCallbacks,
  setReactUi,
  $,
  $$,
  setStatus,
  clamp,
  escapeHTML,
  sanitiseFilename,
} from './ui/host-context.js'

// Undo / redo + transaction wrapper for map edits — moved to
// /ui/map-editor/undo.js.  studio.js still calls these directly
// from the keyboard handler, the ribbon, and every mode tool.
import {
  undoStack,
  redoStack,
  beginTransaction,
  commitTransaction,
  abortTransaction,
  undo,
  redo,
  updateUndoButtons,
  refreshHistoryFlyouts,
  getPendingTransaction,
  setPendingTransaction,
} from './ui/map-editor/undo.js'

// Clipboard subsystem (terrain drag-clipboard + system Ctrl+C/V/X)
// — moved to /ui/map-editor/clipboard.js.  Same call sites as
// before; the implementations are now in the map-editor tree.
import {
  shrinkRectToContent,
  captureTerrain,
  rotateTerrainClipboard,
  dropTerrainClipboard,
  cancelTerrainClipboard,
  clearRegion,
  cutSelection,
  clearAllFeatures,
  clearFeaturesInSelection,
  copyToClipboard,
  pasteFromClipboard,
} from './ui/map-editor/clipboard.js'

// WebGL tile + feature renderer — moved to
// /ui/map-editor/canvas/webgl.js.  Forward-reference helpers
// (whenImageReady, preloadFeatureImage, renderCanvas,
// featureAnchorOffset, featureAnchorWorld) stay in studio.js for
// now and are wired through hostCallbacks.
import {
  resetGL,
  ensureGLRenderer,
  glClearViewport,
  glRenderTilesAndFeatures,
} from './ui/map-editor/canvas/webgl.js'

// Pure rotation + flip helpers shared by the 2D draw path, the GL
// renderer, and the stamp pipeline.  No state, no DOM — just
// algebra over (origW, origH, rotation, flipH, flipV).
import {
  rotatedFootprint,
  rotatedSourceCell,
  transformedSourceCell,
  drawTransformedTile,
} from './ui/map-editor/rotation.js'

// Persisted UI prefs — drawer filters, view-menu toggles, inspector
// panel visibility, the Settings dialog's tunables.  Moved to
// /ui/common/prefs.js so every view (map editor, unit editor,
// sandbox) reads + writes its own subset through the same API.
import {
  loadPersistedPrefs,
  syncDomFromPrefs,
  persistPrefs,
} from './ui/common/prefs.js'

// Server heartbeat poller — every /api/studio/heartbeat ping
// detects a dead backend so the UI can flip into a disconnected
// state.  Lives in /ui/common/ since both the editor and the
// welcome screen poll on the same timer.
import { startServerHeartbeat, isConnected } from './ui/common/heartbeat.js'

// Floating-panel layout (drag + collapse + persist) for the legacy
// non-React panels — dev stats panel, camera-info panel.  React-
// managed panels (Stats / Minimap / Camera) own their own position
// via panel-store + FloatingPanel, and applyPanelLayout skips them.
import {
  makePanelDraggable,
  persistPanelCollapsed,
  applyPanelLayout,
} from './ui/common/panel-layout.js'

// confirmDialog — imperative wrapper around the React confirm modal.
// Delegates to reactUi.confirmDialog when the bridge has loaded,
// falls back to native window.confirm before then.  Lives in
// /ui/dialogs/ alongside the React component.
import { confirmDialog } from './ui/dialogs/confirm.js'

// Welcome dialog visual + audio FX — all three are pure
// self-contained subsystems that observe #welcome-dialog's hidden
// class via MutationObserver to suspend / resume on dialog close.
// No host state, no React touch.
import { wireWelcomeNanoFX } from './ui/screens/welcome/fx/nano-fx.js'
import { wireWelcomeAmbient } from './ui/screens/welcome/fx/ambient.js'
import { wireWelcomeGlamour } from './ui/screens/welcome/fx/glamour.js'

// Welcome-screen arrow-key + Enter navigation.  Pure DOM, no host
// state.  Auto-focuses the New card on every re-show.
import { wireWelcomeKeyboard } from './ui/screens/welcome/keyboard.js'

// Welcome-screen drag-drop loader — accepts .tnt + optional .ota
// from the user's desktop and routes through the openLoadedMap
// host callback.
import { wireWelcomeDropZone } from './ui/screens/welcome/drop-zone.js'

// Open-map picker flow.  Owns its own catalogue polling state
// (availableMaps / mapsLoading / mapsPollTimer / selectedMapPath
// / openMapSource); routes the chosen map through the
// openLoadedMap host callback.
import {
  openMapDialog,
  closeOpenDialog,
} from './ui/pickers/open-map.js'

// ?initial_map=<name> URL shortcut — polls the catalogue then
// routes through the same openLoadedMap host callback as the
// picker.  Called from the boot block.
import { maybeAutoOpenFromQuery } from './ui/pickers/auto-open.js'

// View-menu visibility toggles (minimap / features / start
// positions / voids).  Each flips the matching state.show* flag,
// persists prefs, republishes the ribbon, and drops out of any
// mode whose targets just became invisible.
import {
  setMinimapVisible,
  setFeaturesVisible,
  setStartPositionsVisible,
  setVoidsVisible,
} from './ui/map-editor/view-toggles.js'

// Dice-face player-count picker for the New-map size dialog.
// Owns its own dicePicked Set; pickedPlayerCounts() reads it at
// startEditor() time to seed N-player schemas.
import {
  pickedPlayerCounts,
  populateWorldSelect,
  renderDiceGrid,
} from './ui/map-editor/dialogs/dice-picker.js'

// KBot Studio — browser-side editor.
//
// State model
// -----------
//   map = {
//     tileW, tileH,         // map dimensions in tiles
//     name, planet,         // metadata used by the saved .ota
//     tiles[tileW*tileH]    // each cell is null OR { sectionPath, sx, sy }
//     features[]            // { name, ax, ay } — feature placements at 16px res
//   }
//
// Sections are loaded once from /api/studio/sections and their tile-grid
// renders are fetched lazily from /api/studio/section-image/.  When the
// user stamps a section onto the map, we slice the corresponding 32×32
// tile out of the section's tile-grid image at draw time.

// The numeric / string literal map-editor constants (TILE_PX,
// VOID_COLOR, MAX_START_POSITIONS, the WORLDS table, ...) and the
// pure helpers that consume them (worldFor, activeWorldsFor, ...)
// live in ./ui/map-editor/{constants,helpers}.js and are imported at
// the top of this file.  Keeping them out of studio.js lets the
// React /ui tree share the same source of truth without a circular
// dependency on the legacy host.

// Per-map state (MapDoc + PER_MAP_FIELDS + the `state` Proxy + the
// tab registry + DOM helpers + the tiny string/clamp utilities) is
// now exported from ./ui/host-context.js — see the import block at
// the top of this file.  The single-source-of-truth lives there so
// subsystem modules can mutate it without going through studio.js.

// OTA defaults (defaultOTAState / defaultSchema /
// defaultStartPositionsForSchema) and world-resolution helpers
// (activeWorldsFor, featureWorldMatches) now live in
// ./ui/map-editor/helpers.js — see the import block at the top of
// this file.

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Wire host-context callbacks so the extracted subsystems
  // (/ui/map-editor/undo.js, /ui/map-editor/clipboard.js, ...) can
  // call back into studio.js for functions that haven't moved yet.
  // Every value is a plain function pointer — subsystems look up
  // via `hostCallbacks.foo?.()` and tolerate a missing entry, so
  // ordering with the rest of boot is forgiving.
  hostCallbacks.cancelPlacement = cancelPlacement
  hostCallbacks.showPlacementHint = showPlacementHint
  hostCallbacks.hidePlacementHint = hidePlacementHint
  hostCallbacks.renderCanvas = () => renderCanvas()
  hostCallbacks.renderMapTabs = renderMapTabs
  hostCallbacks.recreateEditorView = recreateEditorView
  hostCallbacks.refreshSchemaSelector = refreshSchemaSelector
  hostCallbacks.publishMapRibbonState = publishMapRibbonState
  hostCallbacks.setMode = setMode
  hostCallbacks.invalidateMinimapBase = invalidateMinimapBase
  hostCallbacks.whenImageReady = whenImageReady
  hostCallbacks.preloadFeatureImage = preloadFeatureImage
  hostCallbacks.featureAnchorOffset = featureAnchorOffset
  hostCallbacks.featureAnchorWorld = featureAnchorWorld
  hostCallbacks.configureReactUi = configureReactUi
  hostCallbacks.openLoadedMap = openLoadedMap
  // Cross-module helpers — keyboard shortcuts in mv-controls call
  // these via window.* to avoid an ES-module circular import.
  _wireRuntimeHelpersToWindow()
  // Size dialog (New flow).
  $('#size-confirm').addEventListener('click', startEditor)
  $('#size-w').addEventListener('keydown', confirmOnEnter)
  $('#size-h').addEventListener('keydown', confirmOnEnter)
  $('#size-name').addEventListener('keydown', confirmOnEnter)
  // Welcome modal — pick New vs Open.
  $('#welcome-new').addEventListener('click', () => {
    sizeDialogSource = 'welcome'
    $('#welcome-dialog').classList.add('hidden')
    openSizeDialog()
  })
  $('#welcome-open').addEventListener('click', () => openMapDialog('welcome'))
  wireWelcomeKeyboard()
  wireWelcomeDropZone()
  wireWelcomeNanoFX()
  wireWelcomeGlamour()
  wireWelcomeAmbient()
  // Welcome tabs are React-rendered (see /ui/screens/welcome/welcome-screen.js);
  // the host mounts the card body via mountWelcomeScreen() inside
  // configureReactUi().  No vanilla tab wiring needed any more.
  wireMvRuntimeVisibility()
  // Hydrate persisted UI prefs FIRST — the wire* helpers below read
  // from state during setup (e.g. wireMvInspectors decides each
  // inspector panel's initial visibility from state.mvInspectorVisible).
  // If load runs after wiring, every wire-time read sees an empty
  // state and the user's saved choices get clobbered on each reload.
  loadPersistedPrefs()
  wireModelDialogs()
  // Settings + Help + Developer dialog handlers are needed even
  // when the user never enters the map editor (e.g. open straight
  // into a 3DO model).  Wiring them at boot keeps the buttons
  // working from every entry point.
  wireDeveloperDialog()
  // Multi-tab management — the tab bar + "+" popout above the toolbar.
  wireMapTabBar()
  $('#size-cancel').addEventListener('click', closeSizeDialog)
  // Open-map dialog is React-managed now (see /ui/pickers/open-map-dialog.js).
  // The static #open-dialog markup in index.html is no longer driven;
  // the React picker mounts its own DOM via mountDialogs().
  const yr = $('#copyright-year')
  if (yr) yr.textContent = new Date().getFullYear()
  // Paint the dice-face player-count picker so the size dialog is ready
  // to interact with the moment the user opens it.
  renderDiceGrid()
  // Populate the world / planet pickers from the single WORLDS source
  // of truth so adding a new world only requires one edit.
  populateWorldSelect($('#size-planet'), 'slug')
  populateWorldSelect($('#ota-planet'), 'defaultTileset')
  // Start the server heartbeat as soon as the page is wired — works
  // even on the Welcome screen so the user finds out the server died
  // before they pick a map.
  startServerHeartbeat()
  // ?initial_map=<name> skips the Welcome dialog and jumps straight
  // into the named map.  Match is case-insensitive against either the
  // file name or the OTA mission name so URL-friendly slugs like
  // "Metal%20Heck" line up with however the catalogue indexes them.
  maybeAutoOpenFromQuery()
})

// Persisted UI prefs (PREFS_KEY, PREF_FIELDS, createPrefsStore,
// loadPersistedPrefs, syncDomFromPrefs, persistPrefs) moved to
// /ui/common/prefs.js — imported at the top of this file.  Same
// call sites; the implementation now lives in /ui/common.

// ── Multi-tab management ────────────────────────────────────────────
//
// Each open map has one entry in `tabs` ({ map: MapDoc }) and one
// chip in the #map-tabs row.  tabState.activeIndex picks which is currently
// shown; the state Proxy forwards per-map field reads/writes to
// tabs[tabState.activeIndex].map.
//
// On a tab swap we:
//   1) Snapshot module-level lets (undoStack/redoStack/pending
//      transaction/minimapBase/minimapBaseStale + scroll position)
//      into the outgoing tab.
//   2) Abort transient gesture state (panning, painting in progress,
//      drag offsets) — switching tabs always cancels mid-gesture work.
//   3) Move tabState.activeIndex.
//   4) Restore the new tab's module-level lets.
//   5) Recreate the canvas DOM + GL context via recreateEditorView()
//      so the new map renders from a clean surface.
//   6) Render + restore scroll.

function snapshotActiveTabModuleLets() {
  if (tabState.activeIndex < 0) return
  const tab = tabs[tabState.activeIndex]
  // Model tabs have no .map / undo stack — bail out so we don't
  // throw on `m.undoStack = ...` when the outgoing tab is a 3DO.
  if (!tab || !tab.map) return
  const m = tab.map
  m.undoStack = undoStack.slice()
  m.redoStack = redoStack.slice()
  m.pendingTransaction = getPendingTransaction()
  m.minimapBase = minimapBase
  m.minimapBaseStale = minimapBaseStale
  const scroll = document.querySelector('#canvas-scroll')
  if (scroll) {
    m.scrollLeft = scroll.scrollLeft
    m.scrollTop = scroll.scrollTop
  }
}

function restoreActiveTabModuleLets() {
  if (tabState.activeIndex < 0) return
  const tab = tabs[tabState.activeIndex]
  // Same guard as snapshot — model tabs carry no map state.
  if (!tab || !tab.map) return
  const m = tab.map
  undoStack.length = 0
  for (const x of m.undoStack) undoStack.push(x)
  redoStack.length = 0
  for (const x of m.redoStack) redoStack.push(x)
  setPendingTransaction(m.pendingTransaction)
  minimapBase = m.minimapBase
  minimapBaseStale = m.minimapBaseStale
  // Scroll restored AFTER the new canvases are sized — see switchToTab.
}

function abortTransientGestureState() {
  panState = null
  spacePanHotkey = false
  painting = false
  paintedDuringStroke = false
  canvasHoverFeature = null
  placementMoveAnchor = null
  terrainDragging = false
  terrainDragStart = null
  terrainMoveAnchor = null
  featureDragging = false
  featureDragOffset = null
  startPosDragging = false
  startPosDragOffset = null
  pickerDragStart = null
}

// unsavedChangesDialog asks the user how to proceed when closing a tab
// with pending edits.  Resolves to 'save' / 'discard' / 'cancel'.
// Escape resolves 'cancel' (so the close is aborted).  Matches the
// confirmDialog plumbing pattern.
function unsavedChangesDialog({ mapName } = {}) {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#unsaved-dialog')
    const msg = document.querySelector('#unsaved-message')
    const saveBtn = document.querySelector('#unsaved-save')
    const discardBtn = document.querySelector('#unsaved-discard')
    const cancelBtn = document.querySelector('#unsaved-cancel')
    if (!dlg || !saveBtn || !discardBtn || !cancelBtn) {
      resolve(window.confirm(`Close ${mapName} without saving?`) ? 'discard' : 'cancel')
      return
    }
    msg.textContent = `"${mapName || 'This map'}" has changes that haven't been saved. What would you like to do?`
    dlg.classList.remove('hidden')
    const cleanup = (result) => {
      dlg.classList.add('hidden')
      saveBtn.removeEventListener('click', onSave)
      discardBtn.removeEventListener('click', onDiscard)
      cancelBtn.removeEventListener('click', onCancel)
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onSave = () => cleanup('save')
    const onDiscard = () => cleanup('discard')
    const onCancel = () => cleanup('cancel')
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup('cancel') }
    }
    saveBtn.addEventListener('click', onSave)
    discardBtn.addEventListener('click', onDiscard)
    cancelBtn.addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey, true)
    saveBtn.focus()
  })
}

async function closeTab(idx) {
  if (idx < 0 || idx >= tabs.length) return
  const tab = tabs[idx]
  // Model tabs have no dirty/save concept — but their viewer (the
  // per-tab SandboxView for sandbox tabs, or the shared modelViewer-
  // Instance for unit tabs) owns a live renderer + audio pool + COB
  // runtime + engine.  Closing the tab must tear those down or
  // backgrounded sounds + weapons keep ticking after the user
  // dismissed them (the renderer keeps RAFing, audio keeps playing,
  // projectiles keep flying — the engine has no idea its tab is
  // gone).  Per-tab sandboxes own their own SandboxView; dispose() is
  // a hard tear-down.  Unit tabs all share modelViewerInstance, so we
  // only dispose that when the LAST unit tab closes (next user click
  // will lazy-rebuild it).
  if (tab.type === 'model') {
    if (tab.viewer && typeof tab.viewer.dispose === 'function') {
      // Tear the per-tab viewer down hard: pause its runtime,
      // silence audio, dispose every binding's audio pool, then
      // dispose the renderer.  Both ModelViewer and SandboxView
      // implement dispose() identically enough that the same call
      // covers both.  Unit-tab viewers also own a per-tab
      // MvControls — dispose it explicitly so its TA-cursor host
      // doesn't outlive the canvas.
      try {
        const rt = tab.viewer.cob && tab.viewer.cob.runtime
        if (rt && typeof rt.setPaused === 'function') rt.setPaused(true)
        if (tab.viewer.cob && tab.viewer.cob.audio
            && typeof tab.viewer.cob.audio.dispose === 'function') {
          tab.viewer.cob.audio.dispose()
        }
        if (typeof tab.viewer.setSilenced === 'function') tab.viewer.setSilenced(true)
        if (tab.viewer._mvControls && typeof tab.viewer._mvControls.dispose === 'function') {
          tab.viewer._mvControls.dispose()
          tab.viewer._mvControls = null
        }
        tab.viewer.dispose()
      } catch { /* ignore */ }
      // Drop the global aliases when the closed tab WAS the active
      // viewer — switchToTab below will promote a different tab's
      // viewer into the alias slot.  Clearing first avoids a brief
      // window where modelViewerInstance / _mvControls point at a
      // disposed corpse.
      if (sandboxViewInstance === tab.viewer) sandboxViewInstance = null
      if (modelViewerInstance === tab.viewer) {
        modelViewerInstance = null
        _mvControls = null
      }
      tab.viewer = null
    }
    tabs.splice(idx, 1)
    if (tabs.length === 0) {
      tabState.activeIndex = -1
      $('#model-viewer-dialog').classList.add('hidden')
      showWelcomeAfterLastTabClose()
      return
    }
    if (tabState.activeIndex >= tabs.length) tabState.activeIndex = tabs.length - 1
    switchToTab(tabState.activeIndex, { fresh: false, force: true })
    return
  }
  // Prompt before closing a dirty tab.  Move focus to that tab first
  // so the user can see what they're about to lose AND so a 'Save'
  // choice operates on this tab's data (save() reads state).
  if (tab.map.dirty) {
    if (idx !== tabState.activeIndex) switchToTab(idx, { force: true })
    const choice = await unsavedChangesDialog({ mapName: mapDisplayName(tab.map) })
    if (choice === 'cancel') return
    if (choice === 'save') {
      const ok = await save()
      if (!ok) return // save failed — leave tab open so the user can retry
    }
  }
  // If the user is closing the currently-active tab, snapshot in-flight
  // module-let state into a doomed MapDoc anyway so the closing tab's
  // last edit can't taint the next tab's restore.
  if (idx === tabState.activeIndex) snapshotActiveTabModuleLets()
  tabs.splice(idx, 1)
  if (tabs.length === 0) {
    tabState.activeIndex = -1
    showWelcomeAfterLastTabClose()
    return
  }
  // Pick the previous tab if we closed the active one; otherwise stay
  // on the same active map.
  if (idx <= tabState.activeIndex) tabState.activeIndex = Math.max(0, tabState.activeIndex - (idx === tabState.activeIndex ? 0 : 0))
  if (tabState.activeIndex >= tabs.length) tabState.activeIndex = tabs.length - 1
  // Re-activate with restore semantics so the now-front tab repaints.
  switchToTab(tabState.activeIndex, { fresh: false, force: true })
}

function showWelcomeAfterLastTabClose() {
  // Hide the editor surface and bring back the welcome modal.
  $('#app')?.classList.add('hidden')
  const wel = $('#welcome-dialog')
  if (wel) wel.classList.remove('hidden')
  if (editorView) { editorView.destroy(); editorView = null }
  renderMapTabs()
}

function switchToTab(nextIdx, { fresh = false, force = false } = {}) {
  if (nextIdx < 0 || nextIdx >= tabs.length) return
  if (!force && nextIdx === tabState.activeIndex) return
  const outgoing = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  const incoming = tabs[nextIdx]

  // Close every open thread-debugger panel — they point at the
  // outgoing tab's COB binding, which is either about to be
  // replaced (switching between models) or hidden behind the map
  // editor (switching to a map tab).  Reopening from the Threads
  // inspector is one click.
  closeAllMvThreadCodePanels()
  // Snapshot the outgoing MAP tab.  Model tabs hold no module-let
  // state, so the snapshot/restore dance is bypassed for them.
  if (!fresh && outgoing && outgoing.type !== 'model') snapshotActiveTabModuleLets()
  // Pause the outgoing tab's simulation so its weapons / scripts /
  // particles / sounds freeze instead of churning in the background.
  // We REMEMBER the prior paused state on the tab itself so a user
  // who explicitly paused (Pause button) keeps that intent; one who
  // had it running comes back to a running tab.  The shared
  // modelViewerInstance applies for non-sandbox unit tabs; sandbox
  // tabs each own their own SandboxView's scene/runtime.
  if (!fresh && outgoing && outgoing.type === 'model') {
    pauseOutgoingTabRuntime(outgoing)
  }
  abortTransientGestureState()
  tabState.activeIndex = nextIdx

  // Route on tab type.  Model tabs slot the viewer overlay over
  // the editor's content area while leaving the shared topbar +
  // tabs + footer visible; map tabs hide the overlay and bring the
  // map editor back to front.
  if (incoming.type === 'model') {
    renderMapTabs()
    // .app stays VISIBLE so its topbar / tab bar / statusbar keep
    // showing — the model viewer dialog overlays only the middle.
    $('#app')?.classList.remove('hidden')
    $('#welcome-dialog')?.classList.add('hidden')
    $('#model-open-dialog')?.classList.add('hidden')
    $('#model-viewer-dialog').classList.remove('hidden')
    updateTopbarDocInfo(incoming)
    if (incoming.sandbox) {
      void activateSandboxTab(incoming)
    } else {
      // Hide the sandbox panel when switching back to a regular
      // model tab so its overlay doesn't shadow the single-unit
      // inspectors.  Also drop the sandbox-mode class so the
      // left sidebar (Pieces / Textures / Weapons) comes back.
      const sp = document.getElementById('sandbox-panel')
      if (sp) sp.classList.add('hidden')
      $('#model-viewer-dialog')?.classList.remove('sandbox-mode')
      // Silence audio on every backgrounded viewer (unit + sandbox).
      // activateModelTab re-un-silences the incoming tab below.
      for (const t of tabs) {
        const v = t && t.viewer
        if (v && typeof v.setSilenced === 'function') {
          try { v.setSilenced(true) } catch { /* ignore */ }
        }
      }
      // Stop the currently-active sandbox renderer (if any) so the
      // RAF loop releases the canvas slot for the incoming unit tab.
      if (sandboxViewInstance && sandboxViewInstance.renderer) {
        try {
          sandboxViewInstance.renderer.stop?.()
          sandboxViewInstance.renderer.clearCanvas?.()
        } catch { /* ignore */ }
      }
      // activateModelTab handles canvas attach / detach itself
      // (per-tab ModelViewer + canvas, round 34).  No legacy
      // shared-canvas reattach needed.
      void activateModelTab(incoming)
    }
    return
  }

  // Map tab: tear down any visible model overlay before the editor
  // takes the screen.  Stop BOTH the single-unit and the sandbox
  // renderers — neither is visible while the map editor owns the
  // viewport, and leaving their RAF loops running wastes CPU + can
  // bleed canvas state through during fast tab switches before the
  // dialog's display:none takes effect on the next compositor pass.
  $('#model-viewer-dialog')?.classList.add('hidden')
  // Stop BOTH renderers (single-unit + every sandbox tab) so neither
  // burns CPU on a hidden surface, and clear the canvas so the last
  // rendered frame doesn't bleed through when the user later returns
  // to a model tab.  Silence audio on every view too — the map editor
  // doesn't speak weapon sounds and a backgrounded sandbox shouldn't
  // either.
  if (modelViewerInstance && modelViewerInstance.renderer) {
    try {
      modelViewerInstance.renderer.stop?.()
      modelViewerInstance.renderer.clearCanvas?.()
    } catch { /* ignore */ }
  }
  if (modelViewerInstance && modelViewerInstance._mvControls
      && typeof modelViewerInstance._mvControls.setSilenced === 'function') {
    try { modelViewerInstance._mvControls.setSilenced(true) } catch { /* ignore */ }
  }
  for (const t of tabs) {
    const v = t && t.viewer
    if (v && v.renderer && v.renderer.stop) {
      try {
        v.renderer.stop()
        v.renderer.clearCanvas?.()
      } catch { /* ignore */ }
    }
    if (v && typeof v.setSilenced === 'function') {
      try { v.setSilenced(true) } catch { /* ignore */ }
    }
  }

  restoreActiveTabModuleLets()
  renderMapTabs()
  updateTopbarDocInfo(incoming)
  // recreateEditorView() needs an active app surface to mount into.
  $('#app')?.classList.remove('hidden')
  recreateEditorView()
  // Sync drawer / view / mode UI to the new tab's state.
  if (typeof updateUndoButtons === 'function') updateUndoButtons()
  if (typeof bumpContentVersion === 'function') bumpContentVersion()
  // Reflect the new tab's drawer filter in the sidebar input.
  const filterInput = document.querySelector('#filter')
  if (filterInput) filterInput.value = state.drawerFilters?.[state.drawer] || ''
  if (typeof renderDrawer === 'function') renderDrawer()
  if (typeof setMode === 'function') setMode(activeMap()?.mode || 'select-terrain')
  if (typeof renderCanvas === 'function') renderCanvas()
  // Restore scroll AFTER the new canvases are sized; canvas-scroll's
  // scrollLeft/Top is clamped to the live scrollWidth/Height, which
  // wouldn't exist before mount.
  const tab = tabs[tabState.activeIndex]
  if (tab) {
    const scroll = document.querySelector('#canvas-scroll')
    if (scroll) {
      scroll.scrollLeft = tab.map.scrollLeft || 0
      scroll.scrollTop = tab.map.scrollTop || 0
    }
  }
}

// pauseOutgoingTabRuntime freezes the simulation on a model / sandbox
// tab the user is leaving.  Pausing the runtime is the canonical
// way to stop every downstream tick the engine drives — weapon
// state machines, projectile movement, particle pools, AudioPool
// (gated on runtime.paused via the engine's per-binding tick), and
// the cob bytecode interpreter itself.  Without this the renderer's
// RAF is stopped on switch but the engine kept running through the
// next requestAnimationFrame the host inevitably schedules, so the
// user heard weapons + acks fire in a backgrounded tab.
//
// `_pausedBeforeSwitch` is stashed on the tab itself: a user who had
// explicitly clicked Pause should still see "paused" when they
// return, and a tab that was running should resume on the way back.
function pauseOutgoingTabRuntime(tab) {
  if (!tab || tab.type !== 'model') return
  // Sandbox tabs each have their own SandboxView with its own
  // engine + runtime.  Unit tabs (round 34) each have their own
  // ModelViewer + runtime.  Pausing the per-tab runtime is enough —
  // the per-binding tick reads `runtime.paused` and skips weapons,
  // scripts, and movement when set.  No cross-tab trampling.
  const rt = tab.sandbox
    ? (tab.viewer && tab.viewer.scene && tab.viewer.scene.runtime)
    : (tab.viewer && tab.viewer.cob && tab.viewer.cob.runtime)
  if (!rt || typeof rt.setPaused !== 'function') return
  tab._pausedBeforeSwitch = !!rt.paused
  if (!rt.paused) rt.setPaused(true)
  // Also silence the viewer's audio on the way out so paused-but-
  // playing audio elements don't sit half-decoded in the browser.
  // For sandboxes this is engine-wide via setSilenced; for unit
  // tabs the ModelViewer.setSilenced helper does the right thing.
  if (tab.viewer && typeof tab.viewer.setSilenced === 'function') {
    try { tab.viewer.setSilenced(true) } catch { /* ignore */ }
  }
  // Stop the outgoing tab's renderer so its RAF loop releases the
  // canvas and doesn't fight the incoming tab for the GL slot.
  // renderer.stop() is idempotent + cheap.
  if (tab.viewer && tab.viewer.renderer && typeof tab.viewer.renderer.stop === 'function') {
    try { tab.viewer.renderer.stop() } catch { /* ignore */ }
  }
}

// resumeIncomingTabRuntime restores the paused state the user had
// before they switched away.  Called from activateModelTab /
// activateSandboxTab after the renderer is re-started so the very
// next tick lands the right paused/running state.  Safe to call
// when no prior snapshot exists (fresh tab) — leaves runtime as-is.
function resumeIncomingTabRuntime(tab) {
  if (!tab || tab.type !== 'model') return
  const wasPaused = tab._pausedBeforeSwitch
  tab._pausedBeforeSwitch = undefined
  const rt = tab.sandbox
    ? (tab.viewer && tab.viewer.scene && tab.viewer.scene.runtime)
    : (tab.viewer && tab.viewer.cob && tab.viewer.cob.runtime)
  if (!rt || typeof rt.setPaused !== 'function') return
  // If the user had it running before, un-pause now.  Explicitly
  // skipping the call when `wasPaused === undefined` keeps a freshly
  // loaded tab's default paused=false intact.
  if (wasPaused === false && rt.paused) rt.setPaused(false)
  else if (wasPaused === true && !rt.paused) rt.setPaused(true)
}

// mapDisplayName returns the friendly label for a MapDoc — prefers the
// OTA mission name (the human-readable title the player sees in the
// lobby) and falls back to the TNT filename when the mission name is
// empty (#37).
function mapDisplayName(m) {
  const mission = (m?.ota?.missionName || '').trim()
  if (mission) return mission
  return (m?.name || '').trim() || '(untitled)'
}

function renderMapTabs() {
  // Tab strip is React-managed (see /ui/common/tab-bar.js).  Push the
  // current tabs[] + tabState.activeIndex into the React state signal each
  // time the host's tab list mutates (open / close / switch).  No-op
  // when the React UI hasn't loaded yet (the next setTabs after boot
  // catches up).
  if (_reactUi && typeof _reactUi.setTabs === 'function') {
    _reactUi.setTabs(tabs, tabState.activeIndex)
  }
}

// buildTabElement removed — tab rendering now lives entirely in the
// React TabBar component.  Per-tab formatting (model glyph, dirty
// marker, title metadata) is data-driven from the tab record.

function wireMapTabBar() {
  // Tab bar + its "+" popup are React-managed.  configureReactUi
  // resolves asynchronously (dynamic import), so we may run before
  // the React island is loaded — `await` the promise so the bridge +
  // mount fire as soon as the module lands.  configureReactUi caches
  // its promise so this never starts a second import.
  ;(async () => {
    const ui = _reactUi || await configureReactUi()
    if (!ui) return
    if (typeof ui.configureTabBarBridge === 'function') {
      ui.configureTabBarBridge({
        onSwitch:   (i) => switchToTab(i),
        onClose:    (i) => closeTab(i),
        onNewMap:   () => { sizeDialogSource = 'tabbar'; openSizeDialog() },
        onOpenMap:  () => openMapDialog('tabbar'),
        onOpenUnit: () => { modelOpenIntent = 'add'; openModelPicker() },
        onSandbox:  () => openSandboxStub(),
      })
    }
    if (typeof ui.mountTabBar === 'function') ui.mountTabBar()
    // Push the current tab list into the React state so the bar paints
    // its initial render with whatever was already open (e.g. when this
    // runs after a tab has already been added at boot).
    if (typeof ui.setTabs === 'function') ui.setTabs(tabs, tabState.activeIndex)
  })()
}

// maybeAutoOpenFromQuery + pickMapByName moved to
// /ui/pickers/auto-open.js — imported at the top of this file.

// Server heartbeat moved to /ui/common/heartbeat.js — imported at
// the top of this file.  startServerHeartbeat() is called from
// the DOMContentLoaded boot block; the module owns its own state
// (heartbeat timer, failure count, retry counter) and reads its
// pacing from state.settings so the Settings dialog still tunes it.

// ── Open Existing Map flow ────────────────────────────────────────────────
//
// openMapDialog / fetchMaps / closeOpenDialog / confirmOpenMap and
// their module-level catalogue-polling state moved to
// /ui/pickers/open-map.js.  Studio.js still owns sizeDialogSource
// because openSizeDialog (still in this file) reads it.
let sizeDialogSource = 'welcome' // 'welcome' or 'tabbar' — controls where the size dialog routes back to

// wireOpenDialogKeyboard makes the open-map list keyboard-navigable:
// Tab from the filter lands on the list, arrow keys move the
// kbd-focus marker through the visible cards (no DOM focus shuffling
// — that would scroll the dialog while typing), Enter loads the
// current selection.  Falls back gracefully when no cards are
// rendered (skeleton / empty state).

// wireWelcomeKeyboard (arrow + Enter navigation on the welcome
// cards) moved to /ui/screens/welcome/keyboard.js.  Pure DOM, no
// host state — auto-focuses the New card on every re-show.
// ── Welcome dialog FX ─────────────────────────────────────────────────
//
// All three welcome-screen visual / audio subsystems moved to
// /ui/screens/welcome/fx/:
//   - nano-fx.js  — particle nanolathe spray
//   - ambient.js  — one-shot Web Audio construction cue
//   - glamour.js  — cross-fading splash slideshow
// Each observes #welcome-dialog's hidden class via MutationObserver
// so its RAF / timer / audio stops cleanly when the user clicks
// through into the editor.

// wireWelcomeDropZone moved to /ui/screens/welcome/drop-zone.js.
// Routes successful uploads through the openLoadedMap host
// callback registered above.

async function openLoadedMap(data, card) {
  const w = data.tileW || 128
  const h = data.tileH || 128
  // Push a brand-new MapDoc as the active tab.  Snapshot the
  // outgoing tab first so its undo stack / minimap cache survive,
  // then restore from the fresh MapDoc so the previous map's
  // minimap doesn't leak across.  Subsequent state.X writes land
  // in this new MapDoc — the prior tab keeps its own state intact
  // in tabs[], reachable by clicking back.
  if (tabState.activeIndex >= 0) snapshotActiveTabModuleLets()
  tabs.push({ type: 'map', map: new MapDoc() })
  tabState.activeIndex = tabs.length - 1
  restoreActiveTabModuleLets()
  state.tileW = w
  state.tileH = h
  state.name = data.name || (card && card.name) || 'newmap'
  state.planet = (data.planet || data.ota?.planet || '').toLowerCase() || 'green'

  // Rebuild the per-cell tile stamps with the synthetic section key.
  state.tiles = new Array(w * h).fill(null)
  for (let i = 0; i < data.tiles.length && i < w * h; i++) {
    const t = data.tiles[i]
    state.tiles[i] = { sectionPath: data.tilePoolKey, sx: t.sx, sy: t.sy, rotation: 0, flipH: false, flipV: false }
  }
  invalidateMinimapBase()
  // Heights are byte values from the TNT; pad to the editor's default
  // (sky) if the response somehow comes up short.
  state.heights = new Array(w * 2 * h * 2).fill(80)
  for (let i = 0; i < data.heights.length && i < state.heights.length; i++) {
    state.heights[i] = data.heights[i] | 0
  }
  state.voids = new Array(w * 2 * h * 2).fill(0)
  if (Array.isArray(data.voids)) {
    for (let i = 0; i < data.voids.length && i < state.voids.length; i++) {
      state.voids[i] = data.voids[i] ? 1 : 0
    }
  }
  // Clear features SYNCHRONOUSLY before the upcoming async features-
  // catalog fetch.  Otherwise the previous map's features briefly
  // render against the new map's heights array — and since their ax/ay
  // coords mean different cells in the new heights grid, they appear
  // visibly shifted for a few frames until the catalog fetch finishes.
  state.features = []
  // Features come back as bare { name, ax, ay }; flesh them out with
  // the cataloged features metadata so the canvas can draw previews.
  const featuresByName = new Map()
  try {
    const fresp = await fetch('/api/studio/features')
    const fdata = await fresp.json()
    for (const f of (fdata.features || [])) {
      featuresByName.set((f.name || '').toLowerCase(), f)
    }
    state.featuresList = fdata.features || []
  } catch { /* features list will be loaded again later if needed */ }
  state.features = []
  for (const fp of (data.features || [])) {
    const cat = featuresByName.get((fp.name || '').toLowerCase())
    state.features.push({
      name: fp.name,
      ax: fp.ax,
      ay: fp.ay,
      footprintX: cat?.footprintX || 1,
      footprintZ: cat?.footprintZ || 1,
      previewUrl: cat?.previewUrl || null,
      world: cat?.world,
      category: cat?.category,
      description: cat?.description,
      originX: cat?.originX || 0,
      originY: cat?.originY || 0,
    })
  }
  state.ota = data.ota || defaultOTAState(state.name, state.planet, w, h)
  state.activeSchema = 0
  // Bump again now that features are populated — the spatial /
  // name indices need to rebuild after the bulk load.
  bumpContentVersion()

  // Preload the tile pool atlas as a section image so the existing
  // drawSectionTiles path can render the loaded map at full fidelity.
  const img = new Image()
  const ready = new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }) })
  img.src = data.tilePoolUrl
  state.sectionImages.set(data.tilePoolKey, img)
  await ready

  $('#open-dialog').classList.add('hidden')
  $('#welcome-dialog').classList.add('hidden')
  // If the user came from a model tab, the 3DO viewer was the
  // surface in front — hide it so the map editor takes the screen.
  $('#model-viewer-dialog')?.classList.add('hidden')
  $('#app').classList.remove('hidden')
  renderMapTabs()
  // Refresh the shared topbar + footer hints from this new map tab,
  // otherwise they keep the previous (model) tab's strings.
  updateTopbarDocInfo(tabs[tabState.activeIndex])

  // Wire up the canvas + drawer just like startEditor would have done
  // for a fresh map.
  await finishEditorBoot()
  // Belt-and-braces: snap state.zoom back to 1.0 in case any wheel
  // event leaked between map loads (e.g. while the user was clicking
  // through the Open dialog), then force one more GL render with the
  // clean state so the new map's atlas texture is guaranteed to be
  // uploaded before the user looks at it.
  if (Math.abs((state.zoom || 1) - 1) < 0.05) state.zoom = 1
  // Drop any GPU textures the previous map left behind so the new
  // map starts with a clean texture cache.  resetGL handles both
  // the texture map and the context teardown that ensureGLRenderer
  // will rebuild on the next renderCanvas tick.
  resetGL()
  renderCanvas()
  setStatus(`Opened ${state.name} (${w}×${h}).`)
}

function confirmOnEnter(e) {
  if (e.key === 'Enter') startEditor()
}

async function startEditor() {
  const w = clamp(parseInt($('#size-w').value, 10) || 128, 16, 256)
  const h = clamp(parseInt($('#size-h').value, 10) || 128, 16, 256)
  const name = ($('#size-name').value || 'newmap').trim() || 'newmap'
  const planet = $('#size-planet').value
  // Pull the multi-selected player counts off the dice picker.  Falls
  // back to a single 4-player schema if the user somehow deselected
  // everything (the picker's clamp prevents this from the UI side).
  const counts = pickedPlayerCounts()
  // Push a brand-new MapDoc as the active tab; existing tabs stay in
  // tabs[] and can be reached by clicking them.  Snapshot the
  // outgoing tab first so its undo stack / minimap cache survive the
  // round trip, then restore from the fresh MapDoc so module-level
  // state (minimapBase especially) resets to the new tab's defaults
  // — otherwise the previous map's minimap leaks into the new one
  // until the next commit.
  if (tabState.activeIndex >= 0) snapshotActiveTabModuleLets()
  tabs.push({ type: 'map', map: new MapDoc() })
  tabState.activeIndex = tabs.length - 1
  restoreActiveTabModuleLets()
  state.tileW = w
  state.tileH = h
  state.name = name
  state.planet = planet
  state.tiles = new Array(w * h).fill(null)
  state.heights = new Array(w * 2 * h * 2).fill(80)
  state.voids = new Array(w * 2 * h * 2).fill(0)
  state.features = []
  bumpContentVersion()
  state.ota = defaultOTAState(name, planet, w, h)
  // Replace the placeholder schema list with one Network-N schema
  // per selected player count.
  state.ota.schemas = counts.map((n) => ({
    name: `Network ${n}`,
    type: `Network ${n}`,
    aiProfile: 'DEFAULT',
    surfaceMetal: 3,
    mohoMetal: 30,
    humanMetal: 1000,
    computerMetal: 1000,
    humanEnergy: 1000,
    computerEnergy: 1000,
    meteorWeapon: '',
    meteorRadius: 0,
    meteorDensity: 0,
    meteorDuration: 0,
    meteorInterval: 0,
    // No default start positions — the user places them via Start
    // Points mode, gap-filling 1..N as they click.
    startPositions: [],
  }))
  state.activeSchema = 0

  $('#size-dialog').classList.add('hidden')
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog')?.classList.add('hidden')
  $('#app').classList.remove('hidden')
  renderMapTabs()
  updateTopbarDocInfo(tabs[tabState.activeIndex])

  await finishEditorBoot()
}

// Dice-face player-count picker for the New-map size dialog moved
// to /ui/map-editor/dialogs/dice-picker.js — imported at the top
// of this file.  Owns its own dicePicked Set state.

// finishEditorBoot wires the toolbar / canvas / drawer and loads the
// section + feature catalogs.  Called from both the New-map and
// Open-map paths once state has been seeded; subsequent calls are
// idempotent so File → New / File → Open mid-session re-renders
// without doubling up event listeners.
let editorWired = false
async function finishEditorBoot() {
  if (!editorWired) {
    wireToolbar()
    wireZoomButtons()
    wireTabs()
    wireMinimap()
    wireDeveloperPanel()
    // wireDeveloperDialog now runs at DOMContentLoaded so the
    // Settings / Help / Developer buttons work even when the user
    // opens the studio straight into a model tab.
    wireModeToolbar()
    wireViewMenu()
    wireKeyboard()
    editorWired = true
  }
  // Tear down the previous editing window's canvas DOM + GL state and
  // mount a fresh pair of canvases.  Done every call so File → New,
  // Open, and Resize all start from a guaranteed-clean editing surface
  // — no stale listeners, no carried-over GL textures, no orphaned
  // ResizeObservers.
  recreateEditorView()
  // Reflect the active map's drawer filter in the sidebar input.  Per-tab
  // filters live on MapDoc, so the previous tab's "tree-A" must not leak
  // into the new map's empty filter (#36).  The React MapSidebar reads
  // the live filter off sidebarFilter; publishMapSidebarState pushes
  // the new tab's value into the signal so the input flips on the next
  // commit.  Direct DOM writes also retained for backwards compat with
  // any external instrumentation that scrapes the input's `.value`.
  publishMapSidebarState()
  const filterInput = document.querySelector('#filter')
  if (filterInput) filterInput.value = state.drawerFilters?.[state.drawer] || ''
  // Don't poke canvas.width here on a mid-session swap.  renderCanvas
  // owns the canvas/glCanvas/.canvas-stack dimensions and skips work
  // when they already match — pre-setting only the 2D canvas hides the
  // dim change from it, leaving glCanvas stuck at the previous map's
  // size.  That stale GL buffer is what made the tile layer render
  // garbage after a map switch.

  // Hide the canvas-stack while the boot async chain is in flight.
  // Layout still happens (so clientWidth/Height stay meaningful), but
  // the user doesn't see the top-left of the canvas while sections /
  // features stream in.
  const stack = $('#canvas-stack')
  if (stack) stack.classList.add('booting')
  await Promise.all([loadSections(), loadFeatures()])
  // Size the canvases + overscroll padding before the first paint, so
  // centerViewOnMap can position scroll BEFORE the user ever sees the
  // top-left of the freshly loaded canvas.
  prepareCanvasDimensions()
  // Force a layout read so wrap.clientHeight reflects the post-show
  // dimensions of #app — without this, the very first new-map load
  // can grab a stale (or zero) clientHeight and the resulting
  // scrollTop puts the map's centre in the top portion of the
  // viewport instead of the true visual centre.
  const wrap = $('#canvas-scroll')
  if (wrap) void wrap.getBoundingClientRect()
  centerViewOnMap()
  // Restore saved floating-panel positions/collapsed-state BEFORE
  // un-booting so the user sees the panels in their final spots on
  // the very first painted frame.
  applyPanelLayout()
  renderCanvas()
  // Reveal after the first paint has the centred scroll position
  // committed.
  if (stack) stack.classList.remove('booting')
  // A second pass on the next frame catches any reflow-timing edge
  // case where the post-centerViewOnMap render ran before the browser
  // had finished resizing the canvas-stack — also re-runs the
  // centring math against the now-settled clientHeight.
  requestAnimationFrame(() => {
    centerViewOnMap()
    renderCanvas()
  })
}

// prepareCanvasDimensions resizes the 2D and GL canvases (backing
// buffers + CSS sizes) and runs applyOverscrollPadding to set the
// surrounding canvas-stack dimensions.  Extracted from renderCanvas so
// finishEditorBoot can size everything before the first paint runs,
// which lets centerViewOnMap position scrollLeft / scrollTop against
// the FINAL dimensions instead of the previous map's leftovers.
function prepareCanvasDimensions() {
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  if (!canvas) return
  const wantW = state.tileW * TILE_PX
  const wantH = state.tileH * TILE_PX
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW
    canvas.height = wantH
    if (glCanvas) {
      glCanvas.width = wantW
      glCanvas.height = wantH
    }
  }
  const wantStyleW = wantW * state.zoom + 'px'
  const wantStyleH = wantH * state.zoom + 'px'
  if (canvas.style.width !== wantStyleW) canvas.style.width = wantStyleW
  if (canvas.style.height !== wantStyleH) canvas.style.height = wantStyleH
  if (glCanvas) {
    if (glCanvas.style.width !== wantStyleW) glCanvas.style.width = wantStyleW
    if (glCanvas.style.height !== wantStyleH) glCanvas.style.height = wantStyleH
  }
  applyOverscrollPadding()
}

// centerViewOnMap places the centre of the map at the centre of the
// scroll viewport.  Called on every map load (initial and switch) so
// the user always lands looking at the middle of the map, not the
// top-left corner.  Works in stack-pixel space — the canvas sits at
// overscrollPadding.{x,y} inside .canvas-stack, so the world centre's
// stack-pixel position is overscrollPadding + (mapPixels * zoom / 2).
function centerViewOnMap() {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  if (!wrap || !canvas) return
  const z = state.zoom || 1
  const midX = overscrollPadding.x + (canvas.width * z) / 2
  const midY = overscrollPadding.y + (canvas.height * z) / 2
  wrap.scrollLeft = midX - wrap.clientWidth / 2
  wrap.scrollTop = midY - wrap.clientHeight / 2
}

// ── Sidebar drawer ─────────────────────────────────────────────────────────

function wireTabs() {
  // Sidebar tabs + filter row are React-managed now (see
  // /ui/map-editor/tabs/sidebar.js).  Click / input handlers route
  // through configureSidebarBridge, which the React tree installs.
  // Nothing left to wire here, but the publishMapSidebarState call
  // ensures the React signals reflect the live state every time we
  // re-enter the editor (File → New / Open / etc.).
  publishMapSidebarState()
}

// ── Mode toolbar + View menu wiring ────────────────────────────────────────

function wireModeToolbar() {
  // The Mode dropdown is React-managed (see
  // /ui/map-editor/ribbon/map-ribbon.js).  Mode picks fire through
  // the map-ribbon bridge's setMode action; the React tree reads the
  // active mode off ribbonState.mode each publish.  Nothing to wire
  // here, but publishing the initial mode keeps the dropdown badge in
  // lockstep on first paint.
  publishMapRibbonState()
}

function refreshModeDropdown() {
  const ico = $('#mode-current-ico')
  const lbl = $('#mode-current-lbl')
  const row = $$('#mode-dropdown-popup .menu-row').find((r) => r.dataset.mode === state.mode)
  if (ico && row) ico.textContent = row.querySelector('.ico').textContent
  if (lbl && row) lbl.textContent = row.querySelector('span:not(.ico)').textContent
  $$('#mode-dropdown-popup .menu-row').forEach((r) => {
    r.classList.toggle('active', r.dataset.mode === state.mode)
  })
}

function closeAllRibbonDropdowns(except) {
  $$('.ribbon-dropdown-popup').forEach((el) => {
    if (el !== except) el.classList.add('hidden')
  })
}

// positionRibbonPopup anchors a fixed-position popup directly below its
// triggering button, in viewport coordinates so it escapes the
// ribbon's overflow clipping.  Run on every open so subsequent toolbar
// resizes don't strand the popup.
function positionRibbonPopup(button, popup) {
  if (!button || !popup) return
  const rect = button.getBoundingClientRect()
  popup.style.top = (rect.bottom + 4) + 'px'
  popup.style.left = rect.left + 'px'
}

// Switch the drawer to match the active editing mode — Place Tiles
// implies the user wants sections, Place Features implies features.
function syncDrawerToMode(mode) {
  if (mode === 'paint' && state.drawer !== 'sections') {
    switchTab('sections')
  } else if (mode === 'select-features' && state.drawer !== 'features') {
    switchTab('features')
  }
}

function setMode(mode) {
  state.mode = mode
  // Tear down any in-flight tool state that doesn't belong to the new mode.
  if (mode !== 'paint') cancelPlacement()
  if (mode !== 'select-terrain') {
    if (state.terrainClipboard) dropTerrainClipboard()
    state.rectSelection = null
  }
  if (mode !== 'select-features') state.selectedFeature = -1
  if (mode !== 'picker') {
    state.selectedFeatures.clear()
    state.pickerRect = null
  }
  if (mode !== 'start-points') {
    state.selectedStartPos = -1
  }
  if (mode !== 'ruler' && state.ruler) {
    // Leaving ruler mode clears the measurement so it isn't drawn on
    // top of an unrelated tool overlay.
    state.ruler = null
  }
  if (mode !== 'voids') {
    voidsDragState = null
  } else {
    // Force Map view in Voids mode so the red overlay paints on top of
    // the terrain instead of getting hidden behind the Heightmap view.
    if (state.viewMode !== 'map') {
      state.viewMode = 'map'
      $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r.dataset.display === 'map'))
      const lbl = $('#view-current-lbl')
      if (lbl) lbl.textContent = 'Map'
    }
    // Also enable the View → Voids toggle so it sticks after the user
    // leaves Voids mode — the overlay-on state matches what they were
    // just looking at, instead of vanishing the moment they switch tool.
    if (!state.showVoids) setVoidsVisible(true)
  }
  // Modes that hunt for placed objects need their layer visible — auto
  // -enable the View toggle so the mode doesn't become a no-op.
  if ((mode === 'select-features' || mode === 'picker') && !state.showFeatures) {
    setFeaturesVisible(true)
  }
  if (mode === 'start-points' && !state.showStartPositions) {
    setStartPositionsVisible(true)
  }
  if (mode === 'heightmap') {
    // If the user is on the plain Map view, switch to Blended so they
    // can see the heightmap variance overlaid on the terrain while
    // they edit.  Other view modes (Heightmap / Blended) are left
    // alone — the user's explicit choice wins.
    if (state.viewMode === 'map') {
      state.viewMode = 'blended'
      $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r.dataset.display === 'blended'))
      const lbl = $('#view-current-lbl')
      if (lbl) lbl.textContent = 'Blended'
    }
  }
  // Sync the dropdown label/active row.  The old inline `.tool-btn`s
  // were replaced by the dropdown rows.
  refreshModeDropdown()
  const cnv = $('#canvas')
  if (cnv) {
    if (mode === 'view') cnv.style.cursor = 'grab'
    else if (mode === 'paint') cnv.style.cursor = 'crosshair'
    else if (mode === 'erase') cnv.style.cursor = 'cell'
    else if (mode === 'picker') cnv.style.cursor = 'crosshair'
    else if (mode === 'start-points') cnv.style.cursor = 'crosshair'
    else if (mode === 'voids') cnv.style.cursor = 'crosshair'
    else cnv.style.cursor = 'default'
  }
  syncDrawerToMode(mode)
  renderCanvas()
  setStatus(modeHint(mode))
  // Mirror the new mode into the React ribbon so the dropdown row's
  // `.active` highlight + the toolbar button's label/icon flip in
  // lockstep with the legacy state.
  publishMapRibbonState()
}

function modeHint(mode) {
  switch (mode) {
    case 'view': return 'View mode — click and drag to pan, scroll-wheel to zoom.  No edits are made.'
    case 'paint': return 'Place Tiles — pick a section on the left and click on the canvas to stamp.'
    case 'select-terrain': return 'Select Area — click and drag to grab a rectangle of tiles, then drag to move or Q/E to rotate.  Click outside to drop.'
    case 'select-features': return 'Place Features — pick a feature on the left to drop copies, or click a placed feature to pick/move it.'
    case 'picker': return 'Feature Select — click features to select, drag a rectangle for multi-select, Shift+click to toggle, Delete to remove.'
    case 'erase': return 'Erase — click or drag to remove tiles and features.  Switch to another mode when done.'
    case 'start-points': return 'Start Points — click empty space to drop the next available start position; click an existing one to drag/delete.'
    case 'voids': return 'Voids — click or drag to mark attribute cells impassable / no-build.  The first cell sets the brush state for the rest of the drag.'
  }
  return ''
}

function wireViewMenu() {
  // The View dropdown + every toggle row + the display-mode picker
  // are React-managed now (see /ui/map-editor/ribbon/map-ribbon.js).
  // The host bridge installed in configureReactUi routes the clicks
  // through to setMinimapVisible / setVoidsVisible / setFeaturesVisible
  // / etc.  Only the feature-info-panel's draggable wiring stays
  // here — it's the one floating panel we didn't migrate this round.
  makePanelDraggable($('#feature-info-panel'), $('#feature-info-header'))
  // Push the initial View toggles into the React store so the menu's
  // check-glyphs reflect persisted state on first paint.
  publishMapRibbonState()
}

function wireKeyboard() {
  // Capture phase so we catch Q/E during an HTML5 drag (the dragged
  // node sits inside the drawer item and could otherwise stop the
  // event from reaching the document listener in some browsers).
  document.addEventListener('keydown', (e) => {
    // Escape must close an open dialog *before* the text-input guard
    // below kicks in — dialogs auto-focus their first input on open, so
    // letting the guard run first would swallow Escape and leave the
    // dialog stranded until the user clicked out of the input.
    if (e.key === 'Escape') {
      const ota = $('#ota-dialog')
      if (ota && !ota.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeOTADialog(); return }
      const resize = $('#resize-dialog')
      if (resize && !resize.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeResizeDialog(); return }
      const dev = $('#developer-dialog')
      if (dev && !dev.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeDeveloperDialog(); return }
      const help = $('#help-dialog')
      if (help && !help.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeHelpDialog(); return }
      const settings = $('#settings-dialog')
      if (settings && !settings.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeSettingsDialog(); return }
      const openMap = $('#open-dialog')
      if (openMap && !openMap.classList.contains('hidden')) {
        // closeOpenDialog handles "back to welcome vs. stay on editor"
        // routing via openMapSource, matching the Cancel button.
        e.preventDefault(); e.stopPropagation(); closeOpenDialog(); return
      }
    }
    // Don't intercept other shortcuts while the user is typing into a
    // text input — but checkbox / radio / file <input>s and <select>
    // dropdowns shouldn't swallow our shortcuts (the schema-select used
    // to steal focus and block Q/E rotation).
    const t = e.target
    if (t instanceof HTMLTextAreaElement) return
    if (t instanceof HTMLInputElement) {
      const typ = (t.type || '').toLowerCase()
      if (typ === '' || /^(text|search|number|password|email|url|tel)$/.test(typ)) return
    }
    // `?` (shift+/) opens the help cheat-sheet from anywhere outside
    // a text input.  Symbol comparison handles both US and non-US
    // layouts where Shift+/ produces different keys.
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      openHelpDialog()
      return
    }
    if (e.key === ' ' && !spacePanHotkey) {
      spacePanHotkey = true
      document.body.style.cursor = 'grab'
      e.preventDefault()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      redo()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      selectAllContent()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      // Copy the current Select-Terrain rectangle (or already-lifted
      // terrainClipboard) to the system clipboard.  The OS clipboard
      // is what makes this work across Chrome windows.
      e.preventDefault()
      copyToClipboard()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      // Cut = copy + clear region.  Same selection rule as Copy
      // (rectSelection or already-lifted terrainClipboard).
      e.preventDefault()
      cutSelection()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      // Paste a KBot Studio rectangle from the system clipboard,
      // staged as a follow-the-cursor terrainClipboard.
      e.preventDefault()
      pasteFromClipboard()
    }
    else if (e.key === 'v' || e.key === 'V') setVoidsVisible(!state.showVoids)
    else if (e.key === 'p' || e.key === 'P') setMode('paint')
    else if (e.key === 't' || e.key === 'T') setMode('select-terrain')
    else if (e.key === 'f' || e.key === 'F') {
      // While a section is being placed (or pre-selected from the
      // drawer), F flips horizontally rather than jumping to Features
      // mode — matches Q/E's "act on what's in play" semantics.  No
      // active placement → original mode-switch.
      if (state.placement || state.selected?.type === 'section') flipActive('h')
      else setMode('select-features')
    }
    else if (e.key === 'g' || e.key === 'G') {
      if (state.placement || state.selected?.type === 'section') flipActive('v')
    }
    else if (e.key === 'k' || e.key === 'K') setMode('picker')
    else if (e.key === 's' || e.key === 'S') {
      // Cmd/Ctrl+S would conflict with save shortcuts; without
      // modifiers, plain S switches to Start Points.
      if (!e.ctrlKey && !e.metaKey) setMode('start-points')
    }
    else if (e.key === 'x' || e.key === 'X') setMode('erase')
    else if (e.key === 'd' || e.key === 'D') setMode('voids')
    else if (e.key === 'h' || e.key === 'H') setMode('heightmap')
    else if (e.key === 'b' || e.key === 'B') setMode('fill')
    else if (e.key === 'r' || e.key === 'R') setMode('ruler')
    else if (e.key === 'q' || e.key === 'Q') rotateActive(-1)
    else if (e.key === 'e' || e.key === 'E') rotateActive(1)
    // Shift + Up/Down: zoom in / out at the keyboard.  Handled
    // *before* the bare-arrow pan branch so the modifier wins.
    else if (e.shiftKey && e.key === 'ArrowUp') {
      e.preventDefault()
      setZoom(state.zoom * (state.settings?.zoomStep || 1.25))
    }
    else if (e.shiftKey && e.key === 'ArrowDown') {
      e.preventDefault()
      setZoom(state.zoom / (state.settings?.zoomStep || 1.25))
    }
    // Arrow keys: page through drawer sections when a section is
    // the active selection, otherwise start a continuous pan that
    // ramps from 1× to MAP_PAN_ACCEL_MAX_MULT over
    // MAP_PAN_ACCEL_TIME_MS while held.  The repeat-flag check
    // ignores the OS auto-repeat — the rAF loop drives motion.
    else if (e.key === 'ArrowLeft' && pageSectionSibling(-1)) { e.preventDefault() }
    else if (e.key === 'ArrowRight' && pageSectionSibling(1)) { e.preventDefault() }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); if (!e.repeat) startMapPan('ArrowLeft',  -1,  0) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (!e.repeat) startMapPan('ArrowRight',  1,  0) }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); if (!e.repeat) startMapPan('ArrowUp',     0, -1) }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); if (!e.repeat) startMapPan('ArrowDown',   0,  1) }
    // Page Up / Page Down zoom in / out.  Same step as the toolbar
    // buttons so the keyboard + mouse paths stay in sync.
    else if (e.key === 'PageUp') {
      e.preventDefault()
      setZoom(state.zoom * (state.settings?.zoomStep || 1.25))
    }
    else if (e.key === 'PageDown') {
      e.preventDefault()
      setZoom(state.zoom / (state.settings?.zoomStep || 1.25))
    }
    // Home: fit the entire map to the viewport.
    else if (e.key === 'Home') { e.preventDefault(); fitZoom() }
    else if (e.key === 'Escape') {
      // If the schema-edit dialog is open, Esc cancels it.  Done
      // before the menu / mode-reset paths so editing a schema and
      // pressing Esc behaves like the dialog's Cancel button.
      if (!$('#schema-edit-dialog')?.classList.contains('hidden')) {
        closeSchemaEditor()
        e.preventDefault()
        return
      }
      // If a ribbon dropdown or hover submenu is open, the first
      // Escape press just closes it.  Saves the user from having to
      // mouse away to dismiss, and avoids triggering the mode-reset
      // path below by accident while they were exploring a menu.
      const openPopup = document.querySelector('.ribbon-dropdown-popup:not(.hidden)')
      if (openPopup) {
        document.querySelectorAll('.ribbon-dropdown-popup:not(.hidden)').forEach((el) => el.classList.add('hidden'))
        e.preventDefault()
        return
      }
      // Clear whatever transient state is active first, then drop the
      // user back into Select mode — that's the "neutral" mode that
      // lets them re-orient before picking a new tool.
      if (state.placement) cancelPlacement()
      if (state.terrainClipboard) cancelTerrainClipboard()
      if (state.ruler) { state.ruler = null; renderCanvas() }
      if (state.selectedFeatures.size > 0) state.selectedFeatures.clear()
      if (state.selectedFeature >= 0) state.selectedFeature = -1
      if (state.selected?.type === 'feature') clearStampSelection()
      // Leaving Heightmap mode → drop back to the plain Map view so
      // the editor isn't left in greyscale / blended once the user
      // has finished sculpting.
      const leavingHeightmap = state.mode === 'heightmap'
      if (state.mode !== 'select-terrain') setMode('select-terrain')
      else renderCanvas()
      if (leavingHeightmap && state.viewMode !== 'map') {
        state.viewMode = 'map'
        $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r.dataset.display === 'map'))
        const lbl = $('#view-current-lbl')
        if (lbl) lbl.textContent = 'Map'
        renderCanvas()
      }
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      handleDeleteKey()
    }
  }, { capture: true })
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spacePanHotkey = false
      if (!panState) document.body.style.cursor = ''
    }
    // Stop the held-key pan when the user lets go.  Each direction
    // tracks its own held state, so releasing one of two pressed
    // arrows keeps the other one going.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      stopMapPan(e.key)
    }
  })
  // Window-blur safety net — if the user alt-tabs while holding an
  // arrow, we never see the keyup and would scroll forever.
  window.addEventListener('blur', stopAllMapPan)
}

// handleDeleteKey resolves the Delete keystroke against whatever the
// user has currently picked.  Picker multi-selection wins first, then
// the single Place-Features pick, then a captured terrain rectangle
// (which gets *thrown away* rather than dropped back onto the map).
function handleDeleteKey() {
  if (state.selectedFeatures.size > 0) {
    // Remove every selected feature in one transaction.  Sort indices
    // descending so earlier splices don't shift the later ones.
    const idxs = Array.from(state.selectedFeatures).sort((a, b) => b - a)
    beginTransaction()
    for (const i of idxs) state.features.splice(i, 1)
    state.selectedFeatures.clear()
    commitTransaction(`Delete ${idxs.length} feature${idxs.length === 1 ? '' : 's'}`)
    renderCanvas()
    return
  }
  if (state.selectedFeature >= 0) {
    beginTransaction()
    state.features.splice(state.selectedFeature, 1)
    state.selectedFeature = -1
    commitTransaction('Delete feature')
    renderCanvas()
    return
  }
  if (state.terrainClipboard) {
    // Discard the floating terrain (and any features it had picked up)
    // without putting it back on the map — a destructive "delete this
    // chunk of the map" gesture.
    beginTransaction()
    state.terrainClipboard = null
    commitTransaction('Delete terrain selection')
    hidePlacementHint()
    renderCanvas()
    setStatus('Terrain selection deleted.')
    return
  }
  // Start position selected — remove it from the active schema.
  if (state.mode === 'start-points' && state.selectedStartPos >= 0) {
    const schema = activeSchema()
    if (schema) {
      beginTransaction()
      schema.startPositions.splice(state.selectedStartPos, 1)
      // Renumber what's left so player numbers stay 1..N dense — no
      // gaps, which keeps the click-to-add logic (next = N+1) simple
      // and matches what TA / the OTA save path expect.
      for (let i = 0; i < schema.startPositions.length; i++) {
        schema.startPositions[i].number = i + 1
      }
      state.selectedStartPos = -1
      commitTransaction('Delete start position')
      renderCanvas()
    }
  }
}

// rotateActive rotates whichever interactive subject is in play.  Q/E
// dispatches to the placement preview, the floating terrain clipboard,
// or the currently-selected drawer section (so the user can pre-rotate
// before placement starts).
function rotateActive(dir) {
  // dir: +1 = clockwise, -1 = counter-clockwise.
  if (state.placement) {
    state.placement.rotation = (state.placement.rotation + dir + 4) % 4
    // Manual Q/E rotation pins the orientation — auto-fit must not
    // fight the user's intent once they've taken control.
    state.placement.userRotated = true
    // Wake a dormant placement so the user sees the rotation in the
    // preview immediately.  selectSection seeds dormant=true so the
    // ghost waits for the cursor to enter the canvas before painting;
    // an explicit rotate key is enough engagement to count as
    // "engaged" — pressing Q with no visible preview was confusing.
    if (state.placement.dormant) state.placement.dormant = false
    setStatus(`Rotation ${state.placement.rotation * 90}°.  Click on the canvas to stamp.`)
    renderCanvas()
    return
  }
  if (state.terrainClipboard) {
    rotateTerrainClipboard(dir)
    setStatus(`Terrain rotation ${(state.terrainClipboard.rotation || 0) * 90}°.`)
    renderCanvas()
    return
  }
  if (state.selected?.type === 'section') {
    state.selected.rotation = ((state.selected.rotation || 0) + dir + 4) % 4
    setStatus(`Rotation ${(state.selected.rotation || 0) * 90}°.  Click on the canvas to stamp.`)
  }
}

// flipActive toggles a flip axis on the section currently in flight.
// Mirrors rotateActive's dispatch but only handles sections — the
// terrain clipboard's flip support would need the height grid mirrored
// too, which is a separate piece of work.  Flipping pins the
// orientation against the auto-fit so it doesn't fight the user.
function flipActive(axis) {
  if (state.placement) {
    if (axis === 'h') state.placement.flipH = !state.placement.flipH
    else state.placement.flipV = !state.placement.flipV
    state.placement.userRotated = true
    // Same dormant-wake as rotateActive — pressing F/G during the
    // cursor-follow phase counts as engagement, so the preview
    // shouldn't keep waiting for the cursor to enter the canvas.
    if (state.placement.dormant) state.placement.dormant = false
    const fh = state.placement.flipH ? 'on' : 'off'
    const fv = state.placement.flipV ? 'on' : 'off'
    setStatus(`Flip H ${fh}, V ${fv}.  Click on the canvas to stamp.`)
    renderCanvas()
    return
  }
  if (state.selected?.type === 'section') {
    if (axis === 'h') state.selected.flipH = !state.selected.flipH
    else state.selected.flipV = !state.selected.flipV
  }
}

function switchTab(tab) {
  state.drawer = tab
  // React MapSidebar reads drawer / filter / checkbox visibility off
  // signals — publishMapSidebarState pushes the new tab + restored
  // per-tab filter into the React tree.  Sections-vs-Features-only
  // checkbox visibility is computed inside publishMapSidebarState
  // (showUsed / showWreckage flip off on Sections).
  publishMapSidebarState()
  // Placeholder text — the React input doesn't currently bind it, so
  // poke the DOM input directly when present.  Falls through cleanly
  // when the input hasn't mounted yet (early boot).
  const filterInput = document.getElementById('filter')
  if (filterInput) {
    filterInput.placeholder = tab === 'features'
      ? 'Filter features by name, world, category'
      : 'Filter sections by name, world, group'
  }
  renderDrawer()
}

// isWreckageFeature now lives in ./ui/map-editor/helpers.js.

// featureUsage returns a Map<lowercase name → count> derived from the
// current state.features array, so the drawer can show usage badges and
// filter to "used only" without re-walking the placements per row.
function featureUsage() {
  const usage = new Map()
  for (const f of state.features) {
    const key = (f.name || '').toLowerCase()
    usage.set(key, (usage.get(key) || 0) + 1)
  }
  return usage
}

async function loadSections() {
  const resp = await fetch('/api/studio/sections')
  const data = await resp.json()
  state.sectionsList = data.sections || []
  if (state.drawer === 'sections') renderDrawer()
}

async function loadFeatures() {
  const resp = await fetch('/api/studio/features')
  const data = await resp.json()
  state.featuresList = data.features || []
  if (state.drawer === 'features') renderDrawer()
  // GAF hotspot offsets come from a separate endpoint so the cheap
  // features list isn't blocked by parsing every GAF on the server.
  // We DO await it here on the very first map load so the first
  // render uses correct sub-tile hotspots instead of the bottom-
  // centred fallback (which "snaps" placed features to whole tiles
  // for the few seconds before origins arrive).  Subsequent map
  // switches reuse the cached origins map and complete instantly.
  await fetchFeatureOrigins()
}

let featureOriginsCache = null

async function fetchFeatureOrigins() {
  try {
    if (!featureOriginsCache) {
      const resp = await fetch('/api/studio/feature-origins')
      if (!resp.ok) return
      const data = await resp.json()
      featureOriginsCache = new Map()
      for (const o of (data.origins || [])) {
        featureOriginsCache.set((o.name || '').toLowerCase(), o)
      }
    }
    applyFeatureOrigins(featureOriginsCache)
    renderCanvas()
  } catch { /* ignore — drawing falls back to bottom-centre */ }
}

function applyFeatureOrigins(map) {
  // Patch the drawer catalog so newly-rendered items pick up the
  // right anchor.
  for (const f of state.featuresList) {
    const o = map.get((f.name || '').toLowerCase())
    if (o) { f.originX = o.originX; f.originY = o.originY }
  }
  // Same patch on placed features so the canvas re-anchors them.
  for (const f of state.features || []) {
    const o = map.get((f.name || '').toLowerCase())
    if (o) { f.originX = o.originX; f.originY = o.originY }
  }
}

// DRAWER_ITEM_HEIGHT + DRAWER_OBSERVER_MARGIN live in
// ./ui/map-editor/constants.js (per-row CSS height + IntersectionObserver
// pre-fetch margin for virtualised drawer rendering).

let drawerObserver = null
function ensureDrawerObserver() {
  if (drawerObserver) return drawerObserver
  drawerObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const populate = e.target._populate
      if (populate) {
        delete e.target._populate
        drawerObserver.unobserve(e.target)
        populate(e.target)
      }
    }
  }, { root: $('#drawer'), rootMargin: DRAWER_OBSERVER_MARGIN, threshold: 0 })
  return drawerObserver
}

// virtualisedDrawerBody creates a drawer-group-body element that
// reserves space for `itemCount` rows but defers item creation until
// the body scrolls into view.  Reservations make the drawer scrollbar
// match the real total height even though the DOM only holds visible
// items.  When a group is collapsed (display:none) the observer simply
// doesn't fire until the user expands it — exactly what we want.
function virtualisedDrawerBody(itemCount, populate) {
  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  if (itemCount > 0) body.style.minHeight = (itemCount * DRAWER_ITEM_HEIGHT) + 'px'
  body._populate = (el) => {
    el.style.minHeight = ''
    populate(el)
  }
  ensureDrawerObserver().observe(body)
  return body
}

function renderDrawer() {
  const drawer = $('#drawer')
  // Tear down any pending observers from the previous render — those
  // bodies are about to be discarded and would otherwise keep refs.
  if (drawerObserver) { drawerObserver.disconnect(); drawerObserver = null }
  const q = (state.drawerFilters[state.drawer] || '').trim().toLowerCase()
  if (state.drawer === 'sections') renderSectionsDrawer(drawer, q)
  else renderFeaturesDrawer(drawer, q)
}

// ensureAutoExpandForFilter forces the first matching world + its
// first matching group to render expanded when the user is typing a
// filter but no group is currently open.  Lets a query like "trees"
// surface the first match without an extra click.  Keys go into the
// existing _sectionExpanded set, so toggling later collapses them as
// the user expects.  No-op when the filter is empty or any group is
// already open.
function ensureAutoExpandForFilter(q, worldOrder, tree, keyPrefix, isActive) {
  if (!q || worldOrder.length === 0) return
  const expanded = state._sectionExpanded ??= new Set()
  const collapsed = state.collapsedGroups
  const isOpen = (key, activeByDefault) => {
    if (collapsed.has(key)) return false
    if (activeByDefault) return true
    return expanded.has(key)
  }
  // Walk both levels — if anything is already open we leave the
  // drawer alone (the user's view shouldn't shift while they refine).
  for (const world of worldOrder) {
    const worldKey = `${keyPrefix}-world:${world}`
    const activeWorld = isActive(world)
    if (isOpen(worldKey, activeWorld)) {
      const innerMap = tree.get(world)
      if (innerMap) {
        for (const inner of innerMap.keys()) {
          const groupKey = `${keyPrefix}-${keyPrefix === 'sections' ? 'group' : 'cat'}:${world}/${inner}`
          if (isOpen(groupKey, activeWorld)) return // group inside open world also open → done
        }
      }
    }
  }
  // Nothing is open — surface the first match.
  const firstWorld = worldOrder[0]
  const worldKey = `${keyPrefix}-world:${firstWorld}`
  expanded.add(worldKey)
  collapsed.delete(worldKey)
  const innerMap = tree.get(firstWorld)
  if (innerMap && innerMap.size > 0) {
    const firstInner = innerMap.keys().next().value
    const groupKey = `${keyPrefix}-${keyPrefix === 'sections' ? 'group' : 'cat'}:${firstWorld}/${firstInner}`
    expanded.add(groupKey)
    collapsed.delete(groupKey)
  }
}

function renderSectionsDrawer(drawer, q) {
  const active = activeWorldsFor(state.planet)
  const activeLower = active.map((w) => w.toLowerCase())
  // Two-level tree: world → (group → items).  The world level is the
  // top-most collapse target so the user can fold whole tilesets in
  // one click.
  const tree = new Map()
  for (const s of state.sectionsList) {
    const hay = `${s.name} ${s.world} ${s.group}`.toLowerCase()
    if (q && !hay.includes(q)) continue
    const w = s.world || '—'
    const g = s.group || '—'
    if (!tree.has(w)) tree.set(w, new Map())
    const groups = tree.get(w)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(s)
  }
  if (tree.size === 0) {
    drawer.innerHTML = '<div class="loading">No sections match.</div>'
    return
  }

  const worlds = sortWorldsForDrawer(Array.from(tree.keys()), activeLower)
  ensureAutoExpandForFilter(q, worlds, tree, 'sections',
    (w) => activeLower.includes(w.toLowerCase()))
  const frag = document.createDocumentFragment()
  for (const world of worlds) {
    const groupsMap = tree.get(world)
    const isActive = activeLower.includes(world.toLowerCase())
    const totalItems = Array.from(groupsMap.values()).reduce((n, items) => n + items.length, 0)
    const worldKey = `sections-world:${world}`
    const worldEl = renderDrawerWorldGroup(worldKey, world, totalItems, isActive)
    const body = worldEl.querySelector('.drawer-group-body')
    for (const [groupName, items] of groupsMap) {
      const innerKey = `sections-group:${world}/${groupName}`
      body.appendChild(renderSectionGroup(innerKey, groupName, items, !isActive))
    }
    frag.appendChild(worldEl)
  }
  drawer.replaceChildren(frag)
}

// sortWorldsForDrawer puts the active tileset first, then "All Worlds"
// (handy for features that work across tilesets), then alphabetical.
function sortWorldsForDrawer(worlds, activeLower) {
  return worlds.slice().sort((a, b) => {
    const aA = activeLower.includes(a.toLowerCase())
    const bA = activeLower.includes(b.toLowerCase())
    if (aA !== bA) return aA ? -1 : 1
    const aAll = /\ball worlds?\b/i.test(a) || /allworlds?/i.test(a)
    const bAll = /\ball worlds?\b/i.test(b) || /allworlds?/i.test(b)
    if (aAll !== bAll) return aAll ? -1 : 1
    return a.localeCompare(b)
  })
}

// renderDrawerWorldGroup builds the outer collapsible world group.
// The active world expands by default; everything else collapses so
// the drawer stays compact on first view.
function renderDrawerWorldGroup(key, worldName, totalItems, activeByDefault) {
  const groupEl = document.createElement('div')
  groupEl.className = 'drawer-group drawer-world'
  const defaultCollapsed = !activeByDefault
  const collapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state._sectionExpanded?.has(key))
  if (collapsed) groupEl.classList.add('collapsed')
  const title = document.createElement('div')
  title.className = 'drawer-group-title'
  title.innerHTML = `<span class="chev">▾</span><span class="drawer-world-name">${escapeHTML(worldName)}</span><span class="drawer-group-count">${totalItems}</span>`
  title.addEventListener('click', () => toggleGroup(key, defaultCollapsed))
  // "Set as active" pill — clicking promotes this world to the map's
  // active tileset (state.planet).  Hides on the world that's already
  // active so the only visible pill is the actionable one.
  const world = worldFor(worldName)
  if (world && !activeByDefault) {
    const pill = document.createElement('button')
    pill.className = 'drawer-world-pill'
    pill.type = 'button'
    pill.title = `Make ${world.label} the active tileset for this map`
    pill.textContent = 'Set active'
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      setActiveWorld(world)
    })
    title.appendChild(pill)
  } else if (activeByDefault) {
    const badge = document.createElement('span')
    badge.className = 'drawer-world-pill drawer-world-pill-active'
    badge.textContent = 'Active'
    title.appendChild(badge)
  }
  groupEl.appendChild(title)
  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  groupEl.appendChild(body)
  return groupEl
}

// setActiveWorld switches the editor's planet/tileset to the
// supplied WORLDS entry — re-rendering the drawer (so the chosen
// world sorts to the top + its pill flips to "Active"), updating any
// open OTA properties dialog, and committing the change as an undo
// step so the user can roll back.
function setActiveWorld(world) {
  if (!world) return
  if (state.planet === world.slug) return
  beginTransaction()
  state.planet = world.slug
  if (state.ota) state.ota.planet = world.defaultTileset
  commitTransaction(`Set tileset to ${world.label}`)
  // Reflect in the open OTA dialog if it happens to be on screen.
  const otaSelect = $('#ota-planet')
  if (otaSelect && !$('#ota-dialog')?.classList.contains('hidden')) {
    otaSelect.value = world.defaultTileset
  }
  renderDrawer()
  setStatus(`Active tileset: ${world.label}.`)
}

// renderSectionGroup builds the DOM for one collapsible group of sections.
// `key` is the persistent identifier used for the collapse-state set;
// `defaultCollapsed` is the starting state when the key is unknown.
// Items inside the body are materialised lazily when the body scrolls
// into view so the editor doesn't spend boot time building thousands of
// hidden DOM rows.
function renderSectionGroup(key, groupName, items, defaultCollapsed) {
  const groupEl = document.createElement('div')
  groupEl.className = 'drawer-group'
  const collapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state.collapsedGroups.has(key) && !state._sectionExpanded?.has(key))
  if (collapsed) groupEl.classList.add('collapsed')

  const title = document.createElement('div')
  title.className = 'drawer-group-title'
  title.innerHTML = `<span class="chev">▾</span><span>${escapeHTML(groupName)}</span><span class="drawer-group-count">${items.length}</span>`
  title.addEventListener('click', () => toggleGroup(key, defaultCollapsed))
  groupEl.appendChild(title)

  const body = virtualisedDrawerBody(items.length, (el) => {
    const frag = document.createDocumentFragment()
    for (const s of items) frag.appendChild(createSectionItem(s))
    el.appendChild(frag)
  })
  groupEl.appendChild(body)
  return groupEl
}

function createSectionItem(s) {
  const item = document.createElement('div')
  item.className = 'drawer-item'
  item.draggable = true
  item.dataset.path = s.path
  if (state.selected?.type === 'section' && state.selected.path === s.path) {
    item.classList.add('selected')
  }
  // Native title gives the user the full path + dimensions on hover.
  const tooltipParts = [s.name]
  if (s.tileW || s.tileH) tooltipParts.push(`${s.tileW || '?'}×${s.tileH || '?'} tiles`)
  if (s.world) tooltipParts.push(`World: ${s.world}`)
  if (s.group) tooltipParts.push(`Group: ${s.group}`)
  if (s.path) tooltipParts.push(s.path)
  item.title = tooltipParts.join('\n')
  item.innerHTML = `
    <img class="drawer-thumb" src="/api/studio/section-preview/${encodeURI(s.path)}" alt="" loading="lazy" draggable="false" />
    <div class="drawer-meta">
      <div class="drawer-name">${escapeHTML(s.name)}</div>
      <div class="drawer-sub">${s.tileW || '?'}×${s.tileH || '?'} tiles · ${escapeHTML(s.group || '')}</div>
    </div>
  `
  item.addEventListener('click', () => selectSection(s))
  item.addEventListener('dragstart', (e) => beginSectionDrag(e, s))
  return item
}

// toggleGroup flips a group between collapsed/expanded.  `defaultCollapsed`
// is the initial state when the user has never interacted; toggling moves
// to the opposite state and remembers that the user has interacted (so
// auto-collapse doesn't undo their choice on the next render).
function toggleGroup(key, defaultCollapsed) {
  const isCollapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state._sectionExpanded?.has(key))
  if (isCollapsed) {
    state.collapsedGroups.delete(key)
    ;(state._sectionExpanded ??= new Set()).add(key)
  } else {
    state.collapsedGroups.add(key)
    state._sectionExpanded?.delete(key)
  }
  renderDrawer()
}

function renderFeaturesDrawer(drawer, q) {
  const active = activeWorldsFor(state.planet)
  const usage = featureUsage()
  // Two-level tree: world → (category → items).  The world level is the
  // top-most collapse target so the user can fold an entire tileset
  // (e.g. all of "Green World") in one click.
  const tree = new Map()
  for (const f of state.featuresList) {
    const hay = `${f.name} ${f.world} ${f.category} ${f.description}`.toLowerCase()
    if (q && !hay.includes(q)) continue
    if (state.usedOnly && !usage.has((f.name || '').toLowerCase())) continue
    // Wreckage is hidden by default — it's noisy and rarely something
    // the user wants to place on a fresh map.  Existing placements
    // (usage > 0) always show through so the user can manage them.
    if (!state.includeWreckage && isWreckageFeature(f) && !usage.has((f.name || '').toLowerCase())) continue
    const w = f.world || '—'
    const c = f.category || '—'
    if (!tree.has(w)) tree.set(w, new Map())
    const cats = tree.get(w)
    if (!cats.has(c)) cats.set(c, [])
    cats.get(c).push(f)
  }
  if (tree.size === 0) {
    if (state.usedOnly) {
      drawer.innerHTML = '<div class="loading">No placed features yet — turn off "Used only" to browse the full list.</div>'
    } else {
      drawer.innerHTML = '<div class="loading">No features match.</div>'
    }
    return
  }

  const worlds = sortFeatureWorldsForDrawer(Array.from(tree.keys()), active)
  ensureAutoExpandForFilter(q, worlds, tree, 'features',
    (w) => featureWorldMatches(w, active))
  const frag = document.createDocumentFragment()
  for (const world of worlds) {
    const catsMap = tree.get(world)
    const isActive = featureWorldMatches(world, active)
    const totalItems = Array.from(catsMap.values()).reduce((n, items) => n + items.length, 0)
    const worldKey = `features-world:${world}`
    const worldEl = renderDrawerWorldGroup(worldKey, world, totalItems, isActive)
    const body = worldEl.querySelector('.drawer-group-body')
    for (const [categoryName, items] of catsMap) {
      const innerKey = `features-cat:${world}/${categoryName}`
      body.appendChild(renderFeatureGroup(innerKey, categoryName, items, !isActive, usage))
    }
    frag.appendChild(worldEl)
  }
  drawer.replaceChildren(frag)
}

// sortFeatureWorldsForDrawer mirrors sortWorldsForDrawer but uses
// featureWorldMatches so TDF world names ("Green World", "All Worlds")
// match the active tileset slug.
function sortFeatureWorldsForDrawer(worlds, active) {
  return worlds.slice().sort((a, b) => {
    const aA = featureWorldMatches(a, active)
    const bA = featureWorldMatches(b, active)
    if (aA !== bA) return aA ? -1 : 1
    const aAll = /\ball worlds?\b/i.test(a) || /allworlds?/i.test(a)
    const bAll = /\ball worlds?\b/i.test(b) || /allworlds?/i.test(b)
    if (aAll !== bAll) return aAll ? -1 : 1
    return a.localeCompare(b)
  })
}

function renderFeatureGroup(key, groupName, items, defaultCollapsed, usage) {
  const groupEl = document.createElement('div')
  groupEl.className = 'drawer-group'
  const collapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state._sectionExpanded?.has(key))
  if (collapsed) groupEl.classList.add('collapsed')

  const title = document.createElement('div')
  title.className = 'drawer-group-title'
  title.innerHTML = `<span class="chev">▾</span><span>${escapeHTML(groupName)}</span><span class="drawer-group-count">${items.length}</span>`
  title.addEventListener('click', () => toggleGroup(key, defaultCollapsed))
  groupEl.appendChild(title)

  const body = virtualisedDrawerBody(items.length, (el) => {
    const frag = document.createDocumentFragment()
    for (const f of items) frag.appendChild(createFeatureItem(f, usage))
    el.appendChild(frag)
  })
  groupEl.appendChild(body)
  return groupEl
}

function createFeatureItem(f, usage) {
  const item = document.createElement('div')
  item.className = 'drawer-item feature-item'
  item.draggable = true
  item.dataset.name = f.name
  if (state.selected?.type === 'feature' && state.selected.name === f.name) {
    item.classList.add('selected')
  }
  const fp = `${f.footprintX || 1}×${f.footprintZ || 1}`
  const useCount = usage ? (usage.get((f.name || '').toLowerCase()) || 0) : 0
  const usageBadge = useCount > 0 ? `<span class="usage-badge">${useCount}</span>` : ''
  // Tooltip — fall back to the bare name if every other field is blank.
  const tooltipParts = [f.name]
  if (f.world) tooltipParts.push(`World: ${f.world}`)
  if (f.category) tooltipParts.push(`Category: ${f.category}`)
  tooltipParts.push(`Footprint: ${fp}`)
  if (useCount > 0) tooltipParts.push(`Placed: ${useCount}`)
  if (f.description) tooltipParts.push(f.description)
  item.title = tooltipParts.join('\n')
  const staticUrl = f.previewUrl ? f.previewUrl + '?static=1' : null
  const initialUrl = (state.animateFeatures || state.hoveredFeatureName === f.name)
    ? f.previewUrl
    : staticUrl
  const thumb = f.previewUrl
    ? `<img class="drawer-thumb feature-thumb" src="${initialUrl}" data-animated="${f.previewUrl}" data-static="${staticUrl}" alt="" loading="lazy" draggable="false" />`
    : `<div class="drawer-thumb drawer-thumb-glyph">🌲</div>`
  item.innerHTML = `
    ${thumb}
    <div class="drawer-meta">
      <div class="drawer-name">${escapeHTML(f.name)}</div>
      <div class="drawer-sub">${fp} · ${escapeHTML(f.description || f.category || '')}</div>
    </div>
    ${usageBadge}
  `
  item.addEventListener('click', () => selectFeature(f))
  item.addEventListener('dragstart', (e) => beginFeatureDrag(e, f))
  item.addEventListener('mouseenter', () => {
    state.hoveredFeatureName = f.name
    state.highlightFeatureName = (f.name || '').toLowerCase()
    if (f.previewUrl && !state.animateFeatures) {
      const img = item.querySelector('img.feature-thumb')
      if (img) img.src = img.dataset.animated
    }
    renderCanvas()
  })
  item.addEventListener('mouseleave', () => {
    if (state.hoveredFeatureName === f.name) state.hoveredFeatureName = null
    if (state.highlightFeatureName === (f.name || '').toLowerCase()) state.highlightFeatureName = null
    if (f.previewUrl && !state.animateFeatures) {
      const img = item.querySelector('img.feature-thumb')
      if (img) img.src = img.dataset.static
    }
    renderCanvas()
  })
  return item
}

// beginSectionDrag and beginFeatureDrag are called from dragstart.  We
// keep them lean — set state.selected/state.dragging directly and kick
// off asset preloads — but deliberately avoid re-rendering the drawer
// here.  Mutating the DOM mid-dragstart (which selectSection /
// selectFeature would do via renderDrawer) causes some browsers to
// silently cancel the drag, which is why drag-from-feature-row was
// failing.
function beginSectionDrag(e, s) {
  state.selected = { type: 'section', path: s.path, tileW: s.tileW, tileH: s.tileH, rotation: 0 }
  state.dragging = { type: 'section', path: s.path, tileW: s.tileW, tileH: s.tileH }
  ensureSectionAssets(s.path)
  showPlacementHint(`Dragging ${s.name}`, 'section')
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy'
    try { e.dataTransfer.setData('text/plain', s.path) } catch { /* legacy */ }
    // Use just the section's preview thumbnail as the drag image
    // rather than the full drawer row — the row card obscures the
    // canvas hints and overlap with the placement preview.
    setRowDragImage(e)
  }
  attachDragEnd(e.target)
}

function beginFeatureDrag(e, f) {
  state.selected = {
    type: 'feature',
    name: f.name,
    footprintX: f.footprintX || 1,
    footprintZ: f.footprintZ || 1,
    previewUrl: f.previewUrl || null,
    originX: f.originX || 0,
    originY: f.originY || 0,
  }
  state.dragging = { type: 'feature', name: f.name }
  preloadFeatureImage(f)
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy'
    try { e.dataTransfer.setData('text/plain', f.name) } catch { /* legacy */ }
    setRowDragImage(e)
  }
  attachDragEnd(e.target)
}

// setRowDragImage replaces the browser's default drag ghost (which
// would otherwise render the entire drawer row) with a 1×1 fully
// transparent pixel.  The user gets *only* the in-canvas placement
// preview to look at, not a duplicated thumbnail trailing the cursor.
let transparentDragImage = null
function setRowDragImage(e) {
  if (!e.dataTransfer) return
  if (!transparentDragImage) {
    transparentDragImage = new Image()
    transparentDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  }
  e.dataTransfer.setDragImage(transparentDragImage, 0, 0)
}

// Clear the dragging flag on dragend so a drag cancelled outside the
// canvas (e.g. into another part of the page) doesn't leave state stale.
function attachDragEnd(el) {
  const once = () => {
    state.dragging = null
    let dirty = false
    if (state.dropPreview) { state.dropPreview = null; dirty = true }
    // If the drag started a placement preview but the user dropped
    // outside the canvas, retire the preview rather than leaving a
    // ghost section under a stale cursor position.
    if (state.placement && !state.selected) {
      state.placement = null
      hidePlacementHint()
      dirty = true
    }
    if (dirty) renderCanvas()
    el.removeEventListener('dragend', once)
  }
  el.addEventListener('dragend', once)
}

// pageSectionSibling jumps to the previous (-1) or next (+1) section
// in state.sectionsList relative to the currently selected one.  Used
// by the ArrowLeft / ArrowRight hotkeys to flip through tilesets fast.
// Returns true when it actually paged (so the hotkey can preventDefault).
function pageSectionSibling(direction) {
  if (!state.selected || state.selected.type !== 'section') return false
  const list = state.sectionsList || []
  if (list.length < 2) return false
  const cur = list.findIndex((s) => s.path === state.selected.path)
  if (cur < 0) return false
  const next = ((cur + direction) % list.length + list.length) % list.length
  // Fire-and-forget — selectSection is async because of asset loading
  // but we want the keypress to return immediately.
  selectSection(list[next])
  return true
}

async function selectSection(s) {
  // Clicking a section in the drawer switches the editor into Place
  // Tiles mode so a single click on the canvas stamps it.  (Drag-from-
  // drawer skips this — beginSectionDrag sets state.selected directly
  // so the user's current mode is preserved for one-off drops.)
  if (state.mode !== 'paint') setMode('paint')
  state.selected = { type: 'section', path: s.path, tileW: s.tileW, tileH: s.tileH, rotation: 0 }
  // anchored: false → the preview follows the cursor; first canvas
  // click flips this to true so the preview "drops" at that spot and
  // can be drag-repositioned / rotated before being committed.
  // dormant: true → don't draw the preview until the cursor enters
  // the canvas.  Avoids the "ghost flashes at viewport centre then
  // jumps to the cursor" effect when picking from the drawer.
  const placement = { sectionPath: s.path, origW: s.tileW, origH: s.tileH, rotation: 0, tx: 0, ty: 0, anchored: false, userRotated: false, dormant: true }
  const center = viewportCellCenter()
  const anchor = placementAnchor(center.tx, center.ty, placement)
  placement.tx = anchor.tx
  placement.ty = anchor.ty
  state.placement = placement
  await ensureSectionAssets(s.path)
  tryAutoRotatePlacement(state.placement)
  showPlacementHint(`Placing ${s.name}`, 'section')
  renderDrawer()
  renderCanvas()
  setStatus(`Placing ${s.name} (${s.tileW}×${s.tileH}).  Click on the canvas to anchor — then drag to reposition, Q / E to rotate, click outside to confirm.`)
}

// viewportCellCenter returns the tile coordinate at the centre of the
// currently visible canvas area, honouring scroll + zoom.  Used when a
// placement preview needs a sensible default position before the user
// moves the cursor.
function viewportCellCenter() {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  if (!wrap || !canvas) {
    return { tx: Math.floor(state.tileW / 2), ty: Math.floor(state.tileH / 2) }
  }
  const cx = (wrap.scrollLeft - overscrollPadding.x + wrap.clientWidth / 2) / state.zoom
  const cy = (wrap.scrollTop - overscrollPadding.y + wrap.clientHeight / 2) / state.zoom
  return {
    tx: clamp(Math.floor(cx / TILE_PX), 0, state.tileW - 1),
    ty: clamp(Math.floor(cy / TILE_PX), 0, state.tileH - 1),
  }
}

// ensureSectionAssets fires off (or returns the existing) requests for the
// section's tile-grid image and per-cell heights JSON.  Both are cached
// so re-selecting the same section is instant.
async function ensureSectionAssets(path) {
  if (!state.sectionImages.has(path)) {
    const img = new Image()
    img.src = `/api/studio/section-image/${encodeURI(path)}`
    state.sectionImages.set(path, img)
    img.addEventListener('load', () => renderCanvas())
  }
  if (!state.sectionHeights.has(path)) {
    try {
      const resp = await fetch(`/api/studio/section-heights/${encodeURI(path)}`)
      if (resp.ok) {
        const data = await resp.json()
        state.sectionHeights.set(path, data)
        // Heights arriving late: if the user is currently placing this
        // section, run the auto-fit rotation now that we can score it.
        if (state.placement && state.placement.sectionPath === path) {
          tryAutoRotatePlacement(state.placement)
          renderCanvas()
        }
      }
    } catch { /* heightmap will fall back to defaults */ }
  }
}

function cancelPlacement() {
  if (!state.placement) return
  state.placement = null
  hidePlacementHint()
  renderCanvas()
}

function showPlacementHint(label, kind) {
  const hint = $('#placement-hint')
  const lbl = $('#placement-hint-label')
  const rotateRow = $('#placement-hint-rotate')
  if (hint) hint.classList.remove('hidden')
  if (lbl) lbl.textContent = label
  // Features don't rotate — hide the Q/E line so the pill is less noisy
  // when the user is dragging features.
  if (rotateRow) rotateRow.classList.toggle('hidden', kind === 'feature')
}
function hidePlacementHint() {
  const hint = $('#placement-hint')
  if (hint) hint.classList.add('hidden')
}

function selectFeature(f) {
  // Clicking a feature switches to Place Features mode so the next
  // canvas click drops a copy.  Drag-from-drawer (beginFeatureDrag) is
  // mode-neutral by design — the user might want to drop one feature
  // into a paint workflow without losing their tool.
  if (state.mode !== 'select-features') setMode('select-features')
  state.selected = {
    type: 'feature',
    name: f.name,
    footprintX: f.footprintX || 1,
    footprintZ: f.footprintZ || 1,
    previewUrl: f.previewUrl || null,
    originX: f.originX || 0,
    originY: f.originY || 0,
  }
  preloadFeatureImage(f)
  if (state.placement) cancelPlacement()
  showPlacementHint(`Placing ${f.name}`, 'feature')
  renderDrawer()
  setStatus(`Placing ${f.name} — click anywhere to drop a copy.  Pick a different feature or hit Esc to stop.`)
}

// whenImageReady fires `cb` the first time `img` finishes loading,
// dedupes by (img, kind) so callers in tight render loops don't pile
// up a thousand listeners on the same Image while it decodes.  Every
// repaint of a frame that touches a not-yet-loaded section atlas used
// to attach a new 'load' handler — when the atlas finally decoded all
// those handlers fired in a single tick, each invoking renderCanvas()
// and burning 99% of JS time in the listener add path.
const imageReadyCallbacks = new WeakMap()
function whenImageReady(img, kind, cb) {
  if (!img) return
  let registry = imageReadyCallbacks.get(img)
  if (!registry) {
    registry = new Set()
    imageReadyCallbacks.set(img, registry)
  }
  if (registry.has(kind)) return
  registry.add(kind)
  img.addEventListener('load', () => {
    const r = imageReadyCallbacks.get(img)
    if (r) r.delete(kind)
    cb()
  }, { once: true })
}

function preloadFeatureImage(f) {
  if (!f.previewUrl) return
  const key = f.name.toLowerCase()
  if (state.featureImages.has(key)) return
  // Canvas placements always use the static first-frame PNG.  The
  // animated APNG canvas is padded to the bounding box of all frames,
  // which shifts the in-image hotspot away from (OriginX, OriginY) and
  // breaks placement on multi-frame features.  Drawer thumbnails still
  // animate via their own <img> elements (see renderFeatureGroup).
  const img = new Image()
  img.src = f.previewUrl + '?static=1'
  img.onload = () => renderCanvas()
  state.featureImages.set(key, img)
}

// ── Canvas ─────────────────────────────────────────────────────────────────

// Tracks the cell under the cursor for hotkey actions that don't
// fire from a mouse event (notably Ctrl+V paste, which wants to
// drop the pasted rectangle at the user's last hover point).  The
// authoritative store is hostCallbacks.cursor.lastHover so the
// extracted clipboard module can read it without an import cycle;
// this file just writes to it from the mouse-move/leave handlers.
let painting = false
let paintedDuringStroke = false

// Pan state — populated while the user is mid-drag panning the canvas.
let panState = null
// True while the spacebar is held; engages pan mode regardless of tool.
let spacePanHotkey = false

// Undo / redo + transaction wrapper now live in
// ./ui/map-editor/undo.js — imports at the top of this file pull
// `undoStack`, `redoStack`, `begin/commit/abortTransaction`, `undo`,
// `redo`, `updateUndoButtons`, `refreshHistoryFlyouts`, plus
// `captureSnapshot` / `restoreSnapshot` / `cloneOTA` (re-exported
// for callers that snapshot OTA into a tab swap).

// ── EditorView ─────────────────────────────────────────────────────────────
//
// EditorView owns the editing window's mutable DOM: the 2D #canvas, the
// WebGL #canvas-gl, the per-canvas event listeners, and the
// ResizeObserver watching the scroll wrap.  Each map load (New, Open,
// Resize) calls recreateEditorView(), which destroys the previous view
// — removing the canvas elements, aborting their listeners, and losing
// the GL context — and mounts a fresh one.  No DOM, no event listeners,
// and no GL state from the previous map can leak into the next.

// Module-level singleton.  Reassigned by recreateEditorView().
let editorView = null

class EditorView {
  constructor() {
    this.stack = document.querySelector('#canvas-stack')
    this.scroll = document.querySelector('#canvas-scroll')
    this.canvas = null
    this.glCanvas = null
    this.abort = null
    this.resizeObserver = null
  }

  mount() {
    if (!this.stack) return
    // Wipe any pre-existing canvases (initial HTML markup or a stale
    // mount that destroy() somehow missed).
    for (const c of Array.from(this.stack.querySelectorAll('canvas'))) {
      this.stack.removeChild(c)
    }
    // glCanvas first (sits under the 2D overlay).
    const glCanvas = document.createElement('canvas')
    glCanvas.id = 'canvas-gl'
    const canvas = document.createElement('canvas')
    canvas.id = 'canvas'
    this.stack.append(glCanvas, canvas)
    this.glCanvas = glCanvas
    this.canvas = canvas

    canvas.width = state.tileW * TILE_PX
    canvas.height = state.tileH * TILE_PX
    canvas.style.width = canvas.width * state.zoom + 'px'
    canvas.style.height = canvas.height * state.zoom + 'px'
    glCanvas.width = canvas.width
    glCanvas.height = canvas.height
    glCanvas.style.width = canvas.style.width
    glCanvas.style.height = canvas.style.height

    applyOverscrollPadding()
    this.abort = new AbortController()
    this._bindCanvasListeners()
    this._bindResizeObserver()
  }

  destroy() {
    if (this.abort) { this.abort.abort(); this.abort = null }
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null }
    resetGL()
    if (this.canvas?.parentNode) this.canvas.parentNode.removeChild(this.canvas)
    if (this.glCanvas?.parentNode) this.glCanvas.parentNode.removeChild(this.glCanvas)
    this.canvas = null
    this.glCanvas = null
  }

  _bindResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !this.scroll) return
    this.resizeObserver = new ResizeObserver(() => {
      applyOverscrollPadding()
      scheduleRenderCanvas()
      scheduleMinimapRender()
    })
    this.resizeObserver.observe(this.scroll)
  }

  _bindCanvasListeners() {
    const { canvas, scroll, abort } = this
    if (!canvas || !abort) return
    const sig = { signal: abort.signal }
    canvas.addEventListener('mousedown', (e) => onCanvasMouseDown(e), sig)
    window.addEventListener('mouseup', (e) => onCanvasMouseUp(e), sig)
    canvas.addEventListener('mousemove', (e) => onCanvasMouseMove(e), sig)
    canvas.addEventListener('mouseleave', () => {
      // #hover-cell (legacy canvas-toolbar) is gone — the Camera &
      // Cursor floating panel shows the hover info now.  Guarded
      // lookup so dev tools that still poke at the old span keep
      // working without throwing.
      const hc = document.getElementById('hover-cell')
      if (hc) hc.textContent = '—'
      updateCameraInfoCursor(null)
      if (state.eraseCursor) { state.eraseCursor = null; renderCanvas() }
      hostCallbacks.cursor.lastHover = null
    }, sig)

    // Wheel/trackpad routing:
    //   - Ctrl/Cmd + wheel → zoom (covers Mac pinch — Safari sends pinch
    //     as wheel-with-ctrlKey).
    //   - Any horizontal delta (deltaX) → pan horizontally.
    //   - Shift + wheel → pan vertically.
    //   - Otherwise → zoom anchored to the cursor.
    if (scroll) {
      scroll.addEventListener('wheel', (e) => {
        // Ignore wheel events while any modal dialog is showing — they
        // were sneaking past the dialog overlay and nudging zoom while
        // the user was scrolling dialog content.  Symptom: map switches
        // landed at zoom 1.0015 instead of 1.0.
        if (document.querySelector('.dialog:not(.hidden)')) return
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          zoomAtPointer(e.clientX, e.clientY, e.deltaY)
          return
        }
        if (e.deltaX !== 0) {
          e.preventDefault()
          scroll.scrollLeft += e.deltaX
          if (e.deltaY !== 0) scroll.scrollTop += e.deltaY
          return
        }
        if (e.shiftKey) {
          e.preventDefault()
          scroll.scrollTop += e.deltaY
          return
        }
        e.preventDefault()
        zoomAtPointer(e.clientX, e.clientY, e.deltaY)
      }, { passive: false, signal: abort.signal })
    }

    // Drag-and-drop from the sidebar drawer.  `dragover` only updates the
    // hover highlight; the actual stamp is committed once on `drop`.  This
    // avoids smearing the drag path across every cell the cursor passed.
    canvas.addEventListener('dragenter', (e) => { e.preventDefault() }, sig)
    canvas.addEventListener('dragover', (e) => {
      if (!state.dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      updateHoverLabel(e)
      const { tx, ty } = pickCell(e)
      let dirty = false
      if (state.dropPreview?.tx !== tx || state.dropPreview?.ty !== ty) {
        state.dropPreview = { tx, ty }
        dirty = true
      }
      // While dragging a section, also engage a full placement preview so
      // the user sees the section's pixels + rotation badge + edge hints
      // exactly like a click-to-place flow.  The section is centred on
      // the cursor (rather than top-left anchored) — matches what
      // setDragImage does for the drag ghost.
      if (state.dragging.type === 'section' && state.selected?.type === 'section') {
        if (!state.placement || state.placement.sectionPath !== state.selected.path) {
          state.placement = {
            sectionPath: state.selected.path,
            origW: state.selected.tileW,
            origH: state.selected.tileH,
            rotation: state.selected.rotation || 0,
            tx, ty,
          }
        }
        // selectSection seeds the placement with dormant=true so the
        // first cursor-follow paint waits until the cursor enters the
        // canvas.  When the user re-drags the SAME row immediately
        // after clicking it, the dragover handler above reuses that
        // existing placement — without this wake the dragover-driven
        // preview never paints because drawPlacementPreview early-
        // returns on the stale dormant flag, and the user only sees
        // the tile after the drop / final click.
        if (state.placement.dormant) {
          state.placement.dormant = false
          dirty = true
        }
        const anchor = placementAnchor(tx, ty, state.placement)
        if (state.placement.tx !== anchor.tx || state.placement.ty !== anchor.ty) {
          state.placement.tx = anchor.tx
          state.placement.ty = anchor.ty
          tryAutoRotatePlacement(state.placement)
          dirty = true
        }
      }
      if (dirty) renderCanvas()
    }, sig)
    canvas.addEventListener('dragleave', () => {
      state.dropPreview = null
      renderCanvas()
    }, sig)
    canvas.addEventListener('drop', (e) => {
      if (!state.dragging) return
      e.preventDefault()
      state.dropPreview = null
      paintedDuringStroke = false
      const wasFeature = state.dragging.type === 'feature'
      if (state.dragging.type === 'section' && state.placement) {
        // Anchor the section at the drop point instead of immediately
        // overwriting the tiles underneath — the user can then drag /
        // rotate it and only commit on the next click outside the
        // footprint (or Esc to cancel).  This way the original tiles at
        // the drop point are preserved until the user is happy.
        const { tx: cx, ty: cy } = pickCell(e)
        if (cx >= 0 && cx < state.tileW && cy >= 0 && cy < state.tileH) {
          // Force Paint mode so the anchored placement is interactive
          // regardless of what mode the drag started from (e.g., View).
          if (state.mode !== 'paint') setMode('paint')
          const anchor = placementAnchor(cx, cy, state.placement)
          state.placement.tx = anchor.tx
          state.placement.ty = anchor.ty
          state.placement.anchored = true
          setStatus('Section anchored — drag inside to reposition, Q / E to rotate, click outside to confirm, Esc to cancel.')
          renderCanvas()
        }
      } else if (wasFeature && state.selected?.type === 'feature') {
        // Features remain a one-shot drop — they have no anchored state
        // and the user can re-drag them in Place Features mode after.
        const { ax, ay } = pickFeatureAttrCell(e, state.selected)
        if (ax >= 0 && ax < state.tileW * 2 && ay >= 0 && ay < state.tileH * 2) {
          beginTransaction()
          placeFeature(ax, ay)
          commitTransaction('Place feature')
          paintedDuringStroke = true
        }
      } else {
        beginTransaction()
        handlePaint(e)
        commitTransaction('Place')
      }
      state.dragging = null
      if (wasFeature && state.selected?.type === 'feature') {
        showPlacementHint(`Placing ${state.selected.name}`, 'feature')
      } else if (!wasFeature) {
        // Keep the section placement hint visible so the user knows
        // they're now in the anchored / movable state.
        // (showPlacementHint was already called by beginSectionDrag.)
      }
      paintedDuringStroke = false
    }, sig)
  }
}

// recreateEditorView tears down any previously-mounted EditorView and
// mounts a fresh one.  Called from finishEditorBoot (on every map open
// or new) and applyResize so no DOM nodes, event listeners, or GL
// state from the previous map survive the switch.
function recreateEditorView() {
  if (editorView) editorView.destroy()
  editorView = new EditorView()
  editorView.mount()
}

// wireZoomButtons binds the three Zoom ribbon buttons.  Lives outside
// EditorView because the buttons sit in the toolbar (which is mounted
// once for the session) rather than the canvas stack.
function wireZoomButtons() {
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * (state.settings?.zoomStep || 1.25)))
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / (state.settings?.zoomStep || 1.25)))
  $('#zoom-fit').addEventListener('click', fitZoom)
}

function pickCell(e) {
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const x = (e.clientX - rect.left) / rect.width * state.tileW
  const y = (e.clientY - rect.top) / rect.height * state.tileH
  return { tx: Math.floor(x), ty: Math.floor(y) }
}

// pickFeatureAttrCell returns the (ax, ay) attribute cell to assign to
// a feature placed under the cursor.  It inverts the same offset
// featureAnchorWorld applies on the way out — Footprint*8 in X plus
// Footprint*8 - Height/2 in Y — so the rendered anchor visually lines
// up with the cursor (modulo the unavoidable ±8 px snap to the 16-px
// attribute grid).  Height is sampled at the cursor's plain cell as a
// one-step estimate; the stored ax/ay round-trips through load/save
// unchanged.
function pickFeatureAttrCell(e, sel) {
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = (e.clientX - rect.left) / rect.width * canvas.width
  const cy = (e.clientY - rect.top) / rect.height * canvas.height
  const fw = (sel && sel.footprintX) || 1
  const fh = (sel && sel.footprintZ) || 1
  const cellPx = TILE_PX / 2 // 16
  const anchorPx = TILE_PX / 4 // 8
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const heights = state.heights
  const sampleH = (ax, ay) => {
    if (!heights || !heights.length) return 0
    if (ax < 0 || ay < 0 || ax >= aw || ay >= ah) return 0
    return heights[ay * aw + ax] | 0
  }
  const ax = clamp(Math.floor((cx - fw * anchorPx) / cellPx), 0, aw - 1)
  // Tentative ay using the cursor cell's height — then iterate so the
  // height we use to compute ay matches the height at the cell ay
  // actually lands in.  Without this, releasing a feature near a
  // slope makes the renderer (which reads state.heights at the final
  // ax/ay) disagree with the picker (which read state.heights at the
  // cursor cell), and the feature visibly snaps to a different
  // position after the drop completes.
  const cursorAy = clamp(Math.floor(cy / cellPx), 0, ah - 1)
  let h = sampleH(ax, cursorAy)
  let ay = clamp(Math.floor((cy + (h >> 1) - fh * anchorPx) / cellPx), 0, ah - 1)
  for (let i = 0; i < 3; i++) {
    const nextH = sampleH(ax, ay)
    if (nextH === h) break
    h = nextH
    ay = clamp(Math.floor((cy + (h >> 1) - fh * anchorPx) / cellPx), 0, ah - 1)
  }
  return { ax, ay }
}

function updateHoverLabel(e) {
  const { tx, ty } = pickCell(e)
  // #hover-cell (legacy canvas-toolbar) is gone — the Camera & Cursor
  // floating panel renders the hovered tile + sub-tile + height + zoom
  // in one place via updateCameraInfoCursor below.  We still touch the
  // legacy span when something else (a probe, a third-party extension)
  // happens to have re-inserted it.
  const hc = document.getElementById('hover-cell')
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) {
    if (hc) hc.textContent = '—'
    setCanvasHoverFeature(null)
    updateCameraInfoCursor(null)
    return
  }
  if (hc) hc.textContent = `(${tx}, ${ty})`
  // Highlight the feature under the cursor (if any) so the minimap can
  // narrow its dot view to that type — see renderMinimap.
  const hit = findFeatureAt(e)
  const name = hit >= 0 ? (state.features[hit]?.name || '').toLowerCase() : null
  setCanvasHoverFeature(name)
  // Camera & Cursor panel cursor row: sub-tile is computed from the
  // raw attribute cell under the cursor (independent of feature-anchor
  // adjustments).
  const aa = pickAttrCellForVoid(e)
  updateCameraInfoCursor(tx, ty, aa.ax, aa.ay)
}

// setCanvasHoverFeature updates state.highlightFeatureName from the
// canvas side; the drawer's mouseenter/leave handlers update it from
// the sidebar side.  Whichever source most recently moved wins —
// minimap + outline renderers read state.highlightFeatureName.
let canvasHoverFeature = null
function setCanvasHoverFeature(name) {
  if (canvasHoverFeature === name) return
  canvasHoverFeature = name
  // The drawer's hover handler does its own dance with hoveredFeatureName
  // (which it uses to gate the animated thumbnail).  Don't fight it: if
  // the user is currently hovering a row, leave their highlight alone.
  if (state.hoveredFeatureName) return
  state.highlightFeatureName = name
  renderCanvas()
}

// ── Mouse routing ──────────────────────────────────────────────────────────

function onCanvasMouseDown(e) {
  paintedDuringStroke = false
  painting = true

  if (shouldPan(e)) {
    // Auto-switch on an unambiguous left-click: a clean click on a
    // start position or placed feature in a passive mode (where the
    // click would otherwise just pan) jumps into the matching mode
    // and arms a drag.  Middle-click and space-pan still pan as usual.
    if (e.button === 0 && !spacePanHotkey && tryAutoSwitchAt(e)) return
    beginPan(e)
    return
  }

  if (state.mode === 'paint') {
    if (state.placement) {
      handlePaintModeClick(e)
      return
    }
    beginTransaction()
    handlePaint(e)
  } else if (state.mode === 'erase') {
    // Erase mode runs as a paint stroke — each stamp during the drag
    // calls eraseAt; mouseup commits the whole stroke as one undo step.
    beginTransaction()
    const { tx, ty } = pickCell(e)
    if (tx >= 0 && tx < state.tileW && ty >= 0 && ty < state.tileH) {
      eraseAt(tx, ty)
      paintedDuringStroke = true
    }
  } else if (state.mode === 'select-terrain') {
    onTerrainMouseDown(e)
  } else if (state.mode === 'select-features') {
    onFeatureMouseDown(e)
  } else if (state.mode === 'picker') {
    onPickerMouseDown(e)
  } else if (state.mode === 'start-points') {
    onStartPosMouseDown(e)
  } else if (state.mode === 'voids') {
    onVoidsMouseDown(e)
  } else if (state.mode === 'heightmap') {
    onHeightmapMouseDown(e)
  } else if (state.mode === 'fill') {
    onFillMouseDown(e)
  } else if (state.mode === 'ruler') {
    onRulerMouseDown(e)
  }
}

function onCanvasMouseMove(e) {
  if (panState) { updatePan(e); return }
  updateHoverLabel(e)
  // Track the cursor cell so Ctrl+V can paste at the user's last hover
  // point.  Reset on mouseleave (handled by the canvas leave listener).
  const cell = pickCell(e)
  if (cell.tx >= 0 && cell.tx < state.tileW && cell.ty >= 0 && cell.ty < state.tileH) {
    hostCallbacks.cursor.lastHover = cell
  }
  if (state.mode === 'paint') {
    if (placementMoveAnchor && state.placement) {
      const { tx, ty } = pickCell(e)
      const dx = tx - placementMoveAnchor.cursorTX
      const dy = ty - placementMoveAnchor.cursorTY
      const newTx = placementMoveAnchor.anchoredTX + dx
      const newTy = placementMoveAnchor.anchoredTY + dy
      if (dx !== 0 || dy !== 0) placementMoveAnchor.moved = true
      if (state.placement.tx !== newTx || state.placement.ty !== newTy) {
        state.placement.tx = newTx
        state.placement.ty = newTy
        tryAutoRotatePlacement(state.placement)
        renderCanvas()
      }
    } else if (state.placement && !state.placement.anchored) {
      updatePlacementHover(e)
    } else if (painting) handlePaint(e)
  } else if (state.mode === 'erase') {
    const { tx, ty } = pickCell(e)
    // Track the cursor cell so the brush outline follows the mouse,
    // and erase under it if the user is dragging.
    if (!state.eraseCursor || state.eraseCursor.tx !== tx || state.eraseCursor.ty !== ty) {
      state.eraseCursor = { tx, ty }
      renderCanvas()
    }
    if (painting) {
      if (tx >= 0 && tx < state.tileW && ty >= 0 && ty < state.tileH) {
        eraseAt(tx, ty)
        paintedDuringStroke = true
      }
    }
  } else if (state.mode === 'select-terrain') {
    onTerrainMouseMove(e)
  } else if (state.mode === 'select-features') {
    onFeatureMouseMove(e)
  } else if (state.mode === 'picker') {
    onPickerMouseMove(e)
  } else if (state.mode === 'start-points') {
    onStartPosMouseMove(e)
  } else if (state.mode === 'voids') {
    onVoidsMouseMove(e)
  } else if (state.mode === 'heightmap') {
    onHeightmapMouseMove(e)
  } else if (state.mode === 'ruler') {
    onRulerMouseMove(e)
  }
}

function onCanvasMouseUp(e) {
  if (panState) { endPan(); return }
  if (state.mode === 'paint') {
    if (placementMoveAnchor) {
      // If the mousedown happened inside the anchored footprint and
      // the cursor didn't move, treat the mouseup as a "confirm here"
      // click; otherwise the drag has already updated tx/ty in place
      // and we just clear the anchor.
      if (!placementMoveAnchor.moved) {
        // Mousedown-then-up inside the anchored footprint is a "confirm
        // here" gesture.  Commit, drop the drawer selection, and slip
        // into Select Area mode so the user can immediately move or
        // tweak what they just placed.
        commitAnchoredPlacement()
        state.selected = null
        hidePlacementHint()
        renderDrawer()
        setMode('select-terrain')
      }
      placementMoveAnchor = null
    } else if (painting && paintedDuringStroke && !state.placement) {
      commitTransaction('Paint')
      if (state.selected?.type !== 'feature') clearStampSelection()
    } else if (painting && !paintedDuringStroke) {
      abortTransaction()
    }
  } else if (state.mode === 'erase') {
    if (painting && paintedDuringStroke) commitTransaction('Erase')
    else if (painting) abortTransaction()
  } else if (state.mode === 'select-terrain') {
    onTerrainMouseUp(e)
  } else if (state.mode === 'select-features') {
    onFeatureMouseUp(e)
  } else if (state.mode === 'picker') {
    onPickerMouseUp(e)
  } else if (state.mode === 'start-points') {
    onStartPosMouseUp(e)
  } else if (state.mode === 'voids') {
    onVoidsMouseUp(e)
  } else if (state.mode === 'heightmap') {
    onHeightmapMouseUp(e)
  }
  painting = false
  paintedDuringStroke = false
}

// shouldPan inspects the mousedown event and current editor state to
// decide whether this drag should pan the view instead of running the
// active tool.  Triggers:
//   - middle-click (button 1)
//   - left-click with the Space hotkey held
//   - left-click in Paint mode with no active selection or placement
//   - left-click in Select Features mode over empty space
// selectAllContent captures the bounding box of every tile + feature
// on the map into a Select Area clipboard.  Bound to Ctrl/Cmd-A so
// the user can grab the whole work-in-progress in one keystroke.
function selectAllContent() {
  const all = shrinkRectToContent(0, 0, state.tileW, state.tileH)
  if (!all) {
    setStatus('Nothing to select.')
    return
  }
  if (state.mode !== 'select-terrain') setMode('select-terrain')
  beginTransaction()
  captureTerrain(all.x, all.y, all.w, all.h)
  commitTransaction('Select all')
}

// tryAutoSwitchAt examines a left-click and, if it lands on a placed
// start position or feature, jumps into the matching editing mode with
// that item picked + drag-armed.  Returns true when it took the click.
// When the current mode already owns the clicked object type, we let
// that mode's native handler deal with the click (no redundant switch).
function tryAutoSwitchAt(e) {
  const canvas = $('#canvas')
  if (!canvas) return false
  const rect = canvas.getBoundingClientRect()
  const cpx = (e.clientX - rect.left) / rect.width * canvas.width
  const cpy = (e.clientY - rect.top) / rect.height * canvas.height

  // Start positions are drawn on top of features visually, so they
  // win ties (overlapping click).  Hidden layers don't accept clicks.
  const schema = activeSchema()
  if (schema && state.mode !== 'start-points' && state.showStartPositions) {
    const hit = findStartPositionAt(schema, cpx, cpy)
    if (hit >= 0) {
      setMode('start-points')
      state.selectedStartPos = hit
      const sp = schema.startPositions[hit]
      const { px, py } = gameToCanvas(sp.x, sp.z)
      startPosDragOffset = { dx: px - cpx, dy: py - cpy }
      startPosDragging = true
      beginTransaction()
      renderCanvas()
      setStatus(`Picked start position ${sp.number} — drag to reposition, Delete to remove.`)
      return true
    }
  }

  // Features are anchored at (ax, ay) in 16-px attr coords; hit-test by
  // the tile they sit on.  Skip when features are hidden — clicks fall
  // through to whatever's underneath.
  if (state.mode !== 'select-features' && state.showFeatures) {
    const { tx, ty } = pickCell(e)
    if (tx >= 0 && tx < state.tileW && ty >= 0 && ty < state.tileH) {
      const fhit = findFeatureAt(e)
      if (fhit >= 0) {
        setMode('select-features')
        state.selectedFeature = fhit
        featureDragging = true
        beginTransaction()
        const f = state.features[fhit]
        const cur = pickFeatureAttrCell(e, f)
        featureDragOffset = { ax: f.ax - cur.ax, ay: f.ay - cur.ay }
        state.featureJustMoved = -1
        renderCanvas()
        setStatus(`Picked ${f.name} — drag to reposition, Delete to remove.`)
        return true
      }
    }
  }

  return false
}

function shouldPan(e) {
  if (e.button === 1) return true
  if (e.button === 0 && spacePanHotkey) return true
  if (e.button !== 0) return false
  if (state.mode === 'view') return true
  if (state.mode === 'paint' && !state.selected && !state.placement) return true
  if (state.mode === 'select-features') {
    if (findFeatureAt(e) < 0 && state.selected?.type !== 'feature') return true
  }
  // Erase mode and Picker mode are explicit tools — never pan with a
  // plain left-click; users can still pan via Space-hold or middle-click.
  return false
}

function beginPan(e) {
  const wrap = $('#canvas-scroll')
  panState = {
    startX: e.clientX,
    startY: e.clientY,
    startScrollX: wrap.scrollLeft,
    startScrollY: wrap.scrollTop,
  }
  document.body.style.cursor = 'grabbing'
  e.preventDefault()
}

function updatePan(e) {
  if (!panState) return
  const wrap = $('#canvas-scroll')
  wrap.scrollLeft = panState.startScrollX - (e.clientX - panState.startX)
  wrap.scrollTop = panState.startScrollY - (e.clientY - panState.startY)
}

function endPan() {
  panState = null
  document.body.style.cursor = spacePanHotkey ? 'grab' : ''
  painting = false
  paintedDuringStroke = false
}

// placementAnchor returns the top-left tile coordinate where the section
// should land so that the cursor cell ends up at the centre of the
// section's footprint.  For a W×H section, the cursor at (cx, cy) maps
// to a top-left at (cx - floor(W/2), cy - floor(H/2)).
function placementAnchor(cursorTX, cursorTY, p) {
  const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, p.rotation)
  return { tx: cursorTX - Math.floor(fw / 2), ty: cursorTY - Math.floor(fh / 2) }
}

function updatePlacementHover(e) {
  const { tx: cx, ty: cy } = pickCell(e)
  const { tx, ty } = placementAnchor(cx, cy, state.placement)
  const moved = state.placement.tx !== tx || state.placement.ty !== ty
  const waking = !!state.placement.dormant
  if (moved) {
    state.placement.tx = tx
    state.placement.ty = ty
  }
  // Cursor entered the canvas → wake the preview so it starts
  // rendering under the cursor instead of (invisibly) at the
  // viewport centre we seeded it with.
  if (waking) state.placement.dormant = false
  // Auto-fit rotation while the cursor is dragging the preview around:
  // a new position can change which orientation is the only seam-clean
  // option.  Once Q/E sets userRotated, this becomes a no-op.
  if (moved) tryAutoRotatePlacement(state.placement)
  if (moved || waking) renderCanvas()
}

// placementMoveAnchor tracks an in-flight drag of an already-anchored
// placement preview.  Populated on mousedown inside the footprint and
// cleared on mouseup.
let placementMoveAnchor = null

// handlePaintModeClick implements the two-click placement flow.
//
//   Click 1 — anchors the cursor-following preview at the click cell.
//             Tiles beneath are *not* modified yet.
//   Click 2 inside the anchored footprint (no drag) — confirms.
//   Click 2 outside the anchored footprint — confirms in place and
//             re-engages cursor-follow so the next click drops another
//             copy without re-picking from the drawer.
//   Mousedown + drag inside footprint — slides the preview to a new
//             position.
function handlePaintModeClick(e) {
  const p = state.placement
  const { tx: cx, ty: cy } = pickCell(e)
  if (!p.anchored) {
    // First click — anchor at the click cell (centred via placementAnchor).
    const a = placementAnchor(cx, cy, p)
    p.tx = a.tx
    p.ty = a.ty
    p.anchored = true
    renderCanvas()
    setStatus('Section anchored — drag to reposition, Q / E to rotate, click again to confirm.')
    return
  }
  // Already anchored.  Mousedown inside the footprint kicks off a
  // drag-move; anywhere else commits and re-arms for the next stamp.
  const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, p.rotation)
  const insideFootprint = cx >= p.tx && cx < p.tx + fw && cy >= p.ty && cy < p.ty + fh
  if (insideFootprint) {
    placementMoveAnchor = {
      cursorTX: cx, cursorTY: cy,
      anchoredTX: p.tx, anchoredTY: p.ty,
      moved: false,
    }
    return
  }
  // Click outside the anchored footprint — commit, clear the drawer
  // selection, and switch to Select Area mode so the user is ready
  // to manipulate the just-placed section without re-mode-switching.
  commitAnchoredPlacement()
  state.selected = null
  hidePlacementHint()
  renderDrawer()
  setMode('select-terrain')
}

// commitAnchoredPlacement writes the current anchored placement to the
// map.  The drawer selection's rotation is updated so the next time we
// re-arm (multi-stamp) we keep the user's rotation choice.
function commitAnchoredPlacement() {
  const p = state.placement
  if (!p) return
  if (state.selected?.type === 'section') {
    state.selected.rotation = p.rotation
    state.selected.flipH = !!p.flipH
    state.selected.flipV = !!p.flipV
  }
  beginTransaction()
  stampSectionWithRotation(p.tx, p.ty, p.sectionPath, p.origW, p.origH, p.rotation, !!p.flipH, !!p.flipV)
  commitTransaction('Place section')
  state.placement = null
  hidePlacementHint()
}

// ── Rotation helpers ───────────────────────────────────────────────────────
//
// Pure rotation + flip primitives moved to
// ./ui/map-editor/rotation.js (rotatedFootprint, rotatedSourceCell,
// transformedSourceCell, drawTransformedTile).  The stamp pipeline
// below — stampSectionWithRotation + copyTileHeights — stays here
// because it mutates the live state.tiles / state.heights and
// triggers minimap + canvas redraws.

// stampSectionWithRotation writes per-cell {sectionPath, sx, sy, rotation,
// flipH, flipV} records into state.tiles and copies the section's height
// samples (with the same transform) into state.heights at 16-px
// resolution.  flipH/flipV are optional and default to false.
function stampSectionWithRotation(tx, ty, sectionPath, origW, origH, rotation, flipH = false, flipV = false) {
  const { w: fw, h: fh } = rotatedFootprint(origW, origH, rotation)
  const sec = state.sectionHeights.get(sectionPath) // may be undefined
  for (let dy = 0; dy < fh; dy++) {
    for (let dx = 0; dx < fw; dx++) {
      const mx = tx + dx
      const my = ty + dy
      if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
      const src = transformedSourceCell(dx, dy, origW, origH, rotation, flipH, flipV)
      state.tiles[my * state.tileW + mx] = { sectionPath, sx: src.sx, sy: src.sy, rotation, flipH, flipV }
      patchMinimapTile(mx, my)

      if (sec) copyTileHeights(sec, src.sx, src.sy, mx, my, rotation, origW, origH, flipH, flipV)
    }
  }
  paintedDuringStroke = true
  renderCanvas()
}

// Each tile cell maps to a 2×2 block in the 16-px attribute grid; copy
// the 4 height samples from the section into state.heights, applying the
// inverse rotation so a rotated section's elevations end up where the
// rotated tile graphic visually points.
function copyTileHeights(sec, ssx, ssy, mtx, mty, rotation, origW, _origH, flipH = false, flipV = false) {
  const secAttrW = origW * 2
  const mapAttrW = state.tileW * 2
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      // The flip mirrors the visible 2×2 attribute slots inside the tile
      // before we map back through the rotation — same composition as
      // drawTransformedTile so seams stay coherent.
      const fqx = flipH ? 1 - qx : qx
      const fqy = flipV ? 1 - qy : qy
      let sqx = fqx
      let sqy = fqy
      switch (rotation & 3) {
        case 1: sqx = fqy; sqy = 1 - fqx; break
        case 2: sqx = 1 - fqx; sqy = 1 - fqy; break
        case 3: sqx = 1 - fqy; sqy = fqx; break
      }
      const srcAX = ssx * 2 + sqx
      const srcAY = ssy * 2 + sqy
      const dstAX = mtx * 2 + qx
      const dstAY = mty * 2 + qy
      if (srcAY >= 0 && srcAX >= 0 && srcAY * secAttrW + srcAX < sec.heights.length) {
        state.heights[dstAY * mapAttrW + dstAX] = sec.heights[srcAY * secAttrW + srcAX]
      }
    }
  }
}

// ── Select Terrain mode ────────────────────────────────────────────────────

let terrainDragging = false
let terrainDragStart = null // { tx, ty } when starting a rectangle drag
let terrainMoveAnchor = null // { tx, ty, originalTx, originalTy } when moving clipboard

function onTerrainMouseDown(e) {
  const { tx, ty } = pickCell(e)
  if (state.terrainClipboard) {
    const c = state.terrainClipboard
    const insideClipboard = tx >= c.tx && tx < c.tx + c.w && ty >= c.ty && ty < c.ty + c.h
    if (insideClipboard) {
      // Begin dragging the floating clipboard.
      terrainMoveAnchor = { tx, ty, originalTx: c.tx, originalTy: c.ty }
      return
    }
    // Click outside drops the clipboard back onto the canvas — undoable
    // as a single "Drop terrain" step.
    beginTransaction()
    dropTerrainClipboard()
    commitTransaction('Drop terrain')
    return
  }
  // Direct click on a placed feature or start position takes precedence
  // over starting a rectangle selection — it switches to the matching
  // edit mode with that object picked.
  if (e.button === 0 && !spacePanHotkey && tryAutoSwitchAt(e)) return
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) return
  terrainDragging = true
  terrainDragStart = { tx, ty }
  state.rectSelection = { x: tx, y: ty, w: 1, h: 1 }
  renderCanvas()
}

function onTerrainMouseMove(e) {
  if (terrainMoveAnchor && state.terrainClipboard) {
    const { tx, ty } = pickCell(e)
    const dx = tx - terrainMoveAnchor.tx
    const dy = ty - terrainMoveAnchor.ty
    state.terrainClipboard.tx = terrainMoveAnchor.originalTx + dx
    state.terrainClipboard.ty = terrainMoveAnchor.originalTy + dy
    renderCanvas()
    return
  }
  if (!terrainDragging) return
  const { tx, ty } = pickCell(e)
  if (!state.rectSelection || !terrainDragStart) return
  state.rectSelection = {
    x: terrainDragStart.tx,
    y: terrainDragStart.ty,
    w: (tx - terrainDragStart.tx) + (tx >= terrainDragStart.tx ? 1 : -1),
    h: (ty - terrainDragStart.ty) + (ty >= terrainDragStart.ty ? 1 : -1),
  }
  renderCanvas()
}

function onTerrainMouseUp(_e) {
  if (terrainMoveAnchor) {
    // Releasing the mouse after a move commits the clipboard at its
    // current position and clears the selection — saves the user a
    // separate "click outside to drop" gesture.
    terrainMoveAnchor = null
    beginTransaction()
    dropTerrainClipboard()
    commitTransaction('Move terrain')
    return
  }
  if (!terrainDragging) return
  terrainDragging = false
  if (!state.rectSelection) return
  const r = normalizedRect(state.rectSelection)
  state.rectSelection = null
  if (r.w <= 0 || r.h <= 0) { renderCanvas(); return }
  // Tighten the captured rectangle to the minimum bounding box of any
  // tiles or features the user actually selected — so a sloppy drag
  // over mostly-empty space still produces a clean clipboard.
  const shrunk = shrinkRectToContent(r.x, r.y, r.w, r.h)
  if (!shrunk) {
    setStatus('No tiles or features in the selected area.')
    renderCanvas()
    return
  }
  beginTransaction()
  captureTerrain(shrunk.x, shrunk.y, shrunk.w, shrunk.h)
  commitTransaction('Capture terrain')
}

// Terrain clipboard (capture / rotate / drop / cancel) and system
// clipboard (Ctrl+C / Ctrl+V / Ctrl+X) + the region-clear helpers
// (clearRegion, clearAllFeatures, clearFeaturesInSelection) now
// live in ./ui/map-editor/clipboard.js — imported at the top of
// this file.  Call sites in mouse routing / ribbon / keyboard
// hand-off to those functions unchanged.

// ── Select Features mode ───────────────────────────────────────────────────

let featureDragging = false
let featureDragOffset = null

function onFeatureMouseDown(e) {
  // Start-position click in features mode jumps to start-points mode.
  if (e.button === 0 && !spacePanHotkey && tryAutoSwitchAt(e)) return
  // Hit-test against the actual cursor pixel — the previous tile-centre
  // shortcut missed 1×1 features whose anchor offset pushed the sprite
  // rect off the tile-centre point.
  const hit = findFeatureAt(e)
  if (hit >= 0) {
    // Treat a click on the just-moved selection as "I'm done with that
    // operation" and clear the selection instead of re-grabbing it.
    if (state.featureJustMoved === hit) {
      state.featureJustMoved = -1
      state.selectedFeature = -1
      renderCanvas()
      return
    }
    state.selectedFeature = hit
    featureDragging = true
    beginTransaction()
    const f = state.features[hit]
    const cur = pickFeatureAttrCell(e, f)
    featureDragOffset = { ax: f.ax - cur.ax, ay: f.ay - cur.ay }
    state.featureJustMoved = -1
    renderCanvas()
    return
  }
  // Empty space + a feature in the drawer → drop a copy here.  This is
  // how the user places multiple features without leaving the mode.
  if (state.selected?.type === 'feature') {
    const { ax, ay } = pickFeatureAttrCell(e, state.selected)
    beginTransaction()
    placeFeature(ax, ay)
    commitTransaction('Place feature')
    return
  }
  // Empty space + nothing armed → deselect any prior pick.
  state.selectedFeature = -1
  renderCanvas()
}

function onFeatureMouseMove(e) {
  if (!featureDragging || state.selectedFeature < 0) return
  const f = state.features[state.selectedFeature]
  const { ax, ay } = pickFeatureAttrCell(e, f)
  f.ax = clamp(ax + (featureDragOffset?.ax || 0), 0, state.tileW * 2 - 1)
  f.ay = clamp(ay + (featureDragOffset?.ay || 0), 0, state.tileH * 2 - 1)
  bumpContentVersion()
  // Remember that this selection was just moved — a subsequent click on
  // the same feature clears the selection (treats the click as "done").
  state.featureJustMoved = state.selectedFeature
  renderCanvas()
}

function onFeatureMouseUp(_e) {
  if (featureDragging) commitTransaction('Move feature')
  featureDragging = false
  featureDragOffset = null
}

// findFeatureAt hit-tests in canvas-pixel space against the feature's
// drawn footprint, accounting for the GAF hotspot offset so the
// hit-box matches the sprite as drawn (not bottom-centred).  We
// re-iterate in z-order (drawn last = on top) so the topmost feature
// wins overlaps.
// FEATURE_HIT_SEARCH_TILES lives in ./ui/map-editor/constants.js
// (how far from the click tile we scan for candidate features).

// findFeatureAt hit-tests the actual canvas-pixel cursor position
// against every feature's drawn rectangle.  The old version reduced
// the cursor to its tile centre, which missed clicks whose tile
// centre fell outside a 1×1 sprite — visible as features on
// subtile (1,1) being unclickable while subtile (1,0) worked because
// the anchor offset happened to leave the tile centre inside the rect.
// Accepts either a MouseEvent or pre-resolved canvas pixel coords.
function findFeatureAt(e) {
  let cpx, cpy
  if (e && typeof e.clientX === 'number') {
    const canvas = $('#canvas')
    const rect = canvas.getBoundingClientRect()
    cpx = (e.clientX - rect.left) / rect.width * canvas.width
    cpy = (e.clientY - rect.top) / rect.height * canvas.height
  } else if (e && typeof e.cpx === 'number') {
    cpx = e.cpx; cpy = e.cpy
  } else {
    return -1
  }
  const tx = Math.floor(cpx / TILE_PX)
  const ty = Math.floor(cpy / TILE_PX)
  const candidates = featuresNear(tx, ty, FEATURE_HIT_SEARCH_TILES)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const idx = candidates[i]
    const f = state.features[idx]
    const { px, py } = featureAnchorWorld(f)
    const r = featureRenderRect(f, px, py)
    if (cpx >= r.x && cpx <= r.x + r.w && cpy >= r.y && cpy <= r.y + r.h) return idx
  }
  return -1
}

// featureRenderRect returns the on-canvas rectangle covered by a
// feature sprite drawn at world position (px, py).  When the sprite
// image is loaded and we know the GAF origin, we use the actual frame
// geometry; otherwise we fall back to a bottom-centred footprint box
// so the click target is still roughly right.
function featureRenderRect(f, px, py) {
  const img = f.previewUrl ? state.featureImages.get((f.name || '').toLowerCase()) : null
  if (img && img.complete && img.naturalWidth > 0) {
    const { dx, dy } = featureAnchorOffset(f, img)
    return { x: px - dx, y: py - dy, w: img.naturalWidth, h: img.naturalHeight }
  }
  const fw = (f.footprintX || 1) * (TILE_PX / 2)
  const fh = (f.footprintZ || 1) * (TILE_PX / 2)
  return { x: px - fw / 2, y: py - fh, w: fw, h: fh }
}

// ── Start positions ────────────────────────────────────────────────────────
// Game pixel coords use 32 game-px per tile.  We convert between game
// pixels and canvas pixels via the TILE_PX scale.
// START_POS_RADIUS lives in ./ui/map-editor/constants.js.

function gameToCanvas(gx, gz) {
  return { px: gx * TILE_PX / 32, py: gz * TILE_PX / 32 }
}
function canvasToGame(px, py) {
  return { gx: Math.round(px * 32 / TILE_PX), gz: Math.round(py * 32 / TILE_PX) }
}

function activeSchema() {
  if (!state.ota || !state.ota.schemas[state.activeSchema]) return null
  return state.ota.schemas[state.activeSchema]
}

function findStartPositionAt(schema, px, py) {
  if (!schema) return -1
  for (let i = schema.startPositions.length - 1; i >= 0; i--) {
    const sp = schema.startPositions[i]
    const { px: spx, py: spy } = gameToCanvas(sp.x, sp.z)
    const dx = spx - px
    const dy = spy - py
    if (dx * dx + dy * dy <= START_POS_RADIUS * START_POS_RADIUS) return i
  }
  return -1
}

let startPosDragging = false
let startPosDragOffset = null // { dx, dy } in canvas px

function onStartPosMouseDown(e) {
  // Feature click in start-points mode jumps to features mode.
  if (e.button === 0 && !spacePanHotkey && tryAutoSwitchAt(e)) return
  const schema = activeSchema()
  if (!schema) return
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = (e.clientX - rect.left) / rect.width * canvas.width
  const cy = (e.clientY - rect.top) / rect.height * canvas.height
  const hit = findStartPositionAt(schema, cx, cy)
  if (hit >= 0) {
    // Re-clicking the just-moved start position clears the selection
    // (treat as confirming the move is done).
    if (state.startPosJustMoved === hit) {
      state.startPosJustMoved = -1
      state.selectedStartPos = -1
      renderCanvas()
      return
    }
    state.selectedStartPos = hit
    const sp = schema.startPositions[hit]
    const { px, py } = gameToCanvas(sp.x, sp.z)
    startPosDragOffset = { dx: px - cx, dy: py - cy }
    startPosDragging = true
    state.startPosJustMoved = -1
    beginTransaction()
    renderCanvas()
    return
  }
  // Empty space — place the next available start position.  Numbering
  // is dense and 1-based: the new marker takes (existing count + 1),
  // capped at MAX_START_POSITIONS (the game-wide multiplayer ceiling).
  // Deleting a marker compacts the list so numbers stay contiguous —
  // see handleDeleteKey.
  const cap = MAX_START_POSITIONS
  if (schema.startPositions.length >= cap) {
    setStatus(`This schema is full — all ${cap} start position${cap === 1 ? '' : 's'} are placed.  Drag a marker or Delete one to free a slot.`)
    return
  }
  const nextNum = schema.startPositions.length + 1
  const { gx, gz } = canvasToGame(cx, cy)
  beginTransaction()
  schema.startPositions.push({ number: nextNum, x: gx, z: gz })
  state.selectedStartPos = schema.startPositions.length - 1
  commitTransaction(`Place start position ${nextNum}`)
  renderCanvas()
}

function onStartPosMouseMove(e) {
  if (!startPosDragging || state.selectedStartPos < 0) return
  const schema = activeSchema()
  if (!schema) return
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = (e.clientX - rect.left) / rect.width * canvas.width
  const cy = (e.clientY - rect.top) / rect.height * canvas.height
  const targetPx = cx + (startPosDragOffset?.dx || 0)
  const targetPy = cy + (startPosDragOffset?.dy || 0)
  const { gx, gz } = canvasToGame(targetPx, targetPy)
  const sp = schema.startPositions[state.selectedStartPos]
  if (sp) {
    sp.x = clamp(gx, 0, state.tileW * 32)
    sp.z = clamp(gz, 0, state.tileH * 32)
    state.startPosJustMoved = state.selectedStartPos
    renderCanvas()
  }
}

function onStartPosMouseUp(_e) {
  if (startPosDragging) {
    commitTransaction('Move start position')
    startPosDragging = false
    startPosDragOffset = null
  }
}

// drawStartPositions renders the active schema's start positions as
// labelled robot markers.  Other schemas' positions are dimmed so the
// user can see them as reference but the active set is unambiguous.
// drawEraseBrush renders an N×N outline + shading at the cursor while
// in Erase mode, so the user can see what the next click/drag will
// remove.  Drawn after the other overlays so it's the topmost hint.
function drawEraseBrush(ctx) {
  if (state.mode !== 'erase' || !state.eraseCursor) return
  const { tx, ty } = state.eraseCursor
  const size = Math.max(1, state.eraseSize || 1)
  const off = Math.floor(size / 2)
  const x0 = (tx - off) * TILE_PX
  const y0 = (ty - off) * TILE_PX
  const w = size * TILE_PX
  const h = size * TILE_PX
  ctx.save()
  ctx.fillStyle = 'rgba(248, 81, 73, 0.20)'
  ctx.fillRect(x0, y0, w, h)
  ctx.strokeStyle = 'rgba(248, 81, 73, 0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2)
  ctx.setLineDash([])
  ctx.restore()
}

// drawHeightmapBrush renders a circular outline at the cursor while in
// Heightmap mode, sized to state.hmRadius (in attribute cells).  Drawn
// in the canvas's tile-pixel coordinate space, so the circle stays the
// same size regardless of zoom.
function drawHeightmapBrush(ctx) {
  if (state.mode !== 'heightmap' || !state.hmCursor) return
  const { ax, ay } = state.hmCursor
  const cellPx = TILE_PX / 2 // one attribute cell = 16px in a 32px tile
  const cx = (ax + 0.5) * cellPx
  const cy = (ay + 0.5) * cellPx
  const r = Math.max(1, state.hmRadius | 0) * cellPx
  const colour = state.hmTool === 'lower' ? 'rgba(56, 132, 255, ' : 'rgba(82, 196, 26, '
  ctx.save()
  ctx.fillStyle = colour + '0.10)'
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = colour + '0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function drawStartPositions(ctx) {
  if (!state.ota) return
  // Hidden via View toggle, and the user isn't in start-points mode
  // (mode forces the layer on so they can see what they're editing).
  if (!state.showStartPositions && state.mode !== 'start-points') return
  const fontFamily = getComputedStyle(document.body).fontFamily
  // Inverse zoom so the marker keeps a stable CSS size as the user
  // zooms out — clamp upward to avoid mountain-sized badges at 1%
  // zoom while still rescuing them from the 16-px-into-the-void
  // disappear they used to do.  At zoom >= 1 we render at the
  // original sizes.
  const z = state.zoom || 1
  const scale = Math.min(8, Math.max(1, 1 / z))
  const ringR = 16 * scale
  const dotR = 8 * scale
  const iconPx = Math.round(18 * scale)
  const badgePx = Math.round(11 * scale)
  const badgeOffsetX = 12 * scale
  const badgeOffsetY = 6 * scale
  const badgeH = 15 * scale

  // Faded markers for non-active schemas (only render if there's more
  // than one schema, otherwise it's noise).
  if (state.ota.schemas.length > 1) {
    ctx.save()
    ctx.globalAlpha = 0.18
    for (let si = 0; si < state.ota.schemas.length; si++) {
      if (si === state.activeSchema) continue
      const s = state.ota.schemas[si]
      for (const sp of s.startPositions) {
        const { px, py } = gameToCanvas(sp.x, sp.z)
        ctx.fillStyle = '#8b5cf6'
        ctx.beginPath()
        ctx.arc(px, py, dotR, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  const schema = activeSchema()
  if (!schema) return
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < schema.startPositions.length; i++) {
    const sp = schema.startPositions[i]
    const { px, py } = gameToCanvas(sp.x, sp.z)
    // Outer ring — accent when selected, gold otherwise.
    const selected = state.mode === 'start-points' && state.selectedStartPos === i
    ctx.fillStyle = selected ? 'rgba(139, 92, 246, 0.92)' : 'rgba(255, 200, 0, 0.92)'
    ctx.strokeStyle = selected ? '#fff' : 'rgba(0, 0, 0, 0.6)'
    ctx.lineWidth = 2 * scale
    ctx.beginPath()
    ctx.arc(px, py, ringR, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Robot glyph.
    ctx.fillStyle = '#000'
    ctx.font = `${iconPx}px ${fontFamily}`
    ctx.fillText('🤖', px, py + scale)
    // Number badge — small pill below/right of the marker.
    const label = String(sp.number)
    ctx.font = `bold ${badgePx}px ${fontFamily}`
    const w = ctx.measureText(label).width + 8 * scale
    const bx = px + badgeOffsetX
    const by = py + badgeOffsetY
    ctx.fillStyle = 'rgba(20, 24, 32, 0.95)'
    ctx.strokeStyle = selected ? '#fff' : 'rgba(139, 92, 246, 0.9)'
    ctx.lineWidth = 1.5 * scale
    roundRect(ctx, bx, by, w, badgeH, 4 * scale)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fillText(label, bx + w / 2, by + badgeH / 2)
  }
  ctx.restore()
}

// ── Picker mode ────────────────────────────────────────────────────────────
// Click toggles single-select on a feature; Shift+click toggles in/out of a
// multi-selection; click+drag in empty space sweeps out a rectangle and
// selects every feature inside it.  Delete (handled elsewhere) removes
// every selected feature in one undo step.

let pickerDragStart = null // { tx, ty, additive } when sweeping a rect

function onPickerMouseDown(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) return
  const hit = findFeatureAt(e)
  if (hit >= 0) {
    if (e.shiftKey) {
      // Toggle this feature in the selection set.
      if (state.selectedFeatures.has(hit)) state.selectedFeatures.delete(hit)
      else state.selectedFeatures.add(hit)
    } else {
      state.selectedFeatures.clear()
      state.selectedFeatures.add(hit)
    }
    renderCanvas()
    return
  }
  // Empty cell — start a rectangle sweep.  Shift makes it additive so
  // the user can build up the selection across multiple sweeps.
  pickerDragStart = { tx, ty, additive: e.shiftKey }
  if (!e.shiftKey) state.selectedFeatures.clear()
  state.pickerRect = { x: tx, y: ty, w: 1, h: 1 }
  renderCanvas()
}

function onPickerMouseMove(e) {
  if (!pickerDragStart) return
  const { tx, ty } = pickCell(e)
  state.pickerRect = {
    x: pickerDragStart.tx,
    y: pickerDragStart.ty,
    w: (tx - pickerDragStart.tx) + (tx >= pickerDragStart.tx ? 1 : -1),
    h: (ty - pickerDragStart.ty) + (ty >= pickerDragStart.ty ? 1 : -1),
  }
  renderCanvas()
}

function onPickerMouseUp(_e) {
  if (!pickerDragStart || !state.pickerRect) {
    pickerDragStart = null
    return
  }
  const r = normalizedRect(state.pickerRect)
  state.pickerRect = null
  const additive = pickerDragStart.additive
  pickerDragStart = null
  // Empty rect (just a click that started but didn't move) — nothing to do.
  if (r.w <= 0 || r.h <= 0) { renderCanvas(); return }
  if (!additive) state.selectedFeatures.clear()
  // Features are anchored at (ax, ay) in attribute coords.  Test against
  // the rectangle in attribute space (×2).
  const minAX = r.x * 2, maxAX = (r.x + r.w) * 2
  const minAY = r.y * 2, maxAY = (r.y + r.h) * 2
  for (let i = 0; i < state.features.length; i++) {
    const f = state.features[i]
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      state.selectedFeatures.add(i)
    }
  }
  renderCanvas()
  if (state.selectedFeatures.size > 0) {
    setStatus(`${state.selectedFeatures.size} feature${state.selectedFeatures.size === 1 ? '' : 's'} selected — Delete to remove, Shift+drag to add more.`)
  }
}

// ── Voids mode ──────────────────────────────────────────────────────────
// Painting impassable / no-build cells.  The first cell clicked sets the
// brush state (toggle of whatever was there); the rest of the drag
// applies that same target state to every attribute cell inside the
// rectangle spanned by the cursor.  Mouseup commits as a single undo.

// voidsDragState records the toggle target chosen on mousedown so the
// whole drag uses the same paint vs. erase mode (matches the previous
// rectangle-paint behaviour).
let voidsDragState = null // { target } while dragging

function onVoidsMouseDown(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  if (ax < 0 || ay < 0 || ax >= state.tileW * 2 || ay >= state.tileH * 2) return
  const aw = state.tileW * 2
  const prev = state.voids[ay * aw + ax] | 0
  beginTransaction()
  voidsDragState = { target: prev ? 0 : 1 }
  paintVoidBrush(ax, ay, voidsDragState.target)
  renderCanvas()
}

function onVoidsMouseMove(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  // Track cursor for the brush outline overlay even when not painting.
  if (!state.voidsCursor || state.voidsCursor.ax !== ax || state.voidsCursor.ay !== ay) {
    state.voidsCursor = { ax, ay }
    renderCanvas()
  }
  if (!voidsDragState) return
  paintVoidBrush(ax, ay, voidsDragState.target)
  renderCanvas()
}

function onVoidsMouseUp(_e) {
  if (!voidsDragState) return
  voidsDragState = null
  commitTransaction('Paint voids')
  invalidateMinimapBase()
  renderCanvas()
}

// paintVoidBrush stamps a size×size block centred on (ax, ay) with the
// given target value (1=void, 0=passable).  Centring matches the
// erase brush so a "1×1" stamp is exactly one cell under the cursor
// and even sizes lean toward the top-left of the cursor cell.
function paintVoidBrush(ax, ay, target) {
  const size = Math.max(1, state.voidsBrushSize || 1)
  const off = Math.floor(size / 2)
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const x0 = ax - off
  const y0 = ay - off
  for (let dy = 0; dy < size; dy++) {
    const cy = y0 + dy
    if (cy < 0 || cy >= ah) continue
    for (let dx = 0; dx < size; dx++) {
      const cx = x0 + dx
      if (cx < 0 || cx >= aw) continue
      state.voids[cy * aw + cx] = target
    }
  }
}

// pickAttrCellForVoid converts a MouseEvent into the attribute cell
// directly under the cursor, ignoring the feature-anchor / Height/2
// adjustment pickFeatureAttrCell applies — voids are flat-grid edits.
function pickAttrCellForVoid(e) {
  const canvas = $('#canvas')
  const rect = canvas.getBoundingClientRect()
  const ax = Math.floor((e.clientX - rect.left) / rect.width * state.tileW * 2)
  const ay = Math.floor((e.clientY - rect.top) / rect.height * state.tileH * 2)
  return { ax, ay }
}

// onFillMouseDown floods the connected region of tiles matching the
// tile under the cursor with the active section's (0,0) source.  4-way
// connectivity; bounded by the map.
function onFillMouseDown(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || ty < 0 || tx >= state.tileW || ty >= state.tileH) return
  const sel = state.selected
  if (!sel || sel.type !== 'section') {
    setStatus('Fill: pick a section from the drawer first.')
    return
  }
  const target = state.tiles[ty * state.tileW + tx]
  const targetKey = target ? `${target.sectionPath}|${target.sx}|${target.sy}` : 'null'
  // The section's (0,0) cell after rotation/flip gives the replacement tile.
  const src = transformedSourceCell(0, 0, sel.tileW, sel.tileH, sel.rotation || 0, !!sel.flipH, !!sel.flipV)
  const replacement = {
    sectionPath: sel.path,
    sx: src.sx, sy: src.sy,
    rotation: sel.rotation || 0,
    flipH: !!sel.flipH,
    flipV: !!sel.flipV,
  }
  const replacementKey = `${replacement.sectionPath}|${replacement.sx}|${replacement.sy}`
  if (replacementKey === targetKey) {
    setStatus('Fill: source and target are identical — nothing to do.')
    return
  }
  beginTransaction()
  const W = state.tileW
  const H = state.tileH
  let filled = 0
  // Shift+click = global replace.  Walks every cell instead of doing a
  // connected flood — handy when the user wants "swap palette A for B
  // everywhere" without manually filling each island.
  if (e.shiftKey) {
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const cell = state.tiles[cy * W + cx]
        const key = cell ? `${cell.sectionPath}|${cell.sx}|${cell.sy}` : 'null'
        if (key !== targetKey) continue
        state.tiles[cy * W + cx] = { ...replacement }
        patchMinimapTile(cx, cy)
        filled++
      }
    }
    commitTransaction(`Replace ${filled} tile${filled === 1 ? '' : 's'}`)
    renderCanvas()
    setStatus(`Replaced ${filled} tile${filled === 1 ? '' : 's'} globally with ${sel.name}.`)
    return
  }
  // Iterative scanline-ish flood — explicit stack to avoid blowing the
  // call frame on big maps.  Tracks visited cells via a Uint8Array.
  const visited = new Uint8Array(W * H)
  const stack = [[tx, ty]]
  visited[ty * W + tx] = 1
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()
    const cell = state.tiles[cy * W + cx]
    const key = cell ? `${cell.sectionPath}|${cell.sx}|${cell.sy}` : 'null'
    if (key !== targetKey) continue
    state.tiles[cy * W + cx] = { ...replacement }
    patchMinimapTile(cx, cy)
    filled++
    const neighbours = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      if (visited[ny * W + nx]) continue
      visited[ny * W + nx] = 1
      stack.push([nx, ny])
    }
  }
  commitTransaction(`Fill ${filled} tile${filled === 1 ? '' : 's'}`)
  renderCanvas()
  setStatus(`Flood-filled ${filled} tile${filled === 1 ? '' : 's'} with ${sel.name}.  Shift-click to replace globally.`)
}

// ── Ruler mode ─────────────────────────────────────────────────────────
//
// Click once to drop the start point, then move the cursor — the end
// point follows.  A second click locks the measurement; a third click
// starts a new one.  Esc clears.  Distances are reported in attr cells
// (16-px resolution, matching the heightmap grid) AND tiles AND map
// pixels, plus the min / max / delta heightmap value sampled along the
// line so the user can sanity-check cliffs and start-position fairness.

function onRulerMouseDown(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  const r = state.ruler
  if (!r || r.locked) {
    state.ruler = { a: { ax, ay }, b: { ax, ay }, locked: false }
  } else {
    state.ruler = { a: r.a, b: { ax, ay }, locked: true }
  }
  renderCanvas()
}

function onRulerMouseMove(e) {
  const r = state.ruler
  if (!r || r.locked) return
  const { ax, ay } = pickAttrCellForVoid(e)
  if (r.b.ax === ax && r.b.ay === ay) return
  r.b = { ax, ay }
  renderCanvas()
}

// rulerStats summarises the active ruler as { dPx, dTiles, dAttr,
// hMin, hMax, hDelta } — or null when there's nothing to measure.
// Heightmap samples walk the line in attribute-cell increments so
// every cell the line crosses contributes to the min / max / delta.
function rulerStats() {
  const r = state.ruler
  if (!r) return null
  const { a, b } = r
  const aw = state.tileW * 2, ah = state.tileH * 2
  const ainA = a.ax >= 0 && a.ax < aw && a.ay >= 0 && a.ay < ah
  const binA = b.ax >= 0 && b.ax < aw && b.ay >= 0 && b.ay < ah
  // Distance in attr cells (16-px); tiles is half of that; pixels x16.
  const dAttrX = b.ax - a.ax, dAttrY = b.ay - a.ay
  const dAttr = Math.hypot(dAttrX, dAttrY)
  const dTiles = dAttr / 2
  const dPx = dAttr * 16
  // Walk the line sampling heights.  Step in 1-attr increments so
  // we hit every cell along the path.
  let hMin = Infinity, hMax = -Infinity
  const steps = Math.max(1, Math.ceil(dAttr))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const sx = Math.round(a.ax + dAttrX * t)
    const sy = Math.round(a.ay + dAttrY * t)
    if (sx < 0 || sx >= aw || sy < 0 || sy >= ah) continue
    const h = state.heights[sy * aw + sx] | 0
    if (h < hMin) hMin = h
    if (h > hMax) hMax = h
  }
  if (!isFinite(hMin)) { hMin = 0; hMax = 0 }
  return { dPx, dTiles, dAttr, hMin, hMax, hDelta: hMax - hMin, ainA, binA }
}

function drawRulerOverlay(ctx) {
  const r = state.ruler
  if (!r) return
  const stats = rulerStats()
  if (!stats) return
  // Convert attr cells (16-px) to map pixels.  Centre of the cell so
  // the line endpoints sit nicely inside the highlighted square.
  const ax = r.a.ax * 16 + 8
  const ay = r.a.ay * 16 + 8
  const bx = r.b.ax * 16 + 8
  const by = r.b.ay * 16 + 8

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // Soft outer glow then bright inner line.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 5
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
  ctx.strokeStyle = r.locked ? 'rgba(255, 220, 80, 0.95)' : 'rgba(255, 255, 255, 0.95)'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()

  // Endpoint markers.
  const drawEnd = (x, y) => {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = r.locked ? 'rgb(255, 220, 80)' : '#fff'
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill()
  }
  drawEnd(ax, ay)
  drawEnd(bx, by)

  // Floating label near the midpoint with the measurement.
  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  const lines = [
    `${stats.dTiles.toFixed(2)} tiles  ·  ${stats.dAttr.toFixed(1)} attr  ·  ${Math.round(stats.dPx)} px`,
    `Δh ${stats.hDelta}  (${stats.hMin}–${stats.hMax})`,
  ]
  ctx.font = '600 12px var(--mono, monospace)'
  // Measure width for the bg rect.
  let w = 0
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width)
  const padX = 8, padY = 6, lineH = 14
  const boxW = w + padX * 2
  const boxH = lines.length * lineH + padY * 2
  // Offset the label so it doesn't sit on top of the line.
  const off = 16
  let bxL = mx + off
  let byL = my + off
  // Keep inside the canvas if possible.
  const mapW = state.tileW * 32, mapH = state.tileH * 32
  if (bxL + boxW > mapW) bxL = mx - off - boxW
  if (byL + boxH > mapH) byL = my - off - boxH
  if (bxL < 0) bxL = 0
  if (byL < 0) byL = 0
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.beginPath()
  ctx.roundRect ? ctx.roundRect(bxL, byL, boxW, boxH, 4) : ctx.rect(bxL, byL, boxW, boxH)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bxL + padX, byL + padY + i * lineH)
  }
  ctx.restore()
}

// hmHoldTimer keeps the brush firing while the user holds the mouse
// button still — raise / lower / smooth all need continuous application
// to sculpt large changes without the user having to wiggle the cursor.
// HM_HOLD_INTERVAL_MS (60 ms tick) lives in
// ./ui/map-editor/constants.js.
let hmHoldTimer = null

function onHeightmapMouseDown(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  beginTransaction()
  // Level samples the cell first clicked so the rest of the stroke
  // flattens to that height.
  const aw = state.tileW * 2
  if (state.hmTool === 'level' && ax >= 0 && ay >= 0 && ax < aw && ay < state.tileH * 2) {
    state.hmLevelHeight = state.heights[ay * aw + ax] | 0
  }
  paintHeightAt(ax, ay)
  paintedDuringStroke = true
  renderCanvas()
  // Auto-repeat: keep applying the brush at the most-recent cursor
  // cell until the user releases the button.  Smooth + level are
  // idempotent at the same cell so this is safe to do.
  if (hmHoldTimer) clearInterval(hmHoldTimer)
  hmHoldTimer = setInterval(() => {
    if (!painting || !state.hmCursor) return
    paintHeightAt(state.hmCursor.ax, state.hmCursor.ay)
    paintedDuringStroke = true
    renderCanvas()
  }, HM_HOLD_INTERVAL_MS)
}

function onHeightmapMouseMove(e) {
  const { ax, ay } = pickAttrCellForVoid(e)
  if (!state.hmCursor || state.hmCursor.ax !== ax || state.hmCursor.ay !== ay) {
    state.hmCursor = { ax, ay }
    renderCanvas()
  }
  if (painting) {
    paintHeightAt(ax, ay)
    paintedDuringStroke = true
  }
}

function onHeightmapMouseUp(_e) {
  if (hmHoldTimer) { clearInterval(hmHoldTimer); hmHoldTimer = null }
  if (painting && paintedDuringStroke) commitTransaction(`Heightmap ${state.hmTool}`)
  else if (painting) abortTransaction()
  invalidateMinimapBase()
  renderCanvas()
}

function paintHeightAt(ax, ay) {
  paintHeightAtSingle(ax, ay)
  for (const m of symmetryMatesAttr(ax, ay)) paintHeightAtSingle(m.ax, m.ay)
}

// paintHeightAtSingle applies the active heightmap brush at attribute-
// cell (ax, ay).  Falloff is a quadratic so the brush feels soft at the
// edge without per-cell trig.  Smooth runs a 3×3 box blur weighted by
// the brush mask so light passes are clean and heavy passes settle.
function paintHeightAtSingle(ax, ay) {
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const r = Math.max(1, state.hmRadius | 0)
  const r2 = r * r
  const tool = state.hmTool
  const strength = Math.max(1, state.hmStrength | 0)
  const target = (tool === 'level') ? clamp(state.hmLevelHeight | 0, 0, 255) : 0
  for (let dy = -r; dy <= r; dy++) {
    const yy = ay + dy
    if (yy < 0 || yy >= ah) continue
    for (let dx = -r; dx <= r; dx++) {
      const xx = ax + dx
      if (xx < 0 || xx >= aw) continue
      const d2 = dx * dx + dy * dy
      if (d2 > r2) continue
      const mask = 1 - d2 / r2 // 0 at the edge, 1 at the centre
      const idx = yy * aw + xx
      const cur = state.heights[idx] | 0
      let next = cur
      if (tool === 'raise') {
        next = cur + Math.round(strength * mask)
      } else if (tool === 'lower') {
        next = cur - Math.round(strength * mask)
      } else if (tool === 'level') {
        // Mix the cell toward the captured height.
        const t = mask * 0.5
        next = Math.round(cur * (1 - t) + target * t)
      } else if (tool === 'smooth') {
        // 3×3 mean of the *current* neighbourhood, mixed in by the mask.
        let sum = 0; let n = 0
        for (let ny = -1; ny <= 1; ny++) {
          const ny2 = yy + ny
          if (ny2 < 0 || ny2 >= ah) continue
          for (let nx = -1; nx <= 1; nx++) {
            const nx2 = xx + nx
            if (nx2 < 0 || nx2 >= aw) continue
            sum += state.heights[ny2 * aw + nx2] | 0
            n++
          }
        }
        const avg = n > 0 ? sum / n : cur
        const t = mask * Math.min(1, strength / 12)
        next = Math.round(cur * (1 - t) + avg * t)
      }
      state.heights[idx] = clamp(next, 0, 255)
    }
  }
}

function handlePaint(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) return

  // Shift held in Paint mode still acts as a quick-erase modifier.
  if (e.shiftKey) {
    eraseAt(tx, ty)
    paintedDuringStroke = true
    return
  }
  if (!state.selected) return
  if (state.selected.type === 'section' && state.mode === 'paint') {
    stampSection(tx, ty)
    paintedDuringStroke = true
  } else if (state.selected.type === 'feature') {
    const { ax, ay } = pickFeatureAttrCell(e, state.selected)
    placeFeature(ax, ay)
    paintedDuringStroke = true
  }
}

// clearStampSelection deselects the active section/feature so subsequent
// clicks no longer stamp.  We keep the erase tool intact since it's a
// distinct mode the user toggles explicitly.
function clearStampSelection() {
  if (!state.selected) return
  state.selected = null
  hidePlacementHint()
  renderDrawer()
  setStatus('Stamp placed.  Pick another section/feature on the left to keep building.')
}

function eraseAt(tx, ty) {
  eraseAtSingle(tx, ty)
  for (const m of symmetryMatesTile(tx, ty, 1, 1)) eraseAtSingle(m.tx, m.ty)
}

function eraseAtSingle(tx, ty) {
  const size = Math.max(1, state.eraseSize || 1)
  const scope = state.eraseScope || 'all'
  // Brush is centred (or near-centred for even sizes) on the cursor tile.
  const off = Math.floor(size / 2)
  const x0 = tx - off
  const y0 = ty - off
  const x1 = x0 + size
  const y1 = y0 + size
  let dirty = false
  if (scope !== 'features') {
    for (let ty2 = y0; ty2 < y1; ty2++) {
      if (ty2 < 0 || ty2 >= state.tileH) continue
      for (let tx2 = x0; tx2 < x1; tx2++) {
        if (tx2 < 0 || tx2 >= state.tileW) continue
        const i = ty2 * state.tileW + tx2
        if (state.tiles[i]) {
          state.tiles[i] = null
          patchMinimapTile(tx2, ty2)
          dirty = true
        }
      }
    }
  }
  if (scope !== 'terrain') {
    // Drop features whose anchor falls inside the brush.
    const minAX = x0 * 2, maxAX = x1 * 2
    const minAY = y0 * 2, maxAY = y1 * 2
    const before = state.features.length
    state.features = state.features.filter((f) => {
      return !(f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY)
    })
    if (state.features.length !== before) {
      bumpContentVersion()
      dirty = true
    }
  }
  if (dirty) renderCanvas()
}

function stampSection(tx, ty) {
  const sel = state.selected
  const rotation = sel.rotation || 0
  const { w: fw, h: fh } = rotatedFootprint(sel.tileW, sel.tileH, rotation)
  stampSectionWithRotation(tx, ty, sel.path, sel.tileW, sel.tileH, rotation, !!sel.flipH, !!sel.flipV)
  for (const m of symmetryMatesTile(tx, ty, fw, fh)) {
    stampSectionWithRotation(m.tx, m.ty, sel.path, sel.tileW, sel.tileH, rotation,
      !!sel.flipH !== m.fx, !!sel.flipV !== m.fy)
  }
}

function placeFeature(ax, ay) {
  const sel = state.selected
  // Features sit on the 16-px attribute grid.  Earlier the placement
  // snapped to tile centres (`tx*2+1`) which made the cursor feel coarse
  // and disagreed with what TA stores in the TNT.  Now the caller passes
  // the actual attribute cell under the cursor.
  const points = [{ ax, ay }, ...symmetryMatesAttr(ax, ay)]
  for (const p of points) {
    state.features = state.features.filter((f) => !(f.ax === p.ax && f.ay === p.ay))
    state.features.push({
      name: sel.name,
      ax: p.ax,
      ay: p.ay,
      footprintX: sel.footprintX || 1,
      footprintZ: sel.footprintZ || 1,
      previewUrl: sel.previewUrl || null,
      originX: sel.originX || 0,
      originY: sel.originY || 0,
    })
  }
  bumpContentVersion()
  renderCanvas()
}

function renderCanvas() {
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  const wantW = state.tileW * TILE_PX
  const wantH = state.tileH * TILE_PX
  // Reassigning canvas.width/height reallocates the pixel buffer —
  // for a 128-tile map that's a 64 MB texture, and a 256-tile map
  // is 256 MB.  Doing it every render (including on every scroll
  // tick) is what made the editor feel "insanely slow".  Only pay
  // that cost when the dimensions actually change.
  const dimsChanged = canvas.width !== wantW || canvas.height !== wantH
  if (dimsChanged) {
    canvas.width = wantW
    canvas.height = wantH
    if (glCanvas) {
      glCanvas.width = wantW
      glCanvas.height = wantH
    }
  }
  // Sync the CSS size on BOTH canvases regardless of whether the 2D
  // canvas's value happened to match — the two layers must always agree
  // on dimensions or features render outside the visible canvas.  This
  // also catches the map-switch case where the previous map's GL canvas
  // style was left stale because the 2D canvas's style happened to
  // already be the new target after a dimsChanged reset.
  const wantStyleW = wantW * state.zoom + 'px'
  const wantStyleH = wantH * state.zoom + 'px'
  if (canvas.style.width !== wantStyleW) canvas.style.width = wantStyleW
  if (canvas.style.height !== wantStyleH) canvas.style.height = wantStyleH
  if (glCanvas) {
    if (glCanvas.style.width !== wantStyleW) glCanvas.style.width = wantStyleW
    if (glCanvas.style.height !== wantStyleH) glCanvas.style.height = wantStyleH
  }
  // .canvas-stack is the normal-flow scroll content; we pad it with
  // half a viewport on every side so the user can pan the map past
  // any edge until that edge sits at the centre of the viewport.
  applyOverscrollPadding()
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  // 2D overlay layer must be transparent everywhere we don't paint
  // an overlay, so the WebGL tile+feature layer shows through.  Clear
  // the visible viewport instead of fill-rect-with-void-colour — the
  // void is now drawn by the GL layer's clear().
  const vp = visiblePixelBounds()
  if (dimsChanged) {
    ctx.clearRect(0, 0, wantW, wantH)
  } else {
    ctx.clearRect(vp.minX, vp.minY, vp.maxX - vp.minX, vp.maxY - vp.minY)
  }

  // Tiles + features render via WebGL.  Heightmap view stays on 2D
  // (it's a one-off greyscale fill, not a per-tile drawImage hot
  // path).  When the GL context isn't available (no WebGL support),
  // fall back to the 2D path so the editor still works.  Note that
  // the GL renderer iterates tile *cells* — it needs visibleTileBounds,
  // not the pixel bounds we use for the 2D clearRect.
  const glReady = ensureGLRenderer()
  const tb = visibleTileBounds()
  if (state.viewMode === 'heightmap') {
    if (glReady) glClearViewport()
    drawHeightmap(ctx)
  } else {
    if (glReady) {
      glRenderTilesAndFeatures(tb)
    } else {
      ctx.fillStyle = VOID_COLOR
      ctx.fillRect(vp.minX, vp.minY, vp.maxX - vp.minX, vp.maxY - vp.minY)
      drawTiles(ctx)
    }
    if (state.viewMode === 'blended') drawHeightmapOverlay(ctx)
    // Optional height contour overlay on Map / Blended views.  The
    // Heightmap view always draws contours via drawHeightmap → here
    // we re-use the same function so the on-screen lines match.
    if (state.showContours) {
      const attrW = state.tileW * 2
      const attrH = state.tileH * 2
      const cell = TILE_PX / 2
      drawHeightContours(ctx, attrW, attrH, cell)
    }
  }

  // Grid overlay — density adapts to zoom so you can see per-tile
  // outlines when you're close and big 8×8 blocks when zoomed out.
  // Major lines every 8 tiles are drawn heavier so the user keeps
  // a sense of the larger grid even at the densest zoom.
  if (state.showGridlines) drawGridlines(ctx, canvas)

  // Features are rendered by the WebGL layer above when GL is active;
  // fall back to the 2D path only when GL isn't available.
  if (!glReady && state.showFeatures && state.viewMode !== 'tiles' && state.viewMode !== 'heightmap') {
    drawFeatures(ctx)
  }

  // Drop-preview, terrain rectangle selection, terrain clipboard preview,
  // placement preview, selected-feature highlight — each draws its own
  // overlay so the user always sees what their next action will do.
  drawDropPreview(ctx)
  drawFeatureDragPreview(ctx)
  drawTerrainOverlays(ctx)
  drawPlacementPreview(ctx)
  drawSelectedFeatureOutline(ctx)
  drawHighlightedFeatureOutlines(ctx)
  drawStartPositions(ctx)
  drawEraseBrush(ctx)
  drawHeightmapBrush(ctx)
  drawVoidOverlay(ctx)
  drawBuildableOverlay(ctx)
  drawRulerOverlay(ctx)

  // Rotation badge is an HTML overlay — hide it when there's nothing
  // to rotate.  The drawPlacementPreview / drawTerrainClipboard
  // functions re-show + reposition it via updateRotationBadge.
  if (!state.placement && !state.terrainClipboard) hideRotationBadge()

  // Mirror the main canvas into the floating minimap.
  scheduleMinimapRender()
  // Refresh the developer stats panel on the next frame too — keeps
  // the counts in sync with whatever the user just stamped.
  scheduleDevStatsRefresh()
  // Keep the per-feature callout in sync with the current selection.
  updateFeatureInfoPanel()
  updateCameraInfoPanel()
}

// setCameraInfoVisible toggles the Camera & Cursor panel.  Mirrors the
// View-menu Minimap toggle so users get a familiar pattern.
function setCameraInfoVisible(visible) {
  state.showCameraInfo = !!visible
  if (_reactUi && typeof _reactUi.setPanelVisible === 'function') {
    _reactUi.setPanelVisible('camera-info-panel', !!visible)
  }
  if (visible) updateCameraInfoPanel()
  persistPrefs()
  publishMapRibbonState()
}

// updateCameraInfoPanel publishes the viewport-centre tile + zoom to
// the React store.  Called from renderCanvas after a pan / zoom; the
// React CameraCursorPanel re-renders on the next signal commit.
function updateCameraInfoPanel() {
  if (!_reactUi || typeof _reactUi.publishMapCameraInfo !== 'function') return
  const cam = viewportCellCenter()
  _reactUi.publishMapCameraInfo({
    cameraTx: cam.tx,
    cameraTy: cam.ty,
    zoomPct: Math.round((state.zoom || 1) * 100),
  })
}

// updateCameraInfoCursor publishes the cursor tile + sub-tile + the
// height byte at the precise attribute cell under the cursor.  Called
// from updateHoverLabel; null tx clears the readout when the mouse
// leaves the canvas.
function updateCameraInfoCursor(tx, ty, ax, ay) {
  if (!_reactUi || typeof _reactUi.publishMapCameraInfo !== 'function') return
  if (tx == null) {
    _reactUi.publishMapCameraInfo({
      cursorTx: null, cursorTy: null,
      subTx: null, subTy: null,
      height: null,
    })
    return
  }
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const height = (ax >= 0 && ay >= 0 && ax < aw && ay < ah && state.heights)
    ? (state.heights[ay * aw + ax] | 0)
    : null
  _reactUi.publishMapCameraInfo({
    cursorTx: tx, cursorTy: ty,
    subTx: ax & 1, subTy: ay & 1,
    height,
  })
}

// updateFeatureInfoPanel populates the floating callout that appears
// while the user has a single feature selected.  It shows the data
// you'd want to round-trip through the TNT file — map tile, attribute
// sub-cell, world pixel, terrain height byte, footprint, category.
// Hidden on no-selection or multi-select (Picker mode).
function updateFeatureInfoPanel() {
  const panel = $('#feature-info-panel')
  if (!panel) return
  const multi = state.selectedFeatures && state.selectedFeatures.size > 0
  const idx = state.selectedFeature
  if (multi || idx < 0 || idx >= (state.features || []).length) {
    panel.classList.add('hidden')
    return
  }
  const f = state.features[idx]
  if (!f) { panel.classList.add('hidden'); return }
  panel.classList.remove('hidden')
  // Tile = which 32-px tile the anchor falls in.  Sub-tile is the 0/1
  // attribute offset inside that tile (TA's 2×2 attribute grid per tile).
  const tx = Math.floor(f.ax / 2)
  const ty = Math.floor(f.ay / 2)
  const sx = f.ax & 1
  const sy = f.ay & 1
  const anchor = featureAnchorWorld(f)
  const height = featureGroundHeight(f)
  const fw = f.footprintX || 1
  const fh = f.footprintZ || 1
  $('#feature-info-title').textContent = f.name || 'Feature'
  $('#fi-tile').textContent = `${tx}, ${ty}`
  $('#fi-subtile').textContent = `${sx}, ${sy}`
  $('#fi-attr').textContent = `${f.ax}, ${f.ay}`
  $('#fi-world').textContent = `${anchor.px}, ${anchor.py}`
  $('#fi-height').textContent = `${height}`
  $('#fi-footprint').textContent = `${fw} × ${fh}`
  $('#fi-category').textContent = f.category || f.world || '—'
}

// WebGL tile + feature batch renderer moved to
// ./ui/map-editor/canvas/webgl.js — see import at the top of this
// file.  The legacy `gl` state, `resetGL`, `ensureGLRenderer`,
// `glClearViewport`, `glRenderTilesAndFeatures`, `glTextureFor`,
// `buildTileBatch`, and `buildFeatureBatch` live there now.  The
// helpers that renderer needs (whenImageReady, preloadFeatureImage,
// renderCanvas, transformedSourceCell, featureAnchorOffset,
// featureAnchorWorld) are wired in via hostCallbacks in the boot
// block above.

// ── View-mode renderers ────────────────────────────────────────────────────

// drawTiles renders the stamped section pixels, with rotation, into the
// editor canvas.  Falls back to a placeholder swatch for cells whose
// section image hasn't decoded yet (and registers an onload so the
// canvas re-renders when it does).
function drawTiles(ctx) {
  const vb = visibleTileBounds()
  for (let ty = vb.minTY; ty <= vb.maxTY; ty++) {
    for (let tx = vb.minTX; tx <= vb.maxTX; tx++) {
      const stamp = state.tiles[ty * state.tileW + tx]
      if (!stamp) continue
      const img = state.sectionImages.get(stamp.sectionPath)
      if (!img || !img.complete || img.naturalWidth === 0) {
        ctx.fillStyle = '#3a4d61'
        ctx.fillRect(tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX)
        whenImageReady(img, 'render', renderCanvas)
        continue
      }
      drawTransformedTile(ctx, img, stamp.sx, stamp.sy, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV, tx * TILE_PX, ty * TILE_PX)
    }
  }
}

// visibleTileBounds returns the inclusive [minTX..maxTX, minTY..maxTY]
// rectangle currently visible in the canvas-scroll viewport, padded by
// one tile so partially-visible edges aren't clipped.  Used by every
// per-cell render pass to skip drawing tiles the user can't see — a
// big win on large maps where the canvas is much larger than the
// viewport.
function visibleTileBounds() {
  const wrap = $('#canvas-scroll')
  if (!wrap) return { minTX: 0, minTY: 0, maxTX: state.tileW - 1, maxTY: state.tileH - 1 }
  // The canvas sits at (overscrollPadding.x, overscrollPadding.y) inside
  // .canvas-stack, so subtract that offset before converting scroll
  // pixels to canvas pixels.  Negative values just mean we're looking
  // at the whitespace beyond a map edge — they clamp away below.
  const z = state.zoom || 1
  const left = (wrap.scrollLeft - overscrollPadding.x) / z
  const top = (wrap.scrollTop - overscrollPadding.y) / z
  const right = (wrap.scrollLeft - overscrollPadding.x + wrap.clientWidth) / z
  const bottom = (wrap.scrollTop - overscrollPadding.y + wrap.clientHeight) / z
  const minTX = clamp(Math.floor(left / TILE_PX) - 1, 0, state.tileW - 1)
  const minTY = clamp(Math.floor(top / TILE_PX) - 1, 0, state.tileH - 1)
  const maxTX = clamp(Math.ceil(right / TILE_PX), 0, state.tileW - 1)
  const maxTY = clamp(Math.ceil(bottom / TILE_PX), 0, state.tileH - 1)
  return { minTX, minTY, maxTX, maxTY }
}

// visiblePixelBounds gives the same rectangle in canvas pixels (game
// pixels at TILE_PX resolution) for callers that work in pixel space
// (features, hit-test outlines, etc.) and need to cull against the
// sprite's drawn box rather than tile cells.
function visiblePixelBounds() {
  const vb = visibleTileBounds()
  return {
    minX: vb.minTX * TILE_PX,
    minY: vb.minTY * TILE_PX,
    // maxTX/maxTY are inclusive tile indices, so add +1 to get the
    // exclusive pixel upper-bound.
    maxX: (vb.maxTX + 1) * TILE_PX,
    maxY: (vb.maxTY + 1) * TILE_PX,
  }
}

// drawRotatedTile copies one 32×32 source tile from a section image to
// the destination canvas, rotated by `rotation` quarter-turns clockwise.
function drawRotatedTile(ctx, img, sx, sy, rotation, dx, dy) {
  if ((rotation & 3) === 0) {
    ctx.drawImage(img, sx * 32, sy * 32, 32, 32, dx, dy, TILE_PX, TILE_PX)
    return
  }
  ctx.save()
  ctx.translate(dx + TILE_PX / 2, dy + TILE_PX / 2)
  ctx.rotate((rotation & 3) * Math.PI / 2)
  ctx.drawImage(img, sx * 32, sy * 32, 32, 32, -TILE_PX / 2, -TILE_PX / 2, TILE_PX, TILE_PX)
  ctx.restore()
}

// drawHeightmap renders the per-attribute-cell heights as a grayscale
// image.  The grid is 2× the tile grid, so each attr cell maps to a
// (TILE_PX/2)² block.
function drawHeightmap(ctx) {
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  if (state.heights.length !== attrW * attrH) return
  let min = 255, max = 0
  for (let i = 0; i < state.heights.length; i++) {
    if (state.heights[i] < min) min = state.heights[i]
    if (state.heights[i] > max) max = state.heights[i]
  }
  const span = Math.max(1, max - min)
  const cell = TILE_PX / 2
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      const v = Math.round(((h - min) / span) * 255)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(ax * cell, ay * cell, cell, cell)
    }
  }
  // Contours are now gated on the View → Show Contours toggle so the
  // user controls them in both Heightmap and Map view from one place.
  if (state.showContours) drawHeightContours(ctx, attrW, attrH, cell)
}

// drawHeightContours overlays thin lines along every CONTOUR_STEP-byte
// height change between neighbouring attribute cells, plus a thicker
// blue line at the configured sea level.  Two passes over the grid:
// one stroking horizontal edges, one stroking vertical edges; uses a
// single path per line colour so big maps stay fast.
function drawHeightContours(ctx, attrW, attrH, cell) {
  // Step grows with zoom-out so we don't draw a dense web of lines at
  // 5–25% zoom.  Each step is a height bucket; lines render where two
  // neighbouring cells fall in different buckets.
  //   ≥75%:  every 16 height units (default detail)
  //   ≥40%:  every 32
  //   ≥20%:  every 64
  //   else:  every 128 (only major bands)
  const z = state.zoom || 1
  let step
  if (z >= 0.75) step = 16
  else if (z >= 0.40) step = 32
  else if (z >= 0.20) step = 64
  else step = 128
  const seaLevel = state.ota?.seaLevel ?? 63
  // Keep strokes at least 1 CSS pixel wide regardless of zoom — same
  // approach the gridlines use, so contours don't alias out at low
  // zoom or balloon at high zoom.
  const minorWidth = Math.max(1, Math.ceil(1 / z))
  const majorWidth = Math.max(2, Math.ceil(2 / z))
  ctx.save()
  ctx.lineWidth = minorWidth
  // Light blue contours so they stand out on both the Map tile
  // textures and the Heightmap greyscale.
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.85)'
  ctx.beginPath()
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      // Right edge.
      if (ax + 1 < attrW) {
        const r = state.heights[ay * attrW + (ax + 1)]
        if (Math.floor(h / step) !== Math.floor(r / step)) {
          const x = (ax + 1) * cell
          ctx.moveTo(x, ay * cell)
          ctx.lineTo(x, (ay + 1) * cell)
        }
      }
      // Bottom edge.
      if (ay + 1 < attrH) {
        const b = state.heights[(ay + 1) * attrW + ax]
        if (Math.floor(h / step) !== Math.floor(b / step)) {
          const y = (ay + 1) * cell
          ctx.moveTo(ax * cell, y)
          ctx.lineTo((ax + 1) * cell, y)
        }
      }
    }
  }
  ctx.stroke()
  // Sea-level line — heavier and tinted blue so it stands out from
  // the regular contours.
  ctx.strokeStyle = 'rgba(56, 132, 255, 0.95)'
  ctx.lineWidth = majorWidth
  ctx.beginPath()
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      const above = h >= seaLevel
      if (ax + 1 < attrW) {
        const r = state.heights[ay * attrW + (ax + 1)]
        if (above !== (r >= seaLevel)) {
          const x = (ax + 1) * cell
          ctx.moveTo(x, ay * cell)
          ctx.lineTo(x, (ay + 1) * cell)
        }
      }
      if (ay + 1 < attrH) {
        const b = state.heights[(ay + 1) * attrW + ax]
        if (above !== (b >= seaLevel)) {
          const y = (ay + 1) * cell
          ctx.moveTo(ax * cell, y)
          ctx.lineTo((ax + 1) * cell, y)
        }
      }
    }
  }
  ctx.stroke()
  ctx.restore()
}

// drawHeightmapOverlay paints a translucent grayscale of the height
// grid on top of the regular tile render.  Used by the "Blended"
// display mode: dark = low ground, bright = high ground, with enough
// alpha that the underlying tile texture still shows through.
function drawHeightmapOverlay(ctx) {
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  if (state.heights.length !== attrW * attrH) return
  let min = 255, max = 0
  for (let i = 0; i < state.heights.length; i++) {
    const h = state.heights[i]
    if (h < min) min = h
    if (h > max) max = h
  }
  const span = Math.max(1, max - min)
  const cell = TILE_PX / 2
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 0.55
  for (let ay = 0; ay < attrH; ay++) {
    for (let ax = 0; ax < attrW; ax++) {
      const h = state.heights[ay * attrW + ax]
      const v = Math.round(((h - min) / span) * 255)
      ctx.fillStyle = `rgb(${v},${v},${v})`
      ctx.fillRect(ax * cell, ay * cell, cell, cell)
    }
  }
  ctx.restore()
}

function drawFeatures(ctx) {
  ctx.font = '14px ' + getComputedStyle(document.body).fontFamily
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const vp = visiblePixelBounds()
  for (const f of state.features) {
    const { px, py } = featureAnchorWorld(f)
    const img = f.previewUrl ? state.featureImages.get(f.name.toLowerCase()) : null
    if (img && img.complete && img.naturalWidth > 0) {
      // GAF frames carry an OriginX/OriginY hotspot — the in-game
      // anchor point inside the sprite — that we apply to the feature's
      // (px, py) world position.  Without it the metal-hill structure
      // floats off-centre to its plinth.  Falls back to bottom-centred
      // anchoring when the origin isn't known yet.
      const { dx, dy } = featureAnchorOffset(f, img)
      const x = px - dx
      const y = py - dy
      // Cull: skip sprites whose drawn rect doesn't intersect the
      // viewport at all.  A feature whose anchor is just off-screen
      // can still render its tall sprite inside the viewport, which
      // is why we cull against the actual draw rect, not the anchor.
      if (x + img.naturalWidth < vp.minX || x > vp.maxX || y + img.naturalHeight < vp.minY || y > vp.maxY) continue
      ctx.drawImage(img, x, y, img.naturalWidth, img.naturalHeight)
    } else {
      if (f.previewUrl && !state.featureImages.has(f.name.toLowerCase())) {
        preloadFeatureImage(f)
      }
      ctx.fillStyle = 'rgba(255, 200, 0, 0.7)'
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#000'
      ctx.fillText('🌲', px, py)
    }
  }
}

// featureAnchorOffset returns the (dx, dy) inside the sprite image that
// corresponds to the feature's world anchor point.  Uses the GAF
// hotspot when the backend supplied it, otherwise falls back to a
// bottom-centred anchor (matches the historical placement until the
// origin metadata arrives over the wire).
function featureAnchorOffset(f, img) {
  if (typeof f.originX === 'number' && typeof f.originY === 'number' && (f.originX !== 0 || f.originY !== 0)) {
    return { dx: f.originX, dy: f.originY }
  }
  return { dx: img.naturalWidth / 2, dy: img.naturalHeight }
}

// featureAnchorWorld returns the world-pixel position the feature is
// anchored at.  TA stores f.ax / f.ay as the *top-left* attribute cell
// of the feature's footprint, but the rendered anchor lives at the
// CENTRE of the footprint, shifted UP by Height/2 to account for the
// underlying terrain elevation — see Kinboat's classTAMap.cls:3340:
//   FeatureTop = IndexY*16 - Height/2 - PositionY + FootprintY*8
// Without the Height/2 term, TA's default ground (height ≈ 64) made
// every feature render one tile too low.
function featureAnchorWorld(f, heightOverride) {
  const fw = f.footprintX || 1
  const fh = f.footprintZ || 1
  const px = f.ax * (TILE_PX / 2) + fw * (TILE_PX / 4)
  const h = heightOverride != null ? heightOverride : featureGroundHeight(f)
  const py = f.ay * (TILE_PX / 2) + fh * (TILE_PX / 4) - (h >> 1)
  return { px, py }
}

// featureGroundHeight reads the height byte from the attribute grid at
// the feature's anchor cell.  Heights live one byte per 16-px attr cell
// in state.heights, sized state.tileW*2 × state.tileH*2.  Out-of-range
// (e.g. orphaned features) returns 0 so the feature falls back to its
// cell centre without any elevation kick.
function featureGroundHeight(f) {
  if (!state.heights || !state.tileW) return 0
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  if (f.ax < 0 || f.ay < 0 || f.ax >= aw || f.ay >= ah) return 0
  const idx = f.ay * aw + f.ax
  return state.heights[idx] | 0
}

function drawDropPreview(ctx) {
  // Sections render a full placement preview separately; this is only
  // the small drop-target highlight for features (the actual sprite
  // gets drawn by drawFeatureDragPreview).
  if (!(state.dropPreview && state.dragging && state.selected)) return
  if (state.dragging.type !== 'feature') return
  const { tx, ty } = state.dropPreview
  ctx.fillStyle = 'rgba(139, 92, 246, 0.14)'
  ctx.fillRect(tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX)
  ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)'
  ctx.lineWidth = 2
  ctx.strokeRect(tx * TILE_PX + 1, ty * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2)
}

// drawFeatureDragPreview renders the actual feature sprite at the cursor
// while a feature drag is in flight — same bottom-centred anchor as
// placed features, just with reduced alpha so the underlying tiles
// still show through.
function drawFeatureDragPreview(ctx) {
  if (!(state.dragging && state.dropPreview)) return
  if (state.dragging.type !== 'feature') return
  if (!state.selected || state.selected.type !== 'feature') return
  const f = state.selected
  const { tx, ty } = state.dropPreview
  const px = (tx + 0.5) * TILE_PX
  const py = (ty + 0.5) * TILE_PX
  const img = f.previewUrl ? state.featureImages.get((f.name || '').toLowerCase()) : null
  ctx.save()
  ctx.globalAlpha = 0.85
  if (img && img.complete && img.naturalWidth > 0) {
    const { dx, dy } = featureAnchorOffset(f, img)
    ctx.drawImage(img, px - dx, py - dy, img.naturalWidth, img.naturalHeight)
  } else {
    ctx.font = '14px ' + getComputedStyle(document.body).fontFamily
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255, 200, 0, 0.7)'
    ctx.beginPath()
    ctx.arc(px, py, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#000'
    ctx.fillText('🌲', px, py)
  }
  ctx.restore()
}

// drawPlacementPreview draws the section that follows the cursor in
// Paint mode (after the user selects from the drawer, before they click
// to commit).  Honours the current rotation so Q/E feedback is live.
function drawPlacementPreview(ctx) {
  if (!state.placement || state.placement.tx == null) return
  // Drawer-pick starts dormant — wait for the cursor to enter the
  // canvas before drawing a ghost, so the preview doesn't briefly
  // sit at viewport centre.
  if (state.placement.dormant) return
  const p = state.placement
  const img = state.sectionImages.get(p.sectionPath)
  const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, p.rotation)
  // Footprint outline.
  ctx.save()
  ctx.globalAlpha = 0.85
  if (img && img.complete && img.naturalWidth > 0) {
    for (let dy = 0; dy < fh; dy++) {
      for (let dx = 0; dx < fw; dx++) {
        const mx = p.tx + dx
        const my = p.ty + dy
        if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
        const src = transformedSourceCell(dx, dy, p.origW, p.origH, p.rotation, !!p.flipH, !!p.flipV)
        drawTransformedTile(ctx, img, src.sx, src.sy, p.rotation, !!p.flipH, !!p.flipV, mx * TILE_PX, my * TILE_PX)
      }
    }
  } else {
    ctx.fillStyle = 'rgba(139, 92, 246, 0.18)'
    ctx.fillRect(p.tx * TILE_PX, p.ty * TILE_PX, fw * TILE_PX, fh * TILE_PX)
  }
  ctx.restore()
  // Anchored placements (post first-click) get a brighter dashed
  // outline so the user can tell at a glance they're in
  // "drag-or-confirm" mode rather than the cursor-follow phase.
  if (p.anchored) {
    ctx.strokeStyle = '#ffcc33'
    ctx.lineWidth = 2.5
    ctx.setLineDash([8, 4])
    ctx.strokeRect(p.tx * TILE_PX + 1, p.ty * TILE_PX + 1, fw * TILE_PX - 2, fh * TILE_PX - 2)
    ctx.setLineDash([])
  } else {
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(p.tx * TILE_PX + 1, p.ty * TILE_PX + 1, fw * TILE_PX - 2, fh * TILE_PX - 2)
  }

  drawRotationBadge(ctx, p.tx, p.ty, fw, fh, p.rotation, !!p.flipH, !!p.flipV)
  drawPlacementEdgeHints(ctx, p, fw, fh)
}

// drawRotationBadge is a thin shim around the HTML overlay updater so
// the placement-preview and terrain-clipboard render paths can keep
// calling it.  We render via HTML (see updateRotationBadge) so the
// badge keeps a fixed CSS size regardless of canvas zoom.
function drawRotationBadge(_ctx, tx, ty, fw, fh, rotation, flipH = false, flipV = false) {
  updateRotationBadge(tx, ty, fw, fh, rotation, flipH, flipV)
}

function updateRotationBadge(_tx, _ty, _fw, _fh, _rotation, _flipH = false, _flipV = false) {
  // The rotation-badge pill is gone (round 33) — its hints
  // duplicated the placement-hint pill and its angle / flip
  // readout was already conveyed by the rotating live preview on
  // the canvas.  Lookup is guarded in case a third-party
  // extension re-injects the legacy badge id; otherwise this is a
  // no-op.  Kept callable so the placement / terrain-clipboard
  // render paths don't need to drop their drawRotationBadge call
  // sites.
  const badge = document.getElementById('rotation-badge')
  if (badge) badge.classList.add('hidden')
}

function hideRotationBadge() {
  // Same deprecation story as updateRotationBadge — no live badge
  // to hide, but the guarded lookup keeps third-party extensions
  // happy.
  const badge = document.getElementById('rotation-badge')
  if (badge) badge.classList.add('hidden')
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

// PLACEMENT_ALIGN_TOLERANCE — threshold beyond which we consider two
// edge samples mis-aligned.  Heights live in a 0–255 byte range; ~16
// is a noticeable game-world step but still smooth enough to be
// plausible.
const PLACEMENT_ALIGN_TOLERANCE = 16

// evaluatePlacementRingDeltas returns the worst-case height delta for
// every ring cell around the placement footprint.  Used by both the
// edge-hint drawer and the auto-rotate logic so they stay in lock-step.
// Returns [] if heights aren't available yet.
function evaluatePlacementRingDeltas(p, fw, fh) {
  const sec = state.sectionHeights.get(p.sectionPath)
  if (!sec) return []
  const mapAttrW = state.tileW * 2

  function sectionHeightAt(fx, fy, sqx, sqy) {
    // Mirror the flips on the destination side, then unrotate.  Same
    // composition copyTileHeights uses — keeps the edge probe in sync
    // with what the stamp actually writes.
    const src = transformedSourceCell(fx, fy, p.origW, p.origH, p.rotation, !!p.flipH, !!p.flipV)
    const fqx = p.flipH ? 1 - sqx : sqx
    const fqy = p.flipV ? 1 - sqy : sqy
    let ssqx = fqx
    let ssqy = fqy
    switch (p.rotation & 3) {
      case 1: ssqx = fqy; ssqy = 1 - fqx; break
      case 2: ssqx = 1 - fqx; ssqy = 1 - fqy; break
      case 3: ssqx = 1 - fqy; ssqy = fqx; break
    }
    const ax = src.sx * 2 + ssqx
    const ay = src.sy * 2 + ssqy
    const idx = ay * sec.attrW + ax
    if (idx < 0 || idx >= sec.heights.length) return null
    return sec.heights[idx]
  }
  function edgeDelta(fx, fy, edge) {
    let mx, my
    const samples = []
    if (edge === 'N') {
      mx = p.tx + fx; my = p.ty + fy - 1
      if (my < 0 || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) samples.push({ secH: sectionHeightAt(fx, fy, q, 0), mapH: state.heights[(my * 2 + 1) * mapAttrW + (mx * 2 + q)] })
    } else if (edge === 'S') {
      mx = p.tx + fx; my = p.ty + fy + 1
      if (my >= state.tileH || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) samples.push({ secH: sectionHeightAt(fx, fy, q, 1), mapH: state.heights[(my * 2) * mapAttrW + (mx * 2 + q)] })
    } else if (edge === 'W') {
      mx = p.tx + fx - 1; my = p.ty + fy
      if (mx < 0 || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) samples.push({ secH: sectionHeightAt(fx, fy, 0, q), mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2 + 1)] })
    } else if (edge === 'E') {
      mx = p.tx + fx + 1; my = p.ty + fy
      if (mx >= state.tileW || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) samples.push({ secH: sectionHeightAt(fx, fy, 1, q), mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2)] })
    }
    if (!state.tiles[my * state.tileW + mx]) return null
    let worst = 0
    for (const s of samples) {
      if (s.secH == null || s.mapH == null) continue
      const d = Math.abs(s.secH - s.mapH)
      if (d > worst) worst = d
    }
    return worst
  }
  function evaluateRingCell(rx, ry) {
    const mx = p.tx + rx, my = p.ty + ry
    if (rx >= 0 && rx < fw && ry >= 0 && ry < fh) return null
    if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) return null
    const edges = []
    if (rx === -1 && ry >= 0 && ry < fh) edges.push({ fx: 0, fy: ry, edge: 'W' })
    if (rx === fw && ry >= 0 && ry < fh) edges.push({ fx: fw - 1, fy: ry, edge: 'E' })
    if (ry === -1 && rx >= 0 && rx < fw) edges.push({ fx: rx, fy: 0, edge: 'N' })
    if (ry === fh && rx >= 0 && rx < fw) edges.push({ fx: rx, fy: fh - 1, edge: 'S' })
    if (rx === -1 && ry === -1) edges.push({ fx: 0, fy: 0, edge: 'N' }, { fx: 0, fy: 0, edge: 'W' })
    if (rx === fw && ry === -1) edges.push({ fx: fw - 1, fy: 0, edge: 'N' }, { fx: fw - 1, fy: 0, edge: 'E' })
    if (rx === -1 && ry === fh) edges.push({ fx: 0, fy: fh - 1, edge: 'S' }, { fx: 0, fy: fh - 1, edge: 'W' })
    if (rx === fw && ry === fh) edges.push({ fx: fw - 1, fy: fh - 1, edge: 'S' }, { fx: fw - 1, fy: fh - 1, edge: 'E' })
    if (edges.length === 0) return null
    let worst = 0
    let evaluated = false
    for (const e of edges) {
      const d = edgeDelta(e.fx, e.fy, e.edge)
      if (d == null) continue
      evaluated = true
      if (d > worst) worst = d
    }
    return evaluated ? worst : null
  }

  const out = []
  for (let ry = -1; ry <= fh; ry++) {
    for (let rx = -1; rx <= fw; rx++) {
      if (rx >= 0 && rx < fw && ry >= 0 && ry < fh) continue
      const delta = evaluateRingCell(rx, ry)
      if (delta == null) continue
      out.push({ rx, ry, mx: p.tx + rx, my: p.ty + ry, delta })
    }
  }
  return out
}

// countPlacementMismatches returns how many ring cells exceed the
// alignment tolerance, and how many were actually evaluated.  Used by
// the auto-rotate heuristic: when exactly one rotation has zero
// mismatches (out of at least one evaluated edge), we snap to it.
function countPlacementMismatches(p, fw, fh) {
  const cells = evaluatePlacementRingDeltas(p, fw, fh)
  let bad = 0
  for (const c of cells) if (c.delta > PLACEMENT_ALIGN_TOLERANCE) bad++
  return { mismatches: bad, evaluated: cells.length }
}

// tryAutoRotatePlacement scans all four rotations and, if exactly one
// produces zero edge mismatches while the others produce at least one,
// snaps the placement to that rotation.  Skipped once the user has
// manually rotated via Q/E (p.userRotated) so we don't override their
// intent.
function tryAutoRotatePlacement(p) {
  if (!p || p.userRotated) return
  if (!state.sectionHeights.has(p.sectionPath)) return
  const original = p.rotation & 3
  const results = []
  for (let r = 0; r < 4; r++) {
    p.rotation = r
    const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, r)
    const c = countPlacementMismatches(p, fw, fh)
    results.push({ r, ...c })
  }
  // Restore so the rest of the call site sees a consistent rotation
  // until we explicitly commit a new one below.
  p.rotation = original
  // Filter to rotations whose ring had at least one evaluated edge —
  // open-field placements (no neighbours) would otherwise tie at 0,0.
  const candidates = results.filter((r) => r.evaluated > 0)
  if (candidates.length === 0) return
  const clean = candidates.filter((r) => r.mismatches === 0)
  if (clean.length !== 1) return
  if (candidates.some((r) => r.r !== clean[0].r && r.mismatches === 0)) return
  if (clean[0].r === original) return
  p.rotation = clean[0].r
}

// drawPlacementEdgeHints walks the ring of tiles immediately outside the
// placement footprint and draws a translucent square in each cell.
// White means the section's heights along that edge match the map's
// existing heights well enough that the seam will look natural; red
// flags a step the user probably wants to smooth out before committing.
function drawPlacementEdgeHints(ctx, p, fw, fh) {
  const sec = state.sectionHeights.get(p.sectionPath)
  if (!sec) return // heights not yet fetched; skip rather than mislead

  const ALIGN_TOLERANCE = PLACEMENT_ALIGN_TOLERANCE

  const mapAttrW = state.tileW * 2

  // Helper: look up the *section*'s height for a rotated footprint cell
  // (fx, fy) at sub-cell slot (sqx, sqy ∈ [0,1]).  Returns null when the
  // section heightmap is missing data for that slot.
  function sectionHeightAt(fx, fy, sqx, sqy) {
    const src = rotatedSourceCell(fx, fy, p.origW, p.origH, p.rotation)
    // Map the rotated sub-slot back to the unrotated section's slot.
    let ssqx = sqx
    let ssqy = sqy
    switch (p.rotation & 3) {
      case 1: ssqx = sqy; ssqy = 1 - sqx; break
      case 2: ssqx = 1 - sqx; ssqy = 1 - sqy; break
      case 3: ssqx = 1 - sqy; ssqy = sqx; break
    }
    const ax = src.sx * 2 + ssqx
    const ay = src.sy * 2 + ssqy
    const idx = ay * sec.attrW + ax
    if (idx < 0 || idx >= sec.heights.length) return null
    return sec.heights[idx]
  }

  // Compare an edge: returns a worst-case delta across the two sub-cells
  // along the boundary, or null when one side is off-map *or* the
  // adjacent map cell is void (no tile stamped there yet — comparing
  // against an unset default would falsely flag mismatches).
  function edgeDelta(footprintCell, edge) {
    const { fx, fy } = footprintCell
    let mx, my
    const samples = []
    if (edge === 'N') {
      mx = p.tx + fx; my = p.ty + fy - 1
      if (my < 0 || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) {
        samples.push({
          secH: sectionHeightAt(fx, fy, q, 0),
          mapH: state.heights[(my * 2 + 1) * mapAttrW + (mx * 2 + q)],
        })
      }
    } else if (edge === 'S') {
      mx = p.tx + fx; my = p.ty + fy + 1
      if (my >= state.tileH || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) {
        samples.push({
          secH: sectionHeightAt(fx, fy, q, 1),
          mapH: state.heights[(my * 2) * mapAttrW + (mx * 2 + q)],
        })
      }
    } else if (edge === 'W') {
      mx = p.tx + fx - 1; my = p.ty + fy
      if (mx < 0 || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) {
        samples.push({
          secH: sectionHeightAt(fx, fy, 0, q),
          mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2 + 1)],
        })
      }
    } else if (edge === 'E') {
      mx = p.tx + fx + 1; my = p.ty + fy
      if (mx >= state.tileW || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) {
        samples.push({
          secH: sectionHeightAt(fx, fy, 1, q),
          mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2)],
        })
      }
    }
    // The neighbour cell only contributes if it actually has a tile —
    // void space carries the default 80 sentinel and produces useless
    // red flags otherwise.
    if (!state.tiles[my * state.tileW + mx]) return null

    let worst = 0
    for (const s of samples) {
      if (s.secH == null || s.mapH == null) continue
      const d = Math.abs(s.secH - s.mapH)
      if (d > worst) worst = d
    }
    return worst
  }

  // ringCell determines which footprint cell is "behind" a given
  // perimeter cell (rx, ry) and which edge of that footprint cell it
  // borders.  Corner cells border two footprint cells along two edges,
  // so we take the worst of the two so the corner colour reflects the
  // worse of the two seams.
  function evaluateRingCell(rx, ry) {
    const mx = p.tx + rx
    const my = p.ty + ry
    // Skip cells that are inside the footprint or off-map.
    if (rx >= 0 && rx < fw && ry >= 0 && ry < fh) return null
    if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) return null

    const edges = []
    if (rx === -1 && ry >= 0 && ry < fh) edges.push({ fx: 0, fy: ry, edge: 'W' })
    if (rx === fw && ry >= 0 && ry < fh) edges.push({ fx: fw - 1, fy: ry, edge: 'E' })
    if (ry === -1 && rx >= 0 && rx < fw) edges.push({ fx: rx, fy: 0, edge: 'N' })
    if (ry === fh && rx >= 0 && rx < fw) edges.push({ fx: rx, fy: fh - 1, edge: 'S' })
    // Corner cells (e.g. rx=-1, ry=-1): both adjacent edges are NW corner
    // of the (0,0) footprint cell.  Add both edges so we look at both
    // sides.
    if (rx === -1 && ry === -1) edges.push({ fx: 0, fy: 0, edge: 'N' }, { fx: 0, fy: 0, edge: 'W' })
    if (rx === fw && ry === -1) edges.push({ fx: fw - 1, fy: 0, edge: 'N' }, { fx: fw - 1, fy: 0, edge: 'E' })
    if (rx === -1 && ry === fh) edges.push({ fx: 0, fy: fh - 1, edge: 'S' }, { fx: 0, fy: fh - 1, edge: 'W' })
    if (rx === fw && ry === fh) edges.push({ fx: fw - 1, fy: fh - 1, edge: 'S' }, { fx: fw - 1, fy: fh - 1, edge: 'E' })

    if (edges.length === 0) return null

    let worst = 0
    let evaluated = false
    for (const e of edges) {
      const d = edgeDelta({ fx: e.fx, fy: e.fy }, e.edge)
      if (d == null) continue
      evaluated = true
      if (d > worst) worst = d
    }
    return evaluated ? worst : null
  }

  // Walk the ring and shade each cell.
  for (let ry = -1; ry <= fh; ry++) {
    for (let rx = -1; rx <= fw; rx++) {
      if (rx >= 0 && rx < fw && ry >= 0 && ry < fh) continue
      const delta = evaluateRingCell(rx, ry)
      if (delta == null) continue
      const mx = p.tx + rx
      const my = p.ty + ry
      const misaligned = delta > ALIGN_TOLERANCE
      ctx.fillStyle = misaligned
        ? 'rgba(248, 81, 73, 0.45)'
        : 'rgba(255, 255, 255, 0.22)'
      ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
      ctx.strokeStyle = misaligned
        ? 'rgba(248, 81, 73, 0.95)'
        : 'rgba(255, 255, 255, 0.7)'
      ctx.lineWidth = 1
      ctx.strokeRect(mx * TILE_PX + 0.5, my * TILE_PX + 0.5, TILE_PX - 1, TILE_PX - 1)
    }
  }
}

function drawTerrainOverlays(ctx) {
  // Rectangle currently being dragged.
  if (state.rectSelection) {
    const r = normalizedRect(state.rectSelection)
    ctx.fillStyle = 'rgba(139, 92, 246, 0.14)'
    ctx.fillRect(r.x * TILE_PX, r.y * TILE_PX, r.w * TILE_PX, r.h * TILE_PX)
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)'
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 2
    ctx.strokeRect(r.x * TILE_PX + 1, r.y * TILE_PX + 1, r.w * TILE_PX - 2, r.h * TILE_PX - 2)
    ctx.setLineDash([])
  }
  // Floating clipboard — preview at current cursor position.
  if (state.terrainClipboard) {
    drawTerrainClipboard(ctx)
  }
}

function drawTerrainClipboard(ctx) {
  const c = state.terrainClipboard
  const tx = c.tx, ty = c.ty
  ctx.save()
  ctx.globalAlpha = 0.85
  for (let dy = 0; dy < c.h; dy++) {
    for (let dx = 0; dx < c.w; dx++) {
      const cell = c.tiles[dy * c.w + dx]
      const mx = tx + dx, my = ty + dy
      if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
      if (!cell) {
        ctx.fillStyle = 'rgba(139, 92, 246, 0.12)'
        ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
        continue
      }
      const img = state.sectionImages.get(cell.sectionPath)
      if (img && img.complete && img.naturalWidth > 0) {
        drawRotatedTile(ctx, img, cell.sx, cell.sy, cell.rotation || 0, mx * TILE_PX, my * TILE_PX)
      } else {
        ctx.fillStyle = '#3a4d61'
        ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
      }
    }
  }
  ctx.restore()

  // Draw carried features so the user can see them following the
  // rectangle.  Positioned with the same bottom-centre anchor
  // drawFeatures uses on the regular map.
  if (c.features && c.features.length) {
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.font = '14px ' + getComputedStyle(document.body).fontFamily
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const cAttrW = c.w * 2
    const cAttrH = c.h * 2
    for (const f of c.features) {
      // Carried features have ax/ay relative to the clipboard, not the
      // world.  featureGroundHeight would read state.heights at the
      // wrong (or zeroed-out) cell — pass the height from the captured
      // c.heights array so the lift matches what the feature had before
      // the user grabbed it.
      let groundH = 0
      if (f.ax >= 0 && f.ay >= 0 && f.ax < cAttrW && f.ay < cAttrH) {
        groundH = c.heights[f.ay * cAttrW + f.ax] | 0
      }
      const local = featureAnchorWorld(f, groundH)
      const px = c.tx * TILE_PX + local.px
      const py = c.ty * TILE_PX + local.py
      const img = f.previewUrl ? state.featureImages.get(f.name.toLowerCase()) : null
      if (img && img.complete && img.naturalWidth > 0) {
        const { dx, dy } = featureAnchorOffset(f, img)
        ctx.drawImage(img, px - dx, py - dy, img.naturalWidth, img.naturalHeight)
      } else {
        ctx.fillStyle = 'rgba(255, 200, 0, 0.7)'
        ctx.beginPath()
        ctx.arc(px, py, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#000'
        ctx.fillText('🌲', px, py)
      }
    }
    ctx.restore()
  }

  ctx.strokeStyle = 'rgba(139, 92, 246, 0.9)'
  ctx.lineWidth = 2
  ctx.strokeRect(tx * TILE_PX + 1, ty * TILE_PX + 1, c.w * TILE_PX - 2, c.h * TILE_PX - 2)

  // Rotation badge + edge-alignment hints — same affordances as the
  // section placement preview so the user has parity between Place
  // Tiles and Select Area drag-move.
  drawRotationBadge(ctx, tx, ty, c.w, c.h, c.rotation || 0)
  drawTerrainEdgeHints(ctx, c)
}

// drawTerrainEdgeHints flags seam mismatches between the floating
// clipboard and the map's existing heights — mirrors the
// section-placement edge hints so the user can see at a glance whether
// the drop point will produce ugly elevation steps.
function drawTerrainEdgeHints(ctx, c) {
  const ALIGN_TOLERANCE = 16
  const mapAttrW = state.tileW * 2
  const clipAttrW = c.w * 2

  // Sample the clipboard's height at (fx, fy) sub-cell (qx, qy ∈ [0,1]).
  function clipboardHeight(fx, fy, qx, qy) {
    const ax = fx * 2 + qx
    const ay = fy * 2 + qy
    const idx = ay * clipAttrW + ax
    if (idx < 0 || idx >= c.heights.length) return null
    return c.heights[idx]
  }

  function edgeDelta(fx, fy, edge) {
    let mx, my
    const samples = []
    if (edge === 'N') {
      mx = c.tx + fx; my = c.ty + fy - 1
      if (my < 0 || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, q, 0),
        mapH: state.heights[(my * 2 + 1) * mapAttrW + (mx * 2 + q)],
      })
    } else if (edge === 'S') {
      mx = c.tx + fx; my = c.ty + fy + 1
      if (my >= state.tileH || mx < 0 || mx >= state.tileW) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, q, 1),
        mapH: state.heights[(my * 2) * mapAttrW + (mx * 2 + q)],
      })
    } else if (edge === 'W') {
      mx = c.tx + fx - 1; my = c.ty + fy
      if (mx < 0 || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, 0, q),
        mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2 + 1)],
      })
    } else if (edge === 'E') {
      mx = c.tx + fx + 1; my = c.ty + fy
      if (mx >= state.tileW || my < 0 || my >= state.tileH) return null
      for (let q = 0; q < 2; q++) samples.push({
        clipH: clipboardHeight(fx, fy, 1, q),
        mapH: state.heights[(my * 2 + q) * mapAttrW + (mx * 2)],
      })
    }
    // Skip seams where the neighbour cell is void.
    if (!state.tiles[my * state.tileW + mx]) return null
    let worst = 0
    for (const s of samples) {
      if (s.clipH == null || s.mapH == null) continue
      const d = Math.abs(s.clipH - s.mapH)
      if (d > worst) worst = d
    }
    return worst
  }

  function evaluateRingCell(rx, ry) {
    const mx = c.tx + rx, my = c.ty + ry
    if (rx >= 0 && rx < c.w && ry >= 0 && ry < c.h) return null
    if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) return null
    const edges = []
    if (rx === -1 && ry >= 0 && ry < c.h) edges.push({ fx: 0, fy: ry, edge: 'W' })
    if (rx === c.w && ry >= 0 && ry < c.h) edges.push({ fx: c.w - 1, fy: ry, edge: 'E' })
    if (ry === -1 && rx >= 0 && rx < c.w) edges.push({ fx: rx, fy: 0, edge: 'N' })
    if (ry === c.h && rx >= 0 && rx < c.w) edges.push({ fx: rx, fy: c.h - 1, edge: 'S' })
    if (rx === -1 && ry === -1) edges.push({ fx: 0, fy: 0, edge: 'N' }, { fx: 0, fy: 0, edge: 'W' })
    if (rx === c.w && ry === -1) edges.push({ fx: c.w - 1, fy: 0, edge: 'N' }, { fx: c.w - 1, fy: 0, edge: 'E' })
    if (rx === -1 && ry === c.h) edges.push({ fx: 0, fy: c.h - 1, edge: 'S' }, { fx: 0, fy: c.h - 1, edge: 'W' })
    if (rx === c.w && ry === c.h) edges.push({ fx: c.w - 1, fy: c.h - 1, edge: 'S' }, { fx: c.w - 1, fy: c.h - 1, edge: 'E' })
    if (edges.length === 0) return null
    let worst = 0
    let evaluated = false
    for (const e of edges) {
      const d = edgeDelta(e.fx, e.fy, e.edge)
      if (d == null) continue
      evaluated = true
      if (d > worst) worst = d
    }
    return evaluated ? worst : null
  }

  for (let ry = -1; ry <= c.h; ry++) {
    for (let rx = -1; rx <= c.w; rx++) {
      if (rx >= 0 && rx < c.w && ry >= 0 && ry < c.h) continue
      const delta = evaluateRingCell(rx, ry)
      if (delta == null) continue
      const mx = c.tx + rx, my = c.ty + ry
      const misaligned = delta > ALIGN_TOLERANCE
      ctx.fillStyle = misaligned ? 'rgba(248, 81, 73, 0.45)' : 'rgba(255, 255, 255, 0.22)'
      ctx.fillRect(mx * TILE_PX, my * TILE_PX, TILE_PX, TILE_PX)
      ctx.strokeStyle = misaligned ? 'rgba(248, 81, 73, 0.95)' : 'rgba(255, 255, 255, 0.7)'
      ctx.lineWidth = 1
      ctx.strokeRect(mx * TILE_PX + 0.5, my * TILE_PX + 0.5, TILE_PX - 1, TILE_PX - 1)
    }
  }
}

// drawGridlines paints the optional gridline overlay.  Density is
// chosen from zoom directly (user-specified bands), and at each band
// we render the chosen step (the "main" grid, lighter) plus the
// next-larger step (bolder) so the user always has a wider reference.
//
// Bands (tile spacing for the main grid):
//   zoom >= 1.50 → 1×1   (with 4×4 reference)
//   zoom >= 1.00 → 4×4   (with 8×8 reference)
//   zoom >= 0.50 → 8×8   (with 16×16)
//   zoom >= 0.25 → 16×16 (with 32×32)
//   zoom >= 0.12 → 32×32 (with 64×64)
//   zoom >= 0.05 → 64×64 (no larger reference)
//   zoom <  0.05 → off
const GRIDLINE_BANDS = [
  { zoom: 1.50, main: 1 },
  { zoom: 1.00, main: 4 },
  { zoom: 0.50, main: 8 },
  { zoom: 0.25, main: 16 },
  { zoom: 0.12, main: 32 },
  { zoom: 0.05, main: 64 },
]

function drawGridlines(ctx, canvas) {
  const z = state.zoom || 1
  let bandIdx = -1
  for (let i = 0; i < GRIDLINE_BANDS.length; i++) {
    if (z >= GRIDLINE_BANDS[i].zoom) { bandIdx = i; break }
  }
  if (bandIdx < 0) return
  const mainStep = GRIDLINE_BANDS[bandIdx].main
  // The "next larger" reference is the entry with a smaller zoom
  // threshold = wider tile spacing, i.e. the entry AFTER bandIdx.
  const refStep = bandIdx + 1 < GRIDLINE_BANDS.length ? GRIDLINE_BANDS[bandIdx + 1].main : null
  // Stroke widths in game-pixels — we want stable CSS widths regardless
  // of zoom so they don't fade at low zoom or balloon at high zoom.
  const mainWidth = Math.max(1, Math.ceil(1 / z))
  const refWidth = Math.max(2, Math.ceil(2 / z))

  ctx.save()
  ctx.lineCap = 'butt'

  // Main (lighter) — skip lines that coincide with the reference grid
  // so the bolder strokes don't get washed out by the thinner overlay.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'
  ctx.lineWidth = mainWidth
  for (let x = 0; x <= state.tileW; x += mainStep) {
    if (refStep && x % refStep === 0) continue
    const xp = x * TILE_PX
    ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, canvas.height); ctx.stroke()
  }
  for (let y = 0; y <= state.tileH; y += mainStep) {
    if (refStep && y % refStep === 0) continue
    const yp = y * TILE_PX
    ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(canvas.width, yp); ctx.stroke()
  }

  if (refStep) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.lineWidth = refWidth
    for (let x = 0; x <= state.tileW; x += refStep) {
      const xp = x * TILE_PX
      ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, canvas.height); ctx.stroke()
    }
    for (let y = 0; y <= state.tileH; y += refStep) {
      const yp = y * TILE_PX
      ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(canvas.width, yp); ctx.stroke()
    }
  }
  ctx.restore()
}

// drawVoidOverlay paints translucent red over every void attribute
// cell.  Each cell is 16 game-pixels (TILE_PX / 2).  Skipped entirely
// when the array is empty or the cells slice is dimensioned wrong
// (e.g. mid-resize) to avoid out-of-bounds reads.  While the user is
// mid-drag in Voids mode, the rectangle they're sweeping renders as
// a dashed red selection on top of the committed overlay.
function drawVoidOverlay(ctx) {
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  // Voids mode forces the overlay on regardless of the View pref so
  // the user can always see what they're painting.
  const visible = state.showVoids || state.mode === 'voids'
  if (!visible) {
    // Still draw the in-flight drag rectangle so the cursor preview
    // shows up even when the toggle is off — but only when actively
    // dragging, which only happens in Voids mode anyway.
    drawVoidsDragRect(ctx)
    return
  }
  if (!state.voids || state.voids.length !== aw * ah) {
    // Still draw the drag rectangle even if no committed voids exist.
    drawVoidsDragRect(ctx)
    return
  }
  const cell = TILE_PX / 2
  ctx.save()
  ctx.fillStyle = 'rgba(220, 38, 38, 0.42)'
  for (let y = 0; y < ah; y++) {
    let runStart = -1
    for (let x = 0; x <= aw; x++) {
      const v = x < aw ? state.voids[y * aw + x] : 0
      if (v) {
        if (runStart < 0) runStart = x
      } else if (runStart >= 0) {
        // Flush a horizontal run of void cells as one fillRect — keeps
        // 70-tile maps from issuing thousands of single-cell fills.
        ctx.fillRect(runStart * cell, y * cell, (x - runStart) * cell, cell)
        runStart = -1
      }
    }
  }
  ctx.restore()
  drawVoidsDragRect(ctx)
}

// drawBuildableOverlay paints a translucent light-blue square on every
// attribute cell where a TA builder could plant a structure.  Rules
// (per BUILDABLE_* constants at the top of the file):
//   - cell isn't a void
//   - cell sits at or above sea level (land-based structures)
//   - height delta across the cell's 3×3 patch is within
//     BUILDABLE_MAX_SLOPE units (a structure's footprint sits across
//     multiple cells, so the engine's slope tolerance is really about
//     the height differential across a patch, not just a single
//     neighbour edge — broad flat regions pass, plateau interiors
//     pass, slope cells fail)
//
// Each painted rectangle is lifted by Height/2 pixels to match the
// visual elevation offset features apply via featureAnchorWorld, so
// the build-plate sits visually on top of the tall structure where
// the player would actually drop a building — not floating at the
// flat tile-grid position with the tower top above it.
//
// Runs of cells in a row that share both buildability AND height are
// flushed as one fillRect so a 256×256 map still renders in a frame.
function drawBuildableOverlay(ctx) {
  if (!state.showBuildable) return
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  if (!state.heights || state.heights.length !== aw * ah) return
  const voids = state.voids && state.voids.length === aw * ah ? state.voids : null
  const seaLevel = state.ota?.seaLevel ?? 0
  const heights = state.heights
  const cell = TILE_PX / 2
  const slopeMax = BUILDABLE_MAX_SLOPE

  const buildable = new Uint8Array(aw * ah)
  for (let y = 0; y < ah; y++) {
    for (let x = 0; x < aw; x++) {
      const idx = y * aw + x
      if (voids && voids[idx]) continue
      const h = heights[idx]
      if (h < seaLevel) continue
      let minH = h, maxH = h
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= ah) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= aw) continue
          const nh = heights[ny * aw + nx]
          if (nh < minH) minH = nh
          if (nh > maxH) maxH = nh
        }
      }
      if (maxH - minH <= slopeMax) buildable[idx] = 1
    }
  }

  ctx.save()
  ctx.fillStyle = BUILDABLE_FILL
  for (let y = 0; y < ah; y++) {
    let runStart = -1
    let runShift = 0
    for (let x = 0; x <= aw; x++) {
      const v = x < aw ? buildable[y * aw + x] : 0
      const shift = v ? (heights[y * aw + x] >> 1) : 0
      if (v && (runStart < 0 || shift === runShift)) {
        if (runStart < 0) { runStart = x; runShift = shift }
      } else {
        if (runStart >= 0) {
          ctx.fillRect(runStart * cell, y * cell - runShift, (x - runStart) * cell, cell)
        }
        if (v) { runStart = x; runShift = shift } else { runStart = -1 }
      }
    }
  }
  ctx.restore()
}

// drawVoidsDragRect now renders the void brush footprint at the cursor
// — a dashed red square sized to state.voidsBrushSize so the user
// sees what their next stamp will affect.  Drawn even when not
// actively painting so the brush size is discoverable on hover.
function drawVoidsDragRect(ctx) {
  if (state.mode !== 'voids' || !state.voidsCursor) return
  const cell = TILE_PX / 2
  const size = Math.max(1, state.voidsBrushSize || 1)
  const off = Math.floor(size / 2)
  const x0 = (state.voidsCursor.ax - off) * cell
  const y0 = (state.voidsCursor.ay - off) * cell
  const w = size * cell
  const h = size * cell
  ctx.save()
  ctx.fillStyle = 'rgba(248, 81, 73, 0.20)'
  ctx.fillRect(x0, y0, w, h)
  ctx.strokeStyle = 'rgba(248, 81, 73, 0.95)'
  ctx.lineWidth = 2
  ctx.setLineDash([6, 4])
  ctx.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2)
  ctx.setLineDash([])
  ctx.restore()
}

function drawSelectedFeatureOutline(ctx) {
  // Single-pick (Place Features) — dashed white box around the feature's
  // footprint cells, so the user sees the area the feature actually
  // occupies on the attribute grid rather than just an anchor circle.
  // Lifted by Height/2 to mirror the same terrain-elevation offset
  // featureAnchorWorld applies, so the box hugs the rendered sprite
  // instead of floating one-to-two tiles below it.
  if (state.selectedFeature >= 0 && state.selectedFeature < state.features.length) {
    const f = state.features[state.selectedFeature]
    const fw = (f.footprintX || 1) * (TILE_PX / 2)
    const fh = (f.footprintZ || 1) * (TILE_PX / 2)
    const x = f.ax * (TILE_PX / 2)
    const y = f.ay * (TILE_PX / 2) - (featureGroundHeight(f) >> 1)
    ctx.save()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.strokeRect(x + 0.5, y + 0.5, fw - 1, fh - 1)
    ctx.setLineDash([])
    ctx.restore()
  }
  // Multi-select (Picker mode) — accent-coloured ring around every
  // selected placement, plus the in-flight rectangle while sweeping.
  if (state.selectedFeatures.size > 0) {
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.95)'
    ctx.lineWidth = 2
    for (const i of state.selectedFeatures) {
      if (i < 0 || i >= state.features.length) continue
      const f = state.features[i]
      const { px, py } = featureAnchorWorld(f)
      ctx.beginPath()
      ctx.arc(px, py, 13, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  if (state.pickerRect) {
    const r = normalizedRect(state.pickerRect)
    ctx.fillStyle = 'rgba(139, 92, 246, 0.12)'
    ctx.fillRect(r.x * TILE_PX, r.y * TILE_PX, r.w * TILE_PX, r.h * TILE_PX)
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.95)'
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 2
    ctx.strokeRect(r.x * TILE_PX + 1, r.y * TILE_PX + 1, r.w * TILE_PX - 2, r.h * TILE_PX - 2)
    ctx.setLineDash([])
  }
}

// FEATURE_HIGHLIGHT_LIMIT — disable the hover-highlight passes
// (canvas red outlines + minimap dots) on heavily populated maps.
// At thousands of features the outline pass becomes the dominant
// cost on each mouse-move; below the limit the visual cue is more
// helpful than the work is expensive.
const FEATURE_HIGHLIGHT_LIMIT = 1000

// drawHighlightedFeatureOutlines draws a red rectangle around every
// placement of the currently-hovered drawer feature.  The rectangle
// follows the feature's footprint so the user can see *exactly* which
// cells are occupied.  Skipped entirely once state.features grows
// past FEATURE_HIGHLIGHT_LIMIT — for huge maps the highlight makes
// every hover feel sluggish and the user can still pick out the
// hovered type via the drawer thumbnail.
function drawHighlightedFeatureOutlines(ctx) {
  if (!state.highlightFeatureName) return
  if ((state.features || []).length > FEATURE_HIGHLIGHT_LIMIT) return
  const indices = getFeaturesByName(state.highlightFeatureName)
  if (!indices.length) return
  const vp = visiblePixelBounds()
  ctx.strokeStyle = '#f85149'
  ctx.lineWidth = 2
  ctx.setLineDash([4, 3])
  for (const idx of indices) {
    const f = state.features[idx]
    const { px, py } = featureAnchorWorld(f)
    const r = featureRenderRect(f, px, py)
    if (r.x + r.w < vp.minX || r.x > vp.maxX || r.y + r.h < vp.minY || r.y > vp.maxY) continue
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
  }
  ctx.setLineDash([])
}

// normalizedRect lives in ./ui/map-editor/helpers.js.

// ── Minimap ────────────────────────────────────────────────────────────────
//
// The minimap used to copy the main canvas via drawImage on every
// render, which is slow on large maps and wrong now that the main
// canvas viewport-culls.  We maintain a separate offscreen "base"
// canvas at minimap resolution that's regenerated only when the tile
// data changes; rendering the visible minimap is then a single
// drawImage from this small cached canvas plus overlay dots and the
// viewport rectangle.

const MINIMAP_PX = 200
const MINIMAP_HOVER_DOT_LIMIT = 100 // if more than this many of the hovered feature exist, skip dots entirely

// minimapBase holds the cached map render at one pixel per tile.
// Feature changes never touch the base — only the dot overlay drawn on
// top by renderMinimap depends on features — so invalidation is split
// between tile-only and feature-only paths.
let minimapBase = null
let minimapBaseStale = true
function invalidateMinimapBase() {
  minimapBaseStale = true
  bumpContentVersion()
}

// contentVersion is bumped any time state.features changes.  Feature
// indices (spatial, name) recompute lazily when their cached version
// falls behind.  Tile changes use invalidateMinimapBase / patchMinimapTile
// directly and do not need to invalidate the feature indices.
let contentVersion = 0
function bumpContentVersion() {
  contentVersion++
  featureSpatial = null
  featureNameIndex = null
}

// sectionThumbCache maps a sectionPath to a downscaled canvas where
// each 32-px source tile collapses to a single pixel.  Built once per
// section via cascading half-size downsamples (browsers handle big
// single-step downscales poorly — direct 32→1 gives essentially one
// sampled pixel, which is what made the minimap look like noise on
// AC01-style maps).  Stored result is tiny (e.g. 64×64 for a 2048×2048
// atlas) and stays valid for the life of the image.
const sectionThumbCache = new Map()
function sectionThumb(path, img) {
  if (!img || !img.complete || img.naturalWidth === 0) return null
  const cached = sectionThumbCache.get(path)
  if (cached && cached.srcW === img.naturalWidth && cached.srcH === img.naturalHeight) {
    return cached.canvas
  }
  const w = img.naturalWidth
  const h = img.naturalHeight
  const targetW = Math.max(1, Math.floor(w / TILE_PX))
  const targetH = Math.max(1, Math.floor(h / TILE_PX))
  let cur = img
  let cw = w, ch = h
  while (cw > targetW * 2 || ch > targetH * 2) {
    const nw = Math.max(targetW, Math.floor(cw / 2))
    const nh = Math.max(targetH, Math.floor(ch / 2))
    const c = document.createElement('canvas')
    c.width = nw
    c.height = nh
    const cctx = c.getContext('2d')
    cctx.imageSmoothingEnabled = true
    cctx.imageSmoothingQuality = 'high'
    cctx.drawImage(cur, 0, 0, nw, nh)
    cur = c
    cw = nw
    ch = nh
  }
  const final = document.createElement('canvas')
  final.width = targetW
  final.height = targetH
  const fctx = final.getContext('2d')
  fctx.imageSmoothingEnabled = true
  fctx.imageSmoothingQuality = 'high'
  fctx.drawImage(cur, 0, 0, targetW, targetH)
  sectionThumbCache.set(path, { canvas: final, srcW: w, srcH: h })
  return final
}

// patchMinimapTile updates a single pixel of the cached minimap base
// for an in-place tile edit (stamp / erase).  Skips when the base is
// already fully stale (a full rebuild will pick it up) or hasn't been
// allocated yet (first render will build it from scratch).
function patchMinimapTile(tx, ty) {
  if (!minimapBase || minimapBaseStale) return
  if (minimapBase.width !== state.tileW || minimapBase.height !== state.tileH) {
    minimapBaseStale = true
    return
  }
  const ctx = minimapBase.getContext('2d')
  const stamp = state.tiles[ty * state.tileW + tx]
  if (!stamp) {
    ctx.fillStyle = VOID_COLOR
    ctx.fillRect(tx, ty, 1, 1)
    return
  }
  const img = state.sectionImages.get(stamp.sectionPath)
  const thumb = sectionThumb(stamp.sectionPath, img)
  if (!thumb) {
    whenImageReady(img, 'minimap-base', invalidateMinimapBase)
    return
  }
  ctx.clearRect(tx, ty, 1, 1)
  ctx.drawImage(thumb, stamp.sx, stamp.sy, 1, 1, tx, ty, 1, 1)
  scheduleMinimapRender()
}

// featureSpatial — tile-keyed bucket of feature indices.  Rebuilt
// lazily by findFeatureAt / featuresNear when contentVersion ticks
// past spatialVersion.  Without this, every mouse-move is O(N) over
// state.features.
let featureSpatial = null
let spatialVersion = -1
function rebuildFeatureSpatial() {
  featureSpatial = new Map()
  const tw = state.tileW
  for (let i = 0; i < state.features.length; i++) {
    const f = state.features[i]
    const tx = Math.floor(f.ax / 2)
    const ty = Math.floor(f.ay / 2)
    const key = ty * tw + tx
    let arr = featureSpatial.get(key)
    if (!arr) { arr = []; featureSpatial.set(key, arr) }
    arr.push(i)
  }
  spatialVersion = contentVersion
}

// featuresNear returns every feature whose ANCHOR tile is within a
// radius of (tx, ty).  Sprites can extend off their anchor so callers
// should still test the final draw rect, but the candidate set is now
// O(radius²) instead of O(N).
function featuresNear(tx, ty, radius) {
  if (!featureSpatial || spatialVersion !== contentVersion) rebuildFeatureSpatial()
  const tw = state.tileW, th = state.tileH
  const lo = { x: Math.max(0, tx - radius), y: Math.max(0, ty - radius) }
  const hi = { x: Math.min(tw - 1, tx + radius), y: Math.min(th - 1, ty + radius) }
  const out = []
  for (let cy = lo.y; cy <= hi.y; cy++) {
    for (let cx = lo.x; cx <= hi.x; cx++) {
      const arr = featureSpatial.get(cy * tw + cx)
      if (arr) for (const i of arr) out.push(i)
    }
  }
  return out
}

// featureNameIndex — name → array of indices.  Used by the hover
// outline + minimap dot loop, which previously walked all features
// looking for matches.  Same lifetime as featureSpatial.
let featureNameIndex = null
let nameIndexVersion = -1
function getFeaturesByName(name) {
  if (!featureNameIndex || nameIndexVersion !== contentVersion) {
    featureNameIndex = new Map()
    for (let i = 0; i < state.features.length; i++) {
      const n = (state.features[i].name || '').toLowerCase()
      let arr = featureNameIndex.get(n)
      if (!arr) { arr = []; featureNameIndex.set(n, arr) }
      arr.push(i)
    }
    nameIndexVersion = contentVersion
  }
  return featureNameIndex.get(name) || []
}

let minimapRenderQueued = false
function scheduleMinimapRender() {
  if (minimapRenderQueued) return
  minimapRenderQueued = true
  requestAnimationFrame(() => {
    minimapRenderQueued = false
    renderMinimap()
  })
}

// scheduleRenderCanvas batches main-canvas redraws into one rAF tick so
// rapid scroll events don't fire dozens of renders per frame.
let canvasRenderQueued = false
function scheduleRenderCanvas() {
  if (canvasRenderQueued) return
  canvasRenderQueued = true
  requestAnimationFrame(() => {
    canvasRenderQueued = false
    renderCanvas()
  })
}

function rebuildMinimapBase() {
  if (!minimapBase) minimapBase = document.createElement('canvas')
  // Base is one pixel per tile.  Per-tile colour comes from the cached
  // section thumb (cascading downsample) rather than drawImage'ing the
  // raw 32×32 source rect to 1 px, which collapses to a single sampled
  // pixel on most browsers and looks like static.
  const W = state.tileW
  const H = state.tileH
  if (minimapBase.width !== W || minimapBase.height !== H) {
    minimapBase.width = W
    minimapBase.height = H
  }
  const ctx = minimapBase.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, W, H)
  for (let ty = 0; ty < state.tileH; ty++) {
    for (let tx = 0; tx < state.tileW; tx++) {
      const stamp = state.tiles[ty * state.tileW + tx]
      if (!stamp) continue
      const img = state.sectionImages.get(stamp.sectionPath)
      const thumb = sectionThumb(stamp.sectionPath, img)
      if (!thumb) {
        whenImageReady(img, 'minimap-base', invalidateMinimapBase)
        continue
      }
      ctx.drawImage(thumb, stamp.sx, stamp.sy, 1, 1, tx, ty, 1, 1)
    }
  }
  minimapBaseStale = false
}

function renderMinimap() {
  const mini = $('#minimap')
  if (!mini) return
  const ctx = mini.getContext('2d')
  ctx.imageSmoothingEnabled = false

  // Preserve aspect ratio: fit the map into MINIMAP_PX × MINIMAP_PX.
  const ratio = state.tileW / state.tileH
  let dw = MINIMAP_PX
  let dh = MINIMAP_PX
  if (ratio >= 1) {
    dh = Math.round(MINIMAP_PX / ratio)
  } else {
    dw = Math.round(MINIMAP_PX * ratio)
  }
  mini.width = MINIMAP_PX
  mini.height = MINIMAP_PX
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, MINIMAP_PX, MINIMAP_PX)
  const ox = Math.floor((MINIMAP_PX - dw) / 2)
  const oy = Math.floor((MINIMAP_PX - dh) / 2)
  if (minimapBaseStale) rebuildMinimapBase()
  if (minimapBase) {
    ctx.drawImage(minimapBase, 0, 0, minimapBase.width, minimapBase.height, ox, oy, dw, dh)
  }

  // Feature dots: only drawn for the currently-highlighted feature
  // type so a dense map doesn't drown the minimap in red specks.
  // Highlight comes from drawer hover or canvas hover — when nothing
  // is hovered we draw none.  Skipped entirely when the hovered type
  // has more than MINIMAP_HOVER_DOT_LIMIT placements (the dots would
  // just look like a uniform haze and we'd pay the loop cost on every
  // mouse-move).
  const target = state.highlightFeatureName
  // Same opt-out as the canvas outline pass — once the map crosses
  // FEATURE_HIGHLIGHT_LIMIT total features the highlight makes every
  // mouse-move sluggish, so disable both.
  if (target && (state.features || []).length <= FEATURE_HIGHLIGHT_LIMIT) {
    const indices = getFeaturesByName(target)
    if (indices.length > 0 && indices.length <= MINIMAP_HOVER_DOT_LIMIT) {
      ctx.fillStyle = '#f85149'
      for (const idx of indices) {
        const f = state.features[idx]
        const a = featureAnchorWorld(f)
        const px = ox + (a.px / (state.tileW * TILE_PX)) * dw
        const py = oy + (a.py / (state.tileH * TILE_PX)) * dh
        ctx.beginPath()
        ctx.arc(px, py, 2.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  drawMinimapStartPositions(ctx, ox, oy, dw, dh)

  updateMinimapViewport(ox, oy, dw, dh)
}

// drawMinimapStartPositions overlays the active schema's start markers
// onto the minimap as numbered gold circles.  Always rendered (no
// hover gate) so the user can see at a glance where the players spawn
// — the markers double as a sanity check that the schema lines up with
// the terrain.
function drawMinimapStartPositions(ctx, ox, oy, dw, dh) {
  const schema = activeSchema?.()
  if (!schema || !schema.startPositions || schema.startPositions.length === 0) return
  const fontFamily = getComputedStyle(document.body).fontFamily
  const mapW = state.tileW * TILE_PX
  const mapH = state.tileH * TILE_PX
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const sp of schema.startPositions) {
    if (typeof sp.x !== 'number' || typeof sp.z !== 'number') continue
    const px = ox + (sp.x / mapW) * dw
    const py = oy + (sp.z / mapH) * dh
    ctx.fillStyle = 'rgba(255, 200, 0, 0.95)'
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(px, py, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#1a1a1a'
    ctx.font = `bold 14px ${fontFamily}`
    ctx.fillText(String(sp.number || ''), px, py + 1)
  }
  ctx.restore()
}

// updateMinimapViewport draws a rectangle showing what portion of the map
// is currently visible in the scroll viewport.
function updateMinimapViewport(ox, oy, dw, dh) {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  const vp = $('#minimap-viewport')
  if (!wrap || !canvas || !vp) return
  const fullW = canvas.width * state.zoom
  const fullH = canvas.height * state.zoom
  if (fullW <= wrap.clientWidth && fullH <= wrap.clientHeight) {
    vp.style.display = 'none'
    return
  }
  vp.style.display = 'block'
  // Scroll position is in stack-pixels; the canvas starts at the padding
  // offset, so subtract that and clamp to the map for the minimap rect.
  const sL = clamp(wrap.scrollLeft - overscrollPadding.x, 0, fullW)
  const sT = clamp(wrap.scrollTop - overscrollPadding.y, 0, fullH)
  const fracL = sL / fullW
  const fracT = sT / fullH
  const fracW = Math.min(1, wrap.clientWidth / fullW)
  const fracH = Math.min(1, wrap.clientHeight / fullH)

  // vp lives inside .minimap-body, which is position:relative and is the
  // viewport's offset parent.  The minimap canvas itself sits at (0,0)
  // within that body, occupying its full size — the content (after
  // aspect-ratio fit) lies in [ox..ox+dw] × [oy..oy+dh] of the canvas.
  vp.style.left = (ox + fracL * dw) + 'px'
  vp.style.top = (oy + fracT * dh) + 'px'
  vp.style.width = (fracW * dw) + 'px'
  vp.style.height = (fracH * dh) + 'px'
}

function wireMinimap() {
  // The minimap panel is React-managed (see
  // /ui/map-editor/panels/minimap-panel.js).  Mouse panning routes
  // through the map-ribbon bridge's minimapBeginPan / Pan / EndPan
  // actions, which the host translates via _doMinimapPan.  FloatingPanel
  // owns drag / collapse / close / position persistence — no per-id
  // wiring left to do here.  Scroll-driven re-renders still need to
  // bump scheduleMinimapRender so the viewport overlay tracks scroll.
  const wrap = $('#canvas-scroll')
  if (wrap) {
    wrap.addEventListener('scroll', () => {
      scheduleRenderCanvas()
      scheduleMinimapRender()
    })
  }
}

// setMinimapVisible / setFeaturesVisible / setStartPositionsVisible /
// setVoidsVisible / applyMinimapPosition moved to
// /ui/map-editor/view-toggles.js — imported at the top of this
// file.

// ── Developer stats panel + dialog ────────────────────────────────────────
//
// The mini panel is a fixed-position widget next to the minimap with
// live counts (distinct tiles, distinct/total features).  The "Developer"
// button in the ribbon opens a richer dialog that shows the same counts
// plus a thumbnail grid of every distinct tile stamped on the map.

// distinctTileKey identifies a stamp's visible appearance — the source
// tile (sectionPath, sx, sy) and the rotation/flip applied to it.  This
// matches what builder.go bakes into the saved TNT's tile pool.
function distinctTileKey(stamp) {
  if (!stamp || !stamp.sectionPath) return null
  return `${stamp.sectionPath}|${stamp.sx}|${stamp.sy}|${stamp.rotation || 0}|${stamp.flipH ? 1 : 0}|${stamp.flipV ? 1 : 0}`
}

function computeDevStats() {
  const tileKeys = new Map() // key → { stamp, count }
  let occupied = 0
  for (const stamp of state.tiles || []) {
    const k = distinctTileKey(stamp)
    if (!k) continue
    occupied++
    const entry = tileKeys.get(k)
    if (entry) entry.count++
    else tileKeys.set(k, { stamp, count: 1 })
  }
  const featureNames = new Set()
  for (const f of state.features || []) {
    featureNames.add((f.name || '').toLowerCase())
  }
  const sectionPaths = new Set()
  for (const v of tileKeys.values()) sectionPaths.add(v.stamp.sectionPath)
  const total = (state.tileW || 0) * (state.tileH || 0)
  const compression = (occupied > 0) ? (occupied / tileKeys.size) : 0
  return {
    distinctTiles: tileKeys.size,
    distinctFeatures: featureNames.size,
    totalFeatures: (state.features || []).length,
    sectionsUsed: sectionPaths.size,
    occupiedTiles: occupied,
    totalTiles: total,
    compressionRatio: compression,
    tileEntries: tileKeys, // for the dialog grid
  }
}

let devStatsRefreshQueued = false
let lastDevStatsVersion = -1
function scheduleDevStatsRefresh() {
  // Cheap no-op when the underlying data hasn't changed — high-freq
  // renders (scroll, hover, drag preview) skip the rAF entirely.
  // The dialog's open() call refreshes directly, so we don't have to
  // poll for it here.
  if (lastDevStatsVersion === contentVersion) return
  if (devStatsRefreshQueued) return
  devStatsRefreshQueued = true
  requestAnimationFrame(() => {
    devStatsRefreshQueued = false
    lastDevStatsVersion = contentVersion
    refreshDevStats()
  })
}

// devStatsCache memoises the last computeDevStats result and the
// content-version it was built for.  On a 256×256 map with thousands
// of features computeDevStats is the heaviest per-render work; gating
// it on contentVersion keeps scroll/hover from recomputing.
let devStatsCache = null
let devStatsCacheVersion = -1
function getDevStats() {
  if (devStatsCache && devStatsCacheVersion === contentVersion) return devStatsCache
  devStatsCache = computeDevStats()
  devStatsCacheVersion = contentVersion
  return devStatsCache
}
function refreshDevStats() {
  const dlgOpen = !$('#developer-dialog')?.classList.contains('hidden')
  // Skip the full compute when content hasn't changed AND the dialog
  // isn't open (its tile grid is the only reader that NEEDS the live
  // tileEntries map; the panel just shows the three counts).
  const stats = getDevStats()
  // Publish to the React Map Stats panel via the inspector store.
  if (_reactUi && typeof _reactUi.publishMapStats === 'function') {
    _reactUi.publishMapStats(stats)
  }
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = String(v) }
  // Legacy DOM lookup retained for the Developer dialog's table cells
  // — those still live inside the dev-dialog markup and want refresh
  // via the same compute call.
  set('dev-stats-distinct-tiles', stats.distinctTiles)
  set('dev-stats-distinct-features', stats.distinctFeatures)
  set('dev-stats-total-features', stats.totalFeatures)
  if (dlgOpen) {
    set('dev-dlg-distinct-tiles', stats.distinctTiles)
    set('dev-dlg-sections-used', stats.sectionsUsed)
    set('dev-dlg-occupied', `${stats.occupiedTiles} / ${stats.totalTiles}`)
    set('dev-dlg-compression', stats.compressionRatio > 0 ? `${stats.compressionRatio.toFixed(2)}×` : '—')
    renderDevTilesGrid(stats.tileEntries)
    renderDevDiagnostics()
  }
}

// renderDevDiagnostics fills the Camera & Canvas tab with live numbers
// pulled straight from the rendering DOM so the user can see exactly
// what state the renderer is reading.  Read-only — purely for debugging.
function renderDevDiagnostics() {
  const tbody = $('#dev-diag-table tbody')
  if (!tbody) return
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  const wrap = $('#canvas-scroll')
  const stack = $('#canvas-stack')
  const num = (v, suffix = '') => (v == null ? '—' : `${v}${suffix}`)
  const tb = (typeof visibleTileBounds === 'function') ? visibleTileBounds() : null
  const vp = (typeof visiblePixelBounds === 'function') ? visiblePixelBounds() : null
  const rows = [
    ['Mode', state.mode || '—'],
    ['View mode', state.viewMode || '—'],
    ['Zoom', `${(state.zoom * 100).toFixed(1)}%  (raw ${state.zoom.toFixed(4)})`],
    ['Map size (tiles)', `${state.tileW} × ${state.tileH}  (attr ${state.tileW * 2} × ${state.tileH * 2})`],
    ['Map size (game-px)', `${state.tileW * TILE_PX} × ${state.tileH * TILE_PX}`],
    ['2D canvas backing buffer', canvas ? `${canvas.width} × ${canvas.height}` : '—'],
    ['2D canvas CSS size', canvas ? `${parseFloat(canvas.style.width || 0).toFixed(1)} × ${parseFloat(canvas.style.height || 0).toFixed(1)}` : '—'],
    ['GL canvas backing buffer', glCanvas ? `${glCanvas.width} × ${glCanvas.height}` : '—'],
    ['GL canvas CSS size', glCanvas ? `${parseFloat(glCanvas.style.width || 0).toFixed(1)} × ${parseFloat(glCanvas.style.height || 0).toFixed(1)}` : '—'],
    ['Scroll viewport (canvas-scroll)', wrap ? `${wrap.clientWidth} × ${wrap.clientHeight}` : '—'],
    ['Scroll position', wrap ? `(${wrap.scrollLeft}, ${wrap.scrollTop})` : '—'],
    ['Stack size (canvas-stack)', stack ? `${parseFloat(stack.style.width || 0).toFixed(0)} × ${parseFloat(stack.style.height || 0).toFixed(0)}` : '—'],
    ['Overscroll padding', `(${overscrollPadding.x}, ${overscrollPadding.y})`],
    ['Canvas offset (left, top)', canvas ? `(${parseFloat(canvas.style.left || 0).toFixed(0)}, ${parseFloat(canvas.style.top || 0).toFixed(0)})` : '—'],
    ['Visible tile bounds', tb ? `tx [${tb.minTX}..${tb.maxTX}]  ty [${tb.minTY}..${tb.maxTY}]` : '—'],
    ['Visible pixel bounds', vp ? `x [${vp.minX}..${vp.maxX}]  y [${vp.minY}..${vp.maxY}]` : '—'],
    ['Content version', num(typeof contentVersion === 'number' ? contentVersion : null)],
    ['Tile / feature counts', `${(state.tiles || []).filter(Boolean).length} tile cells • ${(state.features || []).length} features`],
    ['Renderer', (typeof ensureGLRenderer === 'function' && ensureGLRenderer()) ? 'WebGL2 (tiles+features)' : '2D fallback'],
    ['devicePixelRatio', String(window.devicePixelRatio || 1)],
  ]
  // Re-build the table contents from scratch — small enough that the
  // cost is negligible and avoids per-row id juggling.
  tbody.replaceChildren(...rows.map(([label, value]) => {
    const tr = document.createElement('tr')
    const th = document.createElement('th'); th.textContent = label
    const td = document.createElement('td'); td.textContent = value
    tr.appendChild(th); tr.appendChild(td)
    return tr
  }))
}

function wireDeveloperPanel() {
  const panel = $('#dev-stats-panel')
  const toggle = $('#dev-stats-toggle')
  const header = $('#dev-stats-header')
  if (!panel || !toggle || !header) return
  toggle.addEventListener('click', () => {
    panel.classList.toggle('collapsed')
    toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−'
    persistPanelCollapsed('dev-stats-panel', panel.classList.contains('collapsed'))
  })
  makePanelDraggable(panel, header)
}

// makePanelDraggable wires a header element to drag its panel within
// makePanelDraggable / persistPanelLayout / persistPanelCollapsed /
// applyPanelLayout moved to /ui/common/panel-layout.js — imported
// at the top of this file.  Used by the dev-stats and camera-info
// panels (the React-managed Stats / Minimap / Camera panels own
// their own position via the panel-store + FloatingPanel).

function wireDeveloperDialog() {
  $('#btn-developer')?.addEventListener('click', openDeveloperDialog)
  $('#dev-dialog-close')?.addEventListener('click', closeDeveloperDialog)
  $('#btn-help')?.addEventListener('click', openHelpDialog)
  $('#help-close')?.addEventListener('click', closeHelpDialog)
  // Help dialog tab strip — same DOM pattern as the welcome tabs.
  $$('#help-dialog .help-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.helpTab
      $$('#help-dialog .help-tab').forEach((t) => {
        const on = t.dataset.helpTab === key
        t.classList.toggle('active', on)
        t.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      $$('#help-dialog .help-tab-body').forEach((b) => {
        b.classList.toggle('active', b.dataset.helpTabBody === key)
      })
    })
  })
  $('#btn-settings')?.addEventListener('click', openSettingsDialog)
  // Apply / Reset / Escape are handled by the React Settings dialog
  // itself (see /ui/dialogs/settings-dialog.js).  The legacy static
  // #settings-apply / #settings-reset / #settings-cancel buttons in
  // the static HTML are no longer driven.
  // Settings dialog tab strip is React-managed now.
  $$('#developer-dialog .dev-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.devTab
      $$('#developer-dialog .dev-tab').forEach((t) => t.classList.toggle('active', t === tab))
      $$('#developer-dialog .dev-tab-body').forEach((b) => b.classList.toggle('active', b.dataset.devTabBody === key))
    })
  })
}

function openDeveloperDialog() {
  const dlg = $('#developer-dialog')
  if (!dlg) return
  dlg.classList.remove('hidden')
  // Default to the Distinct Tiles tab.
  $$('#developer-dialog .dev-tab').forEach((t, i) => t.classList.toggle('active', i === 0))
  $$('#developer-dialog .dev-tab-body').forEach((b, i) => b.classList.toggle('active', i === 0))
  refreshDevStats()
}

function closeDeveloperDialog() {
  $('#developer-dialog')?.classList.add('hidden')
}

function openHelpDialog() {
  const dlg = $('#help-dialog')
  if (!dlg) return
  dlg.classList.remove('hidden')
  // Focus the Close button so Enter / Space dismiss matches Escape.
  $('#help-close')?.focus()
}

function closeHelpDialog() {
  $('#help-dialog')?.classList.add('hidden')
}

// ── Settings dialog ────────────────────────────────────────────────
//
// state.settings is the canonical source of truth, persisted via the
// PrefsStore alongside the visibility toggles.  Opening the dialog
// populates the form controls from current values; Apply pushes them
// back and re-renders affected UI.  Reset restores the shipped
// defaults defined in the sessionState declaration.

const DEFAULT_SETTINGS = {
  zoomStep: 1.25,
  heartbeatIdleMs: 5000,
  heartbeatReconnectMs: 1000,
  defaultEraseSize: 1,
  defaultVoidsSize: 1,
  defaultHmRadius: 4,
  defaultHmStrength: 4,
  // Unit Editor defaults — applied when a new model tab opens.
  unitDefaultEnv: 'greenworld',
  unitDefaultReflections: true,
  unitDefaultBob: true,
  unitDefaultWaterReflections: true,
  unitDefaultSpecular: true,
  unitDefaultGodBeams: true,
}

// openSettingsDialog — React-managed now (see /ui/dialogs/settings-dialog.js).
// Snapshots the current state into the initial form values, then hands
// the dialog the apply + reset callbacks.  Apply pushes back into the
// host's state.settings + flushes downstream effects (minimap toggle,
// View-menu flags, canvas re-render, prefs persist).
function openSettingsDialog() {
  if (!_reactUi || typeof _reactUi.openSettingsDialog !== 'function') return
  const s = state.settings || DEFAULT_SETTINGS
  const activeTab = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  const defaultTab = activeTab?.type === 'model' ? 'unit'
    : activeTab?.type === 'map' ? 'map'
    : 'general'
  // forceTargetGround lives in localStorage (force-target.js owns it).
  // Default OFF — the unit viewer's plain canvas click should orbit the
  // camera, not fire the primary weapon at whatever the ground raycast
  // hits.  Mirrors force-target.js's forceTargetEnabled() default.
  let forceTargetGround = false
  try { forceTargetGround = (localStorage.getItem('studio.forceTargetGround') === 'on') } catch { /* ignore */ }
  const envOptions = WORLDS.map((w) => ({ key: w.slug, label: w.label }))
  const initial = {
    zoomStep:                  s.zoomStep ?? 1.25,
    defaultEraseSize:          s.defaultEraseSize ?? 1,
    defaultVoidsSize:          s.defaultVoidsSize ?? 1,
    defaultHmRadius:           s.defaultHmRadius ?? 4,
    defaultHmStrength:         s.defaultHmStrength ?? 4,
    heartbeatIdleMs:           s.heartbeatIdleMs ?? 5000,
    heartbeatReconnectMs:      s.heartbeatReconnectMs ?? 1000,
    showMinimap:               !!state.showMinimap,
    showCameraInfo:            !!state.showCameraInfo,
    showGridlines:             !!state.showGridlines,
    animateFeatures:           !!state.animateFeatures,
    showVoids:                 !!state.showVoids,
    showContours:              !!state.showContours,
    showBuildable:             !!state.showBuildable,
    showFeatures:              !!state.showFeatures,
    showStartPositions:        !!state.showStartPositions,
    unitDefaultEnv:            s.unitDefaultEnv ?? 'greenworld',
    unitDefaultReflections:    s.unitDefaultReflections !== false,
    unitDefaultBob:            s.unitDefaultBob !== false,
    unitDefaultWaterReflections: s.unitDefaultWaterReflections !== false,
    unitDefaultSpecular:       s.unitDefaultSpecular !== false,
    unitDefaultGodBeams:       s.unitDefaultGodBeams !== false,
    forceTargetGround,
  }
  void _reactUi.openSettingsDialog({
    initial,
    envOptions,
    defaultTab,
    onApply: (v) => {
      const next = { ...DEFAULT_SETTINGS, ...(state.settings || {}) }
      next.zoomStep             = clamp(+v.zoomStep || 1.25, 1.05, 2)
      next.defaultEraseSize     = clamp(Math.round(+v.defaultEraseSize || 1), 1, 16)
      next.defaultVoidsSize     = clamp(Math.round(+v.defaultVoidsSize || 1), 1, 32)
      next.defaultHmRadius      = clamp(Math.round(+v.defaultHmRadius || 4), 1, 32)
      next.defaultHmStrength    = clamp(Math.round(+v.defaultHmStrength || 4), 1, 32)
      next.heartbeatIdleMs      = clamp(Math.round(+v.heartbeatIdleMs || 5000), 500, 60000)
      next.heartbeatReconnectMs = clamp(Math.round(+v.heartbeatReconnectMs || 1000), 200, 10000)
      next.unitDefaultEnv               = v.unitDefaultEnv || 'greenworld'
      next.unitDefaultReflections       = !!v.unitDefaultReflections
      next.unitDefaultBob               = !!v.unitDefaultBob
      next.unitDefaultWaterReflections  = !!v.unitDefaultWaterReflections
      next.unitDefaultSpecular          = !!v.unitDefaultSpecular
      next.unitDefaultGodBeams          = !!v.unitDefaultGodBeams
      state.settings = next
      try { localStorage.setItem('studio.forceTargetGround', v.forceTargetGround ? 'on' : 'off') } catch { /* ignore */ }
      setMinimapVisible(!!v.showMinimap)
      setCameraInfoVisible(!!v.showCameraInfo)
      state.showGridlines       = !!v.showGridlines
      state.animateFeatures     = !!v.animateFeatures
      state.showVoids           = !!v.showVoids
      state.showContours        = !!v.showContours
      state.showBuildable       = !!v.showBuildable
      state.showFeatures        = !!v.showFeatures
      state.showStartPositions  = !!v.showStartPositions
      syncDomFromPrefs()
      persistPrefs()
      renderCanvas()
      setStatus('Settings applied and saved.')
    },
    onReset: () => {
      // Restore SHIPPED defaults into the form (the React component
      // re-seeds its local state from whatever this returns).  Doesn't
      // commit — the user still has to hit Apply.
      state.settings = { ...DEFAULT_SETTINGS }
      return {
        ...initial,
        zoomStep:                  DEFAULT_SETTINGS.zoomStep,
        defaultEraseSize:          DEFAULT_SETTINGS.defaultEraseSize,
        defaultVoidsSize:          DEFAULT_SETTINGS.defaultVoidsSize,
        defaultHmRadius:           DEFAULT_SETTINGS.defaultHmRadius,
        defaultHmStrength:         DEFAULT_SETTINGS.defaultHmStrength,
        heartbeatIdleMs:           DEFAULT_SETTINGS.heartbeatIdleMs,
        heartbeatReconnectMs:      DEFAULT_SETTINGS.heartbeatReconnectMs,
        unitDefaultEnv:            DEFAULT_SETTINGS.unitDefaultEnv,
        unitDefaultReflections:    DEFAULT_SETTINGS.unitDefaultReflections,
        unitDefaultBob:            DEFAULT_SETTINGS.unitDefaultBob,
        unitDefaultWaterReflections: DEFAULT_SETTINGS.unitDefaultWaterReflections,
        unitDefaultSpecular:       DEFAULT_SETTINGS.unitDefaultSpecular,
        unitDefaultGodBeams:       DEFAULT_SETTINGS.unitDefaultGodBeams,
      }
    },
  })
}

function closeSettingsDialog() {
  if (_reactUi && typeof _reactUi.closeSettingsDialog === 'function') {
    _reactUi.closeSettingsDialog()
  }
}

// renderDevTilesGrid paints a thumbnail per distinct tile + occurrence
// count.  Each thumbnail is a tiny canvas that copies the right 32x32
// region of the source section image and applies the same rotation /
// flip the stamp uses — so the user sees the tile exactly as it appears
// on the map.
function renderDevTilesGrid(tileEntries) {
  const grid = $('#dev-tiles-grid')
  if (!grid) return
  // Sort by descending count so the most-used tiles show first.
  const rows = Array.from(tileEntries.values()).sort((a, b) => b.count - a.count)
  const frag = document.createDocumentFragment()
  for (const { stamp, count } of rows) {
    const cell = document.createElement('div')
    cell.className = 'dev-tile-cell'
    const cnv = document.createElement('canvas')
    cnv.width = 32; cnv.height = 32
    cnv.style.width = '56px'
    cnv.style.height = '56px'
    cnv.style.imageRendering = 'pixelated'
    const cctx = cnv.getContext('2d')
    cctx.imageSmoothingEnabled = false
    const img = state.sectionImages.get(stamp.sectionPath)
    if (img && img.complete && img.naturalWidth > 0) {
      // drawTransformedTile draws into a 32-px target slot starting at
      // (dx, dy); pass TILE_PX-sized coords by temporarily overriding
      // since the canvas is exactly TILE_PX (32) wide.
      drawTransformedTile(cctx, img, stamp.sx, stamp.sy, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV, 0, 0)
    } else {
      cctx.fillStyle = '#3a4d61'
      cctx.fillRect(0, 0, 32, 32)
      whenImageReady(img, 'dev-stats', refreshDevStats)
    }
    cell.appendChild(cnv)
    const tag = document.createElement('div')
    tag.className = 'dev-tile-count'
    tag.textContent = String(count)
    cell.appendChild(tag)
    cell.title = `${stamp.sectionPath} · (${stamp.sx},${stamp.sy})  rot=${stamp.rotation || 0}${stamp.flipH ? ' H' : ''}${stamp.flipV ? ' V' : ''}\n${count}× on map`
    frag.appendChild(cell)
  }
  grid.replaceChildren(frag)
}

const MIN_ZOOM = 0.01
const MAX_ZOOM = 2

function setZoom(z) {
  state.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM)
  const canvas = $('#canvas')
  const w = canvas.width * state.zoom + 'px'
  const h = canvas.height * state.zoom + 'px'
  canvas.style.width = w
  canvas.style.height = h
  const glCanvas = $('#canvas-gl')
  if (glCanvas) {
    glCanvas.style.width = w
    glCanvas.style.height = h
  }
  applyOverscrollPadding()
  scheduleRenderCanvas()
  scheduleMinimapRender()
}

// overscrollPadding tracks the half-viewport padding currently applied
// to .canvas-stack so visibleTileBounds and the minimap viewport
// rectangle can convert scroll position back to canvas-pixel space.
const overscrollPadding = { x: 0, y: 0 }

// applyOverscrollPadding resizes .canvas-stack to (map + viewport) and
// positions both canvases at the centre of that padded box, so the
// scroll container can pan the map past any edge until the centre of
// the viewport reaches a map corner.  Scroll position is adjusted by
// the padding delta so the rendered scene doesn't visibly jump when
// padding grows or shrinks (window resize, zoom change).
function applyOverscrollPadding() {
  const wrap = $('#canvas-scroll')
  const stack = $('#canvas-stack')
  const canvas = $('#canvas')
  const glCanvas = $('#canvas-gl')
  if (!wrap || !stack || !canvas) return
  const padX = Math.max(0, Math.floor(wrap.clientWidth / 2))
  const padY = Math.max(0, Math.floor(wrap.clientHeight / 2))
  const canvasW = parseFloat(canvas.style.width) || canvas.width
  const canvasH = parseFloat(canvas.style.height) || canvas.height
  const stackW = canvasW + padX * 2
  const stackH = canvasH + padY * 2
  const stackWS = stackW + 'px'
  const stackHS = stackH + 'px'
  if (stack.style.width !== stackWS) stack.style.width = stackWS
  if (stack.style.height !== stackHS) stack.style.height = stackHS
  const padXS = padX + 'px'
  const padYS = padY + 'px'
  if (canvas.style.left !== padXS) canvas.style.left = padXS
  if (canvas.style.top !== padYS) canvas.style.top = padYS
  if (glCanvas) {
    if (glCanvas.style.left !== padXS) glCanvas.style.left = padXS
    if (glCanvas.style.top !== padYS) glCanvas.style.top = padYS
  }
  if (overscrollPadding.x !== padX) {
    wrap.scrollLeft += padX - overscrollPadding.x
    overscrollPadding.x = padX
  }
  if (overscrollPadding.y !== padY) {
    wrap.scrollTop += padY - overscrollPadding.y
    overscrollPadding.y = padY
  }
}

// zoomAtPointer scales around a screen-space point (typically the cursor
// during a wheel event) so the map pixel under that point stays anchored.
// `deltaY` follows the WheelEvent convention: positive = zoom out.
function zoomAtPointer(clientX, clientY, deltaY) {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  if (!wrap || !canvas) return

  const rect = canvas.getBoundingClientRect()
  // Map-pixel coords under the cursor before the zoom change.
  const mapX = (clientX - rect.left) / state.zoom
  const mapY = (clientY - rect.top) / state.zoom

  // Pinch trackpads emit very small deltas; mouse wheels emit large ones.
  // Normalise so a single wheel click is ~1.1×.
  const step = Math.exp(-deltaY * 0.0015)
  const newZoom = clamp(state.zoom * step, MIN_ZOOM, MAX_ZOOM)
  if (newZoom === state.zoom) return
  setZoom(newZoom)

  // Re-anchor the cursor: after the canvas size changes, the same map
  // pixel should appear under the same client point.  The canvas's new
  // top-left in client coords is (clientX - mapX * newZoom).  The scroll
  // wrap's top-left is at wrap.getBoundingClientRect().{left,top}, so the
  // canvas's offset inside the scroll content equals
  //   newCanvasLeft = scrollLeft + (canvas.offsetLeft relative to content)
  // Easiest path: compute the new desired scroll directly.
  const wrapRect = wrap.getBoundingClientRect()
  // The canvas sits at overscrollPadding inside .canvas-stack, so the
  // scroll position that puts map pixel (mapX, mapY) under the cursor
  // is offset by the same padding.
  wrap.scrollLeft = mapX * newZoom - (clientX - wrapRect.left) + overscrollPadding.x
  wrap.scrollTop = mapY * newZoom - (clientY - wrapRect.top) + overscrollPadding.y
}

function fitZoom() {
  const wrap = $('#canvas-scroll')
  const canvas = $('#canvas')
  const zx = wrap.clientWidth / canvas.width
  const zy = wrap.clientHeight / canvas.height
  setZoom(Math.min(zx, zy) * 0.95)
}

// Continuous pan via held arrow keys.  startMapPan / stopMapPan
// register a direction in heldPanKeys; mapPanRAF drives a rAF loop
// that scrolls every frame at MAP_PAN_RATE_PX_S, ramping the speed
// up to MAP_PAN_ACCEL_MAX_MULT over MAP_PAN_ACCEL_TIME_MS.  Native
// scrollLeft / Top clamping handles edge cases at the map boundary.
const heldPanKeys = new Map() // key -> { dx, dy, pressedAt }
let mapPanRAF = 0
let mapPanLastT = 0

function startMapPan(key, dx, dy) {
  if (heldPanKeys.has(key)) return
  heldPanKeys.set(key, { dx, dy, pressedAt: performance.now() })
  if (mapPanRAF) return
  mapPanLastT = performance.now()
  mapPanRAF = requestAnimationFrame(mapPanTick)
}

function stopMapPan(key) {
  heldPanKeys.delete(key)
  if (heldPanKeys.size === 0 && mapPanRAF) {
    cancelAnimationFrame(mapPanRAF)
    mapPanRAF = 0
  }
}

function mapPanTick(now) {
  mapPanRAF = 0
  const wrap = $('#canvas-scroll')
  if (!wrap || heldPanKeys.size === 0) return
  const dt = Math.min(0.1, (now - mapPanLastT) / 1000 || 0)
  mapPanLastT = now
  let dxSum = 0, dySum = 0
  for (const entry of heldPanKeys.values()) {
    const heldMs = now - entry.pressedAt
    const ramp = Math.min(1, heldMs / MAP_PAN_ACCEL_TIME_MS)
    const mult = 1 + ramp * (MAP_PAN_ACCEL_MAX_MULT - 1)
    const px = MAP_PAN_RATE_PX_S * mult * (state.zoom || 1) * dt
    dxSum += entry.dx * px
    dySum += entry.dy * px
  }
  if (dxSum) wrap.scrollLeft += dxSum
  if (dySum) wrap.scrollTop  += dySum
  mapPanRAF = requestAnimationFrame(mapPanTick)
}

function stopAllMapPan() {
  heldPanKeys.clear()
  if (mapPanRAF) { cancelAnimationFrame(mapPanRAF); mapPanRAF = 0 }
}

// ── Toolbar ────────────────────────────────────────────────────────────────

function wireToolbar() {
  // Most of the ribbon-side buttons (#btn-save, #btn-undo, the
  // Edit / Mode / View / Advanced dropdowns, etc.) are React-managed
  // now — the migration moves them into MapRibbon and the host bridge
  // routes the clicks through to the legacy handlers below.  The
  // optional-chaining guards below short-circuit when those static
  // elements are absent (the ribbon's hidden template still ships
  // them so they're harmless when present).
  $('#btn-save')?.addEventListener('click', save)
  $('#btn-save-loose')?.addEventListener('click', saveLoose)
  $('#btn-resize')?.addEventListener('click', openResizeDialog)
  $('#btn-scatter')?.addEventListener('click', openScatterDialog)
  $('#scatter-cancel')?.addEventListener('click', closeScatterDialog)
  $('#scatter-apply')?.addEventListener('click', applyScatter)
  $('#btn-export-heightmap')?.addEventListener('click', exportHeightmap)
  $('#btn-export-minimap')?.addEventListener('click', exportMinimap)
  $('#btn-export-full-render')?.addEventListener('click', exportFullRender)
  $('#btn-export-map-image')?.addEventListener('click', exportMapImage)
  $('#btn-export-buildmap')?.addEventListener('click', exportBuildmap)
  $('#btn-export-voidmap')?.addEventListener('click', exportVoidmap)
  $('#btn-quality-audit')?.addEventListener('click', () => {
    // Advanced › Quality Check… — standalone audit, no save afterward.
    runQualityChecker(buildSavePayload(), { mode: 'audit' })
  })
  $('#btn-import-heightmap')?.addEventListener('click', () => $('#import-heightmap-file')?.click())
  // The import-heightmap-file <input> stays as a real DOM element
  // (kept outside the ribbon template precisely because the React
  // ribbon's importHeightmap bridge action synthesises a click on it).
  $('#import-heightmap-file')?.addEventListener('change', onImportHeightmapFile)
  $('#btn-undo')?.addEventListener('click', undo)
  $('#btn-redo')?.addEventListener('click', redo)
  wireHistoryFlyout($('#btn-undo'), $('#undo-history-popup'))
  wireHistoryFlyout($('#btn-redo'), $('#redo-history-popup'))
  $('#btn-new')?.addEventListener('click', startNewMapFromEditor)
  $('#btn-open')?.addEventListener('click', openExistingMapFromEditor)
  // Edit dropdown clipboard entries — share the same handlers as the
  // Ctrl+C / Ctrl+V hotkeys so a user who reaches for the menu gets
  // the same behaviour.
  $('#btn-cut')?.addEventListener('click', cutSelection)
  $('#btn-copy')?.addEventListener('click', copyToClipboard)
  $('#btn-paste')?.addEventListener('click', () => pasteFromClipboard('all'))
  $('#btn-paste-features')?.addEventListener('click', () => pasteFromClipboard('features'))
  $('#btn-paste-tiles')?.addEventListener('click', () => pasteFromClipboard('tiles'))
  $('#btn-clear-region')?.addEventListener('click', clearRegion)
  $('#btn-clear-features-selection')?.addEventListener('click', clearFeaturesInSelection)
  $('#btn-clear-all-features')?.addEventListener('click', clearAllFeatures)
  // New Window opens the studio in a fresh tab — the user can run two
  // copies side by side and compare/edit different maps without
  // discarding the current session.
  $('#btn-new-window')?.addEventListener('click', () => {
    window.open(location.origin + '/', '_blank', 'noopener')
  })
  $('#btn-ota')?.addEventListener('click', openOTADialog)

  // Actions dropdown.
  const actBtn = $('#actions-dropdown-btn')
  const actPopup = $('#actions-dropdown-popup')
  if (actBtn && actPopup) {
    actBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      closeAllRibbonDropdowns(actPopup)
      positionRibbonPopup(actBtn, actPopup)
      actPopup.classList.toggle('hidden')
    })
  }

  // File dropdown — nests New / Open / Save behind one button so the
  // ribbon stays narrow.  Menu rows close the popup automatically on
  // click (matches the Actions dropdown pattern).
  const fileBtn = $('#file-dropdown-btn')
  const filePopup = $('#file-dropdown-popup')
  if (fileBtn && filePopup) {
    fileBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      closeAllRibbonDropdowns(filePopup)
      positionRibbonPopup(fileBtn, filePopup)
      filePopup.classList.toggle('hidden')
    })
    for (const row of filePopup.querySelectorAll('.menu-row')) {
      row.addEventListener('click', () => filePopup.classList.add('hidden'))
    }
  }

  // Edit dropdown — clipboard operations.  Same toggle pattern as the
  // File menu; menu rows close on click.
  const editBtn = $('#edit-dropdown-btn')
  const editPopup = $('#edit-dropdown-popup')
  if (editBtn && editPopup) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      closeAllRibbonDropdowns(editPopup)
      positionRibbonPopup(editBtn, editPopup)
      editPopup.classList.toggle('hidden')
    })
    for (const row of editPopup.querySelectorAll('.menu-row')) {
      row.addEventListener('click', () => editPopup.classList.add('hidden'))
    }
  }

  // Advanced dropdown — exports and diagnostics today; future home for
  // power-user tools.  Same click-toggle pattern as File / Edit.
  const advBtn = $('#advanced-dropdown-btn')
  const advPopup = $('#advanced-dropdown-popup')
  if (advBtn && advPopup) {
    advBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      closeAllRibbonDropdowns(advPopup)
      positionRibbonPopup(advBtn, advPopup)
      advPopup.classList.toggle('hidden')
    })
    for (const row of advPopup.querySelectorAll('.menu-row')) {
      row.addEventListener('click', () => advPopup.classList.add('hidden'))
    }
  }

  // Outside-click closes any open ribbon dropdown.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ribbon-dropdown')) return
    closeAllRibbonDropdowns(null)
  })

  wireResizeDialog()
  wireSchemaSelector()
  wireOTADialog()
  wireSchemaEditor()
  wireBrushSizeGroup()
  wireHeightmapBrushGroup()
  wireVoidsBrushGroup()
  wireSymmetryGroup()
  refreshSchemaSelector()
  updateUndoButtons()
}

// Symmetry is now exposed as a single has-sub menu row that pops a
// submenu to the right with the four choices.  The row itself shows
// the active label + a tick when symmetry is non-off, matching the
// gridlines / animation toggle rows in the View menu.
const SYMMETRY_LABELS = { off: 'Off', x: 'Vertical', y: 'Horizontal', xy: 'Both' }

function wireSymmetryGroup() {
  const row = $('#mode-row-symmetry')
  const popup = $('#symmetry-dropdown-popup')
  if (!row || !popup) return
  let closeTimer = null
  const open = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    positionSubmenuRight(row, popup)
  }
  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => popup.classList.add('hidden'), 220)
  }
  row.addEventListener('mouseenter', open)
  row.addEventListener('mouseleave', scheduleClose)
  popup.addEventListener('mouseenter', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  })
  popup.addEventListener('mouseleave', scheduleClose)
  $$('#symmetry-dropdown-popup [data-symmetry]').forEach((r) => {
    r.addEventListener('click', (e) => {
      e.stopPropagation()
      state.symmetry = r.dataset.symmetry
      refreshSymmetryRow()
      popup.classList.add('hidden')
      setStatus(`Symmetry: ${SYMMETRY_LABELS[state.symmetry].toLowerCase()}.`)
      renderCanvas()
    })
  })
  refreshSymmetryRow()
}

function refreshSymmetryRow() {
  const row = $('#mode-row-symmetry')
  const lbl = $('#symmetry-current-lbl')
  if (lbl) lbl.textContent = SYMMETRY_LABELS[state.symmetry] || 'Off'
  if (row) row.dataset.on = state.symmetry === 'off' ? '0' : '1'
  $$('#symmetry-dropdown-popup [data-symmetry]').forEach((r) => {
    r.classList.toggle('active', r.dataset.symmetry === state.symmetry)
  })
}

// symmetryMatesTile returns the tile coords each stroke should also
// touch when symmetry is on.  The original (tx, ty) is implicit and
// not included.  Each mate carries its own (dx, dy) flip flags so
// callers can apply matching tile rotations.
function symmetryMatesTile(tx, ty, footW = 1, footH = 1) {
  if (state.symmetry === 'off') return []
  const W = state.tileW
  const H = state.tileH
  // The mirrored top-left for a footprint is the reflection of the *far*
  // edge so the footprint's body lands inside the canvas.
  const mx = W - tx - footW
  const my = H - ty - footH
  const mates = []
  if (state.symmetry === 'x' || state.symmetry === 'xy') mates.push({ tx: mx, ty, fx: true, fy: false })
  if (state.symmetry === 'y' || state.symmetry === 'xy') mates.push({ tx, ty: my, fx: false, fy: true })
  if (state.symmetry === 'xy') mates.push({ tx: mx, ty: my, fx: true, fy: true })
  return mates
}

function symmetryMatesAttr(ax, ay) {
  if (state.symmetry === 'off') return []
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const mx = aw - 1 - ax
  const my = ah - 1 - ay
  const mates = []
  if (state.symmetry === 'x' || state.symmetry === 'xy') mates.push({ ax: mx, ay })
  if (state.symmetry === 'y' || state.symmetry === 'xy') mates.push({ ax, ay: my })
  if (state.symmetry === 'xy') mates.push({ ax: mx, ay: my })
  return mates
}

// positionSubmenuRight places `popup` to the right of `parentRow`,
// flipping to the left if there isn't horizontal room, and clamping
// vertically so the popup stays on-screen.  Used by all the mode-row
// hover submenus (Erase / Heightmap / Voids) so they appear off to
// the side instead of dropping below their parent.
function positionSubmenuRight(parentRow, popup) {
  const rect = parentRow.getBoundingClientRect()
  popup.classList.remove('hidden') // need real dimensions
  const popW = popup.offsetWidth
  const popH = popup.offsetHeight
  const vpW = window.innerWidth
  const vpH = window.innerHeight
  let left = rect.right + 4
  let top = rect.top
  if (left + popW > vpW - 8) left = Math.max(8, rect.left - popW - 4)
  if (top + popH > vpH - 8) top = Math.max(8, vpH - popH - 8)
  popup.style.left = left + 'px'
  popup.style.top = top + 'px'
}

// wireHistoryFlyout opens a list popup to the right of the Undo or
// Redo row when hovered, showing what would happen on the next few
// presses.  Skips opening when the row is disabled (empty stack).
function wireHistoryFlyout(row, popup) {
  if (!row || !popup) return
  let closeTimer = null
  const open = () => {
    if (row.disabled) return
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    refreshHistoryFlyouts()
    positionSubmenuRight(row, popup)
  }
  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => popup.classList.add('hidden'), 220)
  }
  row.addEventListener('mouseenter', open)
  row.addEventListener('mouseleave', scheduleClose)
  popup.addEventListener('mouseenter', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  })
  popup.addEventListener('mouseleave', scheduleClose)
}

function wireVoidsBrushGroup() {
  const row = $('#mode-row-voids')
  const popup = $('#voids-dropdown-popup')
  if (!row || !popup) return
  let closeTimer = null
  const open = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    positionSubmenuRight(row, popup)
  }
  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => popup.classList.add('hidden'), 220)
  }
  row.addEventListener('mouseenter', open)
  row.addEventListener('mouseleave', scheduleClose)
  popup.addEventListener('mouseenter', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  })
  popup.addEventListener('mouseleave', scheduleClose)
  $$('#voids-dropdown-popup [data-voids-size]').forEach((r) => {
    r.addEventListener('click', (e) => {
      e.stopPropagation()
      const sz = parseInt(r.dataset.voidsSize, 10) || 1
      state.voidsBrushSize = sz
      $$('#voids-dropdown-popup [data-voids-size]').forEach((x) => x.classList.toggle('active', x === r))
      const lbl = $('#voids-current-lbl')
      if (lbl) lbl.textContent = `${sz}×${sz}`
      popup.classList.add('hidden')
      $('#mode-dropdown-popup')?.classList.add('hidden')
      if (state.mode !== 'voids') setMode('voids')
      setStatus(`Voids brush set to ${sz}×${sz}.`)
      renderCanvas()
    })
  })
}

function wireHeightmapBrushGroup() {
  const hmRow = $('#mode-row-heightmap')
  const popup = $('#hm-dropdown-popup')
  if (!hmRow || !popup) return
  let closeTimer = null
  const open = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    positionSubmenuRight(hmRow, popup)
  }
  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => popup.classList.add('hidden'), 220)
  }
  hmRow.addEventListener('mouseenter', open)
  hmRow.addEventListener('mouseleave', scheduleClose)
  popup.addEventListener('mouseenter', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  })
  popup.addEventListener('mouseleave', scheduleClose)

  const refreshLabel = () => {
    const lbl = $('#hm-current-lbl')
    if (lbl) {
      const cap = state.hmTool.charAt(0).toUpperCase() + state.hmTool.slice(1)
      lbl.textContent = `${cap} · ${state.hmRadius}`
    }
  }

  $$('#hm-dropdown-popup [data-hmtool]').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      state.hmTool = row.dataset.hmtool
      $$('#hm-dropdown-popup [data-hmtool]').forEach((r) => r.classList.toggle('active', r === row))
      if (state.mode !== 'heightmap') setMode('heightmap')
      refreshLabel()
      setStatus(`Heightmap tool: ${state.hmTool}.`)
    })
  })
  $$('#hm-dropdown-popup [data-hm-radius]').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      state.hmRadius = parseInt(row.dataset.hmRadius, 10) || 4
      $$('#hm-dropdown-popup [data-hm-radius]').forEach((r) => r.classList.toggle('active', r === row))
      if (state.mode !== 'heightmap') setMode('heightmap')
      refreshLabel()
    })
  })
  $$('#hm-dropdown-popup [data-hm-strength]').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      state.hmStrength = parseInt(row.dataset.hmStrength, 10) || 4
      $$('#hm-dropdown-popup [data-hm-strength]').forEach((r) => r.classList.toggle('active', r === row))
      if (state.mode !== 'heightmap') setMode('heightmap')
    })
  })
}

function wireBrushSizeGroup() {
  const eraseRow = $('#mode-row-erase')
  const popup = $('#brush-dropdown-popup')
  if (!eraseRow || !popup) return
  // The brush picker hangs off the Erase row of the Mode menu — hovering
  // the row pops the size choices out to the side; mouseleave closes
  // after a short grace period so the cursor can travel onto the popup.
  let closeTimer = null
  const open = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    positionSubmenuRight(eraseRow, popup)
  }
  const scheduleClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => popup.classList.add('hidden'), 220)
  }
  eraseRow.addEventListener('mouseenter', open)
  eraseRow.addEventListener('mouseleave', scheduleClose)
  popup.addEventListener('mouseenter', () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
  })
  popup.addEventListener('mouseleave', scheduleClose)
  $$('#brush-dropdown-popup .menu-row[data-size]').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      const sz = parseInt(row.dataset.size, 10) || 1
      state.eraseSize = sz
      $$('#brush-dropdown-popup .menu-row[data-size]').forEach((r) => r.classList.toggle('active', r === row))
      const lbl = $('#brush-current-lbl')
      if (lbl) lbl.textContent = `${sz}×${sz}`
      popup.classList.add('hidden')
      // Picking a brush size also commits to Erase mode — the user is
      // clearly about to start erasing — and closes the parent Mode
      // popup so we're back to the canvas.
      $('#mode-dropdown-popup')?.classList.add('hidden')
      if (state.mode !== 'erase') setMode('erase')
      setStatus(`Erase brush set to ${sz}×${sz}.`)
      renderCanvas()
    })
  })
  // Scope toggle — picking a scope also commits to Erase mode but
  // leaves the submenu open so the user can adjust size + scope in one
  // pass without re-hovering.
  $$('#brush-dropdown-popup .scope-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      const scope = row.dataset.scope || 'all'
      state.eraseScope = scope
      $$('#brush-dropdown-popup .scope-row').forEach((r) => r.classList.toggle('active', r === row))
      if (state.mode !== 'erase') setMode('erase')
      const labelMap = { all: 'all', terrain: 'terrain only', features: 'features only' }
      setStatus(`Erase scope: ${labelMap[scope] || 'all'}.`)
      renderCanvas()
    })
  })
}

// Schemas are addressed by their player count (the "Network N" the
// schema's Type ends in).  Treating count as the identity keeps the
// add-grid in sync — counts already present are disabled, the rest can
// be added with one click.  SCHEMA_PLAYER_COUNTS lives in
// ./ui/map-editor/constants.js.

function schemaPlayerCount(schema) {
  if (!schema) return 0
  // The start-position count is the authoritative player count.  TA's
  // OTA "Type = Network N" stores N as the schema index (0, 1, …), not
  // the player count, so trusting that would mis-report the cap.  Fall
  // back to the type-extracted N only when no start positions exist.
  const sp = (schema.startPositions || []).length
  if (sp > 0) return sp
  const m = /network\s*(\d+)/i.exec(schema.type || '')
  if (m) return parseInt(m[1], 10)
  return 2
}

// schemaPickerLabel formats the row label for the schema picker.  For
// Network-type schemas this comes out as "Network <name> (N Players)"
// where N is the actual start-position count.  TA stores some OTAs with
// bare digits in the name field ("0", "1", …) so we synthesise the
// "Network " prefix when it's not already on the name.  Non-Network
// schemas (rare in TA) display the bare name without a player suffix.
function schemaPickerLabel(s) {
  if (!s) return 'Schema'
  const isNetwork = /network/i.test(s.type || '')
  let name = s.name || s.type || 'Schema'
  if (isNetwork && !/^network/i.test(name)) name = `Network ${name}`
  if (!isNetwork) return name
  const n = (s.startPositions || []).length
  return `${name} (${n} ${n === 1 ? 'Player' : 'Players'})`
}

function wireSchemaSelector() {
  const btn = $('#schema-dropdown-btn')
  const popup = $('#schema-dropdown-popup')
  if (!btn || !popup) return
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    closeAllRibbonDropdowns(popup)
    positionRibbonPopup(btn, popup)
    popup.classList.toggle('hidden')
    if (!popup.classList.contains('hidden')) refreshSchemaSelector()
  })
}

function refreshSchemaSelector() {
  // React MapRibbon's Map Settings dropdown reads its schema list +
  // active label off the publishRibbonState snapshot — push every
  // refresh through so the dropdown stays in lockstep with the legacy
  // (now-templated) DOM render below.
  publishMapRibbonState()
  const lbl = $('#schema-current-lbl')
  if (lbl && state.ota) {
    const active = state.ota.schemas[state.activeSchema]
    lbl.textContent = active ? schemaPickerLabel(active) : 'Schema'
  }
  const list = $('#schema-row-list')
  if (list && state.ota) {
    const frag = document.createDocumentFragment()
    state.ota.schemas.forEach((s, i) => {
      const row = document.createElement('div')
      row.className = 'schema-row' + (i === state.activeSchema ? ' active' : '')
      const name = document.createElement('span')
      name.className = 'schema-row-name'
      name.textContent = schemaPickerLabel(s)
      const gear = document.createElement('button')
      gear.className = 'schema-row-gear'
      gear.title = 'Edit schema economy / AI settings'
      gear.innerHTML = '⚙'
      gear.addEventListener('click', (ev) => {
        ev.stopPropagation()
        openSchemaEditor(i)
      })
      const del = document.createElement('button')
      del.className = 'schema-row-del'
      del.title = state.ota.schemas.length > 1 ? 'Delete this schema' : 'At least one schema is required'
      del.innerHTML = '✕'
      if (state.ota.schemas.length <= 1) del.disabled = true
      del.addEventListener('click', async (ev) => {
        ev.stopPropagation()
        const ok = await confirmDialog({
          title: 'Delete this schema?',
          message: `"${s.name || `Schema ${i + 1}`}" (${playerCountLabel(schemaPlayerCount(s))}) and its start positions will be removed. This can be undone.`,
          okLabel: 'Delete schema',
          okDanger: true,
        })
        if (ok) deleteSchema(i)
      })
      row.addEventListener('click', () => {
        if (state.activeSchema !== i) {
          state.activeSchema = i
          state.selectedStartPos = -1
          refreshSchemaSelector()
          renderCanvas()
        }
      })
      row.appendChild(name)
      row.appendChild(gear)
      row.appendChild(del)
      frag.appendChild(row)
    })
    list.replaceChildren(frag)
  }
  const addGrid = $('#schema-add-grid')
  if (addGrid && state.ota) {
    // Only the *current* schema's player count is excluded from the
    // Add grid — duplicates against other schemas are allowed so users
    // can keep multiple variants at the same player count.
    const current = state.ota.schemas[state.activeSchema]
    const used = new Set(current ? [schemaPlayerCount(current)] : [])
    const frag = document.createDocumentFragment()
    const available = SCHEMA_PLAYER_COUNTS.filter((n) => !used.has(n))
    if (available.length === 0) {
      const note = document.createElement('div')
      note.className = 'schema-add-empty'
      note.textContent = 'All player counts are already covered.'
      frag.appendChild(note)
    } else {
      for (const n of available) {
        const chip = document.createElement('button')
        chip.className = 'schema-add-chip'
        chip.textContent = `${n} Players`
        chip.title = `Add a ${n}-player schema (named after the next free Network N)`
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation()
          addSchemaWithPlayers(n)
        })
        frag.appendChild(chip)
      }
    }
    addGrid.replaceChildren(frag)
  }
}

// addSchemaWithPlayers appends a Network N schema and selects it.
// The schema starts with no placed positions — the user drops them in
// via Start Points mode, which gap-fills 1..N as they click.  The
// schema's display name is "Network X" where X is the lowest integer
// not already taken by an existing schema's name; the OTA Type stays
// `Network <playerCount>` for engine compatibility.
function addSchemaWithPlayers(playerCount) {
  if (!state.ota) return
  const proto = state.ota.schemas[state.activeSchema] || state.ota.schemas[0]
  const nextName = nextAvailableSchemaName(state.ota.schemas)
  beginTransaction()
  const newSchema = {
    ...proto,
    name: nextName,
    type: `Network ${playerCount}`,
    startPositions: [],
  }
  state.ota.schemas.push(newSchema)
  state.activeSchema = state.ota.schemas.length - 1
  state.selectedStartPos = -1
  commitTransaction(`Add ${nextName}`)
  refreshSchemaSelector()
  renderCanvas()
}

// nextAvailableSchemaName scans existing schema names for the pattern
// "Network N" (also matching bare digit names like "0") and returns
// "Network X" where X is the smallest non-negative integer not used.
function nextAvailableSchemaName(schemas) {
  const used = new Set()
  for (const s of schemas || []) {
    const name = (s.name || '').trim()
    // Match "Network 0", "Network 12", or just "12" — that last form
    // is what TA's OTAs sometimes store the schema index as.
    let m = /^network\s+(\d+)$/i.exec(name)
    if (!m) m = /^(\d+)$/.exec(name)
    if (m) used.add(parseInt(m[1], 10))
  }
  let n = 0
  while (used.has(n)) n++
  return `Network ${n}`
}

function deleteSchema(index) {
  if (!state.ota || state.ota.schemas.length <= 1) return
  beginTransaction()
  state.ota.schemas.splice(index, 1)
  if (state.activeSchema >= state.ota.schemas.length) state.activeSchema = state.ota.schemas.length - 1
  state.selectedStartPos = -1
  commitTransaction('Delete schema')
  refreshSchemaSelector()
  renderCanvas()
}

// ── OTA dialog ─────────────────────────────────────────────────────────────

function openOTADialog() {
  if (!state.ota) return
  $('#ota-mission-name').value = state.ota.missionName
  $('#ota-planet').value = state.ota.planet
  $('#ota-mission-description').value = state.ota.missionDescription
  $('#ota-numplayers').value = state.ota.numPlayers
  $('#ota-size').value = state.ota.size
  $('#ota-tidal').value = state.ota.tidalStrength
  $('#ota-solar').value = state.ota.solarStrength
  $('#ota-gravity').value = state.ota.gravity
  $('#ota-min-wind').value = state.ota.minWindSpeed
  $('#ota-max-wind').value = state.ota.maxWindSpeed
  $('#ota-killmul').value = state.ota.killmul
  $('#ota-lava').value = String(state.ota.lavaWorld || 0)
  $('#ota-sea-level').value = state.ota.seaLevel ?? 63
  $('#ota-impassible-water').value = String(state.ota.impassibleWater || 0)
  $('#ota-water-damage').value = String(state.ota.waterDoesDamage || 0)
  $('#ota-dialog').classList.remove('hidden')
}

function closeOTADialog() { $('#ota-dialog').classList.add('hidden') }

function wireOTADialog() {
  $('#ota-cancel').addEventListener('click', closeOTADialog)
  $('#ota-apply').addEventListener('click', applyOTADialog)
}

function applyOTADialog() {
  beginTransaction()
  state.ota.missionName = $('#ota-mission-name').value.trim() || state.name
  state.ota.planet = $('#ota-planet').value
  state.planet = state.ota.planet
  state.ota.missionDescription = $('#ota-mission-description').value
  state.ota.numPlayers = $('#ota-numplayers').value || '2'
  state.ota.size = $('#ota-size').value
  state.ota.tidalStrength = parseInt($('#ota-tidal').value, 10) || 0
  state.ota.solarStrength = parseInt($('#ota-solar').value, 10) || 0
  state.ota.gravity = parseInt($('#ota-gravity').value, 10) || 0
  state.ota.minWindSpeed = parseInt($('#ota-min-wind').value, 10) || 0
  state.ota.maxWindSpeed = parseInt($('#ota-max-wind').value, 10) || 0
  state.ota.killmul = parseInt($('#ota-killmul').value, 10) || 0
  state.ota.lavaWorld = parseInt($('#ota-lava').value, 10) || 0
  state.ota.seaLevel = clamp(parseInt($('#ota-sea-level').value, 10) || 0, 0, 255)
  state.ota.impassibleWater = parseInt($('#ota-impassible-water').value, 10) || 0
  state.ota.waterDoesDamage = parseInt($('#ota-water-damage').value, 10) || 0
  commitTransaction('Edit map properties')
  state.name = state.ota.missionName
  // The tab chip's label is the mission name — refresh.
  renderMapTabs()
  refreshSchemaSelector()
  closeOTADialog()
  renderCanvas()
}

// ── Schema editor (gear icon on each schema row) ───────────────────────
// Per-schema economy / AI fields used to live in the Properties dialog;
// now each schema has its own editor accessed via the gear icon on its
// row in the schema dropdown.  schemaBeingEdited tracks which schema
// index is active so Apply writes back to the right one.
let schemaBeingEdited = -1

function openSchemaEditor(index) {
  if (!state.ota || !state.ota.schemas[index]) return
  schemaBeingEdited = index
  const s = state.ota.schemas[index]
  $('#se-name').value = s.name || ''
  $('#se-type').value = s.type || ''
  $('#se-ai-profile').value = s.aiProfile || ''
  $('#se-surface-metal').value = s.surfaceMetal || 0
  $('#se-moho-metal').value = s.mohoMetal || 0
  $('#se-human-metal').value = s.humanMetal || 0
  $('#se-computer-metal').value = s.computerMetal || 0
  $('#se-human-energy').value = s.humanEnergy || 0
  $('#se-computer-energy').value = s.computerEnergy || 0
  $('#se-meteor-weapon').value = s.meteorWeapon || ''
  $('#se-meteor-radius').value = s.meteorRadius || 0
  $('#se-meteor-density').value = s.meteorDensity || 0
  $('#se-meteor-duration').value = s.meteorDuration || 0
  $('#se-meteor-interval').value = s.meteorInterval || 0
  // Close the schema dropdown so it doesn't sit on top of the dialog.
  $('#schema-dropdown-popup')?.classList.add('hidden')
  $('#schema-edit-dialog').classList.remove('hidden')
}

function closeSchemaEditor() {
  $('#schema-edit-dialog').classList.add('hidden')
  schemaBeingEdited = -1
}

function wireSchemaEditor() {
  $('#se-cancel')?.addEventListener('click', closeSchemaEditor)
  $('#se-apply')?.addEventListener('click', applySchemaEditor)
}

function applySchemaEditor() {
  if (schemaBeingEdited < 0 || !state.ota?.schemas[schemaBeingEdited]) {
    closeSchemaEditor()
    return
  }
  beginTransaction()
  const s = state.ota.schemas[schemaBeingEdited]
  s.name = $('#se-name').value.trim() || 'Default'
  s.type = $('#se-type').value.trim() || 'Network 1'
  s.aiProfile = $('#se-ai-profile').value
  s.surfaceMetal = parseInt($('#se-surface-metal').value, 10) || 0
  s.mohoMetal = parseInt($('#se-moho-metal').value, 10) || 0
  s.humanMetal = parseInt($('#se-human-metal').value, 10) || 0
  s.computerMetal = parseInt($('#se-computer-metal').value, 10) || 0
  s.humanEnergy = parseInt($('#se-human-energy').value, 10) || 0
  s.computerEnergy = parseInt($('#se-computer-energy').value, 10) || 0
  s.meteorWeapon = $('#se-meteor-weapon').value.trim()
  s.meteorRadius = parseInt($('#se-meteor-radius').value, 10) || 0
  s.meteorDensity = parseInt($('#se-meteor-density').value, 10) || 0
  s.meteorDuration = parseInt($('#se-meteor-duration').value, 10) || 0
  s.meteorInterval = parseInt($('#se-meteor-interval').value, 10) || 0
  commitTransaction(`Edit schema: ${s.name}`)
  refreshSchemaSelector()
  closeSchemaEditor()
}

// startNewMapFromEditor is the toolbar New button — confirms first
// because it nukes the current canvas, undo history, OTA, everything.
async function startNewMapFromEditor() {
  // Multi-tab: New simply opens the size dialog and appends a new tab
  // on confirm.  No discard prompt — the existing map stays on its
  // own tab.  Dimensions inherit from the current map (likely the
  // user wants the same size), but the name resets to "newmap" so
  // a previous map's name doesn't shadow what they're about to make.
  sizeDialogSource = 'tabbar'
  const wIn = $('#size-w'); if (wIn) wIn.value = String(state.tileW || 128)
  const hIn = $('#size-h'); if (hIn) hIn.value = String(state.tileH || 128)
  const nIn = $('#size-name'); if (nIn) nIn.value = 'newmap'
  openSizeDialog()
}

// closeSizeDialog returns the user to the surface they came from when
// they cancel the size picker.  Resetting transient state is deferred
// to the actual swap inside startEditor (or openLoadedMap) so a
// cancelled New leaves the existing editor untouched.
function closeSizeDialog() {
  $('#size-dialog').classList.add('hidden')
  if (sizeDialogSource === 'welcome') {
    $('#welcome-dialog').classList.remove('hidden')
    return
  }
  // Restore the surface that was visible before the size dialog
  // appeared.  When the user came from a model tab via the "+"
  // popup the 3DO viewer was hidden; bring it back.
  const active = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  if (active?.type === 'model') {
    $('#model-viewer-dialog').classList.remove('hidden')
  }
}

// openSizeDialog reveals the New-map dialog and focuses the name input
// so the user can immediately type the friendly map name (#38).
function openSizeDialog() {
  // Same as openMapDialog: hide the 3DO viewer if it's the current
  // surface so the size dialog isn't trapped behind a higher dialog.
  $('#model-viewer-dialog').classList.add('hidden')
  $('#size-dialog').classList.remove('hidden')
  // Defer the focus to the next frame so the browser has shown the
  // dialog before we try to put the caret in the input.
  requestAnimationFrame(() => {
    const nm = $('#size-name')
    if (nm) {
      nm.focus()
      nm.select()
    }
  })
}

// openExistingMapFromEditor confirms then reuses the same picker the
// Welcome modal shows on first boot — the load flow then replaces the
// editor's state in place via openLoadedMap → finishEditorBoot.
async function openExistingMapFromEditor() {
  // Multi-tab: Open appends a new tab; no need to discard or prompt.
  openMapDialog('tabbar')
}

// confirmDialog moved to /ui/dialogs/confirm.js — imported at the
// top of this file.  Same imperative API, now routes through
// getReactUi() from host-context so callers in other extracted
// modules can use it without a studio.js back-reference.

// Resize dialog state — anchor index in [0..2] for row/col.
const resizeState = { anchorRow: 1, anchorCol: 1 }

function wireResizeDialog() {
  const grid = $('#resize-anchor')
  grid.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      resizeState.anchorRow = parseInt(btn.dataset.r, 10)
      resizeState.anchorCol = parseInt(btn.dataset.c, 10)
      grid.querySelectorAll('button').forEach((b) => b.classList.toggle(
        'selected',
        b.dataset.r === btn.dataset.r && b.dataset.c === btn.dataset.c,
      ))
      updateResizePreview()
    })
  })
  $('#resize-w').addEventListener('input', updateResizePreview)
  $('#resize-h').addEventListener('input', updateResizePreview)
  $('#resize-cancel').addEventListener('click', closeResizeDialog)
  $('#resize-apply').addEventListener('click', applyResize)
  $('#resize-crop')?.addEventListener('click', cropToContent)
}

// cropToContent shrinks the map to the bounding box of every stamped
// tile + every placed feature, with a one-tile margin so things aren't
// flush against the new edge.  Driven from the Resize dialog so the
// user can review the new dimensions before committing.
function cropToContent() {
  // Tile bounds.
  let bounds = shrinkRectToContent(0, 0, state.tileW, state.tileH)
  let minX = bounds.w > 0 ? bounds.x : null
  let minY = bounds.h > 0 ? bounds.y : null
  let maxX = bounds.w > 0 ? bounds.x + bounds.w - 1 : null
  let maxY = bounds.h > 0 ? bounds.y + bounds.h - 1 : null
  // Feature bounds — features sit on the 16-px attribute grid, so
  // divide by 2 to get back to tile coords and widen by the footprint.
  for (const f of state.features || []) {
    const fx = Math.floor(f.ax / 2)
    const fy = Math.floor(f.ay / 2)
    const fw = Math.max(1, Math.ceil((f.footprintX || 1) / 2))
    const fh = Math.max(1, Math.ceil((f.footprintZ || 1) / 2))
    const lo = { x: fx, y: fy }
    const hi = { x: fx + fw - 1, y: fy + fh - 1 }
    if (minX == null || lo.x < minX) minX = lo.x
    if (minY == null || lo.y < minY) minY = lo.y
    if (maxX == null || hi.x > maxX) maxX = hi.x
    if (maxY == null || hi.y > maxY) maxY = hi.y
  }
  if (minX == null) {
    setStatus('Nothing to crop — the map is empty.')
    return
  }
  // Add a one-tile margin and clamp to the map.
  const margin = 1
  minX = Math.max(0, minX - margin)
  minY = Math.max(0, minY - margin)
  maxX = Math.min(state.tileW - 1, maxX + margin)
  maxY = Math.min(state.tileH - 1, maxY + margin)
  const newW = clamp(maxX - minX + 1, 16, 256)
  const newH = clamp(maxY - minY + 1, 16, 256)
  // Re-pin to top-left so the anchor offset maps directly to the
  // bounding-box origin.
  resizeState.anchorRow = 0
  resizeState.anchorCol = 0
  $('#resize-anchor').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.r === '0' && b.dataset.c === '0')
  })
  $('#resize-w').value = newW
  $('#resize-h').value = newH
  // Stash the crop offset so applyResize knows to discard
  // top-of-map / left-of-map rather than padding.
  pendingCropOffset = { x: minX, y: minY }
  updateResizePreview()
  setStatus(`Cropping to ${newW}×${newH} starting at (${minX}, ${minY}).  Click Apply to confirm.`)
}
// pendingCropOffset is non-null when the user has just clicked "Crop
// to content" — applyResize honours it by offsetting the source rect
// instead of using the anchor.  Cleared on close / cancel.
let pendingCropOffset = null

function openResizeDialog() {
  $('#resize-w').value = state.tileW
  $('#resize-h').value = state.tileH
  pendingCropOffset = null
  updateResizePreview()
  $('#resize-dialog').classList.remove('hidden')
}

function closeResizeDialog() {
  $('#resize-dialog').classList.add('hidden')
  pendingCropOffset = null
}

// updateResizePreview shows the user-visible offsets in tiles so they can
// see at a glance what content survives a shrink or where the existing
// content lands inside a larger canvas.
function updateResizePreview() {
  const newW = clamp(parseInt($('#resize-w').value, 10) || state.tileW, 16, 256)
  const newH = clamp(parseInt($('#resize-h').value, 10) || state.tileH, 16, 256)
  const oldW = state.tileW
  const oldH = state.tileH
  const { offsetX, offsetY } = anchorOffsets(oldW, oldH, newW, newH)
  const dW = newW - oldW
  const dH = newH - oldH
  // Count tiles and features that would fall outside the new canvas
  // with the current anchor offset.  Iterates the live grid so it
  // tracks any in-progress edits accurately.
  let lostTiles = 0
  for (let oy = 0; oy < oldH; oy++) {
    const ny = oy + offsetY
    for (let ox = 0; ox < oldW; ox++) {
      if (!state.tiles[oy * oldW + ox]) continue
      const nx = ox + offsetX
      if (nx < 0 || ny < 0 || nx >= newW || ny >= newH) lostTiles++
    }
  }
  let lostFeatures = 0
  const attrOffX = offsetX * 2
  const attrOffY = offsetY * 2
  const newAttrW = newW * 2
  const newAttrH = newH * 2
  for (const f of state.features) {
    const nax = f.ax + attrOffX
    const nay = f.ay + attrOffY
    if (nax < 0 || nay < 0 || nax >= newAttrW || nay >= newAttrH) lostFeatures++
  }
  const lossText = (lostTiles || lostFeatures)
    ? `  · ⚠ would lose ${lostTiles} tile${lostTiles === 1 ? '' : 's'}, ${lostFeatures} feature${lostFeatures === 1 ? '' : 's'}`
    : ''
  const desc = `${oldW}×${oldH} → ${newW}×${newH}` +
    `  (Δ ${dW >= 0 ? '+' : ''}${dW}, ${dH >= 0 ? '+' : ''}${dH})` +
    `  · existing content placed at (${offsetX}, ${offsetY})${lossText}`
  const el = $('#resize-preview')
  el.textContent = desc
  el.classList.toggle('warning', !!(lostTiles || lostFeatures))
}

// anchorOffsets returns the (offsetX, offsetY) in tiles that the existing
// content's (0,0) maps to in the new canvas, given the chosen anchor.
function anchorOffsets(oldW, oldH, newW, newH) {
  const dW = newW - oldW
  const dH = newH - oldH
  // anchorCol=0 → content anchored left, offsetX=0
  // anchorCol=1 → centre, offsetX = dW/2
  // anchorCol=2 → right, offsetX = dW
  const offsetX = Math.floor(dW * resizeState.anchorCol / 2)
  const offsetY = Math.floor(dH * resizeState.anchorRow / 2)
  return { offsetX, offsetY }
}

function applyResize() {
  const newW = clamp(parseInt($('#resize-w').value, 10) || state.tileW, 16, 256)
  const newH = clamp(parseInt($('#resize-h').value, 10) || state.tileH, 16, 256)
  if (newW === state.tileW && newH === state.tileH && !pendingCropOffset) {
    closeResizeDialog()
    return
  }
  const oldW = state.tileW
  const oldH = state.tileH
  // Crop-to-content pre-stages an offset that shifts old (cropX, cropY)
  // to new (0, 0).  In ordinary resize math the offset is positive
  // (content pushed inward); for crop we want it negative (content
  // pulled out of the top-left).
  let offsetX, offsetY
  if (pendingCropOffset) {
    offsetX = -pendingCropOffset.x
    offsetY = -pendingCropOffset.y
  } else {
    ({ offsetX, offsetY } = anchorOffsets(oldW, oldH, newW, newH))
  }

  // Tile grid: pull each new cell from the corresponding old cell when
  // the offset places it inside the old footprint, else leave null.
  const newTiles = new Array(newW * newH).fill(null)
  for (let ny = 0; ny < newH; ny++) {
    for (let nx = 0; nx < newW; nx++) {
      const ox = nx - offsetX
      const oy = ny - offsetY
      if (ox < 0 || oy < 0 || ox >= oldW || oy >= oldH) continue
      newTiles[ny * newW + nx] = state.tiles[oy * oldW + ox]
    }
  }

  // Heights live on the 16-px attribute grid (2× tile resolution).  Same
  // anchored copy, default fill for cells outside the old map.
  const oldAttrW = oldW * 2
  const newAttrW = newW * 2
  const newAttrH = newH * 2
  const offAX = offsetX * 2
  const offAY = offsetY * 2
  const newHeights = new Array(newAttrW * newAttrH).fill(80)
  const newVoids = new Array(newAttrW * newAttrH).fill(0)
  for (let ny = 0; ny < newAttrH; ny++) {
    for (let nx = 0; nx < newAttrW; nx++) {
      const ox = nx - offAX
      const oy = ny - offAY
      if (ox < 0 || oy < 0 || ox >= oldAttrW || oy >= oldH * 2) continue
      newHeights[ny * newAttrW + nx] = state.heights[oy * oldAttrW + ox]
      newVoids[ny * newAttrW + nx] = state.voids[oy * oldAttrW + ox] || 0
    }
  }

  const newFeatures = []
  for (const f of state.features) {
    const nax = f.ax + offAX
    const nay = f.ay + offAY
    if (nax < 0 || nay < 0 || nax >= newAttrW || nay >= newAttrH) continue
    newFeatures.push({ ...f, ax: nax, ay: nay })
  }

  beginTransaction()
  state.tileW = newW
  state.tileH = newH
  state.tiles = newTiles
  state.heights = newHeights
  state.voids = newVoids
  state.features = newFeatures
  renderMapTabs()
  commitTransaction('Resize map')

  closeResizeDialog()
  // Recreate the canvas DOM + GL context at the new dimensions.  The
  // previous map-switch bug class came from re-using the existing
  // canvas elements at a different size; tearing them out and mounting
  // fresh ones guarantees no stale backing buffers survive.
  recreateEditorView()
  renderCanvas()
  setStatus(`Resized to ${newW}×${newH}.  Existing content anchored to (${offsetX}, ${offsetY}).`)
}

function openScatterDialog() {
  $('#scatter-dialog').classList.remove('hidden')
  $('#scatter-names').focus()
}

function closeScatterDialog() {
  $('#scatter-dialog').classList.add('hidden')
}

// mulberry32 (the seeded PRNG that powers Scatter) lives in
// ./ui/map-editor/helpers.js.

function applyScatter() {
  const namesIn = $('#scatter-names').value.trim()
  const count = clamp(parseInt($('#scatter-count').value, 10) || 0, 1, 5000)
  const spacingTiles = clamp(parseInt($('#scatter-spacing').value, 10) || 0, 0, 64)
  const seedIn = parseInt($('#scatter-seed').value, 10) || 0
  const area = $('#scatter-area').value
  const seed = seedIn > 0 ? seedIn : (Date.now() >>> 0)
  const rand = mulberry32(seed)

  // Resolve the feature pool.  If the user typed names, look them up by
  // exact (case-insensitive) name.  Otherwise honour the current drawer
  // filter — what's visible to the user is what we scatter.
  const library = state.featuresList || []
  let pool = []
  if (namesIn) {
    const wanted = new Set(namesIn.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    for (const f of library) {
      if (wanted.has((f.name || '').toLowerCase())) pool.push(f)
    }
  } else {
    const q = (state.drawerFilters?.features || '').trim().toLowerCase()
    for (const f of library) {
      if (!state.includeWreckage && isWreckageFeature(f)) continue
      const hay = `${f.name || ''} ${f.world || ''} ${f.category || ''} ${f.description || ''}`.toLowerCase()
      if (q && !hay.includes(q)) continue
      pool.push(f)
    }
  }
  if (pool.length === 0) {
    setStatus('Scatter: no matching features.')
    return
  }

  // Build the legal area (attribute-cell rect).
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  let x0 = 0, y0 = 0, x1 = attrW, y1 = attrH
  if (area === 'selection' && state.terrainClipboard) {
    const s = state.terrainClipboard
    x0 = s.tx * 2; y0 = s.ty * 2
    x1 = (s.tx + s.w) * 2; y1 = (s.ty + s.h) * 2
  }
  if (x1 <= x0 || y1 <= y0) {
    setStatus('Scatter: empty area.')
    return
  }

  // Occupancy: existing feature anchor cells, plus their footprints, plus
  // void cells.  Spacing is enforced by stamping a halo of size
  // spacingTiles*2 attr-cells around each successful placement.
  const occupied = new Uint8Array(attrW * attrH)
  for (let i = 0; i < state.voids.length && i < occupied.length; i++) {
    if (state.voids[i]) occupied[i] = 1
  }
  const markCell = (ax, ay) => {
    if (ax >= 0 && ay >= 0 && ax < attrW && ay < attrH) occupied[ay * attrW + ax] = 1
  }
  const markFootprint = (ax, ay, fx, fz, halo) => {
    const r = halo
    for (let dy = -r; dy < fz + r; dy++) {
      for (let dx = -r; dx < fx + r; dx++) {
        markCell(ax + dx, ay + dy)
      }
    }
  }
  for (const f of state.features) {
    markFootprint(f.ax, f.ay, f.footprintX || 1, f.footprintZ || 1, 0)
  }

  const spacingHalo = spacingTiles * 2
  beginTransaction()
  let placed = 0
  let attempts = 0
  const maxAttempts = count * 20
  while (placed < count && attempts < maxAttempts) {
    attempts++
    const pick = pool[Math.floor(rand() * pool.length)]
    const fx = pick.footprintX || 1
    const fz = pick.footprintZ || 1
    const ax = x0 + Math.floor(rand() * Math.max(1, x1 - x0 - fx))
    const ay = y0 + Math.floor(rand() * Math.max(1, y1 - y0 - fz))
    // Reject if any cell of the footprint is occupied or void.
    let blocked = false
    for (let dy = 0; dy < fz && !blocked; dy++) {
      for (let dx = 0; dx < fx && !blocked; dx++) {
        const cx = ax + dx
        const cy = ay + dy
        if (cx < x0 || cy < y0 || cx >= x1 || cy >= y1) { blocked = true; break }
        if (occupied[cy * attrW + cx]) blocked = true
      }
    }
    if (blocked) continue
    state.features.push({
      name: pick.name,
      ax, ay,
      footprintX: fx,
      footprintZ: fz,
      previewUrl: pick.previewUrl || null,
      world: pick.world,
      category: pick.category,
      description: pick.description,
      originX: pick.originX || 0,
      originY: pick.originY || 0,
    })
    markFootprint(ax, ay, fx, fz, spacingHalo)
    placed++
  }
  bumpContentVersion()
  commitTransaction(`Scatter ${placed} feature${placed === 1 ? '' : 's'}`)
  closeScatterDialog()
  renderCanvas()
  setStatus(`Scattered ${placed} feature${placed === 1 ? '' : 's'} (seed ${seed}).`)
}

function exportHeightmap() {
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  const c = document.createElement('canvas')
  c.width = attrW; c.height = attrH
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(attrW, attrH)
  for (let i = 0; i < attrW * attrH; i++) {
    const h = clamp(state.heights[i] | 0, 0, 255)
    img.data[i * 4 + 0] = h
    img.data[i * 4 + 1] = h
    img.data[i * 4 + 2] = h
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  c.toBlob((blob) => {
    if (!blob) { setStatus('Heightmap export failed.'); return }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}-heightmap.png`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${attrW}×${attrH} heightmap PNG.`)
  }, 'image/png')
}

function exportMinimap() {
  // Ensure the visible minimap canvas is in sync with the latest map
  // state before exporting — renderMinimap is idempotent, so re-running
  // it here is cheap and avoids exporting a stale frame.
  renderMinimap()
  const mini = $('#minimap')
  if (!mini) { setStatus('Minimap not available to export.'); return }
  mini.toBlob((blob) => {
    if (!blob) { setStatus('Minimap export failed.'); return }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}-minimap.png`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${mini.width}×${mini.height} minimap PNG.`)
  }, 'image/png')
}

// exportFromBackend POSTs the current map state to one of the
// /api/studio/export-* endpoints and triggers a download of the
// returned PNG.  The endpoints share their request shape with
// /api/studio/save (saveRequest), so we can reuse buildSavePayload()
// for all of them — same data, three different renderers on the
// server side.
async function exportFromBackend(endpoint, suffix, label) {
  setStatus(`Rendering ${label}…`)
  try {
    const resp = await fetch(`/api/studio/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSavePayload()),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(text || `HTTP ${resp.status}`)
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}-${suffix}.png`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Exported ${label} PNG.`)
  } catch (err) {
    setStatus(`${label} export failed: ${err.message || err}`)
  }
}

// confirmLargeRender warns the user that a 1:1 PNG render of a big map
// could chew memory and produce a huge file.  Shared by both the full
// render (with features + markers) and the bare map image — both ship
// the same per-pixel payload, only their compositing differs.
function confirmLargeRender(label) {
  const pxW = state.tileW * 32
  const pxH = state.tileH * 32
  if (pxW * pxH > 6000 * 6000) {
    const ok = window.confirm(
      `${label} is ${pxW}×${pxH} pixels.  This can take a while and the PNG file may be very large.  Continue?`,
    )
    if (!ok) { setStatus(`${label} cancelled.`); return false }
  }
  return true
}

function exportFullRender() {
  if (!confirmLargeRender('Full render')) return
  exportFromBackend('export-render', 'render', 'full render')
}

function exportMapImage() {
  if (!confirmLargeRender('Map image')) return
  exportFromBackend('export-map-image', 'map', 'map image')
}

function exportBuildmap() {
  exportFromBackend('export-buildmap', 'buildmap', 'buildmap')
}

function exportVoidmap() {
  exportFromBackend('export-voidmap', 'voidmap', 'voidmap')
}

async function onImportHeightmapFile(e) {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file) return
  const attrW = state.tileW * 2
  const attrH = state.tileH * 2
  const img = new Image()
  const url = URL.createObjectURL(file)
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('decode failed'))
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = attrW; c.height = attrH
    const ctx = c.getContext('2d')
    // Nearest-neighbour-ish: disable smoothing so a same-size import is
    // exact, and a different-size import is sampled rather than blurred.
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0, attrW, attrH)
    const data = ctx.getImageData(0, 0, attrW, attrH).data
    beginTransaction()
    for (let i = 0; i < attrW * attrH; i++) {
      // Use luminance so colour PNGs still produce sensible heights.
      const r = data[i * 4 + 0]
      const g = data[i * 4 + 1]
      const b = data[i * 4 + 2]
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) | 0
      state.heights[i] = clamp(lum, 0, 255)
    }
    commitTransaction('Import heightmap')
    renderCanvas()
    setStatus(`Imported heightmap from ${file.name} (${img.naturalWidth}×${img.naturalHeight} → ${attrW}×${attrH}).`)
  } catch (err) {
    setStatus(`Heightmap import failed: ${err.message}`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// buildSavePayload snapshots the current per-map state into the shape
// the save / quality-check endpoints accept.  Splitting it out lets
// the Quality Checker re-send the same payload across multiple fix
// iterations without rebuilding it each time — and keeps save() /
// saveLoose() honest about what they ship.
function buildSavePayload() {
  if (state.terrainClipboard) dropTerrainClipboard()
  cancelPlacement()
  return {
    mapName: state.name,
    displayName: state.ota?.missionName || state.name,
    tileW: state.tileW,
    tileH: state.tileH,
    planet: state.planet,
    tiles: state.tiles,
    heights: state.heights,
    voids: state.voids,
    features: state.features.map((f) => ({ name: f.name, ax: f.ax, ay: f.ay })),
    seaLevel: state.ota?.seaLevel ?? 0,
    ota: state.ota,
    activeSchema: state.activeSchema | 0,
  }
}

async function saveLoose() {
  const payload = buildSavePayload()
  const fixes = await runQualityChecker(payload)
  if (!fixes) return false
  payload.fixes = fixes
  setStatus('Building TNT + OTA…')
  for (const which of ['tnt', 'ota']) {
    try {
      const resp = await fetch(`/api/studio/save-loose?which=${which}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${sanitiseFilename(state.name)}.${which}`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setStatus(`Loose save failed (${which}): ${err.message}`)
      return false
    }
  }
  setStatus('Saved loose .tnt + .ota.')
  const m = activeMap()
  if (m) { m.dirty = false; renderMapTabs() }
  return true
}

async function save() {
  const payload = buildSavePayload()
  const fixes = await runQualityChecker(payload)
  if (!fixes) return false
  payload.fixes = fixes
  setStatus('Building HPI archive…')
  try {
    const resp = await fetch('/api/studio/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(text || `HTTP ${resp.status}`)
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitiseFilename(state.name)}.hpi`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setStatus(`Saved ${a.download}.`)
    const m = activeMap()
    if (m) { m.dirty = false; renderMapTabs() }
    return true
  } catch (err) {
    setStatus(`Save failed: ${err.message}`)
    return false
  }
}

// ── Quality Checker ────────────────────────────────────────────────────────
//
// The save flow opens this dialog, runs every server-side check
// against the build of `payload`, and either auto-closes on green
// (proceeding straight to the actual save) or hands control to the
// user.  The user can apply individual Fix actions (which add the
// fix's id to a set and re-run all checks), apply every fix in one
// click (Fix All), force a save with the issues unresolved (Save
// anyway, gated by a confirm dialog), or back out entirely (Cancel).
//
// Resolves with:
//   - an array of fix ids to apply during the actual save (possibly empty)
//   - or `null` when the user cancelled — the caller should bail without saving.
//
// `mode` switches the dialog between two callers:
//   - 'save'  (default): the pre-save flow.  Auto-closes on a clean
//             first check, green "Save" button after a manual fix.
//   - 'audit': opened from the Advanced menu for a standalone
//             inspection.  No Save button at any time; the user
//             dismisses with Cancel (relabelled "Close") when done.
async function runQualityChecker(payload, { mode = 'save' } = {}) {
  const dlg = document.querySelector('#quality-dialog')
  const list = document.querySelector('#quality-list')
  const subtitle = document.querySelector('#quality-subtitle')
  const cancelBtn = document.querySelector('#quality-cancel')
  const fixAllBtn = document.querySelector('#quality-fix-all')
  const saveAnywayBtn = document.querySelector('#quality-save-anyway')
  if (!dlg || !list) return [] // no dialog present — skip checks
  const isAudit = mode === 'audit'
  return new Promise((resolve) => {
    // Seed from any fixes the user has previously accepted on this
    // map — they shouldn't have to re-click Fix every save.
    const m = activeMap()
    const fixes = new Set(m?.appliedFixes ?? [])
    let latestIssues = []
    let busy = false
    // Tracks whether the user has clicked Fix / Fix All this session.
    // Drives the save-button state machine: a clean first check
    // auto-closes the dialog (no user effort needed); once the user
    // has fixed something, we hold the dialog open with a green
    // "Save" button so they get to confirm what they fixed.
    let userInteracted = false
    // performance.now() at the moment the dialog became visible.  The
    // overall window minimum (QUALITY_WINDOW_MIN_MS) is measured from
    // here so a sub-second check still feels deliberate.
    const windowStart = performance.now()
    cancelBtn.textContent = isAudit ? 'Close' : 'Cancel'

    const rowSpec = (issue, severity, message) => ({
      check: issue.check,
      label: issue.label,
      severity,
      message: message ?? issue.message ?? '',
      canAutoFix: issue.canAutoFix,
      fix: issue.fix,
    })

    // renderRows patches the existing row DOM in place rather than
    // rebuilding it.  Each call previously did list.replaceChildren()
    // + createElement per row, which made every row re-trigger the
    // quality-row-in fade animation on every progress tick — the
    // dialog visibly flickered as checks completed sequentially.  By
    // creating each row once and updating only the parts that changed
    // (severity class, status glyph, message text, optional progress
    // bar and Fix button), the entrance animation plays exactly once
    // per row and the running spinner's infinite animation keeps its
    // current frame between ticks.
    const statusGlyph = { ok: '✓', warning: '!', error: '✗', running: '' }
    function renderRows(rows) {
      const wanted = new Set(rows.map((r) => r.check))
      for (const el of Array.from(list.querySelectorAll('.quality-row'))) {
        if (!wanted.has(el.dataset.check)) el.remove()
      }
      const existing = new Map()
      for (const el of list.querySelectorAll('.quality-row')) {
        existing.set(el.dataset.check, el)
      }
      let prev = null
      for (const r of rows) {
        let row = existing.get(r.check)
        if (!row) {
          row = document.createElement('div')
          row.dataset.check = r.check
          const status = document.createElement('div')
          const body = document.createElement('div')
          row.append(status, body)
          if (prev && prev.nextSibling) list.insertBefore(row, prev.nextSibling)
          else if (prev) list.appendChild(row)
          else if (list.firstChild) list.insertBefore(row, list.firstChild)
          else list.appendChild(row)
        } else {
          const expected = prev ? prev.nextSibling : list.firstChild
          if (row !== expected) list.insertBefore(row, expected)
        }
        const targetClass = `quality-row severity-${r.severity}`
        if (row.className !== targetClass) row.className = targetClass
        const status = row.children[0]
        const wantStatusClass = 'quality-status'
        if (status.className !== wantStatusClass) status.className = wantStatusClass
        const glyph = statusGlyph[r.severity] ?? ''
        if (status.textContent !== glyph) status.textContent = glyph
        const body = row.children[1]
        if (body.className !== 'quality-body') body.className = 'quality-body'
        let label = body.querySelector('.quality-label')
        if (!label) {
          label = document.createElement('div')
          label.className = 'quality-label'
          body.appendChild(label)
        }
        if (label.textContent !== r.label) label.textContent = r.label
        let msg = body.querySelector('.quality-message')
        if (!msg) {
          msg = document.createElement('div')
          msg.className = 'quality-message'
          body.appendChild(msg)
        }
        if (msg.textContent !== r.message) msg.textContent = r.message
        let prog = body.querySelector('.quality-progress')
        if (r.severity === 'running') {
          if (!prog) {
            prog = document.createElement('div')
            prog.className = 'quality-progress'
            prog.appendChild(document.createElement('span'))
            body.appendChild(prog)
          }
        } else if (prog) {
          prog.remove()
        }
        let fixBtn = row.querySelector('.btn')
        const wantFix = r.severity !== 'ok' && r.severity !== 'running' && r.canAutoFix && r.fix
        if (wantFix) {
          if (!fixBtn) {
            fixBtn = document.createElement('button')
            fixBtn.className = 'btn primary'
            fixBtn.textContent = 'Fix'
            fixBtn.addEventListener('click', () => applyFixes([r.fix]))
            row.appendChild(fixBtn)
          }
          fixBtn.disabled = busy
        } else if (fixBtn) {
          fixBtn.remove()
        }
        prev = row
      }
    }

    function refreshFooter() {
      const fixableLeft = latestIssues.some(
        (i) => i.severity !== 'ok' && i.canAutoFix && i.fix && !fixes.has(i.fix),
      )
      const anyIssue = latestIssues.some((i) => i.severity !== 'ok')
      fixAllBtn.classList.toggle('hidden', !fixableLeft)
      fixAllBtn.disabled = busy || !fixableLeft
      // The save button doubles as both "Save anyway" (red, when issues
      // remain) and "Save" (green, when the user has fixed everything
      // and we're holding the dialog open for their final click).  We
      // only hide it for the initial-clean-check case — there the
      // dialog auto-closes and the user never needs it.  Audit mode
      // (Advanced › Quality Check…) hides the button at all times —
      // there's no save to advance to.
      const showSave = !isAudit && (anyIssue || userInteracted)
      saveAnywayBtn.classList.toggle('hidden', !showSave)
      saveAnywayBtn.disabled = busy
      if (anyIssue) {
        saveAnywayBtn.textContent = 'Save anyway'
        saveAnywayBtn.classList.remove('ready')
        saveAnywayBtn.classList.add('danger')
        saveAnywayBtn.title = 'Save the map with the current issues unresolved'
      } else {
        saveAnywayBtn.textContent = 'Save'
        saveAnywayBtn.classList.remove('danger')
        saveAnywayBtn.classList.add('ready')
        saveAnywayBtn.title = 'All checks passed — write the map to disk'
      }
      cancelBtn.disabled = busy
    }

    async function runChecks() {
      busy = true
      refreshFooter()
      // Seed every known check as "running" so the user sees motion
      // immediately, then patch in real results on response.
      const placeholders = latestIssues.length
        ? latestIssues.map((i) => rowSpec(i, 'running', 'Re-checking…'))
        : [rowSpec({ check: 'dedupTiles', label: 'Deduplicate Tiles', canAutoFix: false, fix: '' }, 'running', 'Inspecting tile pool…')]
      renderRows(placeholders)
      subtitle.textContent = isAudit
        ? 'Running quality checks…'
        : 'Running pre-save checks…'
      const checkStart = performance.now()
      let data, fetchErr
      try {
        const resp = await fetch('/api/studio/quality-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, fixes: Array.from(fixes) }),
        })
        if (!resp.ok) {
          const text = await resp.text()
          fetchErr = new Error(text || `HTTP ${resp.status}`)
        } else {
          data = await resp.json()
        }
      } catch (err) {
        fetchErr = err
      }
      if (fetchErr) {
        // Even the error path respects the per-check minimum — the
        // single error row needs at least QUALITY_CHECK_MIN_MS of
        // visible "running" before we flip it to the error state.
        const elapsed = performance.now() - checkStart
        if (elapsed < QUALITY_CHECK_MIN_MS) {
          await new Promise((r) => setTimeout(r, QUALITY_CHECK_MIN_MS - elapsed))
        }
        latestIssues = []
        busy = false
        renderRows([{
          check: 'fetch',
          label: 'Quality Checker',
          severity: 'error',
          message: `Could not reach the kbot server: ${fetchErr.message}`,
          canAutoFix: false,
          fix: '',
        }])
        subtitle.textContent = 'Check failed.'
        refreshFooter()
        return
      }
      const results = Array.isArray(data.issues) ? data.issues : []
      // Sequentially reveal each result — each check spends at least
      // QUALITY_CHECK_MIN_MS in the "running" state before its row
      // transitions to its final colour.  Without this, the dialog
      // feels like a placebo on a fast machine.
      for (let i = 0; i < results.length; i++) {
        const targetMs = (i + 1) * QUALITY_CHECK_MIN_MS
        const wait = targetMs - (performance.now() - checkStart)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
        const rows = results.map((iss, j) => {
          if (j <= i) return rowSpec(iss, iss.severity, iss.message)
          const ph = placeholders[j]
          return rowSpec(iss, 'running', ph?.message ?? 'Inspecting…')
        })
        renderRows(rows)
      }
      latestIssues = results
      // Clear busy *before* the final renderRows so per-row Fix
      // buttons are interactive (button.disabled is sampled at
      // row-creation time, not via refreshFooter).
      busy = false
      renderRows(results.map((i) => rowSpec(i, i.severity, i.message)))
      refreshFooter()
      const total = results.length
      const passed = results.filter((i) => i.severity === 'ok').length
      const summary = `${passed} of ${total} checks passed`
      if (data.allOk) {
        if (!userInteracted && !isAudit) {
          // Clean first check on the save path — sail through, but
          // wait for the overall window minimum so the dialog stays
          // visible long enough to register.
          subtitle.textContent = `${summary} — saving…`
          const elapsed = performance.now() - windowStart
          const wait = Math.max(0, QUALITY_WINDOW_MIN_MS - elapsed)
          setTimeout(() => finish(Array.from(fixes)), wait)
          return
        }
        // Hold the dialog open — either the user fixed something
        // (save mode: green Save) or this is an audit (Close button).
        subtitle.textContent = isAudit
          ? `${summary}.`
          : `${summary} — click Save to write the map.`
        return
      }
      subtitle.textContent = isAudit
        ? `${summary} — review the warnings below.`
        : `${summary} — review before saving.`
    }

    async function applyFixes(ids) {
      userInteracted = true
      for (const id of ids) {
        fixes.add(id)
        // Persist into the active map so future saves don't re-prompt
        // for fixes the user has already approved.
        if (m) m.appliedFixes.add(id)
      }
      await runChecks()
    }

    function finish(result) {
      dlg.removeEventListener('keydown', onKey)
      document.removeEventListener('keydown', onDocKey, true)
      cancelBtn.removeEventListener('click', onCancel)
      fixAllBtn.removeEventListener('click', onFixAll)
      saveAnywayBtn.removeEventListener('click', onSaveAnyway)
      dlg.classList.add('hidden')
      resolve(result)
    }

    function onCancel() {
      if (busy) return
      setStatus(isAudit ? 'Quality check closed.' : 'Save cancelled.')
      finish(null)
    }

    async function onFixAll() {
      if (busy) return
      const ids = latestIssues
        .filter((i) => i.severity !== 'ok' && i.canAutoFix && i.fix && !fixes.has(i.fix))
        .map((i) => i.fix)
      if (ids.length === 0) return
      await applyFixes(ids)
    }

    async function onSaveAnyway() {
      if (busy) return
      const anyIssue = latestIssues.some((i) => i.severity !== 'ok')
      // Green-Save path (no remaining issues) — skip the confirm prompt
      // since there's nothing dangerous to confirm.  The red Save-anyway
      // path still gates the save behind the confirmation.
      if (!anyIssue) {
        finish(Array.from(fixes))
        return
      }
      const ok = await confirmDialog({
        title: 'Save with unresolved issues?',
        message: 'There are issues with this map. The TNT will still be written, but the unresolved warnings remain in the saved file.',
        okLabel: 'Save anyway',
        okDanger: true,
      })
      if (!ok) return
      finish(Array.from(fixes))
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
    }
    // The Escape global handler closes the OTA / Resize / Settings
    // dialogs — wire the same convention here.  Using capture so we
    // beat the global handler's `closest('input')` guard.
    function onDocKey(e) {
      if (dlg.classList.contains('hidden')) return
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); onCancel()
      }
    }

    cancelBtn.addEventListener('click', onCancel)
    fixAllBtn.addEventListener('click', onFixAll)
    saveAnywayBtn.addEventListener('click', onSaveAnyway)
    dlg.addEventListener('keydown', onKey)
    document.addEventListener('keydown', onDocKey, true)
    dlg.classList.remove('hidden')
    runChecks()
  })
}

// ── Modelling tab ──────────────────────────────────────────────────────────
//
// The welcome dialog's "Modelling" tab is a thin shell over the model3d/
// module: clicking "Open a 3DO model" loads /api/studio/models, the
// browser presents a familiar list-with-filter (same shape as the map
// picker), and the chosen model opens in a full-screen WebGL viewer.

let modelViewerInstance = null
let availableModels = []
let modelsLoaded = false
// selectedModelName was the module-scoped staging slot the legacy
// Open Unit dialog wrote into before openModelViewer fired.  Picker
// is React now and resolves with { name, sandboxIntent } directly so
// the staging slot is gone.


function wireModelDialogs() {
  // The welcome-card buttons (#welcome-model-open, #welcome-sandbox)
  // are React-managed now via mountWelcomeScreen()'s onOpenUnit /
  // onOpenSandbox callbacks.  The Open Unit picker dialog itself is
  // also React-owned (see /ui/pickers/open-unit-dialog.js), so the
  // legacy #model-filter / #model-open-back / #model-open-confirm
  // wiring is gone too — those static elements are no longer driven.
  // No "Close" button on the viewer overlay any more — the user
  // closes the model tab via the × in the shared tab bar, same
  // gesture they use for maps.
  //
  // The unit-editor ribbon (Model / Camera / Rendering / Scene / Studio
  // Options / Animation / View / Configure / Help) is React-managed
  // now (see /ui/unit-editor/ribbon/model-viewer-ribbon.js).  Mount +
  // bridge wiring lives in wireModelViewerRibbon() which is called
  // once the React UI island has finished loading.
  //
  // Tree filter — typing narrows the visible pieces to those whose
  // name matches.  Match is case-insensitive substring, applied to
  // both group and leaf rows.
  const treeFilter = $('#mv-tree-filter')
  if (treeFilter) treeFilter.addEventListener('input', () => filterPieceTree(treeFilter.value))
  wireMvInspectors()
  // Bring the Preact UI island online once at boot.  Persistence
  // callbacks bridge the panel-store's signals into the existing
  // prefs system so a React panel's saved position / collapsed /
  // visible state ends up in the same localStorage blob the legacy
  // panels write to, and the View menu + Developer Tools dropdown
  // mirrors stay in lockstep without an extra cross-channel.
  configureReactUi()
}

// rowNameText / wireToggleSubmenu / wireSliderInput /
// wireModelRibbonDropdown / setModelViewerStatus / wireModelViewMenu /
// wireModelChromeButtons / wireModelTabBar — all replaced by the React
// model-viewer ribbon (/ui/unit-editor/ribbon/model-viewer-ribbon.js).
// Bridge wiring lives in wireModelViewerRibbon() further down in this
// file; the model name + tri count status line moved into the React
// dropdown body via the bridge.showStats callback.

// modelOpenIntent: tells openModelViewer how to handle the next
// load — 'add' pushes a new tab, 'replace' overwrites the current
// active tab (only meaningful when the active tab is already a
// model tab).
let modelOpenIntent = 'add'

// updateTopbarDocInfo populates the shared topbar's doc-info pill
// AND the shared footer's hints from whichever tab is now active.
// Empty when nothing's open.
function updateTopbarDocInfo(tab) {
  const titleEl = $('#app-doc-title')
  const metaEl = $('#app-doc-meta')
  const hintsEl = $('#app-hints')
  const MAP_HINTS = 'Drag-paint with the mouse.  Hold <kbd>Shift</kbd> to erase.  Scroll to zoom (<kbd>Shift</kbd>+scroll pans).'
  const MODEL_HINTS = 'Drag — orbit · Wheel — zoom · <kbd>Shift</kbd> / right-drag — pan · Click a piece to centre on it'
  if (!titleEl || !metaEl) return
  if (!tab) {
    titleEl.textContent = ''
    metaEl.textContent = ''
    if (hintsEl) hintsEl.innerHTML = MAP_HINTS
    return
  }
  if (tab.type === 'model') {
    titleEl.textContent = tab.name
    const parts = [tab.meta?.unitTitle, tab.meta?.side, tab.meta?.category, tab.meta?.description].filter(Boolean)
    metaEl.textContent = parts.join(' · ')
    if (hintsEl) hintsEl.innerHTML = MODEL_HINTS
  } else {
    const m = tab.map
    titleEl.textContent = mapDisplayName(m)
    const parts = [
      m?.tileW && m?.tileH ? `${m.tileW}×${m.tileH}` : null,
      m?.planet || null,
    ].filter(Boolean)
    metaEl.textContent = parts.join(' · ')
    if (hintsEl) hintsEl.innerHTML = MAP_HINTS
  }
}

// activateModelTab makes a model tab the visible one — refreshes
// the shared topbar info and asks the per-tab viewer to load (or
// re-show) that 3DO.  Each unit tab owns its own ModelViewer +
// canvas + runtime + MvControls so swapping between unit tabs
// preserves per-unit state (live threads, weapon mid-fire, build
// progress, etc.).  modelViewerInstance + _mvControls are aliases
// that always point at the active tab's instances — host code that
// reads either gets the right tab's data.
async function activateModelTab(tab) {
  // Lazy-import the model3d module so users who never click a
  // model tab don't pay for the shader / matrix code.
  const mod = await import('./model3d/index.js')
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
    const legacyCanvas = sharedModelViewerCanvas()
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
        mvFetchUnitMeta(viewer)
        // Wire the per-frame inspector + auto-build hook.  Bind to
        // the viewer's controls explicitly so the closure stays
        // accurate even when a tab swap retargets _mvControls.
        if (viewer.renderer) {
          viewer.renderer.onAfterFrame = (dtMs) => {
            advanceMvAutoBuild(dtMs)
            // Only refresh inspectors when THIS viewer is the
            // active one — backgrounded tabs shouldn't shove their
            // signal updates into the React tree.
            if (modelViewerInstance === viewer) refreshMvInspectors(dtMs)
            ctrls.tick(dtMs)
          }
        }
        // Per-tab sidebar + COB panel only refresh when THIS viewer
        // is the front one.  Otherwise a delayed load (the user
        // clicked away mid-fetch) would clobber the active tab's
        // piece tree / textures / etc.
        if (modelViewerInstance === viewer) {
          renderPieceTree(model)
          renderTexturesTab(model)
          wireMvSidebarTabs()
          refreshCobPanel(cob)
          _mvControls = ctrls
        }
      },
    })
    tab.viewer = viewer
  }
  // Promote this tab's viewer to the global aliases the rest of the
  // studio reads (host bridges, panels, ribbon handlers, inspector
  // refresh).  Mirrors how sandboxViewInstance flips on each
  // activateSandboxTab.
  modelViewerInstance = tab.viewer
  _mvControls = tab.viewer._mvControls || null
  // Debug shim — keep window.__modelViewer pointing at the active
  // viewer so dev-console scripts see the right unit.
  window.__modelViewer = tab.viewer
  // Attach this tab's canvas into the stage so it's the visible
  // surface again.  Idempotent — re-attaching to the same parent
  // is a no-op.
  if (stage && typeof tab.viewer.attach === 'function') tab.viewer.attach(stage)
  // Wire the per-frame inspector refresh callback the first time
  // the renderer is alive (it might not be on the very first
  // activation if the network fetch lost a race).  Idempotent.
  if (tab.viewer.renderer && !tab.viewer.renderer.onAfterFrame) {
    tab.viewer.renderer.onAfterFrame = (dtMs) => {
      advanceMvAutoBuild(dtMs)
      if (modelViewerInstance === tab.viewer) refreshMvInspectors(dtMs)
      tab.viewer._mvControls?.tick(dtMs)
    }
  }
  // Carry the unit editor's persisted Auto-Rotate state into this
  // tab's viewer.  Per-tab — each tab can have its own rotate
  // state if you wanted, but the global cache means all tabs share
  // the user's last pick by default.
  tab.viewer.setAutoRotate(_unitEditorAutoRotate)
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
    if (modelViewerInstance === tab.viewer && tab.viewer._mvControls) {
      _mvControls = tab.viewer._mvControls
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
  resumeIncomingTabRuntime(tab)
  if (!alreadyLoaded) {
    applyDefaultGroundFor(tab.meta)
    // Apply Unit Editor defaults from the persisted Settings the
    // first time we load this tab's unit.
    applyUnitEditorDefaults()
  }
}

// applyUnitEditorDefaults pushes settings.unitDefault* through the
// renderer's setters + into the React ribbon's state signal so the
// Studio Options dropdown's check-marks + Environment chip reflect
// the freshly-applied defaults.
function applyUnitEditorDefaults() {
  if (!modelViewerInstance?.renderer) return
  const s = state.settings || DEFAULT_SETTINGS
  const r = modelViewerInstance.renderer
  const env = s.unitDefaultEnv || 'greenworld'
  const reflections = s.unitDefaultReflections !== false
  const bob = s.unitDefaultBob !== false
  const waterReflections = s.unitDefaultWaterReflections !== false
  const specular = s.unitDefaultSpecular !== false
  const godbeams = s.unitDefaultGodBeams !== false
  // Environment first because it swaps the sky scheme; the toggles
  // below operate on flags the env doesn't touch.
  r.setEnvironment(env)
  r.setReflectionsEnabled(reflections)
  r.setBobEnabled(bob)
  r.setWaterReflectionsEnabled(waterReflections)
  r.setSpecularEnabled(specular)
  r.setGodBeamsEnabled(godbeams)
  if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
    _reactUi.setModelViewerRibbonState({
      env, reflections, bob, waterReflections, specular, godbeams,
    })
  }
}

// applyDefaultGroundFor sets the ground mode based on the unit's
// FBI metadata.  Ships / subs get "sea"; every other unit falls back
// to "terrain" so opening a kbot after a sub doesn't leave it
// floating on water from the previous tab's choice.
// mvFetchUnitMeta loads the FBI movement + weapon refs for the
// currently-loaded model and pushes the result onto the viewer +
// the Controls overlay.  Fire-and-forget — failure leaves the
// action buttons disabled (no metadata = "we don't know what the
// unit can do" = safe default).
async function mvFetchUnitMeta(mv) {
  if (!mv?.model) return
  mv.unitMeta = null
  // The model name comes from the COB unit (set by model-viewer.js
  // open() to the originally-requested model name).  Without a COB
  // the unit isn't a real unit anyway — props/features have no
  // FBI metadata.
  const name = mv.cob?.unit?.name
  if (!name) return
  try {
    const resp = await fetch(`/api/studio/unit/${encodeURIComponent(name)}`)
    if (!resp.ok) return
    mv.unitMeta = await resp.json()
    if (_mvControls) _mvControls.onMetaLoaded()
    // Controls/Ports panel re-renders off the inspector-store
    // signals; once unitMeta is set the next publish updates the
    // panel's per-port visibility (canMove, isBuilder, onoffable
    // gating) automatically — no imperative call needed.
    // Populate the left-panel Weapons tab now that the FBI + weapon
    // TDF data is in.  Empty-state shows "No weapons declared" for
    // structures / props.  Passed the whole viewer so the renderer
    // can read scriptNames + wire change-weapon / sound-play actions.
    renderMvWeaponsTab(mv)
  } catch (err) {
    console.warn(`[unit-meta:${name}] fetch failed:`, err)
  }
}

function applyDefaultGroundFor(meta) {
  if (!modelViewerInstance?.renderer) return
  const want = meta?.defaultGround || 'terrain'
  // Submersion comes from the FBI's TEDClass / Category / WaterLine
  // (computed server-side in inferSubmersionMode).  Surface ships
  // ride the boot-stripe; subs end up under the water; everything
  // else sits on top.
  modelViewerInstance.renderer.setSubmersionMode(meta?.submersionMode || '')
  modelViewerInstance.renderer.setGroundMode(want)
  // Sub units are lifted UP off the seabed via a model-matrix Y
  // translation; the camera was framed in open() against the
  // un-translated bounds, so without this adjustment the camera
  // target stays at the original centroid (well below the lifted
  // unit).  Bump target Y by the same offset so the camera keeps
  // looking at where the unit is actually rendered.
  const yOff = modelViewerInstance.renderer.getUnitYOffset?.() || 0
  if (yOff !== 0 && modelViewerInstance.camera) {
    modelViewerInstance.camera.target[1] += yOff
    modelViewerInstance.renderer.requestRedraw()
  }
  // Submerged units need the camera eye to sit BELOW the water
  // plane, otherwise the renderer paints the surface from above
  // and the sub itself disappears under the waves.  open() set
  // pitch=18 deg / distance×1.25 unconditionally — for subs we
  // recompute pitch so eye.y lands a few units under uWaterY.
  //   eye.y = target.y + distance · sin(pitch)
  // Solve for pitch given a target eye.y of (waterY - margin).
  if (meta?.submersionMode === 'submerged' && modelViewerInstance.camera) {
    const cam = modelViewerInstance.camera
    const r = modelViewerInstance.renderer
    const waterY = r._getWaterY ? r._getWaterY() : 0
    const margin = 6 // eye sits this far under the surface
    const desiredEyeY = waterY - margin
    const dy = desiredEyeY - cam.target[1]
    const dist = Math.max(1, cam.distance || 1)
    // Clamp the sine to [-1, 0.05] so we always land at or just
    // below horizontal even if the math says the eye should rise.
    const sinP = Math.max(-1, Math.min(0.05, dy / dist))
    cam.pitch = Math.asin(sinP)
    r.requestRedraw()
  }
  // Sync the React Scene/Ground dropdown's selection chip so the
  // closed dropdown shows what's actually applied (ship default sets
  // Sea programmatically; the user never clicked the row so the
  // signal wouldn't otherwise update).
  if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
    _reactUi.setModelViewerRibbonState({ ground: want })
  }
}

// refreshPieceTreeEyes — no-op now that the piece tree is React-managed.
// The React component (see /ui/unit-editor/tabs/piece-tree.js) subscribes
// to runtimeTick + reads piece.visible directly on each render, so the
// inspector's 4 Hz publish already keeps icons in sync.  Kept as a
// stub so call sites in studio.js (and anywhere external) don't break.
function refreshPieceTreeEyes() { /* React subscribes to runtimeTick */ }

// refreshPieceTreeStatus + pieceDisplayName — both moved into the
// React piece-tree component (see /ui/unit-editor/tabs/piece-tree.js).
// The component owns the per-piece flag rendering + the GP →
// "Ground Plate (GP)" name humanisation directly.

// renderPieceTree replaces the sidebar drawer with a hierarchical
// representation of the model's pieces — each piece becomes either a
// drawer-group (if it has children) or a drawer-item-piece (leaf).
// Click the row to centre the camera on the piece; hover highlights
// the piece's wireframe in red; the eye toggle hides/shows the piece.
// ── Model viewer floating inspectors ──────────────────────────────
//
// Three overlays — COB Scripts, Static Vars, Camera — that hover
// over the canvas, can be dragged / collapsed / closed, and are
// individually toggleable from the View dropdown.  Each is hidden
// by default; the user opts in via the View menu (and the prefs
// remember the choice).  Per-frame contents are refreshed by
// refreshMvInspectors() which the model renderer calls at the
// tail of every redraw — cheap when panels are hidden because
// the function early-returns on each closed panel.

const MV_INSPECTOR_IDS = ['mv-inspector-scripts', 'mv-inspector-actions', 'mv-inspector-ports', 'mv-inspector-staticvars', 'mv-inspector-camera', 'mv-inspector-effects', 'mv-inspector-audio']

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
function clampMvInspectorIntoStage(panel) {
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
function clampAllMvInspectors() {
  for (const panel of document.querySelectorAll('.mv-inspector')) {
    clampMvInspectorIntoStage(panel)
  }
}

function wireMvInspectors() {
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
  // Runtime panel's Pause / Step / Terminate All Scripts controls used
  // to be vanilla DOM buttons (#mv-threads-stopall, #mv-threads-toggle,
  // #mv-threads-step) wired up here.  The React RuntimePanel now owns
  // them via host-bridge callbacks (configureReactUi → toggleRuntimePaused
  // / stepRuntime / stopAllThreads).  The legacy IDs no longer exist in
  // the DOM, so the old getElementById-and-attach handlers were dead
  // code — and they also referenced rt._threads / single-unit semantics
  // that broke when the runtime went multi-unit.  Removed wholesale.
  // Controls panel "Create Unit" button is React-managed now (see
  // /ui/panels/controls-panel.js).  Click handler routes through the host
  // bridge's runControlsCreate, which is configured in
  // configureReactUi to fire the same start('Create') +
  // startMvAutoBuild sequence the legacy wired-once handler did.
  // Controls panel "Reset" button — sibling of the Stop action.
  // Same handler as the historic Script Commands panel reset (full
  // COB + controller reset) but exposed beside Stop so the user can
  // revert without opening another inspector.
  const ctrlsReset = document.getElementById('mv-controls-reset-btn')
  if (ctrlsReset && ctrlsReset.dataset.wired !== '1') {
    ctrlsReset.dataset.wired = '1'
    ctrlsReset.addEventListener('click', (e) => {
      e.stopPropagation()
      modelViewerInstance?.resetState?.()
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

function wireMvInspector(panelId) {
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

function setMvInspectorVisible(panelId, visible, opts = {}) {
  // React-managed panels route through the panel-store so the Preact
  // tree re-renders with the right .hidden class.  Writing straight
  // into the DOM here would survive only until the next Preact diff
  // and then snap back to whatever the store says.  Legacy panels
  // still take the direct-DOM path below.
  if (_reactUi && _reactUi.isInspectorMounted && _reactUi.isInspectorMounted(panelId)) {
    _reactUi.setPanelVisible(panelId, !!visible)
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

// refreshMvInspectors is called from the model renderer's draw loop
// each frame.  Cheap when nothing is visible — checks each panel's
// hidden flag and bails early.  Throttled to 4 Hz so an
// auto-rotating camera doesn't burn DOM ops every animation tick.
let _mvInspectorThrottleMs = 0
// Sandbox-only sentinel — tracks which unit's Script Commands panel
// is currently rendered.  refreshMvInspectors rebuilds the panel only
// when this changes so the per-tick refresh doesn't flicker the
// button list mid-hover.  null = no unit focused (zero or multi-
// select; the panel shows "No COB loaded.").
let _mvSandboxFocusedUnitId = -1
function refreshMvInspectors(dtMs = 16) {
  _mvInspectorThrottleMs += dtMs
  if (_mvInspectorThrottleMs < 250) return
  _mvInspectorThrottleMs = 0
  // Pick the viewer to source inspector data from — when a sandbox
  // tab is active we want the sandbox view's camera + runtime, not
  // the (possibly stale) single-unit viewer.  Both view classes
  // expose .camera, .renderer, and a .cob-like surface, so the
  // existing panel renderers don't have to know which kind it is.
  const sandbox = (typeof window !== 'undefined') ? window.__sandboxView : null
  const sandboxActive = sandbox && document.getElementById('model-viewer-dialog')?.classList?.contains('sandbox-mode')
  // Build the proxy mv.  When exactly ONE unit is selected in
  // sandbox we promote its CobBinding to mv.cob — the single-unit
  // inspector renderers (Actions / Static Vars / Threads) then
  // populate against the selected unit, mirroring the experience in
  // the Unit Editor.  With zero or multiple units selected we fall
  // back to the runtime-only proxy so the runtime / runtime-list
  // panels still tick but the per-unit panels show "select a unit".
  // mv proxy comes from view.getInspectorMv() now — viewer and
  // sandbox each implement the method (BaseView contract) and return
  // the shape the inspector panel renderers below consume.  This
  // collapses what used to be a ~50-line sandbox-vs-viewer branch
  // here into one method call, and pushes the "aggregate scene
  // particles", "synthesise stub cob when 0/multi selected", and
  // "lifecycle backfill" responsibilities home to the views.
  let mv = sandboxActive
    ? (sandbox && typeof sandbox.getInspectorMv === 'function' ? sandbox.getInspectorMv() : null)
    : (modelViewerInstance && typeof modelViewerInstance.getInspectorMv === 'function'
        ? modelViewerInstance.getInspectorMv()
        : modelViewerInstance)
  if (sandboxActive) {
    // Pull focused-unit id back out so the Actions-panel rebuild
    // gating + the Controls button enable map below can read it.
    // The view stashed it on mv._focusedUnitId.
    const focusedId = mv && mv._focusedUnitId != null ? mv._focusedUnitId : null
    // Focused-unit sentinel — kept here so other per-tick code that
    // wants to know "did the selection change this tick?" can read
    // it off _mvSandboxFocusedUnitId.  The Script Commands panel
    // itself now re-renders off the inspector-store mv signal
    // published below (no imperative render here).
    if (focusedId !== _mvSandboxFocusedUnitId) {
      _mvSandboxFocusedUnitId = focusedId
    }
    // Enable the Controls panel's action buttons based on what the
    // selection as a whole supports.  Single-unit selection mirrors
    // the unit-editor's MvControls _refreshButtons logic.  Multi-
    // unit selection takes the INTERSECTION of capabilities — a
    // button only enables when EVERY selected unit's COB carries the
    // matching Aim* / Fire* / Query* scripts, so a Move-and-Primary
    // selection that includes a unit without Tertiary will grey out
    // Tertiary.  Move + Stop are always enabled when there's at
    // least one selected unit (anything that walked into the
    // selection set is moveable / stoppable by definition).
    const selectedUnits = (sandbox && typeof sandbox.getSelectedUnits === 'function')
      ? sandbox.getSelectedUnits().filter((u) => u && u.binding && u.binding.hasScript)
      : []
    const everyHasAny = (names) => selectedUnits.length > 0
      && selectedUnits.every((u) => names.some((n) => u.binding.hasScript(n)))
    const ctrlEnabled = {
      move: selectedUnits.length > 0,
      primary:   everyHasAny(['AimPrimary',   'FirePrimary',   'QueryPrimary']),
      secondary: everyHasAny(['AimSecondary', 'FireSecondary', 'QuerySecondary']),
      tertiary:  everyHasAny(['AimTertiary',  'FireTertiary',  'QueryTertiary']),
    }
    for (const btn of document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')) {
      const action = btn.dataset.ctrlAction
      if (action === 'stop' || action === 'reset') continue
      btn.disabled = !ctrlEnabled[action]
    }
  }
  if (!mv) return
  // Publish the freshly-computed proxy + sandbox flags to the React
  // inspector store.  Every migrated panel (Static Vars, Audio) is
  // subscribed to these signals via @preact/signals and re-renders
  // automatically when its inputs change.  Skipping the per-panel
  // imperative renderMvXxxPanel call below for migrated panels is
  // intentional — the React tree owns those bodies now.
  if (_reactUi && typeof _reactUi.publishInspectorState === 'function') {
    const selSize = (sandbox && sandbox.scene && sandbox.scene.selected)
      ? sandbox.scene.selected.size
      : 0
    _reactUi.publishInspectorState({ mv, sandboxActive: !!sandboxActive, sandboxSelSize: selSize })
  }
  // Runtime/Scripts panel — React-managed (see /ui/panels/runtime-panel.js).
  // Stats + Speed + Pause/Step/Stop All + per-unit thread list all
  // re-render off the inspector-store mv signal + the runtimeTick
  // counter; no per-tick imperative render here.
  // Static Vars + Renderer panels — React-managed (see
  // /ui/panels/static-vars-panel.js, /ui/panels/renderer-panel.js).  Bodies
  // re-render off the inspector-store signals published above;
  // no per-tick imperative calls needed here.
  // Ports panel — re-render the row controls whenever the active view
  // Controls / Ports panel — React-managed (see /ui/panels/controls-panel.js).
  // The component reads cobPorts / cobDamage / cobBuildPercent off
  // the inspector-store mv signal and re-renders per publish, so
  // there's no need for an imperative render or live-values refresh
  // here.  The per-tick syncMvActionsRunning call below still
  // promotes 'creating' → 'created', which the React panel's class-
  // name computation picks up on the next render.
  // Effects + Audio panels — both React-managed.  See
  // /ui/panels/effects-panel.js and /ui/panels/audio-panel.js.  Bodies re-render
  // off the inspector-store signals published above; the
  // FloatingPanel visibility signal gates the heavy pool walks so a
  // hidden / collapsed panel does no per-tick work.
  // Weapons-tab live bits — reload bars + recent-projectiles lists.
  // Cheap: the panel is in the left sidebar (not an inspector), so
  // we don't gate on hidden-class.  Each card's __mvLiveRefresh
  // closure no-ops when the card has no reload bar / projlist.
  refreshMvWeaponsLive(mv)
  // Promote 'creating' → 'created' once the Create thread has died.
  // The React Controls + Script Commands panels read cob._lifecycle
  // and render the right gated state next refresh, so this is the
  // only imperative bit the host still needs to do.  The ribbon's
  // COB section is still vanilla and gates its own button rows.
  syncMvActionsRunning(mv.cob)
  syncCobRibbonRunning(mv.cob)
  // Runtime stats — rendered by the React RuntimePanel (subscribes
  // to runtimeTick to re-read tick/lastMs/units/threads each publish).
  // The legacy refreshMvRuntimeStats sweep is gone; mvRefreshRuntimeToggle
  // is still called from the toggle-paused handler so spacebar /
  // programmatic pause keep the button label in sync.
  // Piece-tree status icons (eye / shade / cache / shadow) — mirror
  // the live COB-driven per-piece state.  Cheap query-and-toggle
  // per row so a Create-script hide / dont-shade lights up in the
  // tree the same tick the opcode runs.
  refreshPieceTreeEyes()
  // Thread code-view modals — refresh every open debugger panel.
  // Each panel tracks its own thread, hover state, and DOM scope so
  // multiple debuggers can run side-by-side.
  for (const state of _mvThreadCodePanels.values()) {
    refreshMvThreadCodeHighlight(state)
    redrawMvThreadCodeBrackets(state)
  }
}

// _mvCollapsedUnits + renderMvScriptsPanel + buildMvUnitGroupHeader +
// mvResetUnit + renderMvThreadRow + applyMvUnitCollapseState —
// replaced by the Preact RuntimePanel component in
// /ui/panels/runtime-panel.js (round 18).  Per-unit Reset routes through
// hostBridge.resetUnit; click-to-debug routes through
// hostBridge.openThreadCodeModal.

// ── Thread code-view modal ─────────────────────────────────────────────
// Pops over the model viewer when the user clicks a Threads-panel row.
// Renders the thread's script disassembly (each instruction on a line
// with offset + opcode-category colour) and highlights the row at the
// current PC.  Locals + stack tray on the right.  Refreshes via the
// same 4 Hz `refreshMvInspectors` tick so the highlight tracks live
// execution.  Tracking by thread id so the modal stays bound to the
// specific thread (not just "the next thread named Foo").

// Keyed by thread id → per-panel state.  Multiple debugger panels
// can be open simultaneously; each clones the template and tracks
// its own hover/pc/locals scope.  Iterated by the inspector tick
// (refreshMvInspectors) so each window updates independently.
const _mvThreadCodePanels = new Map()

// openMvThreadCodeModal opens (or focuses) a debugger panel for the
// given thread.  If a panel already exists for this thread id it
// just rises to the top — clicking the same thread twice doesn't
// pile up duplicates.  Otherwise a fresh template instance is cloned,
// cascaded ~30px down/right from the previous to keep both visible.
function openMvThreadCodeModal(cob, thread) {
  const existing = _mvThreadCodePanels.get(thread.id)
  if (existing) {
    bringMvThreadCodePanelToFront(existing)
    return
  }
  const tpl = document.getElementById('mv-thread-code-template')
  if (!tpl) return
  const node = tpl.content.firstElementChild.cloneNode(true)
  node.dataset.threadId = String(thread.id)
  // Cascade — each new panel offsets from the prior so they don't
  // perfectly overlap.  Wraps every 8 to keep things on-screen.
  const slot = _mvThreadCodePanels.size
  const cascade = (slot % 8) * 30
  node.style.left = (360 + cascade) + 'px'
  node.style.top = (120 + cascade) + 'px'
  // Mount inside the model viewer dialog so the panel inherits its
  // display:none when the user switches to a non-model tab — without
  // this, fixed-position panels stayed pinned to the viewport across
  // map tabs.  Falls back to document.body if the dialog isn't
  // rendered yet (defensive — shouldn't happen in normal use).
  const host = document.getElementById('model-viewer-dialog') || document.body
  host.appendChild(node)
  // AbortController scopes the panel's window-level drag/resize
  // listeners so closing one debugger cleanly removes its handlers
  // (rather than leaking one set per ever-opened panel).
  const ac = new AbortController()
  const state = { panel: node, cob, threadId: thread.id, hoverLine: null, hoverAsmIdx: null, abort: ac }
  _mvThreadCodePanels.set(thread.id, state)
  bringMvThreadCodePanelToFront(state)
  wireMvThreadCodeChrome(state)
  renderMvThreadCodeSource(state, thread)
  renderMvThreadCodeDecompiled(state, cob)
  wireMvThreadCodeBrackets(state)
  refreshMvThreadCodeHighlight(state)
  redrawMvThreadCodeBrackets(state)
}

// bringMvThreadCodePanelToFront tops the z-order of the chosen
// panel.  Called on initial open + on every header pointerdown.
// Bumps z-index relative to the highest currently-open panel so
// clicks always raise the focused one.
function bringMvThreadCodePanelToFront(state) {
  let top = 6000
  for (const s of _mvThreadCodePanels.values()) {
    const z = parseInt(s.panel.style.zIndex || '6000', 10)
    if (z > top) top = z
  }
  state.panel.style.zIndex = String(top + 1)
}

function closeMvThreadCodeModal(state) {
  if (!state) return
  state.abort?.abort()
  state.panel.remove()
  _mvThreadCodePanels.delete(state.threadId)
}

// closeAllMvThreadCodePanels tears down every open debugger panel.
// Called on tab switch so a debugger opened in tab A isn't left
// pointing at tab A's now-stale runtime once tab B becomes active.
function closeAllMvThreadCodePanels() {
  for (const state of [..._mvThreadCodePanels.values()]) closeMvThreadCodeModal(state)
}

// wireMvThreadCodeChrome attaches per-panel handlers — close, pause,
// step, drag, resize, vars-collapse.  Idempotent via dataset.wired
// (each cloned node starts unwired so flags don't bleed across).
function wireMvThreadCodeChrome(state) {
  const panel = state.panel
  const closeBtn = panel.querySelector('.mv-thread-code-close')
  if (closeBtn) closeBtn.addEventListener('click', () => closeMvThreadCodeModal(state))
  // Pause/resume the entire runtime.  Icon swaps ⏸↔▶ so the user
  // sees what the click WILL do (current state visible as label).
  const pauseBtn = panel.querySelector('.mv-thread-code-pause')
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      const rt = state.cob?.runtime
      if (!rt) return
      rt.setPaused(!rt.paused)
      pauseBtn.textContent = rt.paused ? '▶' : '⏸'
      pauseBtn.title = rt.paused ? 'Resume the runtime.' : 'Pause / resume the entire runtime.'
    })
  }
  // Step past a hit breakpoint — KEEP the thread's breakpointHit flag
  // set so _runThread reads `allowFirstBreakpoint=false`, skipping the
  // BP check for the very first instruction this tick (executing the
  // BP'd line once) before resuming normal BP checking.  We briefly
  // unpause the runtime, tick once, then leave it paused again so the
  // user can keep stepping or hit Resume to keep going.  Clearing
  // breakpointHit (the old behaviour) caused the BP to immediately
  // re-trigger on the same line, defeating the step.
  const stepBtn = panel.querySelector('.mv-thread-code-step')
  if (stepBtn) {
    stepBtn.addEventListener('click', () => {
      const rt = state.cob?.runtime
      if (!rt || typeof rt.findThreadById !== 'function') return
      const found = rt.findThreadById(state.threadId)
      if (!found) return
      const t = found.thread
      // Clear any pending sleep/wait so the next instruction runs
      // (the user pressed Step — they don't want to wait out timers).
      if (t.sleepMs > 0) t.sleepMs = 0
      if (t.waitOn) t.waitOn = null
      // Advance exactly one bytecode instruction.  No animator tick —
      // user can watch e.g. stack pushes accumulate before a CALL.
      rt.stepOne(state.threadId)
      // Stay paused after the step so the user can step again.
      rt.paused = true
      if (pauseBtn) {
        pauseBtn.textContent = '▶'
        pauseBtn.title = 'Resume the runtime.'
      }
      // Force an immediate panel refresh so the new PC + locals/stack
      // values are visible without waiting for the next 4 Hz tick.
      refreshMvThreadCodeHighlight(state)
    })
  }
  // Drag handler.  Reads the panel's bounding rect and updates
  // position via inline left/top so subsequent layout doesn't fight.
  // Header pointerdown also raises the panel above its siblings so
  // overlapping debuggers focus cleanly on click.
  const sig = state.abort?.signal
  const header = panel.querySelector('.mv-thread-code-header')
  if (header) {
    let dragOff = null
    header.addEventListener('mousedown', (e) => {
      bringMvThreadCodePanelToFront(state)
      // Don't claim mousedown when the user is interacting with a
      // form control or a chrome button.  Calling preventDefault on
      // an input mousedown would block focus, which is exactly why
      // the search box stopped accepting typing.
      if (e.target.closest('button, input, select, textarea')) return
      e.preventDefault()
      const r = panel.getBoundingClientRect()
      dragOff = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      header.classList.add('dragging')
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragOff) return
      const left = clamp(e.clientX - dragOff.dx, 0, window.innerWidth - 100)
      const top = clamp(e.clientY - dragOff.dy, 0, window.innerHeight - 60)
      panel.style.left = left + 'px'
      panel.style.top = top + 'px'
    }, { signal: sig })
    window.addEventListener('mouseup', () => {
      if (!dragOff) return
      dragOff = null
      header.classList.remove('dragging')
    }, { signal: sig })
  }
  // Eight-direction resize: corners + edges.  Each handle's
  // data-resize encodes which sides the drag moves (n/s/e/w).
  // We capture the starting rect + pointer then apply per-side
  // deltas, clamping to a sensible minimum so the panel can't
  // collapse to nothing.
  let rzStart = null
  for (const handle of panel.querySelectorAll('.mv-resize')) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      const r = panel.getBoundingClientRect()
      rzStart = {
        dir: handle.dataset.resize || 'se',
        x: e.clientX, y: e.clientY,
        left: r.left, top: r.top, w: r.width, h: r.height,
      }
    })
  }
  window.addEventListener('mousemove', (e) => {
    if (!rzStart) return
    const dx = e.clientX - rzStart.x
    const dy = e.clientY - rzStart.y
    const minW = 380, minH = 220
    let { left, top, w, h } = rzStart
    if (rzStart.dir.includes('e')) w = Math.max(minW, rzStart.w + dx)
    if (rzStart.dir.includes('s')) h = Math.max(minH, rzStart.h + dy)
    if (rzStart.dir.includes('w')) {
      const newW = Math.max(minW, rzStart.w - dx)
      left = rzStart.left + (rzStart.w - newW)
      w = newW
    }
    if (rzStart.dir.includes('n')) {
      const newH = Math.max(minH, rzStart.h - dy)
      top = rzStart.top + (rzStart.h - newH)
      h = newH
    }
    panel.style.width = w + 'px'
    panel.style.height = h + 'px'
    if (rzStart.dir.includes('w')) panel.style.left = left + 'px'
    if (rzStart.dir.includes('n')) panel.style.top = top + 'px'
  }, { signal: sig })
  window.addEventListener('mouseup', () => { rzStart = null }, { signal: sig })
  // Minimize toggle — temporarily hides everything but the header.
  // Useful when the user wants the unit visible behind without
  // closing + reopening (which would lose hover/scroll state).
  const minBtn = panel.querySelector('.mv-thread-code-minimize')
  if (minBtn) {
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const minimized = panel.classList.toggle('minimized')
      minBtn.textContent = minimized ? '▢' : '_'
      minBtn.title = minimized
        ? 'Restore this debugger window to its previous size.'
        : 'Minimize this debugger window to a thin header bar (click again to restore).  State preserved.'
    })
  }
  // Variables-panel collapse toggle (now in the header).
  const varsSideToggle = panel.querySelector('.mv-thread-code-vars-side-toggle')
  if (varsSideToggle) {
    varsSideToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      panel.classList.toggle('vars-collapsed')
      varsSideToggle.textContent = panel.classList.contains('vars-collapsed') ? '▭' : '▮'
      // Bracket geometry depends on pane widths — repaint after the
      // transition settles so curves stay glued to the asm edges.
      setTimeout(() => redrawMvThreadCodeBrackets(state), 200)
    })
  }
  // Per-section (Locals / Globals / Stack) collapse — clicking the
  // section label toggles a class on the immediately-following list
  // so the user can hide noisy sections without losing the whole tray.
  for (const lbl of panel.querySelectorAll('.mv-thread-code-locals-label.mv-section-toggle')) {
    lbl.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = lbl.dataset.section
      const body = panel.querySelector(`[data-section-body="${key}"]`)
      if (!body) return
      const hidden = body.classList.toggle('section-hidden')
      const caret = lbl.querySelector('.mv-section-caret')
      if (caret) caret.textContent = hidden ? '▸' : '▾'
    })
  }
  // Always-visible search box — typing filters matches in both panes.
  // Esc clears + blurs.  Ctrl/Cmd+F inside the panel focuses it.
  const searchInput = panel.querySelector('.mv-thread-code-search')
  if (searchInput) {
    searchInput.addEventListener('input', () => applyMvThreadCodeSearch(state, searchInput.value))
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        searchInput.value = ''
        applyMvThreadCodeSearch(state, '')
        searchInput.blur()
      }
    })
  }
  panel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      searchInput?.focus()
      searchInput?.select()
    }
  })
}

// applyMvThreadCodeSearch lights up every line in either pane whose
// text contains the query.  Case-insensitive substring match; empty
// query clears all marks.  Matches use a class (not a DOM rewrite)
// so existing syntax-highlight spans stay intact.
function applyMvThreadCodeSearch(state, query) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  for (const el of src.querySelectorAll('.mv-search-match')) el.classList.remove('mv-search-match')
  for (const el of dec.querySelectorAll('.mv-search-match')) el.classList.remove('mv-search-match')
  const q = (query || '').trim().toLowerCase()
  if (!q) return
  let firstMatch = null
  for (const line of src.querySelectorAll('.mv-code-line')) {
    if (line.textContent.toLowerCase().includes(q)) {
      line.classList.add('mv-search-match')
      if (!firstMatch) firstMatch = line
    }
  }
  for (const line of dec.querySelectorAll('div[data-line]')) {
    if (line.textContent.toLowerCase().includes(q)) {
      line.classList.add('mv-search-match')
      if (!firstMatch) firstMatch = line
    }
  }
  if (firstMatch) firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

// mvOpCategory delegates to the shared cob-highlight module so studio
// and explorer produce identical opcode classes.
function mvOpCategory(name) { return cobaOpCategory(name) }

// renderMvThreadCodeSource paints the WHOLE disassembly (all scripts
// in the COB, not just the currently-executing one).  Each script
// gets its own section header + jump-arrow gutter.  Lines carry
// data-script + data-idx so the cross-pane curves, PC tracking, and
// BP lookups can find them by script name regardless of which thread
// currently owns the panel.
function renderMvThreadCodeSource(state, thread) {
  const panel = state.panel
  const cob = state.cob
  const src = panel.querySelector('.mv-thread-code-source')
  const title = panel.querySelector('.mv-thread-code-title')
  if (!src) return
  src.replaceChildren()
  // dataset.scriptName tracks the thread's CURRENT script — used by
  // refreshMvThreadCodeHighlight to detect script changes (via
  // CALL_SCRIPT) and trigger PC-centring.  Still useful even though
  // we render all scripts.
  if (thread) {
    src.dataset.scriptName = thread.script.name
    if (title) title.textContent = `Thread #${thread.id} · ${thread.script.name}`
  }
  const pieceNames = cob.unit.pieceNames || []
  const scripts = cob.unit.scripts || []
  const LANE_W = 10
  // outerBody hosts every script section back-to-back.  Each section
  // is its own positioning context so per-script jump arrows don't
  // overlap into adjacent script gutters.
  const outerBody = document.createElement('div')
  outerBody.className = 'mv-code-outer'
  // Track jump computations per section so the post-mount RAF can
  // paint each section's arrows independently.
  const sectionRenders = []
  for (let si = 0; si < scripts.length; si++) {
    const script = scripts[si]
    if (!script) continue
    const scriptName = script.name
    const scriptLower = scriptName.toLowerCase()
    const instructions = script.instructions || []
    const section = document.createElement('div')
    section.className = 'mv-code-script'
    section.dataset.script = scriptLower
    // Header — clickable to collapse/expand the section body.
    const header = document.createElement('div')
    header.className = 'mv-code-script-header'
    const caret = document.createElement('span')
    caret.className = 'mv-code-fold-caret'
    caret.textContent = '▾'
    const hdrText = document.createElement('span')
    hdrText.className = 'coba-directive'
    hdrText.textContent = '.script '
    const hdrName = document.createElement('span')
    hdrName.className = 'coba-script-name'
    hdrName.textContent = scriptName
    header.appendChild(caret)
    header.appendChild(hdrText)
    header.appendChild(hdrName)
    section.appendChild(header)
    // Per-section body — positioning context for jump arrows.
    const sBody = document.createElement('div')
    sBody.className = 'mv-code-body'
    const { jumps, maxLane } = sharedComputeJumps(instructions)
    const gutterW = maxLane >= 0 ? (maxLane + 1) * LANE_W + 6 : 0
    sBody.style.paddingLeft = (gutterW ? (gutterW + 4) : 0) + 'px'
    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    arrowSvg.classList.add('mv-code-arrows')
    arrowSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    arrowSvg.setAttribute('overflow', 'visible')
    arrowSvg.style.position = 'absolute'
    arrowSvg.style.left = '0'
    arrowSvg.style.top = '0'
    arrowSvg.style.width = (gutterW || 0) + 'px'
    arrowSvg.style.pointerEvents = 'none'
    sBody.appendChild(arrowSvg)
    for (let i = 0; i < instructions.length; i++) {
      const ins = instructions[i]
      const line = mvBuildAsmLine(state, scriptLower, scriptName, i, ins, pieceNames)
      sBody.appendChild(line)
    }
    // Collapse / expand handler — toggle a class on the section.
    header.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed')
      caret.textContent = collapsed ? '▸' : '▾'
      requestAnimationFrame(() => redrawMvThreadCodeBrackets(state))
    })
    section.appendChild(sBody)
    outerBody.appendChild(section)
    sectionRenders.push({ sBody, arrowSvg, jumps, gutterW })
  }
  src.appendChild(outerBody)
  // After lines mount, paint each section's jump arrows.
  requestAnimationFrame(() => {
    for (const s of sectionRenders) {
      drawMvJumpArrows(s.sBody, s.arrowSvg, s.jumps, LANE_W, s.gutterW)
    }
  })
}

// mvBuildAsmLine constructs one assembly row — PC marker + BP dot +
// offset + opcode + operands — wired with click/hover handlers.
// Extracted so renderMvThreadCodeSource stays readable while still
// driving the same line shape across every script section.
function mvBuildAsmLine(state, scriptLower, scriptName, i, ins, pieceNames) {
  const cob = state.cob
  const line = document.createElement('div')
  line.className = 'mv-code-line'
  line.dataset.idx = String(i)
  line.dataset.offset = String(ins.offset >>> 0)
  line.dataset.script = scriptLower
  if (cob.unit.hasBreakpoint(scriptName, ins.offset)) line.classList.add('breakpointed')
  // Line-number column (leftmost).  1-based, scoped to the script
  // section so each .script restarts at 1.  Tabular numerics keep
  // the gutter from wobbling as the digit count changes.
  const lineNo = document.createElement('span')
  lineNo.className = 'mv-code-lineno'
  lineNo.textContent = String(i + 1)
  line.appendChild(lineNo)
  // PC marker column.  Empty by default; shows ▶ when the line is
  // the current PC and is draggable to set t.pc to another line.
  const pcCol = document.createElement('span')
  pcCol.className = 'mv-code-pc-marker'
  pcCol.title = 'Drag to move the program counter to another line.'
  line.appendChild(pcCol)
  // Breakpoint dot column.
  const bp = document.createElement('span')
  bp.className = 'mv-code-bp'
  bp.title = 'Click to toggle breakpoint at this instruction.'
  bp.addEventListener('click', (e) => {
    e.stopPropagation()
    if (cob.unit.hasBreakpoint(scriptName, ins.offset)) {
      cob.unit.removeBreakpoint(scriptName, ins.offset)
      line.classList.remove('breakpointed')
      // Reflect on BOS side too.
      mvSyncBosBpForOffset(state, scriptLower, ins.offset >>> 0, false)
    } else {
      cob.unit.addBreakpoint(scriptName, ins.offset)
      line.classList.add('breakpointed')
      mvSyncBosBpForOffset(state, scriptLower, ins.offset >>> 0, true)
    }
  })
  line.appendChild(bp)
  const off = document.createElement('span')
  off.className = 'mv-code-off coba-offset'
  off.textContent = '0x' + (ins.offset >>> 0).toString(16).padStart(4, '0')
  const code = document.createElement('span')
  const op = document.createElement('span')
  op.className = mvOpCategory(ins.name)
  op.textContent = ins.name
  code.appendChild(op)
  const operandText = mvFormatOperands(ins, pieceNames)
  if (operandText) {
    const opd = document.createElement('span')
    opd.className = 'coba-operand'
    opd.textContent = ' ' + operandText
    code.appendChild(opd)
  }
  line.appendChild(off)
  line.appendChild(code)
  // Mutual hover — uses the line's data-script so it works across
  // every section in the full disassembly view.
  line.addEventListener('mouseenter', () => {
    const bosLine = cob.unit._asmToBos?.get(`${scriptLower}:${i}`)
    state.hoverAsmIdx = i
    state.hoverAsmScript = scriptLower
    state.hoverLine = (bosLine !== undefined) ? bosLine : null
    applyMvThreadCodeCrossHover(state)
    redrawMvThreadCodeBrackets(state)
  })
  line.addEventListener('mouseleave', () => {
    if (state.hoverAsmIdx === i && state.hoverAsmScript === scriptLower) {
      state.hoverAsmIdx = null
      state.hoverAsmScript = null
      state.hoverLine = null
      applyMvThreadCodeCrossHover(state)
      redrawMvThreadCodeBrackets(state)
    }
  })
  return line
}

// mvSyncBosBpForOffset adds / removes .bos-bp on whichever BOS line
// owns the given script:offset pair.  Used by the asm-side BP toggle
// so both panes stay in sync without re-rendering.
function mvSyncBosBpForOffset(state, scriptLower, offset, on) {
  const dec = state.panel.querySelector('.mv-thread-code-decompiled')
  const map = state.cob?.runtime?._bosMap
  if (!dec || !map) return
  for (const [lineIdx, entry] of map.entries()) {
    if (entry.script.toLowerCase() !== scriptLower) continue
    if ((entry.startOffset >>> 0) !== offset) continue
    const bosEl = dec.querySelector(`div[data-line="${lineIdx}"]`)
    if (bosEl) bosEl.classList.toggle('bos-bp', on)
    return
  }
}

// drawMvJumpArrows paints arrow paths into one section's gutter SVG.
// Called once per script section after the section's lines have
// mounted (so getBoundingClientRect returns real positions).
function drawMvJumpArrows(body, svg, jumps, laneW, gutterW) {
  if (!body || !svg) return
  const lineEls = body.querySelectorAll('.mv-code-line')
  if (lineEls.length === 0) return
  const bodyRect = body.getBoundingClientRect()
  const yOf = (idx) => {
    const el = lineEls[idx]
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return ((r.top + r.bottom) * 0.5) - bodyRect.top
  }
  // Size the SVG to the section's full content height so arrows
  // pointing far down still render when the user scrolls.
  const totalH = body.scrollHeight || body.clientHeight
  svg.setAttribute('height', String(totalH))
  svg.setAttribute('width', String(gutterW || 0))
  svg.style.height = totalH + 'px'
  svg.replaceChildren()
  if (!jumps || jumps.length === 0) return
  const r = 4
  for (const j of jumps) {
    const fromY = yOf(j.fromIdx)
    const toY = yOf(j.toIdx)
    const x = (j.lane + 1) * laneW
    const right = x + 6
    const d = fromY < toY
      ? `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY + r} V ${toY - r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
      : `M ${right} ${fromY} H ${x + r} Q ${x} ${fromY} ${x} ${fromY - r} V ${toY + r} Q ${x} ${toY} ${x + r} ${toY} H ${right}`
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.classList.add('mv-jump-arrow')
    if (j.isLoop) path.classList.add('loop')
    svg.appendChild(path)
    const ah = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
    ah.setAttribute('points', `${right},${toY} ${right - 5},${toY - 3} ${right - 5},${toY + 3}`)
    ah.classList.add('mv-jump-arrow-head')
    if (j.isLoop) ah.classList.add('loop')
    svg.appendChild(ah)
  }
}

function mvFormatOperands(ins, pieceNames) {
  // Piece-targeted ops with axis: piece name + axis letter
  const pieceAxisOps = new Set(['MOVE', 'TURN', 'SPIN', 'STOP_SPIN', 'MOVE_NOW', 'TURN_NOW', 'WAIT_FOR_TURN', 'WAIT_FOR_MOVE'])
  if (pieceAxisOps.has(ins.name)) {
    const pn = pieceNames[ins.p1] || `#${ins.p1}`
    const axis = ['x', 'y', 'z'][ins.p2 | 0] || '?'
    return `${pn}, ${axis}-axis`
  }
  // Piece-only ops
  const pieceOps = new Set(['SHOW', 'HIDE', 'CACHE', 'DONT_CACHE', 'SHADE', 'DONT_SHADE', 'DONT_SHADOW', 'EMIT_SFX', 'EXPLODE'])
  if (pieceOps.has(ins.name)) {
    const pn = pieceNames[ins.p1] || `#${ins.p1}`
    return pn
  }
  // CALL / START — index into scripts array
  if (ins.name === 'CALL_SCRIPT' || ins.name === 'START_SCRIPT') {
    return `script[${ins.p1}], ${ins.p2 | 0} args`
  }
  // PUSH_CONST + immediate ops
  if (ins.name === 'PUSH_CONST') return `${ins.p1}`
  if (ins.name === 'PUSH_LOCAL' || ins.name === 'POP_LOCAL' || ins.name === 'CREATE_LOCAL') return `L${ins.p1}`
  if (ins.name === 'PUSH_STATIC' || ins.name === 'POP_STATIC') return `global_${ins.p1}`
  if (ins.name === 'JUMP' || ins.name === 'JUMP_IF_FALSE') return `→ 0x${(ins.p1 >>> 0).toString(16)}`
  if (ins.p1 || ins.p2) return `${ins.p1}${ins.p2 ? `, ${ins.p2}` : ''}`
  return ''
}

function refreshMvThreadCodeHighlight(state) {
  if (!state) return
  const panel = state.panel
  const thread = state.cob.unit._threads.find((t) => t.id === state.threadId && !t.dead)
  const statusEl = panel.querySelector('.mv-exec-status')
  const pcEl = panel.querySelector('.mv-exec-pc')
  const offsetEl = panel.querySelector('.mv-exec-offset')
  // Helper that picks the colour class for the status text from a
  // short string key (run/sleep/wait/bp/dead) so the user reads the
  // execution state at a glance.
  const setStatus = (text, cls) => {
    if (!statusEl) return
    statusEl.textContent = text
    statusEl.classList.remove('status-run', 'status-sleep', 'status-wait', 'status-bp', 'status-dead')
    if (cls) statusEl.classList.add(cls)
  }
  // Sync the pause label to the runtime's actual state — covers the
  // case where a breakpoint auto-pauses the runtime (the button
  // wasn't clicked, but the label needs to flip to "▶ Resume").
  const pauseBtn = panel.querySelector('.mv-thread-code-pause')
  if (pauseBtn) {
    const wantTxt = state.cob.runtime.paused ? '▶ Resume' : '⏸ Pause'
    if (pauseBtn.textContent !== wantTxt) {
      pauseBtn.textContent = wantTxt
      pauseBtn.title = state.cob.runtime.paused
        ? 'Resume the runtime — all threads and animators resume ticking.'
        : 'Pause or resume the entire COB runtime — animators and all threads freeze.'
    }
  }
  if (!thread) {
    setStatus('terminated', 'status-dead')
    if (pcEl) pcEl.textContent = '—'
    if (offsetEl) offsetEl.textContent = '—'
    // Clear PC highlight when thread dies.
    for (const el of panel.querySelectorAll('.mv-thread-code-source .mv-code-line.pc')) el.classList.remove('pc')
    renderMvThreadCodeLocals(state, null)
    return
  }
  // Title tracks the current script for the user's convenience even
  // though every script is rendered in the asm pane.  No re-render
  // on CALL_SCRIPT — the new script is already drawn elsewhere.
  const src = panel.querySelector('.mv-thread-code-source')
  if (src && src.dataset.scriptName !== thread.script.name) {
    src.dataset.scriptName = thread.script.name
    const title = panel.querySelector('.mv-thread-code-title')
    if (title) title.textContent = `Thread #${thread.id} · ${thread.script.name}`
  }
  // Status row — sleep / wait / running / BP-paused (auto-pause).
  // The runtime-wide `paused` flag set by a BP hit takes priority so
  // the user knows execution stopped because of a breakpoint, not a
  // sleep timer.
  if (state.cob.runtime.paused && thread.breakpointHit) {
    setStatus('paused at breakpoint', 'status-bp')
  } else if (thread.sleepMs > 0) {
    setStatus(`sleeping ${Math.round(thread.sleepMs)} ms`, 'status-sleep')
  } else if (thread.waitOn) {
    setStatus(`waiting for ${thread.waitOn.type}`, 'status-wait')
  } else {
    setStatus(state.cob.runtime.paused ? 'paused' : 'running',
              state.cob.runtime.paused ? 'status-dead' : 'status-run')
  }
  // PC row — instruction index + offset.  Offset reads from the
  // current instruction (or `—` past end of script).
  const ins = thread.script.instructions[thread.pc]
  if (pcEl) pcEl.textContent = `#${thread.pc}`
  if (offsetEl) offsetEl.textContent = ins ? ('0x' + (ins.offset >>> 0).toString(16).padStart(4, '0')) : '—'
  // Update PC class on lines — scoped by data-script so the same idx
  // in two different scripts doesn't both light up.
  let prevPc = null
  for (const el of panel.querySelectorAll('.mv-thread-code-source .mv-code-line.pc')) {
    prevPc = el
    el.classList.remove('pc')
  }
  const fnLower = thread.script.name.toLowerCase()
  const target = panel.querySelector(`.mv-thread-code-source .mv-code-line[data-script="${fnLower}"][data-idx="${thread.pc}"]`)
  if (target) {
    target.classList.add('pc')
    // Auto-scroll BOTH panes (asm + BOS) so the current line stays
    // centred as the thread runs.  Only fires when PC actually moves
    // — without that gate we'd be fighting user scrolls every tick.
    if (prevPc !== target) centerMvThreadPanesOnPc(state, thread, target)
  }
  renderMvThreadCodeLocals(state, thread)
  refreshMvThreadCodeDecompHighlight(state, thread)
}

// centerMvThreadPanesOnPc scrolls the asm pane to put the PC line at
// vertical centre AND scrolls the BOS pane to put the mapped BOS
// statement at vertical centre.  Both happen with _scrollSyncing on
// so the lockstep handlers don't fire and double-correct.
function centerMvThreadPanesOnPc(state, thread, asmTarget) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src) return
  state._scrollSyncing = true
  // Asm-side centring.  We compute scrollTop directly rather than
  // scrollIntoView — `scrollIntoView` would also scroll containing
  // panels (e.g. the panel itself), which is not what we want.
  {
    const lineEl = asmTarget
    const r = lineEl.getBoundingClientRect()
    const srcRect = src.getBoundingClientRect()
    const lineCentre = (r.top + r.bottom) * 0.5
    const srcCentre = srcRect.top + src.clientHeight / 2
    const delta = lineCentre - srcCentre
    const max = src.scrollHeight - src.clientHeight
    src.scrollTop = Math.max(0, Math.min(max, src.scrollTop + delta))
  }
  // BOS-side centring on the statement that maps to this PC.  Match
  // on script + idx range — the BOS pane spans all functions now so
  // we have to filter to the right script even though the asm-side
  // PC line carries data-script already.
  const map = state.cob.unit._bosMap
  if (dec && map) {
    let bestLine = -1
    const fnLower = thread.script.name.toLowerCase()
    for (const [lineIdx, entry] of map.entries()) {
      if (entry.script.toLowerCase() !== fnLower) continue
      if (thread.pc >= entry.startIdx && thread.pc <= entry.endIdx) {
        bestLine = lineIdx
        break
      }
    }
    if (bestLine >= 0) {
      const bosEl = dec.querySelector(`div[data-line="${bestLine}"]`)
      if (bosEl) {
        const r = bosEl.getBoundingClientRect()
        const decRect = dec.getBoundingClientRect()
        const lineCentre = (r.top + r.bottom) * 0.5
        const decCentre = decRect.top + dec.clientHeight / 2
        const delta = lineCentre - decCentre
        const max = dec.scrollHeight - dec.clientHeight
        dec.scrollTop = Math.max(0, Math.min(max, dec.scrollTop + delta))
      }
    }
  }
  // Release sync guard after the scroll events have fired so the
  // lockstep handlers don't loop back.
  // Scroll events fire asynchronously (not during scrollTop=), so a
  // microtask would release the guard before the echo arrives.  A
  // short timeout covers the typical browser scroll-event latency.
  if (state._scrollSyncResetTimer) clearTimeout(state._scrollSyncResetTimer)
  state._scrollSyncResetTimer = setTimeout(() => {
    state._scrollSyncing = false
    state._scrollSyncResetTimer = null
  }, 60)
}

// highlightBosLine delegates to the shared cob-highlight module so
// studio + explorer render identical syntax colouring.
function highlightBosLine(line) { return sharedHighlightBosLine(line) }

// mvBosStatementMatch tries to find the assembly instruction range
// corresponding to a single BOS source line.  It's a heuristic — the
// decompiler doesn't emit a source map, so we pattern-match the
// BOS line against TA's standard opcode shapes:
//
//   turn X to A-axis <V> speed <S>;   → PUSH_CONST S, PUSH_CONST V, TURN X,A
//   turn X to A-axis <V> now;         → PUSH_CONST V, TURN_NOW X,A
//   move X to A-axis <V> speed <S>;   → PUSH_CONST S, PUSH_CONST V, MOVE X,A
//   spin X around A-axis speed <S>;   → PUSH_CONST S, SPIN X,A
//   sleep <V>;                        → PUSH_CONST V, SLEEP
//   wait-for-(turn|move) X around A;  → WAIT_FOR_TURN/MOVE X,A
//   show / hide / cache <piece>;      → SHOW/HIDE/CACHE piece
//
// Returns { startIdx, endIdx } indexes into `instructions[]` or null
// when no match.  `cursor` is the current scan position — callers
// pass the previous match's endIdx+1 so consecutive BOS lines map
// to consecutive instruction ranges.
function mvBosStatementMatch(bosLine, instructions, cursor, pieceNames) {
  const text = bosLine.trim()
  if (!text || text.startsWith('//') || text === '{' || text === '}') return null
  // Strip trailing semicolon for matching.
  const stmt = text.replace(/;\s*(\/\/.*)?$/, '').trim()
  const pieceIdx = (name) => pieceNames.findIndex((p) => p && p.toLowerCase() === name.toLowerCase())
  const axisIdx = (a) => ({ 'x-axis': 0, 'y-axis': 1, 'z-axis': 2 }[a.toLowerCase()] ?? -1)
  // Try a few common shapes — find the relevant tail opcode at or
  // after `cursor`, then back up over its preceding pushes.
  // Helper: walk `cursor..` looking for the predicate's first match.
  const findIns = (pred) => {
    for (let i = cursor; i < instructions.length; i++) if (pred(instructions[i])) return i
    return -1
  }
  // Helper: count the immediately-preceding PUSH (any) instructions.
  const countPrecedingPushes = (idx) => {
    let n = 0
    for (let i = idx - 1; i >= cursor; i--) {
      const o = instructions[i].name
      if (o === 'PUSH_CONST' || o === 'PUSH_LOCAL' || o === 'PUSH_STATIC') n++
      else break
    }
    return n
  }
  let m
  // turn/move X to Y-axis ...
  m = stmt.match(/^(turn|move)\s+(\S+)\s+to\s+(x-axis|y-axis|z-axis)\s+/i)
  if (m) {
    const [, kind, piece, axis] = m
    const isNow = /\bnow\b/.test(stmt)
    const op = kind.toLowerCase() === 'turn' ? (isNow ? 'TURN_NOW' : 'TURN') : (isNow ? 'MOVE_NOW' : 'MOVE')
    const pi = pieceIdx(piece), ai = axisIdx(axis)
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi && ins.p2 === ai)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // spin / stop-spin
  m = stmt.match(/^(spin|stop-spin)\s+(\S+)\s+around\s+(x-axis|y-axis|z-axis)/i)
  if (m) {
    const op = m[1].toLowerCase() === 'spin' ? 'SPIN' : 'STOP_SPIN'
    const pi = pieceIdx(m[2]), ai = axisIdx(m[3])
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi && ins.p2 === ai)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // wait-for-turn / wait-for-move
  m = stmt.match(/^wait-for-(turn|move)\s+(\S+)\s+(?:around|along)\s+(x-axis|y-axis|z-axis)/i)
  if (m) {
    const op = m[1].toLowerCase() === 'turn' ? 'WAIT_FOR_TURN' : 'WAIT_FOR_MOVE'
    const pi = pieceIdx(m[2]), ai = axisIdx(m[3])
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi && ins.p2 === ai)
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  // sleep <V>
  if (/^sleep\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'SLEEP')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // show / hide / cache / dont-cache / dont-shade
  m = stmt.match(/^(show|hide|cache|dont-cache|dont-shade)\s+(\S+)/i)
  if (m) {
    const op = m[1].toUpperCase().replace('-', '_')
    const pi = pieceIdx(m[2])
    const idx = findIns((ins) => ins.name === op && ins.p1 === pi)
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  // return [val]
  if (/^return\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'RETURN')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // start-script / call-script
  m = stmt.match(/^(start-script|call-script)\s+(\w+)/i)
  if (m) {
    const op = m[1].toLowerCase() === 'start-script' ? 'START_SCRIPT' : 'CALL_SCRIPT'
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // signal / set-signal-mask
  m = stmt.match(/^(signal|set-signal-mask)\b/i)
  if (m) {
    const op = m[1].toLowerCase() === 'signal' ? 'SIGNAL' : 'SET_SIGNAL_MASK'
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // emit-sfx / explode
  m = stmt.match(/^(emit-sfx|explode)\b/i)
  if (m) {
    const op = m[1].toLowerCase() === 'emit-sfx' ? 'EMIT_SFX' : 'EXPLODE'
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // if (cond) — compiles to [cond pushes] + JUMP_IF_FALSE.  Both `if`
  // and `else if` land here; the `else` keyword on its own is just a
  // JUMP, handled separately below.
  if (/^(if|else\s+if|while)\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'JUMP_IF_FALSE')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // bare `else` — compiles to a JUMP over the else body.  Skip if not
  // followed by an `if`.
  if (/^else\b/i.test(stmt) && !/^else\s+if\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'JUMP')
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  // set static-var-X = expr; or set X = expr;  — compiles to
  // [expr pushes] + POP_LOCAL/POP_STATIC.
  if (/^set\b/i.test(stmt) || /^[A-Za-z_][\w-]*\s*=/.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'POP_LOCAL' || ins.name === 'POP_STATIC')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // var X = expr;  — local declaration with initializer.  Same shape
  // as a set: pushes then POP_LOCAL (sometimes preceded by
  // CREATE_LOCAL).
  if (/^var\s+/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'POP_LOCAL' || ins.name === 'CREATE_LOCAL')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // get UNIT-VALUE …; standalone (expression-as-statement — uncommon
  // but appears in some scripts).  Match the GET op directly.
  if (/^get\b/i.test(stmt)) {
    const idx = findIns((ins) => ins.name === 'GET' || ins.name === 'GET_UNIT_VALUE')
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // attach-unit / drop-unit
  m = stmt.match(/^(attach-unit|drop-unit)\b/i)
  if (m) {
    const op = m[1].toLowerCase().replace('-', '_').toUpperCase()
    const idx = findIns((ins) => ins.name === op)
    if (idx >= 0) return { startIdx: idx - countPrecedingPushes(idx), endIdx: idx }
  }
  // dont-shadow (separate from dont-shade) — matches DONT_SHADOW.
  m = stmt.match(/^dont-shadow\s+(\S+)/i)
  if (m) {
    const pi = pieceIdx(m[1])
    const idx = findIns((ins) => ins.name === 'DONT_SHADOW' && ins.p1 === pi)
    if (idx >= 0) return { startIdx: idx, endIdx: idx }
  }
  return null
}

// buildMvBosMap walks the decompiled source once per COB to build the
// BOS↔assembly cross-reference structures used by every open debugger
// panel.  Stored on the runtime so multiple panels share the same
// map without re-walking.  Builds two indexes:
//   _bosMap : line idx → { script, startIdx, endIdx, startOffset }
//   _asmToBos : "scriptLower:asmIdx" → bos line idx  (reverse, for
//             mutual-hover highlighting)
function buildMvBosMap(cob) {
  if (cob.unit._bosMap && cob.unit._asmToBos) return
  const src = cob.unit.decompiled || cob.unit._decompiledSource
  cob.unit._bosMap = new Map()
  cob.unit._asmToBos = new Map()
  if (!src) return
  const lines = src.split('\n')
  // BOS keywords that LOOK like function calls (they have parens) but
  // aren't.  Without this guard, `if (1)` and `while (cond)` would
  // be treated as function headers and clobber our current-script
  // tracking — most activatescr-body lines fell through unmapped.
  const NOT_A_FN = new Set(['if', 'else', 'while', 'for', 'return', 'get', 'rand'])
  let currentFn = null
  let cursor = 0
  let scriptInsts = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const m = ln.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*\(/)
    if (m && !NOT_A_FN.has(m[1].toLowerCase())) {
      currentFn = m[1]
      const scriptIdx = cob.unit.scriptNames.findIndex((n) => n && n.toLowerCase() === m[1].toLowerCase())
      scriptInsts = scriptIdx >= 0 ? (cob.unit.scripts[scriptIdx]?.instructions || null) : null
      cursor = 0
    } else if (scriptInsts && currentFn) {
      const match = mvBosStatementMatch(ln, scriptInsts, cursor, cob.unit.pieceNames)
      if (match) {
        cob.unit._bosMap.set(i, {
          script: currentFn,
          startIdx: match.startIdx,
          endIdx: match.endIdx,
          startOffset: scriptInsts[match.startIdx].offset,
        })
        const fnLower = currentFn.toLowerCase()
        for (let a = match.startIdx; a <= match.endIdx; a++) {
          cob.unit._asmToBos.set(`${fnLower}:${a}`, i)
        }
        cursor = match.endIdx + 1
      }
    }
  }
}

function renderMvThreadCodeDecompiled(state, cob) {
  const pane = state.panel.querySelector('.mv-thread-code-decompiled')
  if (!pane) return
  pane.replaceChildren()
  const src = cob.unit.decompiled || cob.unit._decompiledSource
  if (!src) {
    // Decompile isn't loaded yet (model-load fetch used
    // ?decompile=0 to skip the slow pass).  Kick off a one-shot
    // fetch, show a skeleton while it runs, and re-enter on success.
    // _decompileFetchInFlight guards against double-fetch when
    // multiple debugger panels open while one fetch is still in
    // flight.
    const name = cob.unit.scriptOriginName || cob.unit.name || (modelViewerInstance?.model?.name)
    if (!name) {
      pane.textContent = '// decompile unavailable'
      return
    }
    renderMvBosSkeleton(pane)
    if (!cob.unit._decompileFetchInFlight) {
      cob.unit._decompileFetchInFlight = fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=1`)
        .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then((json) => {
          cob.unit._decompiledSource = json.decompiled || '// decompile failed'
          // Bust cached map so it rebuilds against the fetched source.
          cob.unit._bosMap = null
          cob.unit._asmToBos = null
        })
        .catch((err) => { cob.unit._decompiledSource = `// decompile fetch failed: ${err.message}` })
        .finally(() => { cob.unit._decompileFetchInFlight = null })
    }
    // Re-enter once the fetch settles.  Use the shared promise so
    // every open panel waits on the same fetch.
    cob.unit._decompileFetchInFlight.then(() => {
      // Re-render every open panel that's pointing at this same cob —
      // when the fetch lands, every debugger's BOS pane needs to
      // refresh from the now-cached source.
      for (const s of _mvThreadCodePanels.values()) {
        if (s.cob === cob) renderMvThreadCodeDecompiled(s, cob)
      }
    })
    return
  }
  buildMvBosMap(cob)
  const lines = src.split('\n')
  // BOS keywords that LOOK like function calls (they have parens) but
  // aren't.  Used here purely for dataset.fn marking so the
  // function-header lookup in refreshMvThreadCodeDecompHighlight works.
  const NOT_A_FN = new Set(['if', 'else', 'while', 'for', 'return', 'get', 'rand'])
  // Track the function the current body lines belong to so each line
  // can be tagged with `data-fn-parent="<fn>"` — the fold handler
  // uses this attribute to hide an entire function in one query.
  let currentFnLower = null
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const div = document.createElement('div')
    div.dataset.line = String(i)
    // Line-number gutter — 1-based, matches what most editors show.
    // Lives outside the syntax-highlighted span so it doesn't get
    // selected when the user copies a chunk of source.
    const lineNo = document.createElement('span')
    lineNo.className = 'bos-lineno'
    lineNo.textContent = String(i + 1)
    div.appendChild(lineNo)
    const m = ln.match(/^([A-Za-z_][A-Za-z_0-9]*)\s*\(/)
    if (m && !NOT_A_FN.has(m[1].toLowerCase())) {
      div.dataset.fn = m[1].toLowerCase()
      div.classList.add('bos-fn-header')
      currentFnLower = m[1].toLowerCase()
      // Fold caret prepended to the function-header text.  Click
      // toggles `.bos-fn-collapsed` on the header + hides every line
      // whose data-fn-parent matches this function.
      const caret = document.createElement('span')
      caret.className = 'bos-fold-caret'
      caret.textContent = '▾'
      div.appendChild(caret)
      div.appendChild(document.createTextNode(' '))
    } else if (currentFnLower) {
      div.dataset.fnParent = currentFnLower
    }
    div.insertAdjacentHTML('beforeend', highlightBosLine(ln || ' '))
    // Reflect breakpoint state on initial render.
    const mapEntry = cob.unit._bosMap.get(i)
    if (mapEntry && cob.unit.hasBreakpoint(mapEntry.script, mapEntry.startOffset)) {
      div.classList.add('bos-bp')
    }
    // Click behaviour depends on line kind:
    //  · function header → fold/expand the function body
    //  · mapped statement → toggle a breakpoint at its first asm instr
    //  · unmapped line → no-op
    if (div.classList.contains('bos-fn-header')) {
      div.addEventListener('click', () => {
        const fn = div.dataset.fn
        const collapsed = div.classList.toggle('bos-fn-collapsed')
        const caret = div.querySelector('.bos-fold-caret')
        if (caret) caret.textContent = collapsed ? '▸' : '▾'
        const sel = `.mv-thread-code-decompiled > div[data-fn-parent="${fn}"]`
        for (const row of pane.querySelectorAll(sel)) {
          row.classList.toggle('bos-fn-hidden', collapsed)
        }
        // Bracket curves depend on which BOS lines are visible.
        requestAnimationFrame(() => redrawMvThreadCodeBrackets(state))
      })
    } else {
      div.addEventListener('click', () => {
        const entry = cob.unit._bosMap.get(i)
        if (!entry) return
        const scriptLower = entry.script.toLowerCase()
        const asmLine = state.panel.querySelector(`.mv-thread-code-source .mv-code-line[data-script="${scriptLower}"][data-offset="${entry.startOffset}"]`)
        if (cob.unit.hasBreakpoint(entry.script, entry.startOffset)) {
          cob.unit.removeBreakpoint(entry.script, entry.startOffset)
          div.classList.remove('bos-bp')
          if (asmLine) asmLine.classList.remove('breakpointed')
        } else {
          cob.unit.addBreakpoint(entry.script, entry.startOffset)
          div.classList.add('bos-bp')
          if (asmLine) asmLine.classList.add('breakpointed')
        }
      })
    }
    pane.appendChild(div)
  }
  // After the BOS DOM mounts, paint the cross-pane curves — the
  // panel may have been visible (and asm rendered) for a while
  // waiting on the decompile fetch, so don't rely on the next refresh
  // tick to bring them in.
  requestAnimationFrame(() => redrawMvThreadCodeBrackets(state))
}

// renderMvBosSkeleton paints a placeholder "loading…" pattern in
// the BOS pane while the decompile fetch is in flight.  Each row is
// a pulsing rectangle of varying width so the pane reads as "code
// is incoming" rather than "panel is broken".  Cheap — replaced
// once the fetch resolves and the real source renders.
function renderMvBosSkeleton(pane) {
  pane.replaceChildren()
  const wrap = document.createElement('div')
  wrap.className = 'mv-bos-skeleton'
  // Repeated pattern of bar widths so it looks like indented code
  // (function headers + bodies).  Repeats give the user enough
  // visual context to recognise it's a code skeleton.
  const widths = [
    '38%','82%','64%','55%','70%','38%','58%','46%','42%','62%',
    '34%','78%','60%','52%','68%','42%','64%','48%','40%','58%',
  ]
  for (let i = 0; i < widths.length; i++) {
    const bar = document.createElement('div')
    bar.className = 'mv-bos-skeleton-bar'
    bar.style.width = widths[i]
    bar.style.marginLeft = (i % 4 === 0) ? '0' : ((i % 4) * 8 + 'px')
    bar.style.animationDelay = (i * 60) + 'ms'
    wrap.appendChild(bar)
  }
  pane.appendChild(wrap)
}

// applyMvThreadCodeCrossHover sets `.cross-hover` on the asm lines
// and `.bos-cross-hover` on the BOS line for the panel's current
// hover target.  Called from both the asm and BOS pane hover
// handlers so the link is mutual.  Cheap — touches a handful of
// elements.
function applyMvThreadCodeCrossHover(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  for (const el of src.querySelectorAll('.mv-code-line.cross-hover')) el.classList.remove('cross-hover')
  for (const el of dec.querySelectorAll('div.bos-cross-hover')) el.classList.remove('bos-cross-hover')
  if (state.hoverLine === null || state.hoverLine === undefined) return
  const entry = state.cob.unit._bosMap?.get(state.hoverLine)
  if (!entry) return
  const scriptLower = entry.script.toLowerCase()
  for (let i = entry.startIdx; i <= entry.endIdx; i++) {
    const asmLine = src.querySelector(`.mv-code-line[data-script="${scriptLower}"][data-idx="${i}"]`)
    if (asmLine) asmLine.classList.add('cross-hover')
  }
  const bosEl = dec.querySelector(`div[data-line="${state.hoverLine}"]`)
  if (bosEl) bosEl.classList.add('bos-cross-hover')
}

// wireMvThreadCodeBrackets attaches scroll + hover + resize listeners
// for a single panel.  Idempotent via dataset.wired on each cloned
// node (each cloned panel starts fresh, no cross-bleed).
function wireMvThreadCodeBrackets(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (src && src.dataset.bracketWired !== '1') {
    src.dataset.bracketWired = '1'
    src.addEventListener('scroll', () => {
      // Lockstep: when the user scrolls the asm pane, slide the BOS
      // pane so its current middle line maps to roughly the asm
      // middle.  Guarded against the symmetric handler with
      // _scrollSyncing so the two don't fight.
      if (!state._scrollSyncing) syncScrollFromAsm(state)
      redrawMvThreadCodeBrackets(state)
    })
    // PC-marker drag: mousedown on the ▶ marker of the active PC line
    // starts a drag.  Mousemove tracks the asm line currently under
    // the pointer; mouseup writes that line's idx back to t.pc.
    wireMvPcDrag(state)
  }
  if (dec && dec.dataset.bracketWired !== '1') {
    dec.dataset.bracketWired = '1'
    dec.addEventListener('scroll', () => {
      if (!state._scrollSyncing) syncScrollFromBos(state)
      redrawMvThreadCodeBrackets(state)
    })
    // Hover-snap: when mouse moves over a mapped BOS line, scroll
    // the assembly pane so the FIRST instruction of that line sits
    // at the same Y position as the hovered line.  Snap is
    // suppressed while the user is actively scrolling the assembly
    // pane (otherwise our scroll fights theirs).
    dec.addEventListener('mousemove', (e) => {
      const lineEl = e.target.closest('div[data-line]')
      if (!lineEl) return
      const lineIdx = parseInt(lineEl.dataset.line, 10)
      if (!Number.isFinite(lineIdx)) return
      const entry = state.cob.unit._bosMap?.get(lineIdx)
      if (!entry) {
        if (state.hoverLine !== null) {
          state.hoverLine = null
          state.hoverAsmIdx = null
          state.hoverAsmScript = null
          applyMvThreadCodeCrossHover(state)
          redrawMvThreadCodeBrackets(state)
        }
        return
      }
      if (state.hoverLine !== lineIdx) {
        state.hoverLine = lineIdx
        state.hoverAsmIdx = entry.startIdx
        state.hoverAsmScript = entry.script.toLowerCase()
        // Don't snap-scroll the asm pane any more — the lockstep sync
        // handlers + per-line PC marker handle alignment, and snap
        // would fight the user's intent when they're just hovering.
        applyMvThreadCodeCrossHover(state)
        redrawMvThreadCodeBrackets(state)
      }
    })
    dec.addEventListener('mouseleave', () => {
      if (state.hoverLine !== null) {
        state.hoverLine = null
        state.hoverAsmIdx = null
        applyMvThreadCodeCrossHover(state)
        redrawMvThreadCodeBrackets(state)
      }
    })
  }
  if (panel.dataset.resizeWired !== '1') {
    panel.dataset.resizeWired = '1'
    new ResizeObserver(() => redrawMvThreadCodeBrackets(state)).observe(panel)
  }
}



// syncScrollFromAsm — user scrolled the assembly pane; align the BOS
// pane so the BOS line mapping to the asm middle row lands on the
// BOS middle row.  Sets _scrollSyncing while writing the BOS pane's
// scrollTop so the BOS scroll handler doesn't loop back.
function syncScrollFromAsm(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  const rt = state.cob?.runtime
  if (!rt?._asmToBos || !rt._bosMap) return
  // Asm row sitting on the source pane's vertical midpoint.
  const midY = src.getBoundingClientRect().top + src.clientHeight / 2
  const lineEls = src.querySelectorAll('.mv-code-line')
  let bestI = -1, bestDist = Infinity
  for (let i = 0; i < lineEls.length; i++) {
    const r = lineEls[i].getBoundingClientRect()
    const c = (r.top + r.bottom) * 0.5
    const d = Math.abs(c - midY)
    if (d < bestDist) { bestDist = d; bestI = i }
  }
  if (bestI < 0) return
  // Walk outward from the middle line to find one that's mapped
  // (many PUSH-only asm rows have no BOS mapping; without the walk,
  // sync would no-op whenever those land on the midpoint).
  let bosLineIdx
  for (let off = 0; off < 40; off++) {
    const idxs = off === 0 ? [bestI] : [bestI - off, bestI + off]
    for (const idx of idxs) {
      if (idx < 0 || idx >= lineEls.length) continue
      const el = lineEls[idx]
      const asmIdx = parseInt(el.dataset.idx, 10)
      const asmScript = el.dataset.script
      const m = rt._asmToBos.get(`${asmScript}:${asmIdx}`)
      if (m !== undefined) { bosLineIdx = m; break }
    }
    if (bosLineIdx !== undefined) break
  }
  if (bosLineIdx === undefined) return
  const bosEl = dec.querySelector(`div[data-line="${bosLineIdx}"]`)
  if (!bosEl) return
  // Centre that BOS line within the BOS pane.
  const decRect = dec.getBoundingClientRect()
  const bosRect = bosEl.getBoundingClientRect()
  const bosCentre = (bosRect.top + bosRect.bottom) * 0.5
  const decCentre = decRect.top + dec.clientHeight / 2
  const delta = bosCentre - decCentre
  const max = dec.scrollHeight - dec.clientHeight
  const next = Math.max(0, Math.min(max, dec.scrollTop + delta))
  if (Math.abs(next - dec.scrollTop) < 1) return
  state._scrollSyncing = true
  dec.scrollTop = next
  // Release on the next microtask so the scroll event has fired.
  // Scroll events fire asynchronously (not during scrollTop=), so a
  // microtask would release the guard before the echo arrives.  A
  // short timeout covers the typical browser scroll-event latency.
  if (state._scrollSyncResetTimer) clearTimeout(state._scrollSyncResetTimer)
  state._scrollSyncResetTimer = setTimeout(() => {
    state._scrollSyncing = false
    state._scrollSyncResetTimer = null
  }, 60)
}

// syncScrollFromBos — symmetric: user scrolled BOS pane, slide asm
// pane so the asm chunk mapped to the BOS middle line centres in the
// source pane.
function syncScrollFromBos(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!src || !dec) return
  const rt = state.cob?.runtime
  if (!rt?._bosMap) return
  const midY = dec.getBoundingClientRect().top + dec.clientHeight / 2
  let bestEl = null, bestDist = Infinity
  for (const el of dec.children) {
    if (!el.dataset || el.dataset.line === undefined) continue
    const r = el.getBoundingClientRect()
    const c = (r.top + r.bottom) * 0.5
    const d = Math.abs(c - midY)
    if (d < bestDist) { bestDist = d; bestEl = el }
  }
  if (!bestEl) return
  const bosLineIdx = parseInt(bestEl.dataset.line, 10)
  // Walk outward from the centred BOS line to find one with a mapping
  // (blank lines + comments don't have entries; without this walk, the
  // sync would no-op whenever the centred line happens to be unmapped).
  // The BOS pane spans ALL scripts now, so the matched entry tells us
  // which asm section to align to.
  let entry = null
  for (let off = 0; off < 60; off++) {
    const idxs = off === 0 ? [bosLineIdx] : [bosLineIdx - off, bosLineIdx + off]
    for (const idx of idxs) {
      const e = rt._bosMap.get(idx)
      if (e) { entry = e; break }
    }
    if (entry) break
  }
  if (!entry) return
  const asmEl = src.querySelector(`.mv-code-line[data-script="${entry.script.toLowerCase()}"][data-idx="${entry.startIdx}"]`)
  if (!asmEl) return
  const srcRect = src.getBoundingClientRect()
  const asmRect = asmEl.getBoundingClientRect()
  const asmCentre = (asmRect.top + asmRect.bottom) * 0.5
  const srcCentre = srcRect.top + src.clientHeight / 2
  const delta = asmCentre - srcCentre
  const max = src.scrollHeight - src.clientHeight
  const next = Math.max(0, Math.min(max, src.scrollTop + delta))
  if (Math.abs(next - src.scrollTop) < 1) return
  state._scrollSyncing = true
  src.scrollTop = next
  // Scroll events fire asynchronously (not during scrollTop=), so a
  // microtask would release the guard before the echo arrives.  A
  // short timeout covers the typical browser scroll-event latency.
  if (state._scrollSyncResetTimer) clearTimeout(state._scrollSyncResetTimer)
  state._scrollSyncResetTimer = setTimeout(() => {
    state._scrollSyncing = false
    state._scrollSyncResetTimer = null
  }, 60)
}

// redrawMvThreadCodeBrackets paints the SVG bracket overlay.  Walks
// the VISIBLE BOS lines, finds each mapped line's assembly range,
// and emits a cubic-bezier path connecting the BOS line midpoint
// to the assembly chunk midpoint.  Special classes mark the
// currently-PC'd line + any breakpointed lines + the hover line.
// Throttled implicitly by the inspector's 4 Hz tick + scroll
// debouncing the browser already does.
// Draws curved connectors between each visible assembly instruction
// and its matching BOS line.  One curve per asm line — many curves
// converge on the same BOS line when a single statement compiled to
// multiple ops.  No rectangular {-shape brackets any more (the user
// asked for "just lines from each displayed assembly line flow to
// their corresponding code text line").  Visible only inside the
// gutter strip between the two panes.
function redrawMvThreadCodeBrackets(state) {
  if (!state) return
  const panel = state.panel
  const svg = panel.querySelector('.mv-thread-code-brackets')
  const src = panel.querySelector('.mv-thread-code-source')
  const dec = panel.querySelector('.mv-thread-code-decompiled')
  if (!svg || !src || !dec || !state.cob.unit._bosMap) return
  const body = svg.parentElement
  const bodyRect = body.getBoundingClientRect()
  svg.setAttribute('viewBox', `0 0 ${bodyRect.width} ${bodyRect.height}`)
  svg.setAttribute('width', String(bodyRect.width))
  svg.setAttribute('height', String(bodyRect.height))
  svg.replaceChildren()
  const decRect = dec.getBoundingClientRect()
  const srcRect = src.getBoundingClientRect()
  // The two panes sit flush against each other (zero margin between
  // them), so srcRect.right === decRect.left.  Anchoring the curves
  // at the pane edges would collapse them to a single vertical line.
  // Instead we anchor INSIDE each pane's reserved-gutter padding:
  //   asm has padding-right: 28px → anchor 6 px in from the right
  //   dec has padding-left:  28px → anchor 6 px in from the left
  // That gives ~44 px of horizontal travel even with flush panes.
  const GUTTER_INSET = 22
  const endX   = srcRect.right - bodyRect.left - GUTTER_INSET   // asm side
  const startX = decRect.left  - bodyRect.left + GUTTER_INSET   // dec side
  const mid    = (startX + endX) * 0.5
  const thread = state.cob.unit._threads.find((t) => t.id === state.threadId && !t.dead)
  const pcScript = thread?.script?.name?.toLowerCase()
  const pcIdx = thread ? thread.pc : -1
  const bps = state.cob.unit._breakpoints
  const asmToBos = state.cob.unit._asmToBos
  if (!asmToBos) return
  for (const asmEl of src.querySelectorAll('.mv-code-line')) {
    const asmRect = asmEl.getBoundingClientRect()
    if (asmRect.bottom < srcRect.top - 4 || asmRect.top > srcRect.bottom + 4) continue
    const asmIdx = parseInt(asmEl.dataset.idx, 10)
    const asmScript = asmEl.dataset.script
    if (!Number.isFinite(asmIdx) || !asmScript) continue
    const bosLineIdx = asmToBos.get(`${asmScript}:${asmIdx}`)
    if (bosLineIdx === undefined) continue
    const entry = state.cob.unit._bosMap.get(bosLineIdx)
    if (!entry) continue
    const bosEl = dec.querySelector(`div[data-line="${bosLineIdx}"]`)
    if (!bosEl) continue
    const bosRect = bosEl.getBoundingClientRect()
    if (bosRect.bottom < decRect.top - 4 || bosRect.top > decRect.bottom + 4) continue
    const asmY = (asmRect.top + asmRect.bottom) * 0.5 - bodyRect.top
    const bosY = (bosRect.top + bosRect.bottom) * 0.5 - bodyRect.top
    const asmYClamped = Math.max(srcRect.top - bodyRect.top, Math.min(srcRect.bottom - bodyRect.top, asmY))
    const bosYClamped = Math.max(decRect.top - bodyRect.top, Math.min(decRect.bottom - bodyRect.top, bosY))
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    const d = `M ${endX} ${asmYClamped} C ${mid} ${asmYClamped}, ${mid} ${bosYClamped}, ${startX} ${bosYClamped}`
    path.setAttribute('d', d)
    const isPc = asmScript === pcScript && asmIdx === pcIdx
    const isBp = bps.has(`${asmScript}:${entry.startOffset >>> 0}`)
    const isHover = (state.hoverLine === bosLineIdx) ||
                    (state.hoverAsmIdx === asmIdx && state.hoverAsmScript === asmScript)
    if (isHover) path.classList.add('hover')
    else if (isPc) path.classList.add('pc')
    else if (isBp) path.classList.add('bp')
    svg.appendChild(path)
  }
}

// wireMvPcDrag wires two ways to set the program counter from the
// debugger:
//   1. Click any line's PC marker → set PC to that line.
//   2. Drag the green ▶ on the active PC line → drop on any other
//      line to set PC there.
// Implemented with Pointer Events + setPointerCapture so events keep
// firing even when the pointer leaves the marker mid-drag.  Click vs
// drag is decided by whether the pointer moved > 3 px before release.
function wireMvPcDrag(state) {
  const panel = state.panel
  const src = panel.querySelector('.mv-thread-code-source')
  if (!src) return
  let dragging = false
  let dragGhost = null
  let activePointerId = null
  let armedMarker = null
  let armedAtClient = null
  const moveGhost = (x, y) => {
    if (!dragGhost) return
    dragGhost.style.left = (x + 10) + 'px'
    dragGhost.style.top = (y - 8) + 'px'
  }
  const clearDropHighlight = () => {
    for (const el of src.querySelectorAll('.mv-code-line.pc-drop')) el.classList.remove('pc-drop')
  }
  src.addEventListener('pointerdown', (e) => {
    const marker = e.target.closest('.mv-code-pc-marker')
    if (!marker) return
    e.preventDefault(); e.stopPropagation()
    armedMarker = marker
    armedAtClient = { x: e.clientX, y: e.clientY }
    activePointerId = e.pointerId
    try { marker.setPointerCapture(e.pointerId) } catch { /* not supported in some test envs */ }
  })
  src.addEventListener('pointermove', (e) => {
    if (activePointerId !== e.pointerId || !armedMarker) return
    if (!dragging) {
      // Promote to drag once the pointer travels > 3 px — otherwise
      // every casual click would flash a ghost arrow.
      const dx = e.clientX - armedAtClient.x
      const dy = e.clientY - armedAtClient.y
      if (dx * dx + dy * dy < 9) return
      dragging = true
      panel.classList.add('pc-dragging')
      dragGhost = document.createElement('div')
      dragGhost.className = 'mv-code-pc-ghost'
      dragGhost.textContent = '▶'
      document.body.appendChild(dragGhost)
    }
    moveGhost(e.clientX, e.clientY)
    clearDropHighlight()
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mv-code-line')
    if (target && src.contains(target)) target.classList.add('pc-drop')
  })
  src.addEventListener('pointerup', (e) => {
    if (activePointerId !== e.pointerId) return
    const wasDragging = dragging
    if (wasDragging) {
      clearDropHighlight()
      if (dragGhost) { dragGhost.remove(); dragGhost = null }
      panel.classList.remove('pc-dragging')
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mv-code-line')
      if (target && src.contains(target)) mvSetThreadPc(state, target)
    } else if (armedMarker) {
      // No motion → treat as click.  Sets PC to the clicked line
      // regardless of whether it's the previous active PC line.
      const line = armedMarker.closest('.mv-code-line')
      if (line) mvSetThreadPc(state, line)
    }
    try { armedMarker?.releasePointerCapture(e.pointerId) } catch { /* fine */ }
    dragging = false
    armedMarker = null
    armedAtClient = null
    activePointerId = null
  })
  src.addEventListener('pointercancel', () => {
    dragging = false
    armedMarker = null
    armedAtClient = null
    activePointerId = null
    panel.classList.remove('pc-dragging')
    if (dragGhost) { dragGhost.remove(); dragGhost = null }
    clearDropHighlight()
  })
}

// mvSetThreadPc writes (script, pc) → thread, clears any sleep/wait
// so execution can resume from the new spot, and refreshes the panel.
// Looks the thread up via CobRuntime.findThreadById — the runtime is
// now multi-unit, so a flat rt._threads.find no longer works (threads
// live on the unit, not the runtime).  Script tables (scriptNames /
// scripts) also live on the owning unit.
function mvSetThreadPc(state, lineEl) {
  const newIdx = parseInt(lineEl.dataset.idx, 10)
  const newScript = lineEl.dataset.script
  if (!Number.isFinite(newIdx) || !newScript) return
  const rt = state.cob?.runtime
  if (!rt || typeof rt.findThreadById !== 'function') return
  const found = rt.findThreadById(state.threadId)
  if (!found) return
  const { thread: t, unit: u } = found
  if (newScript !== t.script.name.toLowerCase()) {
    const sIdx = u.scriptNames.findIndex((n) => n && n.toLowerCase() === newScript)
    if (sIdx >= 0 && u.scripts[sIdx]) t.script = u.scripts[sIdx]
  }
  t.pc = newIdx
  t.sleepMs = 0
  t.waitOn = null
  t.breakpointHit = false
  refreshMvThreadCodeHighlight(state)
}

function refreshMvThreadCodeDecompHighlight(state, thread) {
  const pane = state.panel.querySelector('.mv-thread-code-decompiled')
  if (!pane) return
  // Light up ONLY the BOS line whose mapped asm range covers the
  // current PC.  Whole-function highlighting (the prior behaviour)
  // washed out the "you are here" cue; per-statement is precise
  // since `_bosMap` already gives us the asm-range per BOS line.
  for (const el of pane.querySelectorAll('.bos-current')) el.classList.remove('bos-current')
  if (!thread) return
  const fnLower = thread.script.name.toLowerCase()
  const map = state.cob.unit._bosMap
  if (!map) return
  let bestLine = -1
  for (const [lineIdx, entry] of map.entries()) {
    if (entry.script.toLowerCase() !== fnLower) continue
    if (thread.pc >= entry.startIdx && thread.pc <= entry.endIdx) {
      bestLine = lineIdx
      break
    }
  }
  if (bestLine < 0) return
  const lineEl = pane.querySelector(`div[data-line="${bestLine}"]`)
  if (lineEl) {
    lineEl.classList.add('bos-current')
    // Centring is handled by centerMvThreadPanesOnPc (called from
    // refreshMvThreadCodeHighlight) so we don't double-scroll.
  }
}

// Build one editable variable row.  `getValue` reads the current
// number; `setValue` writes the parsed result back.  Both contract
// the value to a 32-bit signed int (TA's COB stack is int32).
function mvBuildVarRow(label, getValue, setValue) {
  const row = document.createElement('div')
  const k = document.createElement('span')
  k.textContent = label
  const v = document.createElement('span')
  v.textContent = String(getValue() | 0)
  v.contentEditable = 'true'
  v.spellcheck = false
  v.addEventListener('focus', () => { v.dataset.editing = '1' })
  v.addEventListener('blur', () => {
    v.dataset.editing = ''
    const parsed = parseInt(v.textContent.trim(), 10)
    const next = Number.isFinite(parsed) ? (parsed | 0) : (getValue() | 0)
    setValue(next)
    v.textContent = String(next)
  })
  v.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); v.blur() }
    if (e.key === 'Escape') { v.textContent = String(getValue() | 0); v.blur() }
  })
  row.appendChild(k); row.appendChild(v)
  return { row, valueEl: v }
}

function renderMvThreadCodeLocals(state, thread) {
  const panel = state.panel
  const locals = panel.querySelector('.mv-thread-code-locals')
  const stack = panel.querySelector('.mv-thread-code-stack')
  const globals = panel.querySelector('.mv-thread-code-globals')
  if (locals) {
    // Skip a rebuild while the user is editing a value — replacing
    // the DOM would yank the cursor mid-edit.
    if (!locals.querySelector('span[data-editing="1"]')) {
      locals.replaceChildren()
      if (thread && thread.locals && thread.locals.length) {
        for (let i = 0; i < thread.locals.length; i++) {
          const { row } = mvBuildVarRow(`L${i}`,
            () => thread.locals[i],
            (n) => { thread.locals[i] = n | 0 })
          locals.appendChild(row)
        }
      } else {
        const empty = document.createElement('div')
        empty.style.color = 'var(--muted)'
        empty.style.fontStyle = 'italic'
        empty.textContent = thread ? '—' : 'no thread'
        locals.appendChild(empty)
      }
    }
  }
  if (globals) {
    if (!globals.querySelector('span[data-editing="1"]')) {
      globals.replaceChildren()
      const rt = state.cob?.runtime
      if (rt && rt.staticVars && rt.staticVars.length) {
        for (let i = 0; i < rt.staticVars.length; i++) {
          const { row } = mvBuildVarRow(`global_${i}`,
            () => rt.staticVars[i],
            (n) => { rt.staticVars[i] = n | 0 })
          globals.appendChild(row)
        }
      } else {
        const empty = document.createElement('div')
        empty.style.color = 'var(--muted)'
        empty.style.fontStyle = 'italic'
        empty.textContent = '—'
        globals.appendChild(empty)
      }
    }
  }
  if (stack) {
    stack.replaceChildren()
    if (thread && thread.stack && thread.stack.length) {
      // Render top-of-stack first so the newest pushes are at the top
      // (matches a typical stack-trace display).
      for (let i = thread.stack.length - 1; i >= 0; i--) {
        const row = document.createElement('div')
        const k = document.createElement('span')
        k.textContent = i === thread.stack.length - 1 ? 'top' : ' '
        const v = document.createElement('span')
        v.textContent = String(thread.stack[i] | 0)
        row.appendChild(k); row.appendChild(v)
        stack.appendChild(row)
      }
    } else {
      const empty = document.createElement('div')
      empty.style.color = 'var(--muted)'
      empty.style.fontStyle = 'italic'
      empty.textContent = '—'
      stack.appendChild(empty)
    }
  }
}

// renderMvStaticVarsPanel — replaced by the Preact StaticVarsPanel
// component in /ui/panels/static-vars-panel.js (round 14).  The React tree
// subscribes to the inspector-store signals and rebuilds when the
// active mv / sandbox selection size changes.

// wireMvRuntimeVisibility pauses the COB runtime whenever the browser
// tab goes background (visibilitychange → hidden) and resumes it
// when the tab comes back.  Important for two reasons:
//   1. background tabs get rAF throttled to ~1 Hz, so the per-frame
//      runtime.tick(dtMs) drains a HUGE dtMs on the next foreground
//      frame — which would burst through 8 fixed sub-steps in one
//      go and look like a teleport / animation jump.
//   2. CPU + battery: a unit-editor tab left in the background
//      shouldn't keep churning script bytecode the user can't see.
// Remembers the prior paused state so we don't blow away an
// explicit user pause (Resume button leaves runtime paused; coming
// back from background must NOT auto-un-pause).
function wireMvRuntimeVisibility() {
  let savedPaused = null
  document.addEventListener('visibilitychange', () => {
    const rt = modelViewerInstance?.cob?.runtime || modelViewerInstance?._runtime
    if (!rt) return
    if (document.hidden) {
      // Capture the prior state on the way DOWN — if already
      // paused (user clicked Pause), savedPaused=true so we leave
      // it paused when we come back.
      savedPaused = !!rt.paused
      if (!rt.paused) rt.setPaused(true)
    } else {
      // Restore the captured pre-hide state.  Defensive null-check
      // — visibilitychange "visible" can fire without a prior
      // "hidden" in some unusual page-load flows.
      if (savedPaused !== null && rt.paused && !savedPaused) {
        rt.setPaused(false)
      }
      savedPaused = null
    }
  })
}

// Particle / audio aggregation across every sandbox binding lives in
// sandbox-view.js where the cardinality concern belongs.  studio.js
// just consumes the result through SandboxView.getInspectorMv() and
// no longer needs the scratch buffers + concat helpers here.

// renderMvEffectsPanel — replaced by the Preact EffectsPanel
// component in /ui/panels/effects-panel.js (round 14).  Section-collapse
// state moved into a module-scoped signal in that file; the body
// re-renders off the inspector-store signals on every refresh tick.
//
// renderMvAudioPanel — replaced by the Preact AudioPanel component
// in /ui/panels/audio-panel.js (round 14).  Body reads off the live
// AudioPool through the inspector-store signals.

// renderMvCameraPanel + wireMvRendererPanel — replaced by the Preact
// RendererPanel component in /ui/panels/renderer-panel.js (round 16).  The
// Tracking + Auto-Rotate toggles route through the host bridge's
// setTracking / setAutoRotate, both of which call into the active
// view via _activeRendererView().

// renderMvPortsPanel + refreshMvPortsLiveValues + refreshMvControlsGating
// — replaced by the Preact ControlsPanel component in
// /ui/panels/controls-panel.js (round 17).  All three render off the
// inspector-store signals; the action grid keeps its MvControls /
// sandbox-intercept click listeners via dangerouslySetInnerHTML.

// refreshMvRuntimeStats — replaced by the StatsBlock subcomponent
// inside /ui/panels/runtime-panel.js (round 18).  Stats are read directly
// off the runtime via runtimeTick subscription, no DOM writes.

// build*Row port-row builders — replaced by the Preact components in
// /ui/common/port-rows.js (round 17).

// mvSyncCobAttrSlidersFromPorts copies cobDamage / cobBuildPercent
// (which the Ports panel edits) back into the React COB ribbon's Unit
// Attributes sliders.  The reverse direction (ribbon slider → ports
// panel) is handled by refreshMvPortsLiveValues which reads the same
// source-of-truth values.
function mvSyncCobAttrSlidersFromPorts(mv) {
  if (!mv) return
  if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
    _reactUi.setModelViewerRibbonState({
      cobDamage: mv.cobDamage | 0,
      cobBuild: mv.cobBuildPercent | 0,
    })
  }
}

// ── Auto-build ramp ──────────────────────────────────────────────
//
// When a unit first loads, we ramp BUILD_PERCENT from 0 → 100 over
// ~5 sim-seconds so the user sees the construction-stripe wireframe
// phase out into the finished model.  Using SIM time (not wall) so
// slow-mo + pause both apply, matching every other timing in the
// studio.  The ramp aborts the moment the user drags either Build
// slider or clicks Create Unit — manual control wins.
//
// State lives on the viewer (mv._autoBuild) so a tab swap to a fresh
// unit naturally re-arms the ramp; setting it to null cancels.
const AUTO_BUILD_DURATION_MS = 5000

function startMvAutoBuild(mv) {
  if (!mv) return
  // Snap to 0% so the ramp begins from the construction-stripe
  // wireframe and phases the unit in.
  if (typeof mv.setBuildPercent === 'function') mv.setBuildPercent(0)
  else mv.cobBuildPercent = 0
  mv._autoBuild = { elapsedMs: 0, durationMs: AUTO_BUILD_DURATION_MS }
}

function advanceMvAutoBuild(dtMs) {
  const mv = modelViewerInstance
  if (!mv || !mv._autoBuild) return
  const rate = mv.cob?.runtime?.playbackRate ?? 1
  const dtSim = Math.max(0, dtMs) * rate
  const state = mv._autoBuild
  state.elapsedMs += dtSim
  const pct = Math.max(0, Math.min(100, (state.elapsedMs / state.durationMs) * 100))
  if (typeof mv.setBuildPercent === 'function') mv.setBuildPercent(pct)
  else mv.cobBuildPercent = pct
  // Keep the React ribbon's Damage + Build sliders + the Ports panel
  // in sync as the ramp advances so the user can watch the percentage
  // tick up rather than only seeing the visual wireframe phase in.
  // Both surfaces read off mv.cobBuildPercent so a single push covers
  // them (the Ports panel re-renders off the inspector-store mv signal
  // each publish).
  mvSyncCobAttrSlidersFromPorts(mv)
  if (state.elapsedMs >= state.durationMs) {
    mv._autoBuild = null  // ramp complete — release the slot
  }
}

// renderMvActionsPanel + wireMvActionsPanel — replaced by the Preact
// ScriptCommandsPanel component in /ui/panels/script-commands-panel.js
// (round 16; renamed from ActionsPanel in round 28).  Per-button
// running state is read live via the host bridge's isCobScriptRunning;
// the Include-Private filter is bound to the actionsIncludePrivate
// signal in the inspector store.
//
// syncMvActionsRunning is now folded into the React tree's per-tick
// re-read of cob._lifecycle, so the only sync helper retained here
// is syncCobRibbonRunning (drives the ribbon row, not the panel).
function syncMvActionsRunning(cob) {
  if (!cob) return
  // Promote 'creating' → 'created' once the Create thread has died.
  // The React Script Commands panel reads cob._lifecycle every tick
  // so this promotion takes effect on the next publish without an
  // explicit re-render call.
  if (cob._lifecycle === 'creating' && !isCobScriptRunning(cob, 'Create')) {
    cob._lifecycle = 'created'
  }
}
function syncCobRibbonRunning(cob) {
  if (!cob) return
  if (!_reactUi || typeof _reactUi.setModelViewerCobState !== 'function') return
  // Push the live running-scripts set + lifecycle into the React COB
  // dropdown's signal so the entry buttons + "All scripts" rows flip
  // between disabled / enabled the instant a thread starts or dies.
  // Lower-cased keys mirror the runtime's case-insensitive lookup so
  // the React side can check `runningScripts.has(name.toLowerCase())`.
  _reactUi.setModelViewerCobState({
    runningScripts: _collectRunningCobScripts(cob),
    lifecycle: cob._lifecycle || 'created',
  })
}

// _collectRunningCobScripts — Set of lower-cased script names that
// currently have at least one live thread.  Shared between the
// per-tick syncCobRibbonRunning fire and refreshCobPanel's per-unit
// reset; centralising avoids two slightly-different walkers drifting
// apart on what counts as "running."
function _collectRunningCobScripts(cob) {
  const set = new Set()
  if (cob && cob.unit && cob.unit._threads) {
    for (const t of cob.unit._threads) {
      if (!t.dead) set.add(t.script.name.toLowerCase())
    }
  }
  return set
}

// wireMvActionsPanel — replaced by the Preact ScriptCommandsPanel +
// inspector-store's actionsIncludePrivate signal in round 16.

// wireMvPortsPanel — port row builders + the panel-header Reset host
// are both gone in round 17; the React ControlsPanel renders rows + a
// React-owned Reset attribute via /ui/common/port-rows.js + /ui/panels/controls-panel.js.

// wireCobAttributeSliders — the COB-menu Damage / Build / Playback
// sliders + Reset button are React-managed now (see the model viewer
// ribbon's CobDropdown).  The Runtime overlay's Speed slider is also
// React (RuntimePanel.SpeedSlider).  Click handlers route through the
// configureModelViewerRibbonBridge installation below so this helper
// became a vestigial stub — kept only to preserve the per-tick call
// shape refreshCobPanel and friends use; safe to delete once nothing
// references it externally.

// Expose the two runtime-control helpers on `window` so cross-module
// callers (the mv-controls keyboard handler) can drive Space + +/-
// hotkeys without having to import the studio module's bundle.
// Set after the function definitions below so the assignment sees
// the live function reference.
function _wireRuntimeHelpersToWindow() {
  window.mvToggleRuntimePaused = mvToggleRuntimePaused
  window.mvSetSimulationSpeed = mvSetSimulationSpeed
  // ModelViewer.resetState lives in its own module and needs to
  // re-arm the auto-build ramp; expose the helper so it can call
  // through without an ES-module circular import.
  window.startMvAutoBuild = startMvAutoBuild
}

// mvToggleRuntimePaused flips the active runtime's paused state and
// refreshes the merged Pause/Resume button's label + tooltip so the
// caption always reflects what the NEXT click will do.  Routes through
// _activeRuntime so the Spacebar hotkey and the Runtime overlay's
// Pause button drive whichever runtime the user is actually looking
// at (sandbox engine OR unit-editor viewer).
//
// On Resume: we DELIBERATELY leave each thread's breakpointHit flag
// alone.  _runThread reads `allowFirstBreakpoint = !breakpointHit` —
// when breakpointHit is true (the thread is paused on a BP), the
// first instruction this tick skips the BP check, executes the BP'd
// line once, then re-engages BP checking for subsequent ops.  If we
// cleared the flag here the BP at the same PC would re-fire
// immediately, paused would flip back to true, and the sim would
// look like it "stepped one tick and re-paused" — which is exactly
// the bug Resume used to ship.
function mvToggleRuntimePaused() {
  const rt = _activeRuntime()
  if (!rt) return
  const willPause = !rt.paused
  rt.setPaused(willPause)
  mvRefreshRuntimeToggle()
  // Kick the React inspector tree so the Pause/Resume button label
  // (and any other panel that reads rt.paused) flips RIGHT NOW
  // instead of after the next 4 Hz publish.  Without this nudge the
  // click → label-change latency was 250 ms, which read as "did the
  // click register?" — bad for a control whose feedback is the label
  // itself.  Cheap: just increments the runtimeTick signal.
  if (_reactUi && typeof _reactUi.bumpRuntimeTick === 'function') {
    _reactUi.bumpRuntimeTick()
  }
}

// mvRefreshRuntimeToggle syncs the merged button's caption + title
// to the runtime's current paused state.  Called after every state
// flip (button click, Space hotkey, programmatic pause).  Safe to
// call when the button isn't in the DOM yet.
function mvRefreshRuntimeToggle() {
  const btn = document.getElementById('mv-threads-toggle')
  if (!btn) return
  const paused = !!modelViewerInstance?.cob?.runtime?.paused
  if (paused) {
    btn.textContent = '▶ Resume'
    btn.title = 'Resume — un-pause the runtime and continue past any breakpoint that fired.  Spacebar does the same thing.'
  } else {
    btn.textContent = '⏸ Pause'
    btn.title = 'Pause — freeze every unit’s animators + threads on this runtime.  Spacebar does the same thing.'
  }
}

// mvSetSimulationSpeed is the single entry point for changing the
// runtime's playback rate.  Both the COB-menu Playback slider and
// the Runtime overlay's Speed slider call this — it pushes the new
// rate to the runtime and writes the value labels on both sliders
// so the two UIs stay in lock-step.  rate is the multiplier (1.0 =
// real time, 0.01 = 1/100 speed, 10.0 = 10× fast-forward).  Slider
// max range matches CobRuntime.setPlaybackRate clamping (0.01 → 10).
function mvSetSimulationSpeed(rate) {
  // Resolve `rate` to a number, defaulting to 1 only when the caller
  // passes NaN/undefined/null — `+0` is a valid input that should
  // clamp UP to 0.01, NOT silently fall back to 1.  Old `|| 1`
  // version mis-handled the "+/- key stepped past zero" path.
  const n = Number(rate)
  const v = Math.max(0.01, Math.min(10, Number.isFinite(n) ? n : 1))
  const cob = modelViewerInstance?.cob
  if (cob) cob.runtime.setPlaybackRate(v)
  // Sandbox tabs have their own per-tab CobRuntime inside their
  // GameEngine — the unit editor's runtime is unrelated.  Dispatch
  // the rate to the active sandbox view's runtime too so dragging
  // the slider while a sandbox is in front actually slows / speeds
  // its sim.  No-op when no sandbox is open.
  const sbRt = sandboxViewInstance?.scene?.runtime
  if (sbRt && typeof sbRt.setPlaybackRate === 'function') sbRt.setPlaybackRate(v)
  // React COB ribbon's Playback slider — pushed via state signal.
  // The Runtime overlay's SpeedSlider component reads rt.playbackRate
  // directly (subscribed via runtimeTick), so it picks up the new rate
  // on the next publish without an explicit push here.
  if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
    _reactUi.setModelViewerRibbonState({ cobPlayback: Math.round(v * 100) })
  }
}

// refreshCobPanel wires the Animation→COB dropdown buttons to the
// currently-loaded unit's runtime.  Entry-point buttons grey out
// when the script isn't present.  The "All scripts" list at the
// bottom enumerates every entry point the COB carries — useful
// for AimFromPrimary / QueryPrimary / RestoreAfterDelay and other
// less-common scripts the static button row doesn't enumerate.
function refreshCobPanel(cob) {
  // Push the loaded unit's playback rate through the shared helper so
  // the React Runtime panel + the sandbox runtime (if any) all land
  // on the same value.  mvSetSimulationSpeed also writes through to
  // the React COB ribbon's cobPlayback state.
  mvSetSimulationSpeed(cob ? cob.runtime.playbackRate : 1)
  if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
    _reactUi.setModelViewerRibbonState({
      cobDamage: modelViewerInstance?.cobDamage || 0,
      cobBuild: modelViewerInstance?.cobBuildPercent ?? 100,
    })
  }
  if (_reactUi && typeof _reactUi.setModelViewerCobState === 'function') {
    _reactUi.setModelViewerCobState({
      hasCob: !!cob,
      scriptNames: cob ? cob.listScripts() : [],
      runningScripts: _collectRunningCobScripts(cob),
      lifecycle: cob?._lifecycle || 'created',
    })
  }
}

// isCobScriptRunning reports whether the named script has at least
// one live thread.  Case-insensitive, matches the runtime's own
// script lookup semantics.  Used by runCobEntry to no-op a click
// on a script that's already executing, and by refreshCobPanel +
// the Script Commands panel to grey out the corresponding buttons.
function isCobScriptRunning(cob, name) {
  if (!cob || !cob.unit) return false
  const lower = name.toLowerCase()
  for (const t of cob.unit._threads) {
    if (!t.dead && t.script.name.toLowerCase() === lower) return true
  }
  return false
}

// runCobEntry invokes a script by name, randomising any required
// inputs.  AimWeapon-class scripts expect (heading, pitch) on the
// stack in TA's fixed-point angle units (65536 = 360°); we pick a
// fully random target in the unit's forward hemisphere so every
// click visibly retargets to a fresh spot.  Primary and secondary
// can run concurrently — the runtime supports independent threads
// per weapon (they signal-mask different bits so retargeting one
// weapon does NOT interrupt the other).
function runCobEntry(cob, name) {
  if (!cob || !cob.hasScript(name)) return
  // Don't re-start a script that already has a thread alive.  The
  // first line of activatescr-style helpers is usually
  // `turn <piece> to <axis> <0> now` which INSTANTLY snaps the
  // piece back to origin before animating to the open position —
  // re-triggering caused a visible jerk while pieces were already
  // at their target.  For long-running loops (SmokeUnit, MotionControl)
  // this also prevents stacking N threads from N clicks.
  if (isCobScriptRunning(cob, name)) return
  // Create-only gate: while the unit hasn't finished its Create
  // script (state 'unborn' = never started, 'creating' = Create
  // thread is mid-flight), suppress every other action.  Real TA
  // does the same — a freshly-built unit only responds to its own
  // initialisation script.  Once Create completes (handled by the
  // 4 Hz tick below) every button unlocks.
  const lifecycle = cob._lifecycle || 'created'
  if ((lifecycle === 'unborn' || lifecycle === 'creating') && !/^Create$/i.test(name)) return
  // Starting Create flips the lifecycle into 'creating' so the
  // other buttons stay disabled while the script runs.
  if (/^Create$/i.test(name)) cob._lifecycle = 'creating'
  // Lifecycle-state skip: when the user clicks Activate but the
  // unit is already in the activated state (and the script has
  // FINISHED its prior run), redundantly re-running activatescr
  // would replay the entire opening sequence from scratch.  Worse
  // for Deactivate: its FIRST instructions are `now`-snaps that
  // teleport every piece BACK to the activated pose, then animate
  // to closed — so a second Deactivate click on an already-closed
  // unit causes the lab to pop open and then close again.  Track
  // the state on the binding and skip the redundant call.
  if (/^Activate$/i.test(name)) {
    if (cob._lifecycle === 'activated') return
    cob._lifecycle = 'activated'
    if (cob.hasScript('activatescr') && !isCobScriptRunning(cob, 'activatescr')) cob.start('activatescr')
    if (cob.hasScript('OpenYard') && !isCobScriptRunning(cob, 'OpenYard')) cob.start('OpenYard')
    // FBI SoundCategory's `activate` event — fires the same audio
    // TA plays for an in-game activation (factory doors open,
    // radar dish spinning up, etc).  Many unit categories don't
    // define `activate` (factories like KBOTPLANT carry only
    // select1 / build / unitcomplete), so fall back to the
    // unit's acknowledge voice (`select*`) and finally to `build`
    // — that way the user always hears SOMETHING when they
    // command an open/yard-up.
    if (_mvControls) _mvControls._playSoundRandom(['activate', 'select1', 'select2', 'select3', 'build', 'unitcomplete'])
  }
  if (/^Deactivate$/i.test(name)) {
    if (cob._lifecycle === 'deactivated') return
    cob._lifecycle = 'deactivated'
    if (cob.hasScript('deactivatescr') && !isCobScriptRunning(cob, 'deactivatescr')) cob.start('deactivatescr')
    if (cob.hasScript('CloseYard') && !isCobScriptRunning(cob, 'CloseYard')) cob.start('CloseYard')
    // Same fallback chain as Activate, biased toward the second
    // acknowledge voice so Activate / Deactivate sound distinct
    // even when both fall back to the select bank.
    if (_mvControls) _mvControls._playSoundRandom(['deactivate', 'select2', 'select3', 'select1', 'cant1'])
  }
  // Create script kicks the unit "online" — play the select voice
  // so the user hears the unit acknowledge itself when they bring
  // it to life.  Skipped when the unit has no Create.
  if (/^Create$/i.test(name)) {
    if (_mvControls) _mvControls._playSoundRandom(['select1', 'select2', 'select3', 'unitcomplete'])
  }
  if (/^Aim(Primary|Secondary|Tertiary|Weapon\d+)$/i.test(name)) {
    // Each Aim* call's bos spawns RestoreAfterDelay which sleeps
    // the reload-timer then snaps the turret back to neutral.  If
    // the previous aim's RestoreAfterDelay is still pending when
    // the user re-aims, its timer fires partway through the new
    // aim's hold window and yanks the turret back early — the
    // "instant snap" the user reported.  Kill any stale ones so
    // the LATEST aim gets its full timer.
    cob.unit.killThreadsByName('RestoreAfterDelay')
    cob.unit.killThreadsByName('RestorePosition')
    // Independent random heading per click - no per-weapon bias.
    // Forward hemisphere only (±90°): aiming behind a unit clips
    // through the body on most TA models and looks broken.
    //
    // Pitch is NOT random — we aim at a virtual target sitting at
    // the unit's own elevation, ≥10× the unit size away.  At that
    // distance the angle from a turret mounted on top of the unit
    // down to a same-altitude target is ~ atan(turret_height /
    // distance) — a few degrees at most.  This stops the gun from
    // tipping down through the deck when the random pitch happened
    // to land at -15° with the implicit target inside the unit's
    // own build footprint (the "shooting through your own hull"
    // bug the user reported).  Heights from model.bounds: max Y
    // is the top of the unit's bbox (a reasonable proxy for where
    // the turret sits), centre Y is the target altitude.
    const TURNS = 65536
    const heading = Math.floor((Math.random() - 0.5) * TURNS * 0.5)
    const m = modelViewerInstance?.model
    let pitch = 0
    if (m && m.bounds && m.bounds.min && m.bounds.max) {
      const ext = [
        m.bounds.max[0] - m.bounds.min[0],
        m.bounds.max[1] - m.bounds.min[1],
        m.bounds.max[2] - m.bounds.min[2],
      ]
      // Unit size = largest horizontal extent; height feeds the
      // turret-mount offset, not the distance, so the aim line
      // stays roughly flat regardless of how tall the unit is.
      const unitSize = Math.max(ext[0], ext[2]) || ext[1] || 1
      const distance = 10 * unitSize
      const turretY = m.bounds.max[1]
      const targetY = (m.bounds.min[1] + m.bounds.max[1]) * 0.5
      const dy = targetY - turretY // negative → looking down
      const pitchRad = Math.atan2(dy, distance)
      pitch = Math.round(pitchRad * TURNS / (2 * Math.PI))
    }
    cob.start(name, [heading, pitch])
    return
  }
  cob.start(name)
}

function renderPieceTree(model) {
  // React-managed now (see /ui/unit-editor/tabs/piece-tree.js).  The
  // host hands the model to the React component via setPieceTreeModel;
  // the tree subscribes to runtimeTick + inspector-store.mv so the
  // eye/shade/cache/shadow icons, hover-highlight, and selectPiece
  // routing all flow through React.
  if (_reactUi && typeof _reactUi.setPieceTreeModel === 'function') {
    _reactUi.setPieceTreeModel(model)
  }
  return
}

// wireMvSidebarTabs wires the Pieces / Textures tab buttons once.
// Idempotent — sets data-wired so subsequent model loads don't
// stack handlers.  Tab click swaps which .mv-sidebar-panel is
// visible AND nulls any active texture-hover state (a Textures
// → Pieces switch must clear the red highlight or it sticks).
function wireMvSidebarTabs() {
  const bar = document.querySelector('.mv-sidebar-tabs')
  if (!bar || bar.dataset.wired === '1') return
  bar.dataset.wired = '1'
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mv-tab]')
    if (!btn) return
    const tab = btn.dataset.mvTab
    for (const t of bar.querySelectorAll('[data-mv-tab]')) {
      const on = t.dataset.mvTab === tab
      t.classList.toggle('active', on)
      t.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    for (const p of document.querySelectorAll('.mv-sidebar-panel')) {
      p.classList.toggle('hidden', p.dataset.mvTabPanel !== tab)
    }
    // Switching tabs implicitly clears any hover-highlight state
    // (a stuck red wireframe after leaving the textures tab
    // would look broken).
    modelViewerInstance?.renderer?.setHoveredTexture?.(null)
    modelViewerInstance?.renderer?.setHoveredPieceName?.(null)
  })
}

// renderTexturesTab builds the Textures left-panel content.  Each
// distinct texture the unit references becomes a row showing its
// thumbnail + name + use-count.  Rows are grouped by parent GAF
// (server-provided via model.textureSources); groups + rows are
// sorted by usage count descending so the biggest atlases sit at
// the top.  Hovering a row highlights every piece whose drawGroups
// reference that texture; the group header collapses/expands the
// block.
function renderTexturesTab(model) {
  // React-managed now (see /ui/unit-editor/tabs/textures-tab.js).
  if (_reactUi && typeof _reactUi.setTexturesModel === "function") {
    _reactUi.setTexturesModel(model)
  }
}

// renderMvWeaponsTab populates the left-panel Weapons tab from the
// unit FBI + per-weapon TDF data on `mv.unitMeta` and the COB's
// `scriptNames` for the script-presence indicators.  Three slot
// cards (Primary / Secondary / Tertiary), each showing:
//
//   • Weapon ID (1/2/3) + slot label header
//   • Weapon name + colour rectangle (from TDF `color=` palette idx)
//   • Script-presence chips (Aim<X> / Fire<X> / Query<X>) green when
//     present in the unit's COB, red when missing
//   • A warning line when Query<X> is missing — the runtime can't
//     resolve the firing piece without it so the weapon can't fire
//   • Quick-stat grid (reload / range / velocity / burst / model)
//   • Sound rows with ▶ play buttons
//   • A "Change Weapon" button that opens the picker modal scoped to
//     this slot — swapping in a different weapon's TDF data live
//   • Classifier flag chips (beam / smoke / ballistic / command-fire)
//
// Empty slots ("Weapon2=NONE" or missing) render as a muted "—"
// placeholder card so the slot count stays consistent across units.
// Per-slot collapse + the master Show Projectiles toggle persist
// inside the React tab module itself now (see
// /ui/unit-editor/tabs/weapons-tab.js).

function renderMvWeaponsTab(_mv) {
  // React-managed now (see /ui/unit-editor/tabs/weapons-tab.js).
  // The React tab reads inspector-store.mv directly, so the host
  // does not need to push anything explicitly.  Keeping the function
  // for call-site compatibility (mv-controls re-render after weapon
  // swap, etc.); a runtime-tick bump nudges the React tree to repaint.
  if (_reactUi && typeof _reactUi.bumpRuntimeTick === "function") {
    _reactUi.bumpRuntimeTick()
  }
}
// how to refresh themselves via a closure stashed on dataset.
function refreshMvWeaponsLive() {
  // No-op — the React Weapons tab subscribes to runtimeTick.
}
function playWeaponSound(stem) {
  if (!stem) return
  const mv = modelViewerInstance
  const pool = mv && mv.cob && mv.cob.audio
  if (!pool) return
  // Position from the controls overlay (authoritative live unit pos)
  // if available, otherwise origin.
  const ctrl = mv._mvControls
  const pos = ctrl ? [ctrl.pos.x, ctrl.alt || 0, ctrl.pos.z] : null
  pool.play(stem, { vol: 0.6, kind: 'ui', source: `Preview: ${stem}`, pos })
}

// ── Weapon picker dialog ────────────────────────────────────────
//
// Catalogue cache for the dialog list.  Fetched lazily on first open
// and reused thereafter — the VFS doesn't change after startup so a
// single fetch covers the whole session.
let _weaponCatalogue = null
// _weaponPickerSelected / _weaponPickerWired — were used by the
// legacy vanilla picker chrome; the React picker owns selection in
// its own signal now, so these are gone.

// openWeaponPicker shows the Change Weapon dialog scoped to one slot
// of one unit.  React-managed now (see /ui/pickers/weapon-picker-dialog.js);
// we resolve the slot's current weapon name + the catalogue, then
// hand them to the React opener.  On Apply we re-call /api/studio/unit/{name}
// with the override query param and re-render the Weapons panel.
async function openWeaponPicker(mv, slotIndex) {
  if (!mv) return
  const name = mv.cob && mv.cob.unit && mv.cob.unit.name
  if (!name) return
  const ui = _reactUi || await configureReactUi()
  if (!ui || typeof ui.openWeaponPicker !== 'function') return
  // Current weapon name for this slot — surfaces as "(current)" + the
  // .active row highlight in the picker so the user sees what's
  // already installed before swapping.
  const currentMeta = mv.unitMeta && mv.unitMeta.weapons
  const currentName = currentMeta && currentMeta[slotIndex - 1]
    ? currentMeta[slotIndex - 1].name
    : ''
  // Slot label for the dialog title.  Picker is one dialog reused
  // across all three slots so the title carries the slot context.
  const slotLabel = slotIndex === 1 ? 'Primary'
    : slotIndex === 2 ? 'Secondary'
    : slotIndex === 3 ? 'Tertiary'
    : `Slot ${slotIndex}`
  // Open with a loading hint first; push the catalogue in once it
  // arrives.  In practice the catalogue is cached after the first
  // open so this path resolves immediately on repeat opens.
  const inFlight = ui.openWeaponPicker({
    items: _weaponCatalogue || [],
    loading: !_weaponCatalogue,
    query: '',
    currentName,
    slotLabel,
    paletteColor: (idx) => {
      const pal = modelViewerInstance && modelViewerInstance.palette
      if (!pal || idx <= 0) return null
      return pal.colorFor(idx)
    },
  })
  if (!_weaponCatalogue) {
    loadWeaponCatalogue().then((list) => {
      if (typeof ui.updateWeaponPicker === 'function') {
        ui.updateWeaponPicker({ items: list, loading: false })
      }
    })
  }
  const picked = await inFlight
  if (!picked) return
  // Build the override URL + remember the swap on the viewer so a
  // re-fetch doesn't lose it.
  const params = new URLSearchParams()
  params.set(`weapon${slotIndex}`, picked)
  const mv2 = modelViewerInstance
  mv2._weaponOverrides = mv2._weaponOverrides || {}
  mv2._weaponOverrides[slotIndex] = picked
  for (const [k, v] of Object.entries(mv2._weaponOverrides)) {
    if (parseInt(k, 10) !== slotIndex) params.set(`weapon${k}`, v)
  }
  try {
    const resp = await fetch(`/api/studio/unit/${encodeURIComponent(name)}?${params.toString()}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    mv2.unitMeta = await resp.json()
    renderMvWeaponsTab(mv2)
    if (_mvControls) _mvControls.onMetaLoaded()
  } catch (err) {
    console.warn('[weapon-swap] failed:', err)
  }
}

function loadWeaponCatalogue() {
  if (_weaponCatalogue) return Promise.resolve(_weaponCatalogue)
  return fetch('/api/studio/weapons').then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }).then((list) => {
    _weaponCatalogue = Array.isArray(list) ? list : []
    return _weaponCatalogue
  }).catch((err) => {
    console.warn('[weapon-catalogue] fetch failed:', err)
    _weaponCatalogue = []
    return _weaponCatalogue
  })
}


// wireWeaponPickerOnce removed — the weapon picker is React-managed
// now (see /ui/pickers/weapon-picker-dialog.js).  The Apply path
// lives in openWeaponPicker() above; cancel + filter are handled by
// the React DialogModal chrome.

// filterTexturesList replaced by the React Textures tab's own
// filter signal — see /ui/unit-editor/tabs/textures-tab.js
// (setTexturesFilter).

function selectPiece(name) {
  if (!modelViewerInstance) return
  modelViewerInstance.jumpToPiece(name)
  $$('#model-viewer-tree .drawer-item-piece, #model-viewer-tree .drawer-piece-group').forEach((el) => {
    el.classList.toggle('selected', el.dataset.piece === name)
  })
}

// filterPieceTree hides rows whose piece name (lowercase) doesn't
// contain `q`.  Groups stay visible whenever any descendant matches —
// so typing "nano" still surfaces the parent assembly.
function filterPieceTree(q) {
  q = (q || '').trim().toLowerCase()
  const host = $('#model-viewer-tree')
  if (!host) return
  const matches = (el) => {
    const name = (el.dataset.piece || '').toLowerCase()
    if (!q) return true
    if (name.includes(q)) return true
    // For groups, recurse into children — if any matches, keep us
    // visible so the user sees the path through the hierarchy.
    return Array.from(el.querySelectorAll('[data-piece]')).some((c) => c.dataset.piece.toLowerCase().includes(q))
  }
  host.querySelectorAll('[data-piece]').forEach((el) => {
    el.style.display = matches(el) ? '' : 'none'
  })
}

async function openModelPicker() {
  // The picker is React-managed now (see /ui/pickers/open-unit-dialog.js).
  // Hide whichever editor surface was on top so the modal isn't
  // fighting another dialog stack for the user's eye, then open the
  // React picker.  The legacy #model-open-dialog static markup in
  // index.html is no longer used — React mounts its own dialog DOM
  // on demand.
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog').classList.add('hidden')
  // Bring the React UI up if it hasn't loaded yet (cold-boot path).
  const ui = _reactUi || await configureReactUi()
  if (!modelsLoaded) await fetchModels()
  // The picker spawns into the React tree; await its resolution and
  // route based on the host's pending intent (sandbox spawn vs.
  // open viewer).  Polling via updateUnitDialog isn't needed here
  // because fetchModels has already drained the catalog above.
  const sandboxIntent = !!window.__sandboxSpawnPending
  const result = ui && typeof ui.openUnitDialog === 'function'
    ? await ui.openUnitDialog({
        items: availableModels,
        loading: !modelsLoaded,
        query: '',
        selectedName: null,
        sandboxIntent,
      })
    : null
  if (!result) {
    closeModelPicker()
    return
  }
  if (result.sandboxIntent && sandboxViewInstance) {
    window.__sandboxSpawnPending = false
    const pendingSide = (window.__sandboxSpawnPendingSide | 0) || 0
    window.__sandboxSpawnPendingSide = 0
    $('#model-viewer-dialog')?.classList.remove('hidden')
    void sandboxViewInstance.beginPlacement(result.name, { side: pendingSide })
    return
  }
  openModelViewer(result.name)
}

function closeModelPicker() {
  // React owns the dialog DOM, so dismissing is "close the open-state
  // signal".  When the user cancelled via Esc / Cancel the React
  // dialog has already cleared itself, so this is mainly the post-
  // confirm cleanup path: restore whichever editor surface was on
  // top before the picker opened.
  if (_reactUi && typeof _reactUi.closeUnitDialog === 'function') {
    _reactUi.closeUnitDialog()
  }
  const activeTab = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  if (activeTab?.type === 'model') {
    $('#model-viewer-dialog').classList.remove('hidden')
  } else if (activeTab?.type === 'map') {
    $('#app')?.classList.remove('hidden')
  } else {
    $('#welcome-dialog').classList.remove('hidden')
  }
}

// openSandboxStub — Sandbox welcome-card entry point.  Creates a
// new 'sandbox' tab + activates it.  The activate path mounts the
// SandboxView on the existing model-viewer canvas chrome (sky +
// ground + camera) and exposes a floating Sandbox panel with Spawn /
// Move / Attack actions.
function openSandboxStub() {
  // Reuse the model-viewer tab type for hooking into the existing
  // switchToTab routing; flag it as sandbox via tab.sandbox = true
  // so activateModelTab knows to mount the multi-unit view instead
  // of the single-unit one.  The tab name field is what the tab
  // bar displays, so use "Sandbox" rather than the internal id.
  const tab = { type: 'model', name: 'Sandbox', sandbox: true, displayName: 'Sandbox' }
  tabs.push(tab)
  switchToTab(tabs.length - 1, { fresh: true, force: true })
}

// `sandboxViewInstance` tracks the CURRENTLY ACTIVE sandbox tab's
// SandboxView.  Each sandbox tab owns its own SandboxView (stored on
// tab.viewer); on activation we swap this global pointer to whichever
// view belongs to the incoming tab so the rest of the studio (panels,
// roster, ribbon-button handlers) reads from the right scene.  Two
// sandbox tabs no longer share units / runtime / selection.
let sandboxViewInstance = null

// Captured at first activation — the shared `#model-viewer-canvas`
// element used by the single-unit ModelViewer.  Once a sandbox tab
// detaches it from the stage to mount its own per-tab canvas,
// getElementById('model-viewer-canvas') returns null because the
// element is no longer in the document tree.  Holding a reference
// here keeps the re-mount path on the way back to a unit-editor tab
// alive instead of silently appending nothing.
let _sharedModelViewerCanvas = null
function sharedModelViewerCanvas() {
  if (!_sharedModelViewerCanvas) {
    _sharedModelViewerCanvas = document.getElementById('model-viewer-canvas')
  }
  return _sharedModelViewerCanvas
}

async function activateSandboxTab(tab) {
  // Hide the model-viewer dialog if visible — sandbox lives on the
  // same canvas but with its own chrome.  Reuse the model-viewer
  // dialog so the canvas + ribbon are already mounted.
  $('#model-viewer-dialog')?.classList.remove('hidden')
  // Stop the regular ModelViewer's renderer if it's running so we
  // don't have two RAF loops fighting over the canvas.  Also silence
  // its audio so the unit editor's COB sounds don't bleed into the
  // sandbox while it owns the screen.
  if (modelViewerInstance && modelViewerInstance.renderer) {
    try { modelViewerInstance.renderer.stop?.() } catch { /* ignore */ }
  }
  if (modelViewerInstance && modelViewerInstance._mvControls
      && typeof modelViewerInstance._mvControls.setSilenced === 'function') {
    try { modelViewerInstance._mvControls.setSilenced(true) } catch { /* ignore */ }
  }
  // Stop every OTHER sandbox tab's renderer too — two sandbox tabs
  // each have their own SandboxView, and only the active one should
  // own the canvas / RAF loop.  Without this, an inactive sandbox
  // tab's renderer kept ticking + drew its scene over the canvas
  // each frame.  Clear the canvas after stopping so the new tab's
  // first paint doesn't get layered over the previous tab's frame.
  for (const t of tabs) {
    if (t === tab) continue
    const v = t.viewer
    if (v && v.renderer && v.renderer.stop) {
      try {
        v.renderer.stop()
        v.renderer.clearCanvas?.()
      } catch { /* ignore */ }
    }
  }
  // Per-tab SandboxView — each sandbox tab owns its own scene,
  // runtime, selection set, camera state, AND canvas.  Lazy-
  // constructed on first activation; reused across re-activations
  // of the SAME tab so units / camera framing survive.  The canvas
  // gets attached into the stage on activation and detached on the
  // way out so an inactive tab's GL surface is not in the DOM and
  // can't bleed through into the active tab's frame.
  const stage = document.querySelector('.model-viewer-stage')
  // Detach every OTHER tab's canvas (sandbox + unit) from the stage
  // so the incoming sandbox's canvas is the only one in the DOM
  // tree.  Both ModelViewer and SandboxView implement detach()
  // identically.  Also drop the legacy boot-time #model-viewer-canvas
  // (if still in the stage from page load) — every tab owns its own
  // per-tab canvas now and the legacy one is never re-attached.
  if (stage) {
    for (const t of tabs) {
      if (t === tab) continue
      if (t.viewer && typeof t.viewer.detach === 'function') t.viewer.detach()
    }
    const legacyCanvas = sharedModelViewerCanvas()
    if (legacyCanvas && legacyCanvas.parentNode === stage) {
      stage.removeChild(legacyCanvas)
    }
  }
  if (!tab.viewer) {
    const mod = await import('./model3d/sandbox-view.js')
    tab.viewer = new mod.SandboxView({
      statusEl: $('#status'),
    })
  }
  if (typeof tab.viewer.attach === 'function' && stage) tab.viewer.attach(stage)
  // Swap the global to whichever tab is now active so the rest of
  // the studio (panels, ribbon handlers, refreshMvInspectors) reads
  // from this tab's view.
  sandboxViewInstance = tab.viewer
  await sandboxViewInstance.open()
  // Push the current Runtime-overlay slider rate into the new
  // sandbox's runtime so it starts at the user's chosen speed instead
  // of the default 1.0×.  Each sandbox tab owns its own CobRuntime,
  // so the value WOULD be reset on every tab switch / new spawn
  // without this — manifests as "projectiles still move at full
  // speed even though the slider is at 0.1×" because the slider
  // updates were only ever forwarded to the unit-editor runtime + the
  // PREVIOUSLY active sandbox.  Read the live slider value to avoid
  // depending on cached state.
  // Read the runtime's current playback rate from whichever cob is
  // alive on the unit-editor's modelViewerInstance (the React Runtime
  // panel's Speed slider routes through mvSetSimulationSpeed which
  // commits to that runtime).  Falls back to 1× when no unit is open.
  try {
    const editorRate = modelViewerInstance?.cob?.runtime?.playbackRate
    if (typeof mvSetSimulationSpeed === 'function') {
      mvSetSimulationSpeed(typeof editorRate === 'number' ? editorRate : 1)
    }
  } catch { /* ignore */ }
  // Make sure the RAF loop is live — switchToTab stops it on the way
  // to a map tab so we don't burn frames behind the editor.  Renderer
  // .start() is idempotent.
  try { sandboxViewInstance.renderer?.start?.() } catch { /* ignore */ }
  // Un-silence audio on the incoming sandbox — outgoing tab's switch
  // muted every viewer; the active one comes back un-muted so weapon
  // fire / unit acks / death sounds play normally.
  if (typeof sandboxViewInstance.setSilenced === 'function') {
    try { sandboxViewInstance.setSilenced(false) } catch { /* ignore */ }
  }
  // Restore the sandbox's runtime to the paused/running state it was
  // in before the user switched away.  switchToTab's
  // pauseOutgoingTabRuntime stashed the pre-switch flag on the tab;
  // a fresh sandbox (no snapshot) defaults to running — its
  // weapons/scripts/particles resume ticking exactly where they
  // stopped, instead of the engine racing ahead while the tab was
  // hidden.
  resumeIncomingTabRuntime(tab)
  // Wrap the sandbox view's onAfterFrame so the inspector refresh +
  // animation-advance pipeline runs on the sandbox renderer's frames
  // too.  The sandbox view sets its own onAfterFrame (scene tick +
  // entity refresh); we wrap it here to ADD the inspector tick so
  // Renderer + Runtime overlays receive their per-frame data.
  if (sandboxViewInstance.renderer) {
    const innerHook = sandboxViewInstance.renderer.onAfterFrame
    sandboxViewInstance.renderer.onAfterFrame = (dtMs) => {
      if (innerHook) innerHook(dtMs)
      refreshMvInspectors(dtMs)
    }
  }
  // Hide the left sidebar (Pieces / Textures / Weapons — all
  // single-unit inspectors) by tagging the model-viewer-dialog as
  // sandbox-mode; the CSS rule below collapses .sidebar in this
  // mode so the canvas expands to fill the editor width.
  const dlg = $('#model-viewer-dialog')
  if (dlg) dlg.classList.add('sandbox-mode')
  // Show the Sandbox floating panel; it offers Spawn / Move / Attack
  // / Stop buttons + a unit roster.  Lazy-created on first show via
  // the React UI island — the mount is idempotent so awaiting the
  // dynamic import on every activation is cheap (one network round-
  // trip the first time, cached + immediate after).
  await ensureSandboxPanel()
  showSandboxPanel(true)
  // Force-show the inspector panels meaningful in multi-unit mode:
  // Renderer (camera info) + Scripts (runtime telemetry) for the
  // scene as a whole; Static Vars + Controls + Effects + Audio for
  // the focused unit (these render against the currently-selected
  // sandbox unit's binding — when exactly one unit is selected the
  // refreshMvInspectors proxy promotes its binding to mv.cob, which
  // owns .particles + .audio + static vars; with zero or multiple
  // units selected the panels show an empty state).
  //
  // Hide Script Commands (per-script COB buttons — too granular for
  // a strategic view; the unit editor remains the place for that).
  for (const id of ['mv-inspector-actions']) {
    const p = document.getElementById(id)
    if (p) p.classList.add('hidden')
  }
  for (const id of ['mv-inspector-camera', 'mv-inspector-scripts', 'mv-inspector-staticvars', 'mv-inspector-ports', 'mv-inspector-effects', 'mv-inspector-audio']) {
    const p = document.getElementById(id)
    if (p) p.classList.remove('hidden')
  }
  // The Controls panel's action buttons (Move / Primary / Secondary /
  // Tertiary / Stop) are wired into MvControls — which operates on
  // the single-unit ModelViewer.  In sandbox we intercept those
  // clicks in the capture phase and route them through the sandbox
  // command pipeline instead, so the same Controls panel drives the
  // currently-selected sandbox unit.  Idempotent guard so repeated
  // tab activations don't stack listeners.
  wireSandboxControlsIntercept()
  // Reset the focused-unit sentinel so the next refresh tick re-runs
  // the Script Commands panel for whatever's selected (or "No COB
  // loaded" for an empty selection).
  _mvSandboxFocusedUnitId = -1
  // Controls panel body is React-managed (see /ui/panels/controls-panel.js);
  // the inspector-store mv signal already carries the active view's
  // proxy so a tab swap re-renders the panel automatically without
  // the old DOM-wipe + sentinel-reset dance.
  // Wire sandbox ribbon buttons.  Idempotent guard so repeated tab
  // switches don't stack listeners.
  wireSandboxRibbon()
  // Patch the global modelViewerInstance proxy so refreshMvRuntimeStats
  // + refreshMvCameraPanel (both read mv.cob.runtime / mv.camera /
  // mv.renderer) see the sandbox view's runtime + camera instead of
  // the stale single-unit one.  Stashed on a separate global so the
  // single-unit instance state isn't trashed when the user returns
  // to a unit tab.
  if (typeof window !== 'undefined') {
    window.__sandboxView = sandboxViewInstance
    window.__activeViewer = sandboxViewInstance
  }
}

// wireSandboxControlsIntercept — when sandbox is active, the
// Controls panel's action buttons (Move / Primary / Secondary /
// Tertiary / Stop) should drive the currently-selected sandbox unit
// rather than the single-unit MvControls singleton.  We attach a
// capture-phase click listener that — only when the dialog is in
// sandbox-mode — translates each ctrl-action into the sandbox
// command pipeline (setPendingCommand + per-unit order writes) and
// stops the event so the underlying MvControls handler doesn't run
// against the now-dormant single-unit viewer.  Idempotent guard via
// a dataset flag.
function wireSandboxControlsIntercept() {
  const grid = document.getElementById('mv-controls-actions')
  if (!grid || grid.dataset.sandboxWired === '1') return
  grid.dataset.sandboxWired = '1'
  grid.addEventListener('click', (e) => {
    const dlg = document.getElementById('model-viewer-dialog')
    if (!dlg || !dlg.classList.contains('sandbox-mode')) return
    const btn = e.target.closest('.mv-ctrl-action')
    if (!btn) return
    const action = btn.dataset.ctrlAction
    if (!action) return
    e.stopPropagation()
    e.preventDefault()
    const sb = sandboxViewInstance
    if (!sb || !sb.scene) return
    if (action === 'stop') {
      // Stop dispatches through BaseView.stop() → engine.stopUnits.
      // The canonical "drop move + attack + weapon slots + run
      // StopMoving + TargetCleared" entry point lives in the engine
      // now; both the sandbox S-hotkey + #stopSelected and this
      // Controls grid handler converge on one code path so the three
      // can't drift apart again.
      sb.stop()
      return
    }
    // All slots arm the next canvas click — matches the unit
    // editor's Controls panel semantics (you click Primary, then
    // click in the scene to lock the weapon onto that target).
    // setPendingCommand swaps the armed-cursor overlay so the user
    // sees which slot is armed.
    if (action === 'move') sb.setPendingCommand('move')
    else if (action === 'primary' || action === 'secondary' || action === 'tertiary') sb.setPendingCommand(action)
  }, /* capture = */ true)
}

// _unitEditorAutoRotate — host-side cache of the Auto-Rotate toggle
// state shared by the React Camera dropdown, the Renderer panel, the
// R hotkey, and freshly-opened model tabs.  Mutated through the React
// ribbon's bridge (which writes both this var and the renderer) and
// the configureHostBridge.setAutoRotate callback (which mirrors back
// into the React state signal).  Default matches the React signal's
// initial `autoRotate: true` so an early open before the user touches
// the toggle paints the same default both surfaces show.
let _unitEditorAutoRotate = true

// __mvNotifyAutoRotateOff — model-viewer.js's orbit-controls fire
// this when a wheel-zoom interrupts an active auto-rotate.  We flip
// the host cache + the React Camera dropdown's check-mark in one
// place; the renderer's own state was already updated by the orbit
// controller, so we don't double-dispatch into setAutoRotate(false).
if (typeof window !== 'undefined') {
  window.__mvNotifyAutoRotateOff = () => {
    _unitEditorAutoRotate = false
    if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
      _reactUi.setModelViewerRibbonState({ autoRotate: false })
    }
  }
}

// TEAM_COLOURS — hue-shift RGB triplets the renderer's setTeamColor
// applies to the unit's team-colour palette indices.  `blue` is the
// ARM default and intentionally null so picking it disables the
// shader's recolour entirely (matching the original game's "Blue
// (default)" semantics).  Kept at module scope so the React ribbon's
// bridge can look up a colour without re-importing model3d's tables.
const TEAM_COLOURS = {
  blue:   null,
  red:    [0.92, 0.18, 0.16],
  green:  [0.20, 0.78, 0.28],
  yellow: [0.95, 0.85, 0.20],
  purple: [0.62, 0.30, 0.85],
  cyan:   [0.20, 0.80, 0.92],
  orange: [0.98, 0.55, 0.18],
  white:  [0.95, 0.95, 0.95],
  black:  [0.10, 0.10, 0.12],
}

// wireModelViewerRibbon — install the React unit-editor ribbon bridge
// + mount the React tree into #model-viewer-ribbon-mount.  Called
// once configureReactUi has resolved.  Idempotent: the bridge is
// stub-merged on every call, the mount is a no-op when the React
// tree already lives in the slot.
//
// Every action callback resolves modelViewerInstance / its renderer
// at call time so a tab swap from one unit to another reaches the
// right renderer (the React state lives on its own signal — when the
// renderer changes the host pushes fresh defaults via
// applyUnitEditorDefaults, so the toggle row check-marks reflect
// the new unit's renderer state).
function wireModelViewerRibbon() {
  if (!_reactUi) return
  if (typeof _reactUi.configureModelViewerRibbonBridge === 'function') {
    _reactUi.configureModelViewerRibbonBridge({
      openAnother: () => { modelOpenIntent = 'add'; openModelPicker() },
      showStats:   () => {
        const mv = modelViewerInstance
        if (!mv || !mv.model) return
        const m = mv.model
        const triCount = m.flat.reduce((n, p) => n + p.drawGroups.reduce(
          (s, g) => s + (g.mode === mv.renderer.gl.TRIANGLES ? g.vertexCount / 3 : 0), 0), 0)
        const msg = `${m.name} · ${m.flat.length} pieces · ${Math.round(triCount)} triangles`
        const el = $('#status')
        if (el) el.textContent = msg
      },

      resetCamera: () => {
        const mv = modelViewerInstance
        if (!mv || !mv.model) return
        const cam = mv.camera
        cam.frameBounds(mv.model.bounds.min, mv.model.bounds.max)
        // Restore the entry-view angle the auto-rotate sweep has
        // walked away from.
        cam.yaw = 215 * Math.PI / 180
        cam.pitch = 18 * Math.PI / 180
        cam.distance *= 1.25
        mv.renderer.requestRedraw()
      },
      setAutoRotate: (on) => {
        _unitEditorAutoRotate = !!on
        modelViewerInstance?.setAutoRotate(!!on)
      },

      setRenderMode:   (mode) => modelViewerInstance?.renderer?.setRenderMode(mode),
      setWireOverlay:  (on)   => modelViewerInstance?.renderer?.setWireframeOverlay(!!on),
      setWireWidth:    (px)   => modelViewerInstance?.renderer?.setWireframeWidth(px),

      setGround:       (mode) => modelViewerInstance?.renderer?.setGroundMode(mode),

      setEnvironment:  (env, _opts) => {
        modelViewerInstance?.renderer?.setEnvironment(env)
      },
      setTeamColor:    (key, _opts) => {
        modelViewerInstance?.renderer?.setTeamColor(TEAM_COLOURS[key] ?? null)
      },

      setReflections:       (on) => modelViewerInstance?.renderer?.setReflectionsEnabled(!!on),
      setSpecular:          (on) => modelViewerInstance?.renderer?.setSpecularEnabled(!!on),
      setGodBeams:          (on) => modelViewerInstance?.renderer?.setGodBeamsEnabled(!!on),
      setDoF:               (on) => modelViewerInstance?.renderer?.setDoFEnabled(!!on),
      setWaterReflections:  (on) => modelViewerInstance?.renderer?.setWaterReflectionsEnabled(!!on),

      setBob:               (on) => modelViewerInstance?.renderer?.setBobEnabled(!!on),
      setBobAmount:         (v)  => modelViewerInstance?.renderer?.setBobAmount(v),
      setBobSpeed:          (v)  => modelViewerInstance?.renderer?.setBobSpeed(v),
      setWaves:             (on) => modelViewerInstance?.renderer?.setWavesEnabled(!!on),
      setWavesIntensity:    (v)  => modelViewerInstance?.renderer?.setWavesIntensity(v),
      setBgTerrain:         (on) => modelViewerInstance?.renderer?.setBgTerrainEnabled(!!on),
      setBgTerrainHeight:   (v)  => modelViewerInstance?.renderer?.setBgTerrainHeight(v),
      setBgTerrainScale:    (v)  => modelViewerInstance?.renderer?.setBgTerrainScale(v),
      setSeabedHeight:      (v)  => modelViewerInstance?.renderer?.setSeabedHeight(v),
      setSeabedScale:       (v)  => modelViewerInstance?.renderer?.setSeabedScale(v),
      setSeabedRocks:       (v)  => modelViewerInstance?.renderer?.setSeabedRockChance(v),

      runCobEntry: (name) => {
        const cob = modelViewerInstance?.cob
        if (cob) runCobEntry(cob, name)
      },
      setCobDamage: (v) => modelViewerInstance?.setDamage?.(v | 0),
      setCobBuild:  (v) => {
        if (modelViewerInstance) modelViewerInstance._autoBuild = null
        modelViewerInstance?.setBuildPercent?.(v | 0)
      },
      setCobPlayback: (pct) => mvSetSimulationSpeed((pct | 0) / 100),
      resetCob:       () => modelViewerInstance?.resetState?.(),

      setPanelVisible: (panelId, on) => setMvInspectorVisible(panelId, !!on),

      openSettings: () => {
        if (typeof openSettingsDialog === 'function') openSettingsDialog()
        else $('#btn-settings')?.click()
      },
      openHelp: () => {
        if (typeof openHelpDialog === 'function') openHelpDialog()
        else $('#btn-help')?.click()
      },
    })
  }
  if (typeof _reactUi.mountModelViewerRibbon === 'function') {
    _reactUi.mountModelViewerRibbon()
  }
}

// wireSandboxRibbon — React-managed now (see /ui/sandbox/sandbox-ribbon.js).
// Mounts the React tree into #sandbox-ribbon-mount + installs the host
// bridge that ferries the per-button actions back into the sandbox view.
function wireSandboxRibbon() {
  if (!_reactUi) return
  const sb = () => sandboxViewInstance
  if (typeof _reactUi.configureSandboxRibbonBridge === 'function') {
    _reactUi.configureSandboxRibbonBridge({
      openSpawnPicker: (anchorEl) => openSandboxSpawnPicker(anchorEl),
      setPendingCommand: (cmd) => sb()?.setPendingCommand(cmd),
      stopSelected: () => {
        const scene = sb()?.scene
        if (!scene) return
        for (const id of scene.selected) {
          const u = scene.unitById(id)
          if (u) { u.moveTarget = null; u.attackTarget = null }
        }
      },
      selectAll: () => {
        const scene = sb()?.scene
        if (!scene) return
        scene.selectClear()
        for (const u of scene.units()) if (!u.dead) scene.selectAdd(u.id)
      },
      deselectAll: () => sb()?.scene?.selectClear(),
      clearField: async () => {
        const scene = sb()?.scene
        if (!scene) return
        const count = [...scene.units()].length
        if (count === 0) return
        const ok = await confirmDialog({
          title: 'Clear Field',
          message: count === 1
            ? 'Remove the unit currently on the battlefield?'
            : `Remove all ${count} units currently on the battlefield?`,
          okLabel: 'Clear Field',
          cancelLabel: 'Cancel',
          okDanger: true,
        })
        if (!ok) return
        const ids = [...scene.units()].map((u) => u.id)
        for (const id of ids) scene.removeUnit(id)
      },
      resetCamera: () => {
        const view = sb()
        if (!view || !view.camera) return
        view.camera.target = [0, 10, 0]
        view.camera.distance = 951.5
        view.camera.yaw = 215 * Math.PI / 180
        view.camera.pitch = 28 * Math.PI / 180
      },
      setPanelVisible: (panelId, visible) => setSandboxPanelVisible(panelId, visible),
    })
  }
  if (typeof _reactUi.mountSandboxRibbon === 'function') _reactUi.mountSandboxRibbon()
}

// handleSandboxDevToggle removed — the React sandbox ribbon's
// Developer Controls row routes directly through
// setControlsDevSectionVisible (the inspector-store signal).

// controlsDevSectionVisible — the persisted preference now lives
// inside the inspector-store signal exported from /ui/common/
// inspector-store.js; both the React Controls panel and the React
// sandbox ribbon read it from there.  The legacy host getter is gone.

// setControlsDevSectionVisible — the React sandbox ribbon flips the
// inspector-store signal directly, so the host's vanilla wrapper is
// gone.  applyControlsDevSectionVisibility still runs to keep the
// (legacy) DOM mirror in sync where it matters.

// applyControlsDevSectionVisibility removed — the React sandbox
// ribbon's Developer Controls row subscribes to the inspector-store
// signal directly, so its check-mark + active state flip the instant
// the value changes (no manual DOM mirror needed).

// setSandboxPanelVisible — uniform visibility toggle that handles both
// the standard mv-inspector panels (which route through
// setMvInspectorVisible so the unit-editor View menu stays in sync)
// AND the bespoke #sandbox-panel (Spawn floating panel) which lives
// outside the MV_INSPECTOR_IDS list.  syncPanelToggleRows fires through
// the panel-store's saveVisible callback so we don't need to mirror
// the dropdown rows here.
function setSandboxPanelVisible(panelId, visible) {
  if (panelId === 'sandbox-panel') {
    // Route through showSandboxPanel — when the React UI island has
    // loaded this updates the panel-store's visible signal so the
    // Preact tree re-renders with the right .hidden class.  Before
    // the island is up it falls back to a direct DOM toggle so the
    // toggle still feels responsive on cold starts.
    showSandboxPanel(visible)
    return
  }
  const panel = document.getElementById(panelId)
  if (!panel) return
  setMvInspectorVisible(panelId, visible)
}

// syncPanelToggleRows — removed.  Both the unit-editor View dropdown
// + the sandbox Developer Tools dropdown are React-managed now and
// subscribe to the panel-store's visible signal directly, so changing
// a panel's visibility re-renders the row check automatically without
// an extra cross-channel sync.
//
// syncSandboxDevtoolsDropdown removed for the same reason.

// _activeRuntime — pick the runtime the Runtime overlay's Pause /
// Step / Stop All controls should target.  Sandbox tab → that tab's
// engine runtime; otherwise the single-unit model viewer's runtime.
// Returns null when neither is live yet (boot races).
function _activeRuntime() {
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxOn = dlg && dlg.classList.contains('sandbox-mode')
  if (sandboxOn && typeof window !== 'undefined' && window.__sandboxView) {
    return window.__sandboxView.runtime || null
  }
  return (modelViewerInstance && modelViewerInstance.cob && modelViewerInstance.cob.runtime) || null
}

// _activeRendererView — which view currently owns the canvas.  The
// React Renderer panel's Tracking + Auto-Rotate toggles route through
// the host bridge here so they hit the right view's setTracking /
// renderer.setAutoRotate, mirroring the legacy wireMvRendererPanel
// `activeView()` helper.
function _activeRendererView() {
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode')
  return sandboxActive
    ? (typeof window !== 'undefined' ? window.__sandboxView : null)
    : modelViewerInstance
}

// _reactUi — lazy-loaded handle to the Preact UI island.  Imported
// dynamically the first time configureReactUi runs so the studio's
// initial paint isn't blocked on the framework's parse / compile
// even on cold loads.  Resolves to the module exports from
// /ui/mount.js (configureUi, mountSandboxPanel, showSandboxPanel,
// rescuePanelIntoStage).
let _reactUi = null
let _reactUiPromise = null

// configureReactUi — boot the React/Preact island and install the
// persistence bridge.  Idempotent: repeated calls return the same
// Promise so multiple init paths (initial boot, hot-reload, tab
// activation before the first import has resolved) all wait on the
// same module load.  The persistence hooks route panel-store
// mutations into the existing state.mvInspectorPos / Collapsed /
// Visible maps + persistPrefs so React panels share saved state
// with the legacy panels and stay in lockstep across reloads.
function configureReactUi() {
  if (_reactUiPromise) return _reactUiPromise
  _reactUiPromise = import('/ui/mount.js').then((ui) => {
    _reactUi = ui
    // Mirror the bridge onto host-context so the extracted /ui/*
    // modules (open-map dialog, confirm dialog, ribbon bridges,
    // future ones) can reach the React API without a back-reference
    // into studio.js.
    setReactUi(ui)
    ui.configureUi({
      loadPos:       (id) => (state.mvInspectorPos       || {})[id] || null,
      savePos:       (id, pos) => {
        state.mvInspectorPos = state.mvInspectorPos || {}
        state.mvInspectorPos[id] = { top: pos.top, left: pos.left }
        persistPrefs()
      },
      loadCollapsed: (id) => !!(state.mvInspectorCollapsed || {})[id],
      saveCollapsed: (id, on) => {
        state.mvInspectorCollapsed = state.mvInspectorCollapsed || {}
        state.mvInspectorCollapsed[id] = !!on
        persistPrefs()
      },
      loadVisible:   (id, def) => {
        const vis = state.mvInspectorVisible || {}
        return Object.prototype.hasOwnProperty.call(vis, id) ? !!vis[id] : !!def
      },
      saveVisible:   (id, on) => {
        state.mvInspectorVisible = state.mvInspectorVisible || {}
        state.mvInspectorVisible[id] = !!on
        persistPrefs()
        // Both dropdown rows (unit-editor View + sandbox Developer
        // Tools) are React-managed now and subscribe to the panel-
        // store's visible signal directly, so writing through here is
        // enough — the rows re-render on the next signal commit.
      },
    })
    // Seed each migrated inspector panel from the persisted visibility
    // BEFORE the first mount so the Preact tree doesn't flash visible
    // and then hide.  Defaults match the legacy wireMvInspectors path
    // (true unless explicitly closed at some prior session).
    for (const id of [
      'mv-inspector-staticvars', 'mv-inspector-audio', 'mv-inspector-effects',
      'mv-inspector-camera', 'mv-inspector-actions', 'mv-inspector-ports',
      'mv-inspector-scripts',
    ]) {
      const vis = state.mvInspectorVisible || {}
      const wasSet = Object.prototype.hasOwnProperty.call(vis, id)
      ui.setPanelVisible(id, wasSet ? !!vis[id] : true)
    }
    // Bridge the host's COB + camera callbacks into the React island.
    // The actual targets (active view, MvControls singleton, runCobEntry)
    // are read at call time so a sandbox / unit-editor swap reaches the
    // right place even though configure runs only once.
    ui.configureHostBridge({
      setTracking:   (on) => {
        const v = _activeRendererView()
        if (v && typeof v.setTracking === 'function') v.setTracking(on)
        else if (_mvControls && typeof _mvControls.setTracking === 'function') {
          _mvControls.setTracking(on)
        }
      },
      setAutoRotate: (on) => {
        _unitEditorAutoRotate = !!on
        const v = _activeRendererView()
        const r = v && v.renderer
        if (r && typeof r.setAutoRotate === 'function') r.setAutoRotate(on)
        // Mirror to the React unit-editor ribbon's Camera dropdown so
        // the Auto-Rotate toggle row's check flips in lockstep.
        if (_reactUi && typeof _reactUi.setModelViewerRibbonState === 'function') {
          _reactUi.setModelViewerRibbonState({ autoRotate: !!on })
        }
      },
      runCobEntry:        (cob, name) => runCobEntry(cob, name),
      isCobScriptRunning: (cob, name) => isCobScriptRunning(cob, name),
      runControlsCreate:  () => {
        // Mirror of the old #mv-controls-create-btn click handler:
        // launch Create, flip lifecycle to 'creating' so the action
        // grid stays gated, then kick the visual build ramp so the
        // user sees the construction-stripe wireframe phase in.
        const mvi = modelViewerInstance
        const cob = mvi && mvi.cob
        if (!cob || !cob.hasScript || !cob.hasScript('Create')) return
        cob.start('Create')
        cob._lifecycle = 'creating'
        startMvAutoBuild(mvi)
      },
      // Runtime overlay controls.  setSimSpeed routes through the
      // same mvSetSimulationSpeed entry point the COB-menu Playback
      // slider uses, so dragging either keeps both labels + sandbox
      // runtime in sync.  toggle/step/stopAll target whichever
      // runtime is active (unit-editor viewer first, then sandbox).
      setSimSpeed: (rate) => mvSetSimulationSpeed(rate),
      toggleRuntimePaused: () => mvToggleRuntimePaused(),
      stepRuntime: () => {
        const rt = _activeRuntime()
        if (!rt) return
        // Force one fixed 25 ms TA tick across the WHOLE per-frame
        // pipeline, not just the COB scripts.  rt.tick(25) alone only
        // advances bytecode — weapons, movement, particles, audio,
        // and smoke trails are driven elsewhere (engine.tick + the
        // per-view onAfterFrame hook), so a script-only step looked
        // like "the panel stats tick but nothing in the world moves."
        //
        // Unpause briefly, drive the same calls a real frame makes,
        // then re-pause.  Leave each thread's breakpointHit flag
        // ALONE — _runThread treats a set flag as "skip the BP check
        // on the first instruction this tick" so the BP'd line
        // executes once, the PC moves past it, and subsequent ops
        // re-engage BP checking.  Clearing the flag here would let
        // the BP at the same PC re-fire immediately and Step would
        // be stuck pacing the same line forever.
        const dlg = document.getElementById('model-viewer-dialog')
        const sandboxOn = dlg && dlg.classList.contains('sandbox-mode')
        const wasPaused = rt.paused
        rt.paused = false
        if (sandboxOn) {
          // Sandbox per-frame: scene.tick → engine.tick (runtime +
          // movement + attack + weapons + particles + audio via
          // syncBinding) + the BaseView smoke-trail advance.
          const sv = (typeof window !== 'undefined') ? window.__sandboxView : null
          if (sv && sv.scene && typeof sv.scene.tick === 'function') sv.scene.tick(25)
          if (sv && typeof sv.tickSmokeTrails === 'function') sv.tickSmokeTrails(25)
        } else {
          // Viewer per-frame: binding.tick (runtime + particles +
          // audio) + MvControls.tick (movement + weapons via
          // engine.tick(skipRuntime, skipMovement, skipSync), plus
          // its own tickSmokeTrails inside).
          const cob = modelViewerInstance && modelViewerInstance.cob
          if (cob && typeof cob.tick === 'function') cob.tick(25)
          if (_mvControls && typeof _mvControls.tick === 'function') _mvControls.tick(25)
        }
        // Always leave the runtime paused after a step so the user
        // can keep stepping (`wasPaused || true === true`).
        rt.paused = wasPaused || true
        mvRefreshRuntimeToggle()
        // Snap the React panels to the post-step state immediately
        // instead of waiting for the next 4 Hz publish — the stats
        // row, the thread list, and the Pause/Resume label all read
        // through mutable refs that need a tick to re-paint.
        if (_reactUi && typeof _reactUi.bumpRuntimeTick === 'function') {
          _reactUi.bumpRuntimeTick()
        }
      },
      stopAllThreads: async () => {
        const rt = _activeRuntime()
        if (!rt || typeof rt.killAllThreads !== 'function') return
        // Confirm before tearing every COB thread down — motion
        // controllers, smoke loops, the unit's idle background scripts
        // all die.  Users almost always WANT this when they click
        // Terminate All Scripts, but the action is irreversible (the
        // dead threads' state is gone), so the in-app confirm modal
        // routes the click through a yes/no prompt.
        const ok = await confirmDialog({
          title: 'Terminate All Scripts',
          message: 'This will stop all unit scripts, including motion controllers, smoke and other background threads.  Proceed?',
          okLabel: 'Terminate All',
          cancelLabel: 'Cancel',
          okDanger: true,
        })
        if (!ok) return
        rt.killAllThreads()
        // Repaint the thread list NOW so the user sees the empty /
        // "killed" state without a 250 ms publish lag.
        if (_reactUi && typeof _reactUi.bumpRuntimeTick === 'function') {
          _reactUi.bumpRuntimeTick()
        }
      },
      resetUnit: (unit, cob) => {
        if (cob && modelViewerInstance && modelViewerInstance.cob === cob && cob.unit === unit) {
          modelViewerInstance.resetState()
          return
        }
        if (typeof unit.killAllThreads === 'function') unit.killAllThreads()
        unit._threads.length = 0
        unit._recentlyKilled.length = 0
        for (let i = 0; i < unit.staticVars.length; i++) unit.staticVars[i] = 0
        unit._moveAnims.length = 0
        unit._rotAnims.length = 0
        for (let i = 0; i < unit._pieceVisible.length; i++) unit._pieceVisible[i] = true
      },
      openThreadCodeModal: (cob, thread) => openMvThreadCodeModal(cob, thread),
    })
    // Bridge the Include-Private toggle into the prefs system so the
    // React Script Commands panel signal + persisted
    // state.mvActionsIncludePrivate stay in lockstep.  Pref key keeps
    // the legacy 'mvActions' prefix so saved preferences survive the
    // Actions → Script Commands rename.
    ui.configureActionsIncludePrivate(
      () => !!state.mvActionsIncludePrivate,
      (on) => { state.mvActionsIncludePrivate = !!on; persistPrefs() },
    )
    // Bridge the Developer Controls toggle so the React Controls
    // panel reads + writes the same persisted preference the
    // Developer Tools dropdown row in the sandbox ribbon uses.
    ui.configureControlsDevSectionVisible(
      () => state.mvControlsDevVisible === undefined ? true : !!state.mvControlsDevVisible,
      (on) => { state.mvControlsDevVisible = !!on; persistPrefs() },
    )
    // Bring the inspector panel tree online — sandbox panel is mounted
    // lazily on first sandbox tab activation (it needs the onSpawn
    // callback closure); the always-on inspectors come up at boot so
    // they're ready when the user opens any tab.
    ui.mountInspectorPanels()
    // Mount the React-managed modal dialogs (confirm, Open Unit, Open
    // Map, weapon picker) so their open-state signals are wired and
    // the first opener call paints instantly.
    if (typeof ui.mountDialogs === 'function') ui.mountDialogs()
    // Mount the unit-editor sidebar tab components (Pieces, Textures,
    // Weapons).  Each one renders empty until the host pushes a model
    // via setPieceTreeModel / setTexturesModel — but mounting at boot
    // keeps Preact's reconciler attached so subsequent updates flow
    // straight to the existing DOM instead of replaceChildren-churn.
    if (typeof ui.mountSidebarTabs === 'function') ui.mountSidebarTabs()
    // Mount the React unit-editor ribbon + install its bridge.  The
    // bridge resolves modelViewerInstance / renderer at call time so
    // a tab swap automatically routes to the right one — no per-open
    // re-wiring needed.  Idempotent on subsequent calls.
    wireModelViewerRibbon()
    // Mount the React welcome card body, wiring its tab card buttons
    // into the existing host helpers (showSizeDialog / openOpenDialog
    // / openModelPicker / openSandboxStub).
    if (typeof ui.mountWelcomeScreen === 'function') {
      ui.mountWelcomeScreen({
        onNewMap:     () => openSizeDialog(),
        onOpenMap:    () => openMapDialog('welcome'),
        onOpenUnit:   () => openModelPicker(),
        onOpenSandbox: () => openSandboxStub(),
      })
    }
    // Bridge the unit-editor sidebar tabs to the live renderer /
    // viewer / weapon-picker / audio so the tab components don't
    // reach into modelViewerInstance globals directly.
    if (typeof ui.configureTexturesBridge === 'function') {
      ui.configureTexturesBridge({
        setHoveredTexture: (name) => {
          modelViewerInstance?.renderer?.setHoveredTexture?.(name)
        },
      })
    }
    if (typeof ui.configurePieceTreeBridge === 'function') {
      ui.configurePieceTreeBridge({
        setHoveredPieceName: (name) => {
          modelViewerInstance?.renderer?.setHoveredPieceName?.(name)
        },
        selectPiece: (name) => selectPiece(name),
        requestRedraw: () => modelViewerInstance?.renderer?.requestRedraw?.(),
      })
    }
    if (typeof ui.configureWeaponsTabBridge === 'function') {
      ui.configureWeaponsTabBridge({
        paletteColor: (idx) => {
          const pal = modelViewerInstance && modelViewerInstance.palette
          if (!pal || idx <= 0) return null
          return pal.colorFor(idx)
        },
        openWeaponPicker: (slotIndex) => openWeaponPicker(modelViewerInstance, slotIndex),
        playSound: (stem) => playWeaponSound(stem),
      })
    }
    // ── Map editor surface ───────────────────────────────────────
    // Mount the React-rendered ribbon, sidebar, and three floating
    // panels (Stats, Camera & Cursor, Minimap).  Idempotent — re-
    // mount during File → New / Open is a re-render into the same
    // roots.  The host wiring below routes every button press
    // through the existing studio.js functions (setMode, undo, etc.)
    // so we don't duplicate behaviour.
    if (typeof ui.mountMapEditor === 'function') ui.mountMapEditor()
    if (typeof ui.configureSidebarBridge === 'function') {
      ui.configureSidebarBridge({
        onTabChange:     (tab) => { switchTab(tab) },
        onFilterChange:  (text) => {
          if (!state.drawerFilters) state.drawerFilters = { sections: '', features: '' }
          state.drawerFilters[state.drawer] = text
          renderDrawer()
          persistPrefs()
        },
        onUsedOnlyChange:    (on) => { state.usedOnly = !!on; renderDrawer(); persistPrefs() },
        onWreckageChange:    (on) => { state.includeWreckage = !!on; renderDrawer(); persistPrefs() },
      })
    }
    if (typeof ui.configureMapRibbonBridge === 'function') {
      ui.configureMapRibbonBridge({
        // File
        fileNew:        () => startNewMapFromEditor(),
        fileNewWindow:  () => window.open(location.origin + '/', '_blank', 'noopener'),
        fileOpen:       () => openExistingMapFromEditor(),
        fileSave:       () => save(),
        fileSaveLoose:  () => saveLoose(),
        // Edit
        editCut:                  () => cutSelection(),
        editCopy:                 () => copyToClipboard(),
        editPaste:                () => pasteFromClipboard('all'),
        editPasteFeatures:        () => pasteFromClipboard('features'),
        editPasteTiles:           () => pasteFromClipboard('tiles'),
        editClearRegion:          () => clearRegion(),
        editClearFeaturesInSel:   () => clearFeaturesInSelection(),
        editClearAllFeatures:     () => clearAllFeatures(),
        // Mode
        setMode:           (m) => { setMode(m); publishMapRibbonState() },
        setSymmetry:       (s) => {
          state.symmetry = s
          persistPrefs()
          publishMapRibbonState()
        },
        setVoidsBrush:     (n) => { state.voidsBrushSize = n; persistPrefs(); publishMapRibbonState() },
        setEraseScope:     (sc) => { state.eraseScope = sc; persistPrefs(); publishMapRibbonState() },
        setEraseSize:      (n) => { state.eraseSize = n; persistPrefs(); publishMapRibbonState() },
        setHmTool:         (t) => { state.hmTool = t; persistPrefs(); publishMapRibbonState() },
        setHmRadius:       (n) => { state.hmRadius = n; persistPrefs(); publishMapRibbonState() },
        setHmStrength:     (n) => { state.hmStrength = n; persistPrefs(); publishMapRibbonState() },
        // Actions
        undo:                  () => undo(),
        redo:                  () => redo(),
        jumpUndoTo:            (n) => { for (let i = 0; i < n; i++) undo() },
        jumpRedoTo:            (n) => { for (let i = 0; i < n; i++) redo() },
        openResize:            () => openResizeDialog(),
        openScatter:           () => openScatterDialog(),
        exportHeightmap:       () => exportHeightmap(),
        importHeightmap:       () => {
          // The file <input id="import-heightmap-file"> is rendered
          // by the legacy template (kept in index.html so the
          // existing change-handler wiring inside wireToolbar still
          // attaches).  Synthesise a click on it to open the OS
          // picker — works even though the surrounding ribbon row
          // is now React-managed.
          const f = document.getElementById('import-heightmap-file')
          if (f) f.click()
        },
        // Zoom
        zoomIn:    () => setZoom(state.zoom * (state.settings?.zoomStep || 1.25)),
        zoomOut:   () => setZoom(state.zoom / (state.settings?.zoomStep || 1.25)),
        zoomFit:   () => fitZoom(),
        // View
        setDisplayMode:    (m) => { state.viewMode = m; renderCanvas(); persistPrefs(); publishMapRibbonState() },
        toggleGridlines:   () => { state.showGridlines = !state.showGridlines; renderCanvas(); persistPrefs(); publishMapRibbonState() },
        toggleAnimate:     () => { state.animateFeatures = !state.animateFeatures; renderDrawer(); renderCanvas(); persistPrefs(); publishMapRibbonState() },
        toggleMinimap:     () => setMinimapVisible(!state.showMinimap),
        toggleCameraInfo:  () => setCameraInfoVisible(!state.showCameraInfo),
        toggleVoids:       () => setVoidsVisible(!state.showVoids),
        toggleContours:    () => { state.showContours = !state.showContours; persistPrefs(); renderCanvas(); publishMapRibbonState() },
        toggleBuildable:   () => { state.showBuildable = !state.showBuildable; persistPrefs(); renderCanvas(); publishMapRibbonState() },
        toggleFeatures:    () => setFeaturesVisible(!state.showFeatures),
        toggleStartPos:    () => setStartPositionsVisible(!state.showStartPositions),
        // Map Settings
        openOTA:              () => openOTADialog(),
        pickSchema:           (idx) => {
          state.activeSchema = idx
          renderCanvas()
          persistPrefs()
          publishMapRibbonState()
        },
        deleteSchema:         (idx) => deleteSchema(idx),
        addSchema:            (count) => addSchemaWithPlayers(count),
        openSchemaEditor:     (idx) => openSchemaEditor(idx),
        // Configure
        openSettings:    () => openSettingsDialog(),
        // Advanced — call the existing export / quality helpers
        // directly.  The matching legacy buttons live inside the
        // hidden ribbon template, but the helper functions are all
        // top-level so they don't need a synthetic click chain.
        exportMinimap:      () => exportMinimap(),
        exportFullRender:   () => exportFullRender(),
        exportMapImage:     () => exportMapImage(),
        exportBuildmap:     () => exportBuildmap(),
        exportVoidmap:      () => exportVoidmap(),
        runQualityCheck:    () => runQualityChecker(buildSavePayload(), { mode: 'audit' }),
        openDeveloper:      () => openDeveloperDialog(),
        // Help
        openHelp:    () => openHelpDialog(),
        // Minimap pan — re-implements the legacy wireMinimap pan
        // logic via the shared bridge.  React fires
        // minimapBeginPan/Pan/EndPan; the host translates the
        // coordinates into a canvas-scroll position.
        minimapBeginPan: (clientX, clientY, canvasEl) => {
          _miniPanActive = true
          _doMinimapPan(clientX, clientY, canvasEl)
        },
        minimapPan: (clientX, clientY, canvasEl) => {
          if (!_miniPanActive) return
          _doMinimapPan(clientX, clientY, canvasEl)
        },
        minimapEndPan: () => { _miniPanActive = false },
        scheduleMinimapRender: () => scheduleMinimapRender(),
      })
    }
    // Seed default visibility for the map panels so their first
    // mount reads the persisted state (or defaults to visible) and
    // the React tree doesn't flash hidden then show.
    for (const id of ['map-stats-panel', 'minimap-panel', 'camera-info-panel']) {
      const vis = state.mvInspectorVisible || {}
      const wasSet = Object.prototype.hasOwnProperty.call(vis, id)
      // Stats panel defaults to visible; camera/minimap honour the
      // legacy state.showCameraInfo / state.showMinimap flags so an
      // upgrading user keeps their View-menu choices.
      let def = true
      if (id === 'minimap-panel')     def = state.showMinimap !== false
      if (id === 'camera-info-panel') def = state.showCameraInfo !== false
      ui.setPanelVisible(id, wasSet ? !!vis[id] : def)
    }
    // Publish the initial ribbon state so the React ribbon has the
    // right mode label + view toggles on its first paint.
    publishMapRibbonState()
    return ui
  }).catch((err) => {
    console.error('[studio] React UI island failed to load:', err)
    _reactUiPromise = null
    return null
  })
  return _reactUiPromise
}

// publishMapRibbonState — push every map-editor ribbon-relevant
// flag/label into the React store so the migrated ribbon re-renders
// on the next signal commit.  Cheap when the React UI hasn't loaded
// (early no-op) so calling unconditionally is safe.
function publishMapRibbonState() {
  if (!_reactUi || typeof _reactUi.publishRibbonState !== 'function') return
  // Schema dropdown — flatten the OTA's schema array into the shape
  // the React ribbon expects.  Player-count labels mirror what the
  // legacy refreshSchemaSelector produced.
  const ota = state.ota
  const schemas = (ota && Array.isArray(ota.schemas)) ? ota.schemas : []
  const activeIdx = state.activeSchema | 0
  const schemaList = schemas.map((s, i) => ({
    index: i,
    label: schemaPickerLabel(s),
    active: i === activeIdx,
    tooltip: s ? `${s.name || `Schema ${i + 1}`} (${playerCountLabel(schemaPlayerCount(s))})` : null,
  }))
  const schemaName = schemas.length > 0
    ? schemaPickerLabel(schemas[activeIdx] || schemas[0])
    : 'Schema'
  // Add-grid — same player counts the legacy renderDiceGrid populated.
  const addCounts = pickedPlayerCounts().map((n) => ({
    count: n,
    label: String(n),
    label2: playerCountLabel(n),
  }))
  // Undo / redo history lists.  Each entry is the {label, kind} pair
  // that captureSnapshot stashed at commit time.  We expose only the
  // labels here — the popout list shows them as menu rows the user
  // can click to jump multiple steps in one gesture.
  const undoHistory = (undoStack || []).slice().reverse().slice(0, 16).map((entry, idx) => ({
    label: (entry && entry.label) || 'Edit',
    depth: idx + 1,
  }))
  const redoHistory = (redoStack || []).slice().reverse().slice(0, 16).map((entry, idx) => ({
    label: (entry && entry.label) || 'Edit',
    depth: idx + 1,
  }))
  _reactUi.publishRibbonState({
    mode: state.mode || 'select-terrain',
    viewMode: state.viewMode || 'map',
    showGridlines: !!state.showGridlines,
    animateFeatures: !!state.animateFeatures,
    showMinimap: !!state.showMinimap,
    showCameraInfo: state.showCameraInfo !== false,
    showVoids: state.showVoids !== false,
    showContours: !!state.showContours,
    showBuildable: !!state.showBuildable,
    showFeatures: state.showFeatures !== false,
    showStartPositions: state.showStartPositions !== false,
    symmetry: state.symmetry || 'off',
    voidsBrushSize: state.voidsBrushSize || 1,
    eraseSize: state.eraseSize || 1,
    eraseScope: state.eraseScope || 'all',
    hmTool: state.hmTool || 'raise',
    hmRadius: state.hmRadius || 4,
    hmStrength: state.hmStrength || 4,
    undoLabel: undoStack && undoStack.length > 0
      ? `Undo ${(undoStack[undoStack.length - 1] || {}).label || 'edit'}`
      : 'Undo',
    undoEnabled: !!(undoStack && undoStack.length > 0),
    redoLabel: redoStack && redoStack.length > 0
      ? `Redo ${(redoStack[redoStack.length - 1] || {}).label || 'edit'}`
      : 'Redo',
    redoEnabled: !!(redoStack && redoStack.length > 0),
    undoHistory,
    redoHistory,
    schemaName,
    schemaList,
    schemaAddCounts: addCounts,
    connected: isConnected(),
  })
}

// Sidebar signal mirror — the React sidebar component reads its own
// active drawer / filter / used+wreckage state off signals.  We
// publish them on every switchTab + persistPrefs change so the
// initial paint + tab swaps land on the right values.
function publishMapSidebarState() {
  if (!_reactUi) return
  if (typeof _reactUi.setSidebarDrawer === 'function') {
    _reactUi.setSidebarDrawer(state.drawer || 'sections')
  }
  if (typeof _reactUi.setSidebarFilter === 'function') {
    _reactUi.setSidebarFilter((state.drawerFilters || {})[state.drawer] || '')
  }
  if (typeof _reactUi.setSidebarUsedOnly === 'function') {
    _reactUi.setSidebarUsedOnly(!!state.usedOnly)
  }
  if (typeof _reactUi.setSidebarWreckage === 'function') {
    _reactUi.setSidebarWreckage(!!state.includeWreckage)
  }
  if (typeof _reactUi.setSidebarUsedOnlyVisible === 'function') {
    _reactUi.setSidebarUsedOnlyVisible(state.drawer === 'features')
  }
  if (typeof _reactUi.setSidebarWreckageVisible === 'function') {
    _reactUi.setSidebarWreckageVisible(state.drawer === 'features')
  }
}

// ── Minimap pan bridge ─────────────────────────────────────────────
// React MinimapPanel fires minimapBeginPan / Pan / EndPan through the
// map-ribbon bridge; the host translates the click coordinates into
// a canvas-scroll position using the live zoom + overscroll padding.
// Mirrors the legacy wireMinimap pan logic, just driven from the
// React component's own listeners.

let _miniPanActive = false
function _doMinimapPan(clientX, clientY, canvasEl) {
  const mini = canvasEl || document.getElementById('minimap')
  const wrap = document.getElementById('canvas-scroll')
  const canvas = document.getElementById('canvas')
  if (!mini || !wrap || !canvas) return
  const rect = mini.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const cx = (clientX - rect.left) / rect.width
  const cy = (clientY  - rect.top)  / rect.height
  const fullW = canvas.width  * state.zoom
  const fullH = canvas.height * state.zoom
  wrap.scrollLeft = cx * fullW - wrap.clientWidth  / 2 + overscrollPadding.x
  wrap.scrollTop  = cy * fullH - wrap.clientHeight / 2 + overscrollPadding.y
}

// ensureSandboxPanel — bring up the React-rendered sandbox panel the
// first time the user enters sandbox mode.  The Preact island owns
// the DOM (drag / collapse / close / clamp); we just hand it the
// Spawn callback that opens the side picker anchored at the clicked
// button.  Mount is idempotent — re-entering sandbox mode re-renders
// into the same root rather than stacking panels.
async function ensureSandboxPanel() {
  const ui = _reactUi || await configureReactUi()
  if (!ui) return
  ui.mountSandboxPanel({
    onSpawn: (sourceEl) => openSandboxSpawnPicker(sourceEl),
  })
}

function showSandboxPanel(show) {
  // Route through the panel-store so the React tree re-renders and
  // the persisted visibility flag stays in sync.  Falls back to a
  // plain DOM toggle when the UI island hasn't loaded yet (very
  // early boot before configureReactUi resolved).
  if (_reactUi && typeof _reactUi.showSandboxPanel === 'function') {
    _reactUi.showSandboxPanel(!!show)
    return
  }
  const p = document.getElementById('sandbox-panel')
  if (p) p.classList.toggle('hidden', !show)
}

// openSandboxSpawnPicker — opens a small side-colour popout
// anchored against the source element the user pressed.  When the
// user picks a side, the existing Open Unit dialog opens with the
// picked side stashed on window.__sandboxSpawnPendingSide; the
// confirm handler then passes that side into
// sandboxView.beginPlacement so the unit spawns with the
// appropriate team-colour recolour.
//
// `sourceEl` (optional) is the button the user clicked — the
// popout anchors directly below it.  Callers pass their own button
// (ribbon Spawn, floating-panel Spawn) so the popout always lands
// adjacent to the gesture.  Falls back to the ribbon button if
// nothing's supplied (keeps existing keyboard-driven callers
// working).
//
// Lazy-creates the popout on first call; subsequent calls just
// re-position + show it.  Click-outside dismisses without choosing.
function openSandboxSpawnPicker(sourceEl = null) {
  let popout = document.getElementById('sandbox-side-popout')
  if (!popout) {
    popout = document.createElement('div')
    popout.id = 'sandbox-side-popout'
    popout.style.cssText = [
      'position: absolute',
      'z-index: 10000',
      'background: rgba(20, 24, 32, 0.96)',
      'border: 1px solid rgba(140, 220, 255, 0.40)',
      'border-radius: 8px',
      'padding: 8px',
      'display: flex',
      'gap: 6px',
      'box-shadow: 0 6px 20px rgba(0,0,0,0.45)',
    ].join('; ')
    // 8 side swatches plus a label.  Same colours as TEAM_SIDES in
    // model3d/team-colors.js; inlined here so studio.js doesn't have
    // to import an ES module at this scope.
    const SIDES = [
      { side: 0, key: 'blue',   css: '#3a6cd6', label: 'Blue (ARM)' },
      { side: 1, key: 'red',    css: '#eb2e29', label: 'Red (CORE)' },
      { side: 2, key: 'green',  css: '#34c747', label: 'Green' },
      { side: 3, key: 'yellow', css: '#f3d933', label: 'Yellow' },
      { side: 4, key: 'purple', css: '#9e4dd9', label: 'Purple' },
      { side: 5, key: 'cyan',   css: '#34ccea', label: 'Cyan' },
      { side: 6, key: 'orange', css: '#fa8d2e', label: 'Orange' },
      { side: 7, key: 'black',  css: '#1a1a1f', label: 'Black' },
    ]
    for (const s of SIDES) {
      const sw = document.createElement('button')
      sw.type = 'button'
      sw.className = 'sandbox-side-swatch'
      sw.dataset.side = String(s.side)
      sw.title = s.label
      sw.style.cssText = [
        'width: 28px', 'height: 28px',
        'border-radius: 4px',
        'border: 2px solid rgba(255,255,255,0.15)',
        'cursor: pointer',
        'padding: 0',
        `background: ${s.css}`,
      ].join('; ')
      sw.addEventListener('click', () => {
        window.__sandboxSpawnPendingSide = s.side
        window.__sandboxSpawnPending = true
        popout.style.display = 'none'
        openModelPicker()
      })
      popout.appendChild(sw)
    }
    document.body.appendChild(popout)
    // Click-outside dismiss — bound on document with capture so it
    // fires before the swatch's own click handler when the user
    // releases on a swatch (the swatch's click runs first because
    // it's inside the popout subtree, and then capture re-fires
    // here; we only hide when the target is outside the popout).
    document.addEventListener('mousedown', (e) => {
      if (popout.style.display === 'none') return
      if (popout.contains(e.target)) return
      // Don't dismiss when re-clicking the spawn-triggering buttons —
      // the same gesture would toggle off then on if we did.  The
      // ribbon's outer Sandbox button is the typical anchor (rounds
      // 13+); the inline Spawn Unit menu row + the floating panel's
      // Spawn button cover the legacy callers.
      const sandboxRbBtn = document.getElementById('sandbox-rb-sandbox-btn')
      const spawnRow = document.getElementById('sandbox-rb-spawn')
      const sandboxPanelBtn = document.getElementById('sandbox-spawn')
      if (sandboxRbBtn && sandboxRbBtn.contains(e.target)) return
      if (spawnRow && spawnRow.contains(e.target)) return
      if (sandboxPanelBtn && sandboxPanelBtn.contains(e.target)) return
      popout.style.display = 'none'
    }, true)
  }
  // Anchor under the source element the caller passed (the button
  // the user actually pressed); fall back to the ribbon's Sandbox
  // dropdown button when no source is supplied, then the legacy
  // ribbon Spawn row and finally the floating-panel Spawn button.
  // Pixel-position the popout right below the anchor with a small gap.
  const anchor = sourceEl
    || document.getElementById('sandbox-rb-sandbox-btn')
    || document.getElementById('sandbox-rb-spawn')
    || document.getElementById('sandbox-spawn')
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    popout.style.left = `${Math.round(r.left)}px`
    popout.style.top  = `${Math.round(r.bottom + 6)}px`
  }
  popout.style.display = 'flex'
}

async function fetchModels() {
  try {
    const resp = await fetch('/api/studio/models')
    const data = await resp.json()
    availableModels = data.models || []
    modelsLoaded = true
  } catch (err) {
    availableModels = []
    modelsLoaded = true
    $('#model-list').innerHTML = `<div class="loading">Failed to load models: ${escapeHTML(String(err))}</div>`
  }
}


async function openModelViewer(name) {
  $('#model-open-dialog').classList.add('hidden')
  // Push a new model tab into the unified tab array so the map
  // editor's tab bar (and the viewer's mirrored tab bar) both show
  // the new entry.  switchToTab routes by type so the dialog mounts
  // automatically.
  const meta = availableModels.find((m) => m.name === name)
  const activeTab = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  if (modelOpenIntent === 'replace' && activeTab?.type === 'model') {
    activeTab.name = name
    activeTab.meta = meta
  } else {
    tabs.push({ type: 'model', name, meta })
    tabState.activeIndex = tabs.length - 1
  }
  modelOpenIntent = 'add'
  // Force-switch so the dialog re-opens, the topbar/footer refresh,
  // and the viewer loads the new model even when the tab index
  // stayed put.
  switchToTab(tabState.activeIndex, { fresh: false, force: true })
}

// closeModelViewer — replaced by the React ribbon's "Open another
// model…" routing through openModelPicker (intent=add), which pushes
// the new unit into a fresh tab instead of dropping the current one.
// Tab close gestures (× on the tab strip + the tab bar's keyboard
// shortcut) still flow through closeTab directly.

// setStatus / clamp / escapeHTML / sanitiseFilename now live in
// ./ui/host-context.js so subsystem modules can pull them in
// without re-importing studio.js.
