// KBot Studio — browser-side editor host.
//
// Current responsibilities:
//   - Boot orchestration (DOMContentLoaded wiring of dialogs, welcome
//     screen, tab bar, server heartbeat).
//   - Cross-section `hostCallbacks` registry — the seam every extracted
//     /ui/* subsystem uses to reach studio-owned helpers without
//     importing studio.js (which would re-introduce circular deps).
//   - Tab type registration + dispatch into /ui/tab-registry.js.
//   - React UI bridge dispatch via configureReactUi.
//
// The active MvControls alias is the only module-level mutable left in
// this file; dozens of map-editor + sandbox call sites still reach it
// through hostCallbacks.getActiveMvControls.
let _mvControls = null

import {
  WORLDS,
} from './ui/map-editor/constants.js'

// Host context — shared module-level state for every /ui/* subsystem.
// MapDoc, the `state` Proxy, the tab registry, the DOM helpers and
// the tiny utilities (setStatus / clamp / escapeHTML / …) all live
// in one module so map-editor / unit-editor / sandbox code can import
// them without dragging studio.js along.  Anything mutable across
// modules goes on a plain object (`tabState.activeIndex`) because
// ES-module `let` exports are read-only on the import side.
import {
  tabs,
  tabState,
  hostCallbacks,
  $,
} from './ui/host-context.js'

import {
  updateUndoButtons,
} from './ui/map-editor/undo.js'

import {
  loadPersistedPrefs,
} from './ui/common/prefs.js'

import { startServerHeartbeat } from './ui/common/heartbeat.js'

// Unsaved-changes Save / Discard / Cancel prompt — awaited from
// closeTab when a dirty map is being closed.
import { unsavedChangesDialog } from './ui/dialogs/unsaved-changes.js'

// Welcome dialog visual + audio FX — three pure self-contained
// subsystems that observe #welcome-dialog's hidden class via
// MutationObserver to suspend / resume on dialog close.
import { gameIconDataUri } from '@kbot/ui/game-icon'
import { applyGameView3D } from './ui/common/game-view3d.js'
import { wireWelcomeNanoFX } from './ui/screens/welcome/fx/nano-fx.js'
import { wireWelcomeAmbient } from './ui/screens/welcome/fx/ambient.js'
import { wireWelcomeGlamour } from './ui/screens/welcome/fx/glamour.js'

import { wireWelcomeKeyboard } from './ui/screens/welcome/keyboard.js'
import { wireWelcomeDropZone } from './ui/screens/welcome/drop-zone.js'

import {
  openMapDialog,
} from './ui/pickers/open-map.js'

// ?initial_map=<name> URL shortcut — polls the catalogue then routes
// through the same openLoadedMap host callback as the picker.
import { maybeAutoOpenFromQuery } from './ui/pickers/auto-open.js'

// Open Unit dialog flow controller — routes the user's pick either
// into the SandboxView's spawn placement loop or into a fresh model
// tab via the openModelViewer host callback registered below.
import { openModelPicker } from './ui/pickers/open-unit-flow.js'

import {
  sharedModelViewerCanvas,
  getActiveSandboxView,
} from './ui/sandbox/tab.js'

// Tab registrar.  Each section ships a register-tab.js that installs
// its TabType descriptor; studio.js dispatches focus + close through
// the registry instead of branching by type.  The host imports the
// registration functions here so the registrar is populated
// synchronously during boot, BEFORE any tab is opened.
import { registerMapTabType } from './ui/map-editor/register-tab.js'
import { registerUnitEditorTabType } from './ui/unit-editor/register-tab.js'
import { registerSandboxTabType } from './ui/sandbox/register-tab.js'
import { registerFilesTabType } from './ui/files-browser/register-tab.js'
import { registerWelcomeTabType } from './ui/screens/welcome/register-tab.js'
import { openWelcomeTab } from './ui/screens/welcome/tab.js'
import {
  openTab,
  switchToTab,
} from './ui/tab-registry.js'

import {
  renderMapTabs,
  wireMapTabBar,
  mapDisplayName,
} from './ui/tab-bar.js'
import { updateTopbarDocInfo } from './ui/topbar.js'
import { configureReactUi } from './ui/wire-react-ui.js'

// setMinimapVisible is the only view-toggle studio.js still touches
// directly (settings dialog seam below).  The other three (features /
// start-positions / voids) are reached through the ribbon bridge.
import {
  setMinimapVisible,
} from './ui/map-editor/view-toggles.js'

import {
  setCameraInfoVisible,
} from './ui/map-editor/camera-info.js'

import {
  publishMapRibbonState,
  publishMapSidebarState,
} from './ui/map-editor/ribbon/bridge.js'

import {
  populateWorldSelect,
  loadTilesets,
  renderDiceGrid,
} from './ui/map-editor/dialogs/dice-picker.js'

import {
  setMode,
  cancelPlacement,
  showPlacementHint,
  hidePlacementHint,
  clearStampSelection,
} from './ui/map-editor/mode.js'

import {
  wireSchemaSelector,
  refreshSchemaSelector,
} from './ui/map-editor/schema-selector.js'

import {
  openSizeDialog,
  closeSizeDialog,
  startNewMapFromEditor,
  openExistingMapFromEditor,
  confirmOnEnter,
  setSizeDialogSource,
} from './ui/map-editor/dialogs/size.js'

import {
  openLoadedMap,
  startEditor,
  snapshotActiveTabModuleLets,
  restoreActiveTabModuleLets,
} from './ui/map-editor/boot.js'

// `save` is needed for the unsaved-changes seam the close path drives
// through hostCallbacks.saveActiveMap.
import { save } from './ui/map-editor/save.js'

import {
  bumpContentVersion,
} from './ui/map-editor/content-cache.js'

import {
  renderMinimap,
  invalidateMinimapBase,
} from './ui/map-editor/minimap.js'

import {
  scheduleRenderCanvas,
  scheduleMinimapRender,
} from './ui/map-editor/render-queue.js'

import {
  whenImageReady,
  preloadFeatureImage,
  featureAnchorOffset,
  featureAnchorWorld,
} from './ui/map-editor/feature-assets.js'

import {
  shouldPan, beginPan, updatePan, endPan, isPanning,
  updateHoverLabel, tryAutoSwitchAt,
} from './ui/map-editor/cursor.js'

import { renderDrawer } from './ui/map-editor/drawer.js'

import {
  beginSectionDrag,
  beginFeatureDrag,
  pageSectionSibling,
  selectSection,
  selectFeature,
  viewportCellCenter,
  setActiveWorld,
} from './ui/map-editor/drawer-actions.js'

import {
  switchTab,
  placementAnchor,
  placeFeature,
  activeSchema,
} from './ui/map-editor/wire-toolbar.js'

import {
  recreateEditorView,
} from './ui/map-editor/editor-view.js'

import { renderCanvas } from './ui/map-editor/canvas/render.js'

import { wireDeveloperDialog } from './ui/map-editor/wire-help-settings-developer.js'

import {
  applyUnitEditorDefaults,
  applyDefaultGroundFor,
  mvFetchUnitMeta,
  advanceMvAutoBuild,
} from './ui/unit-editor/runtime.js'

// Sim-clock controls — background-tab auto-pause + `window.*` hotkey
// aliases.  studio.js only needs the boot-time installers; the
// React-bridge entries reach the per-runtime helpers directly.
import {
  wireMvRuntimeVisibility,
  _wireRuntimeHelpersToWindow,
} from './ui/common/sim-controls.js'

// Per-tick inspector publish + debugger repaint.  Called from each
// view's renderer.onAfterFrame hook (both ModelViewer and SandboxView)
// to publish the active inspector mv proxy + iterate every open
// debugger panel.  Throttled to 4 Hz internally.
import { refreshMvInspectors } from './ui/common/refresh-tick.js'

// COB-state-to-React sync cluster.  Push live cob / runtime /
// lifecycle state into the React COB-dropdown ribbon + Script
// Commands panel signals so the UI tracks thread starts / deaths and
// lifecycle transitions.  External callers route through
// `hostCallbacks` — the registrations below preserve that surface.
import {
  mvSyncCobAttrSlidersFromPorts,
  syncMvActionsRunning,
  syncCobRibbonRunning,
  refreshCobPanel,
} from './ui/unit-editor/cob-sync.js'

import {
  getActiveModelViewer,
  setActiveModelViewer,
  getUnitEditorAutoRotate,
} from './ui/unit-editor/host-state.js'

import { resumeIncomingTabRuntime, openModelViewer } from './ui/unit-editor/tab.js'

// Cold-boot wiring for the unit editor's legacy DOM chrome (piece-
// tree filter + inspectors + the React UI island).
import { wireModelDialogs } from './ui/unit-editor/wire-dialogs.js'

import {
  renderPieceTree,
  renderTexturesTab,
  wireMvSidebarTabs,
} from './ui/unit-editor/sidebar.js'

// Map state model
// ---------------
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

// ── Boot ───────────────────────────────────────────────────────────────────

// applySessionBrand fetches the session's game + name and paints the topbar
// brand: the game's application icon next to the KBot Studio wordmark, plus the
// workspace name as a subtitle. It also tags <body> with the game and publishes
// it on window.__KBOT_GAME__ so the welcome FX + parchment background can pick
// their game theme (green nanolathe vs magical smoke; papyrus tint).
async function applySessionBrand() {
  try {
    const info = await fetch('/api/studio/session-info').then((r) => (r.ok ? r.json() : null))
    if (!info) return
    const game = info.game || ''
    window.__KBOT_GAME__ = game
    if (game) document.body.dataset.game = game
    // Re-inject game3d's view config now the real game id is known (the
    // module applied the TA baseline at import time).
    applyGameView3D()
    const icon = $('#app-brand-logo')
    const uri = gameIconDataUri(game)
    if (icon && uri) { icon.src = uri; icon.removeAttribute('hidden') }
    const sub = $('#app-brand-sub')
    if (sub) sub.textContent = info.name || ''
  } catch { /* leave the default brand on any error */ }
}

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
  hostCallbacks.wireSchemaSelector = wireSchemaSelector
  hostCallbacks.publishMapRibbonState = publishMapRibbonState
  hostCallbacks.publishMapSidebarState = publishMapSidebarState
  hostCallbacks.startNewMapFromEditor = () => startNewMapFromEditor()
  hostCallbacks.openExistingMapFromEditor = () => openExistingMapFromEditor()
  hostCallbacks.startEditor = () => startEditor()
  hostCallbacks.setMode = setMode
  hostCallbacks.invalidateMinimapBase = invalidateMinimapBase
  hostCallbacks.whenImageReady = whenImageReady
  hostCallbacks.preloadFeatureImage = preloadFeatureImage
  hostCallbacks.featureAnchorOffset = featureAnchorOffset
  hostCallbacks.featureAnchorWorld = featureAnchorWorld
  hostCallbacks.configureReactUi = configureReactUi
  hostCallbacks.openModelPicker = openModelPicker
  hostCallbacks.getActiveSandboxView = getActiveSandboxView
  hostCallbacks.openModelViewer = (name) => openModelViewer(name)
  hostCallbacks.switchToTab = (idx, opts) => switchToTab(idx, opts)
  hostCallbacks.getActiveTab = () => (tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null)
  // openTab is the ONLY public path to add a tab — it consults the
  // registry, builds the instance, attaches it to the host record,
  // then switches focus.  Every opener must go through here.
  hostCallbacks.getTabs = () => tabs
  hostCallbacks.openTab = (typeId, spec = {}, opts = {}) => openTab(typeId, spec, opts)
  hostCallbacks.openLoadedMap = openLoadedMap
  hostCallbacks.renderMinimap = renderMinimap
  hostCallbacks.bumpContentVersion = bumpContentVersion
  hostCallbacks.setCameraInfoVisible = setCameraInfoVisible
  hostCallbacks.viewportCellCenter = viewportCellCenter
  hostCallbacks.scheduleRenderCanvas = scheduleRenderCanvas
  hostCallbacks.scheduleMinimapRender = scheduleMinimapRender
  hostCallbacks.tryAutoSwitchAt = tryAutoSwitchAt
  hostCallbacks.placeFeature = placeFeature
  hostCallbacks.placementAnchor = placementAnchor
  hostCallbacks.clearStampSelection = clearStampSelection
  hostCallbacks.renderDrawer = renderDrawer
  hostCallbacks.shouldPan = shouldPan
  hostCallbacks.beginPan = beginPan
  hostCallbacks.updatePan = updatePan
  hostCallbacks.endPan = endPan
  hostCallbacks.isPanning = isPanning
  hostCallbacks.updateHoverLabel = updateHoverLabel
  hostCallbacks.activeSchema = activeSchema
  hostCallbacks.selectSection = selectSection
  hostCallbacks.selectFeature = selectFeature
  hostCallbacks.beginSectionDrag = beginSectionDrag
  hostCallbacks.beginFeatureDrag = beginFeatureDrag
  hostCallbacks.setActiveWorld = setActiveWorld
  // Drawer tab switcher — mode.js' syncDrawerToMode flips the drawer
  // to Sections when the user picks Paint, or Features for Place
  // Features.
  hostCallbacks.switchDrawerTab = (tab) => switchTab(tab)
  // pageSectionSibling lives studio-side because it depends on
  // selectSection — keyboard.js' ArrowLeft / ArrowRight branch calls
  // it through hostCallbacks.
  hostCallbacks.pageSectionSibling = pageSectionSibling
  hostCallbacks.getActiveModelViewer = getActiveModelViewer
  hostCallbacks.setActiveModelViewer = setActiveModelViewer
  hostCallbacks.setActiveMvControls = (c) => { _mvControls = c }
  hostCallbacks.getActiveMvControls = () => _mvControls
  hostCallbacks.advanceMvAutoBuild = advanceMvAutoBuild
  hostCallbacks.refreshMvInspectors = refreshMvInspectors
  hostCallbacks.renderPieceTree = renderPieceTree
  hostCallbacks.renderTexturesTab = renderTexturesTab
  hostCallbacks.wireMvSidebarTabs = wireMvSidebarTabs
  hostCallbacks.refreshCobPanel = refreshCobPanel
  hostCallbacks.resumeIncomingTabRuntime = resumeIncomingTabRuntime
  hostCallbacks.getUnitEditorAutoRotate = getUnitEditorAutoRotate
  hostCallbacks.mvFetchUnitMeta = mvFetchUnitMeta
  hostCallbacks.applyDefaultGroundFor = applyDefaultGroundFor
  hostCallbacks.applyUnitEditorDefaults = applyUnitEditorDefaults
  hostCallbacks.mvSyncCobAttrSlidersFromPorts = mvSyncCobAttrSlidersFromPorts
  hostCallbacks.syncMvActionsRunning = syncMvActionsRunning
  hostCallbacks.syncCobRibbonRunning = syncCobRibbonRunning
  hostCallbacks.sharedModelViewerCanvas = sharedModelViewerCanvas
  // Tab descriptor snapshot/restore hooks — the map descriptor's
  // activate / deactivate / canClose all reach through these.
  hostCallbacks.snapshotActiveTabModuleLets = snapshotActiveTabModuleLets
  hostCallbacks.restoreActiveTabModuleLets = restoreActiveTabModuleLets
  hostCallbacks.updateUndoButtons = () => {
    if (typeof updateUndoButtons === 'function') updateUndoButtons()
  }
  hostCallbacks.mapDisplayName = mapDisplayName
  hostCallbacks.updateTopbarDocInfo = updateTopbarDocInfo
  hostCallbacks.unsavedChangesDialog = (opts) => unsavedChangesDialog(opts)
  hostCallbacks.saveActiveMap = () => save()
  // Settings-dialog seams.  The map editor "section" is the canonical
  // owner of WORLDS + the minimap visibility toggle, so wiring these
  // here keeps /ui/dialogs/settings.js from peer-importing
  // /ui/map-editor/.
  hostCallbacks.getWorldOptions = () => WORLDS.map((w) => ({ key: w.slug, label: w.label }))
  hostCallbacks.setMinimapVisible = (v) => setMinimapVisible(!!v)
  // Register every tab type AFTER the hostCallbacks block so
  // descriptor activate() hooks see a populated host surface on the
  // very first activation.
  registerMapTabType()
  registerUnitEditorTabType()
  registerSandboxTabType()
  registerFilesTabType()
  registerWelcomeTabType()
  // Cross-module helpers — keyboard shortcuts in mv-controls call
  // these via window.* to avoid an ES-module circular import.
  _wireRuntimeHelpersToWindow()
  // Size dialog (New flow).
  $('#size-confirm').addEventListener('click', startEditor)
  $('#size-w').addEventListener('keydown', confirmOnEnter)
  $('#size-h').addEventListener('keydown', confirmOnEnter)
  $('#size-name').addEventListener('keydown', confirmOnEnter)
  // Welcome modal — pick New vs Open.  The welcome card body is now
  // rendered by the React WelcomeScreen (its cards fire onNewMap /
  // onOpenMap callbacks wired in wire-react-ui.js), so these legacy
  // static buttons no longer exist in the DOM.  Guard the wiring so
  // boot doesn't throw, and keep it as a no-op fallback for any build
  // that still ships the static markup.
  $('#welcome-new')?.addEventListener('click', () => {
    setSizeDialogSource('welcome')
    $('#welcome-dialog').classList.add('hidden')
    openSizeDialog()
  })
  $('#welcome-open')?.addEventListener('click', () => openMapDialog('welcome'))
  wireWelcomeKeyboard()
  wireWelcomeDropZone()
  wireWelcomeNanoFX()
  applySessionBrand()
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
  // Replace the TA default world list with the game-appropriate tilesets
  // (TA:Kingdoms → its kingdoms) from the backend; no-ops on failure.
  loadTilesets()
  // Start the server heartbeat as soon as the page is wired — works
  // even on the Welcome screen so the user finds out the server died
  // before they pick a map.
  startServerHeartbeat()
  // ?initial_map=<name> skips the Welcome dialog and jumps straight
  // into the named map.  Match is case-insensitive against either the
  // file name or the OTA mission name so URL-friendly slugs like
  // "Metal%20Heck" line up with however the catalogue indexes them.
  maybeAutoOpenFromQuery().then((opened) => { if (!opened) openWelcomeTab() })
})
