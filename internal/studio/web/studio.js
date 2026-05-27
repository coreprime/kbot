// Controls overlay — Move + Aim/Fire scheduler.  The MvControls class
// is constructed by /ui/unit-editor/tab.js' onModelLoaded closure now;
// studio.js only tracks the active tab's instance for the inspector
// gating + ribbon bridge to read from.
let _mvControls = null

// Map-editor-only literals + pure helpers — extracted into the
// /ui/map-editor/ subfolder so other React components can pick them
// up without dragging studio.js's runtime state along.  These are
// strictly map-scoped: nothing here is referenced by the unit editor
// or sandbox views.
import {
  SCHEMA_PLAYER_COUNTS,
  WORLDS,
} from './ui/map-editor/constants.js'
import {
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
  state,
  hostCallbacks,
  setReactUi,
  $,
  $$,
  setStatus,
  clamp,
} from './ui/host-context.js'

// Undo / redo + transaction wrapper for map edits — moved to
// /ui/map-editor/undo.js.  studio.js still calls these directly
// from the keyboard handler, the ribbon, and every mode tool.
import {
  undoStack,
  redoStack,
  beginTransaction,
  commitTransaction,
  undo,
  redo,
  updateUndoButtons,
  getPendingTransaction,
  setPendingTransaction,
} from './ui/map-editor/undo.js'

// Paint / erase / heightmap stroke flags — shared across every
// stamp-style mode so each mode module reads + writes the same
// `painting` + `paintedDuringStroke` fields without per-module
// setter plumbing.  Foundation for the per-mode extractions in
// R40d / R40d.1 / R40e.
import { resetPaintStroke } from './ui/map-editor/paint-state.js'

// Clipboard subsystem (terrain drag-clipboard + system Ctrl+C/V/X)
// — moved to /ui/map-editor/clipboard.js.  Same call sites as
// before; the implementations are now in the map-editor tree.
import {
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
import { resetGL } from './ui/map-editor/canvas/webgl.js'

// Pure rotation + flip helpers shared by the 2D draw path, the GL
// renderer, and the stamp pipeline live in /ui/map-editor/rotation.js;
// studio.js no longer imports them directly (the placementAnchor
// consumer moved to /ui/map-editor/wire-toolbar.js).

// Persisted UI prefs — drawer filters, view-menu toggles, inspector
// panel visibility, the Settings dialog's tunables.  Moved to
// /ui/common/prefs.js so every view (map editor, unit editor,
// sandbox) reads + writes its own subset through the same API.
import {
  loadPersistedPrefs,
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
  applyPanelLayout,
} from './ui/common/panel-layout.js'

// confirmDialog — imperative wrapper around the React confirm modal.
// Delegates to reactUi.confirmDialog when the bridge has loaded,
// falls back to native window.confirm before then.  Lives in
// /ui/dialogs/ alongside the React component.
import { confirmDialog } from './ui/dialogs/confirm.js'

// Help dialog — imperative show / hide pair.  The tab strip + Close
// button wiring stays with the other dialog-button wiring in
// wireDeveloperDialog below.
import { openHelpDialog, closeHelpDialog } from './ui/dialogs/help.js'

// Unsaved-changes Save / Discard / Cancel prompt — awaited from
// closeTab when a dirty map is being closed.
import { unsavedChangesDialog } from './ui/dialogs/unsaved-changes.js'

// Mouse → grid coordinate converters used by the per-mode mouse
// handlers below.  pickCell → tile grid; pickAttrCellForVoid →
// attribute grid; pickFeatureAttrCell → feature-anchor-aware
// attribute grid.  findFeatureAt / findStartPositionAt hit-test
// the cursor against placed features + the active schema's start
// markers respectively.
// pickCell + pickFeatureAttrCell moved out of studio.js with the
// extracted mode handlers + editor-view (R40* / R41b).

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
} from './ui/pickers/open-map.js'

// ?initial_map=<name> URL shortcut — polls the catalogue then
// routes through the same openLoadedMap host callback as the
// picker.  Called from the boot block.
import { maybeAutoOpenFromQuery } from './ui/pickers/auto-open.js'

// Model catalogue — shared cache + fetcher for /api/studio/models.
// openModelPicker (now in open-unit-flow.js) drains via fetchModels
// then reads the React dialog's items from availableModels();
// openModelViewer below looks up the picked unit's meta through
// findModelMeta.
import { findModelMeta } from './ui/pickers/model-catalog.js'

// Open Unit dialog flow controller — opens the React picker (after
// awaiting the catalogue + UI island) and routes the user's pick
// either into the SandboxView's spawn placement loop or into a
// fresh model tab via the openModelViewer host callback registered
// below.  closeModelPicker restores whichever editor surface owned
// the screen before the dialog opened (read through getActiveTab).
import { openModelPicker } from './ui/pickers/open-unit-flow.js'

// Sandbox tab lifecycle — welcome-card entry point, activation path
// (canvas swap, renderer start/stop, panel show, ribbon wiring), the
// legacy shared-canvas accessor + the live SandboxView reference.
// The per-tab activator + the spawn-picker / panel / ribbon /
// controls-intercept helpers it depends on all live under
// /ui/sandbox/.
import {
  openSandboxStub,
  sharedModelViewerCanvas,
  getActiveSandboxView,
} from './ui/sandbox/tab.js'

// Tab registrar (Phase A).  Each section ships a register-tab.js
// that installs its TabType descriptor; studio.js dispatches focus
// + close through the registry instead of branching by type.  The
// host imports the registration functions here so the registrar is
// populated synchronously during boot, BEFORE any tab is opened.
import { registerMapTabType } from './ui/map-editor/register-tab.js'
import { registerUnitEditorTabType } from './ui/unit-editor/register-tab.js'
import { registerSandboxTabType } from './ui/sandbox/register-tab.js'
import { createTab, getTabType } from './ui/tab-registry.js'

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

// Camera & Cursor panel — visibility toggle + the two publish-to-
// React-store helpers that feed it.  Visibility flag persists via
// prefs alongside the other View toggles.
import {
  setCameraInfoVisible,
} from './ui/map-editor/camera-info.js'

// Dice-face player-count picker for the New-map size dialog.
// Owns its own dicePicked Set; pickedPlayerCounts() reads it at
// startEditor() time to seed N-player schemas.
import {
  pickedPlayerCounts,
  populateWorldSelect,
  renderDiceGrid,
} from './ui/map-editor/dialogs/dice-picker.js'

// Save-payload builder.  Pure snapshot of the current map state
// in the shape /api/studio/save / /api/studio/export-* /
// /api/studio/quality-check all accept.  Used by save / saveLoose
// (still in studio.js) AND by every backend-rendered export.
import { buildSavePayload } from './ui/map-editor/save-payload.js'

// PNG export + heightmap import handlers.  exportHeightmap and
// exportMinimap render client-side from state; the *FullRender /
// MapImage / Buildmap / Voidmap variants POST the save payload to
// the matching /api/studio/export-* endpoint.
import {
  exportHeightmap,
  exportMinimap,
  exportFullRender,
  exportMapImage,
  exportBuildmap,
  exportVoidmap,
} from './ui/map-editor/exports.js'

// Symmetry helpers live in /ui/map-editor/symmetry.js; studio.js no
// longer imports them directly — placeFeature (the last consumer) is
// now in /ui/map-editor/wire-toolbar.js.  The DOM wiring
// (wireSymmetryGroup) moved to /ui/map-editor/ribbon/legacy-popups.js.

// Legacy (pre-React) ribbon popup chrome — closeAllRibbonDropdowns +
// positionRibbonPopup are reached from the local wireSchemaSelector
// below.  The rest of the legacy-popup helpers (wireSymmetry/Brush/
// Voids/Heightmap, wireHistoryFlyout) are consumed by
// /ui/map-editor/wire-toolbar.js directly.
import {
  closeAllRibbonDropdowns,
  positionRibbonPopup,
} from './ui/map-editor/ribbon/legacy-popups.js'

// Mode dispatch + the cluster of helpers that change with the active
// mode (placement hint, terrain clipboard cleanup, the Q/E rotate
// dispatch, the F/G flip dispatch, the Ctrl/Cmd-A select-all,
// handleDeleteKey resolution).  Studio.js still calls these
// directly from the drawer-pill click, selectSection / selectFeature,
// beginSectionDrag / beginFeatureDrag, and the canvas drag-drop
// fallback — and registers the host-side bridge entries so other
// modules reach setMode / cancelPlacement / hide+showPlacementHint /
// clearStampSelection through hostCallbacks.
import {
  setMode,
  cancelPlacement,
  showPlacementHint,
  hidePlacementHint,
  clearStampSelection,
} from './ui/map-editor/mode.js'

// Global keyboard handler — Esc dialog dismiss, mode hotkeys, undo /
// redo + clipboard, zoom + pan + arrow-key scroll, delete dispatch.
// Called from finishEditorBoot the first time the editor surface
// boots.
import { wireKeyboard } from './ui/map-editor/keyboard.js'

// Scatter dialog — drops N features into the map honouring a
// minimum spacing halo.  Self-contained subsystem; the React
// dialog chrome is mounted separately.
import {
  openScatterDialog,
} from './ui/map-editor/dialogs/scatter.js'

// Map Properties (.ota) dialog — mission name, planet, wind, tidal,
// gravity, sea level, lava-world flags.  Apply commits a single
// undo transaction and mirrors mission name + planet onto state.
import {
  openOTADialog,
} from './ui/map-editor/dialogs/ota.js'

// Per-schema editor — opened by the gear icon on each schema row in
// the schema dropdown.  Edits the matching state.ota.schemas[i] in
// a single undo transaction.
import {
  openSchemaEditor,
} from './ui/map-editor/dialogs/schema-editor.js'

// Resize-map dialog — anchor-grid + Crop-to-content path.  Rebuilds
// tiles / heights / voids / features at the new size and tears out
// the canvas DOM so no stale GL buffers survive.
import {
  openResizeDialog,
} from './ui/map-editor/dialogs/resize.js'

// Pre-save Quality Checker dialog — POSTs the payload to
// /api/studio/quality-check, paces the per-check reveal, resolves
// with either an array of fix ids or null on cancel.
import { runQualityChecker } from './ui/map-editor/dialogs/quality-checker.js'

// Save handlers — packaged HPI download (save) or raw .tnt + .ota
// loose-file downloads (saveLoose).  Both gate behind the Quality
// Checker and flip the active map's dirty flag on success.
import { save, saveLoose } from './ui/map-editor/save.js'

// Content-version-keyed caches over state.features — feature
// spatial bucket (featuresNear) + name index (getFeaturesByName).
// Both invalidate together when bumpContentVersion ticks.
import {
  bumpContentVersion,
} from './ui/map-editor/content-cache.js'

// Zoom + scroll-pan controls.  setZoom / zoomAtPointer / fitZoom
// drive the user-facing zoom; applyOverscrollPadding keeps
// .canvas-stack the right size; overscrollPadding is the live
// padding object readers (visible-bounds, minimap, mouse) reach
// for; startMapPan / stopMapPan / stopAllMapPan drive the
// continuous arrow-key scroll loop.
import {
  setZoom,
  fitZoom,
  overscrollPadding,
} from './ui/map-editor/zoom-pan.js'

// Visible-area helpers (visibleTileBounds, visiblePixelBounds)
// live in /ui/map-editor/viewport.js; only render.js consumes
// them now so studio.js doesn't import them directly.

// Developer stats panel + Advanced ▸ Developer dialog.  Per-frame
// scheduleDevStatsRefresh is consumed by render.js; only the
// developer-panel wiring + the dialog open/close stay in
// studio.js for the ribbon + menu hooks.
import {
  wireDeveloperPanel,
  openDeveloperDialog,
  closeDeveloperDialog,
} from './ui/map-editor/dev-stats.js'

// Minimap pipeline — cached one-pixel-per-tile base canvas +
// hover-feature dots + start-position markers + viewport rect.
// invalidateMinimapBase / patchMinimapTile let tile edits update
// the base without forcing a full rebuild.
import {
  renderMinimap,
  invalidateMinimapBase,
  wireMinimap,
  getMinimapBaseSnapshot,
  setMinimapBaseSnapshot,
} from './ui/map-editor/minimap.js'

// rAF-batched re-render queues for the main map canvas + minimap.
// Both schedulers dedupe within a single animation frame so a
// burst of scroll events doesn't fan out into dozens of renders.
import {
  scheduleRenderCanvas,
  scheduleMinimapRender,
} from './ui/map-editor/render-queue.js'

// Feature sprite cache + world-anchor projection helpers.
// whenImageReady dedupes load listeners; preloadFeatureImage
// stages the static-frame PNG; featureAnchorOffset /
// featureAnchorWorld convert TA's top-left attribute cell into the
// rendered world-pixel anchor.
import {
  whenImageReady,
  preloadFeatureImage,
  featureAnchorOffset,
  featureAnchorWorld,
} from './ui/map-editor/feature-assets.js'

// Heightmap drawing passes — Heightmap view's grayscale, the
// Section placement preview — tryAutoRotatePlacement is called
// from the mouse-move handlers so the auto-rotation kicks in as
// the preview follows the cursor.  The render passes themselves
// (drawPlacementPreview / hideRotationBadge / drawHeightmap /
// drawGridlines / drawVoidOverlay / drawBuildableOverlay /
// drawSelectedFeatureOutline / drawHighlightedFeatureOutlines /
// drawEraseBrush / drawHeightmapBrush / drawStartPositions /
// drawRulerOverlay / drawTiles / drawFeatures / drawDropPreview /
// drawFeatureDragPreview / drawTerrainOverlays /
// updateFeatureInfoPanel) are now called from renderCanvas in
// /ui/map-editor/canvas/render.js — studio.js doesn't import them
// directly any more.  tryAutoRotatePlacement moved with selectSection
// / ensureSectionAssets into /ui/map-editor/drawer-actions.js.

// Per-mode handler modules — the canvas mouse-router (imported
// further below) owns the actual mousedown/move/up dispatch.
// Studio.js only pulls in the cleanup hooks the abort path needs
// (each mode's reset for in-flight drag state) + the auto-switch
// seeders that tryAutoSwitchAt below pokes when a click in one
// mode lands on a different mode's pickable.
import { resetPickerDrag } from './ui/map-editor/modes/picker.js'
import { resetStartPosDrag } from './ui/map-editor/modes/start-points.js'
import { resetTerrainDrag } from './ui/map-editor/modes/terrain-select.js'
import { resetFeatureDrag } from './ui/map-editor/modes/feature-select.js'
import { resetHmHoldTimer } from './ui/map-editor/modes/heightmap.js'

// Paint mode — handlePaint is still consumed by the drawer's
// drag-drop fallback below.  resetPaintPlacement clears the
// in-flight anchored-preview drag from abortTransientGestureState
// (R40d).
import { resetPaintPlacement } from './ui/map-editor/modes/paint.js'

// Mouse router moved entirely into editor-view.js's listener
// bindings (R41b); studio.js no longer imports the three
// dispatchers directly.

// Pan + cursor helpers — pan state, space-pan hotkey, shouldPan
// heuristic, tryAutoSwitchAt auto-mode-swap, updateHoverLabel
// (status-bar live cursor read-out).  The mouse router and the
// keyboard handlers both consume these; the module owns the pan
// state and space-hotkey flag privately so studio.js no longer
// holds module-level mutable copies (R40g).
import {
  shouldPan, beginPan, updatePan, endPan, isPanning, cancelPan,
  updateHoverLabel, tryAutoSwitchAt,
} from './ui/map-editor/cursor.js'

// Drawer (left sidebar) — renders the Sections + Features panels
// with virtualised collapsible groups.  Studio.js owns selection
// + drag + active-world side effects; the module reaches those
// through hostCallbacks (R41a).
import { renderDrawer } from './ui/map-editor/drawer.js'

// Drawer interaction helpers — drag-from-row, click-to-select, the
// world picker pill, plus the viewport-centre + section asset
// preload helpers the section selection path needs.  The drawer
// module reaches these through hostCallbacks; studio.js still
// registers the bridge entries below so the seam keeps working.
import {
  beginSectionDrag,
  beginFeatureDrag,
  pageSectionSibling,
  selectSection,
  selectFeature,
  viewportCellCenter,
  setActiveWorld,
} from './ui/map-editor/drawer-actions.js'

// Legacy DOM toolbar wirers + the small cluster of helpers that ride
// alongside them (drawer tab switcher, placement anchor, feature
// placement, active-schema lookup).  All five `wire*` functions are
// called from finishEditorBoot; the helpers are routed back through
// hostCallbacks so other modules reach them through the same seam
// they used pre-extraction.
import {
  wireToolbar,
  wireZoomButtons,
  wireTabs,
  wireModeToolbar,
  wireViewMenu,
  switchTab,
  placementAnchor,
  placeFeature,
  activeSchema,
} from './ui/map-editor/wire-toolbar.js'

// EditorView lifecycle — the two stacked <canvas> elements, every
// mouse / wheel / drag listener bound to them, and the
// ResizeObserver that keeps overscroll padding in sync.
// recreateEditorView() is called on every map open / new + resize
// commit; the module owns the singleton + the AbortController-based
// listener teardown.  prepareCanvasDimensions + centerViewOnMap
// ride alongside because finishEditorBoot needs them before the
// first paint (R41b).
import {
  recreateEditorView,
  prepareCanvasDimensions,
  centerViewOnMap,
  destroyEditorView,
} from './ui/map-editor/editor-view.js'

// renderCanvas — the per-frame orchestrator that paints every
// layer of the map editor canvas.  All sub-passes live in their
// own modules at this point; the orchestrator is just call sites.
import { renderCanvas } from './ui/map-editor/canvas/render.js'

// Settings dialog (imperative open/close + DEFAULT_SETTINGS) —
// the React chrome itself lives at
// /ui/dialogs/settings-dialog.js; this is the host-side bridge
// that snapshots state into the form and flushes Apply through
// to the relevant subsystems.
import {
  openSettingsDialog,
} from './ui/dialogs/settings.js'

// Per-tab unit-editor lifecycle — activateModelTab lives in
// /ui/unit-editor/tab.js and is called by the unit-editor tab
// descriptor's activate() (registered through tab-registry).
// Studio.js doesn't call it directly anymore.

// Floating inspector chrome (drag/collapse/close/clamp + visibility
// persistence) for the unit-editor's Scripts/Actions/Ports/StaticVars/
// Camera/Effects/Audio overlays.  The per-panel data-refresh logic
// (refreshMvInspectors etc.) still lives in this file — moves out in
// a follow-up round once the debugger code it shares state with
// (R43c–e) has also been pulled.
import {
  wireMvInspectors,
  setMvInspectorVisible,
} from './ui/common/inspectors.js'

// Thread-debugger modal lifecycle + chrome.  The asm renderer +
// bracket overlay + per-tick PC highlight still live in this file
// (R43e); the modal reaches them through host-callback seams below.
import {
  openMvThreadCodeModal,
  closeAllMvThreadCodePanels,
} from './ui/unit-editor/debugger/modal.js'

// Per-unit boot helpers — Studio Options defaults push, ground/
// submersion mode setter, FBI metadata fetch, and the 5-second
// auto-build ramp.  All five are reached from studio.js + the
// activateModelTab onModelLoaded closure through hostCallbacks
// already; this import lets the boot wiring point to the
// imported functions instead of stale forward references.
import {
  applyUnitEditorDefaults,
  applyDefaultGroundFor,
  mvFetchUnitMeta,
  startMvAutoBuild,
  advanceMvAutoBuild,
} from './ui/unit-editor/runtime.js'

// Sim-clock controls — _activeRuntime dispatch, sim-speed slider,
// Pause toggle + caption sync, background-tab auto-pause, and the
// `window.*` hotkey aliases.  React-bridge host-bridge entries
// (setSimSpeed / toggleRuntimePaused / stepRuntime) all forward
// into these.
import {
  _activeRuntime,
  mvSetSimulationSpeed,
  mvToggleRuntimePaused,
  mvRefreshRuntimeToggle,
  wireMvRuntimeVisibility,
  _wireRuntimeHelpersToWindow,
} from './ui/common/sim-controls.js'

// Per-tick inspector publish + debugger repaint.  Called from each
// view's renderer.onAfterFrame hook (both ModelViewer and SandboxView)
// to publish the active inspector mv proxy + iterate every open
// debugger panel.  Throttled to 4 Hz internally.
import { refreshMvInspectors } from './ui/common/refresh-tick.js'

// COB-state-to-React sync cluster.  These all push live cob /
// runtime / lifecycle state into the React COB-dropdown ribbon +
// Script Commands panel signals so the UI tracks thread starts /
// deaths and lifecycle transitions.  External callers (refresh
// tick, runtime.js, tab.js) still route through `hostCallbacks` —
// the registrations below preserve that surface.
import {
  mvSyncCobAttrSlidersFromPorts,
  syncMvActionsRunning,
  syncCobRibbonRunning,
  refreshCobPanel,
  isCobScriptRunning,
  runCobEntry,
} from './ui/unit-editor/cob-sync.js'

// Unit-editor sidebar — the React-managed Pieces / Textures / Weapons
// tab bridges + the host-side helpers (selectPiece, filterPieceTree,
// playWeaponSound) the legacy DOM still triggers.  Weapon picker +
// catalogue cache live here too since they're scoped to the unit
// editor's sidebar.
import {
  renderPieceTree,
  renderTexturesTab,
  wireMvSidebarTabs,
  playWeaponSound,
  openWeaponPicker,
  selectPiece,
  filterPieceTree,
} from './ui/unit-editor/sidebar.js'

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
  hostCallbacks.wireSchemaSelector = wireSchemaSelector
  hostCallbacks.publishMapRibbonState = publishMapRibbonState
  hostCallbacks.publishMapSidebarState = publishMapSidebarState
  hostCallbacks.startNewMapFromEditor = () => startNewMapFromEditor()
  hostCallbacks.openExistingMapFromEditor = () => openExistingMapFromEditor()
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
  hostCallbacks.getActiveTab = () => (tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null)
  // getTabs / openTab — seams the extracted section modules use to
  // (1) walk every other tab during activation to stop renderers,
  // and (2) push a fresh tab through the registry.  openTab is the
  // ONLY public path to add a tab — it consults the registry,
  // builds the instance, attaches it to the host record, then
  // switches focus.  Legacy `pushTab` (which took a pre-built
  // record) is gone; every opener must go through here.
  hostCallbacks.getTabs = () => tabs
  hostCallbacks.openTab = (typeId, spec = {}) => openTab(typeId, spec)
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
  // Drawer tab switcher — mode.js' syncDrawerToMode reaches it
  // through hostCallbacks so the drawer flips to Sections when the
  // user picks Paint, or Features when they pick Place Features.
  hostCallbacks.switchDrawerTab = (tab) => switchTab(tab)
  // pageSectionSibling lives studio-side because it depends on
  // selectSection — keyboard.js' ArrowLeft / ArrowRight branch calls
  // it through hostCallbacks so the section-drawer paging hotkey
  // works without dragging selectSection into the extract.
  hostCallbacks.pageSectionSibling = pageSectionSibling
  // Unit-editor seams — /ui/unit-editor/tab.js calls these to flip
  // the host-owned modelViewerInstance / _mvControls aliases when
  // activating a tab.
  hostCallbacks.getActiveModelViewer = () => modelViewerInstance
  hostCallbacks.setActiveModelViewer = (v) => {
    modelViewerInstance = v
    window.__modelViewer = v
  }
  hostCallbacks.setActiveMvControls = (c) => { _mvControls = c }
  hostCallbacks.getActiveMvControls = () => _mvControls
  hostCallbacks.advanceMvAutoBuild = advanceMvAutoBuild
  hostCallbacks.refreshMvInspectors = refreshMvInspectors
  hostCallbacks.renderPieceTree = renderPieceTree
  hostCallbacks.renderTexturesTab = renderTexturesTab
  hostCallbacks.wireMvSidebarTabs = wireMvSidebarTabs
  hostCallbacks.refreshCobPanel = refreshCobPanel
  hostCallbacks.resumeIncomingTabRuntime = resumeIncomingTabRuntime
  hostCallbacks.mvFetchUnitMeta = mvFetchUnitMeta
  hostCallbacks.applyDefaultGroundFor = applyDefaultGroundFor
  hostCallbacks.applyUnitEditorDefaults = applyUnitEditorDefaults
  // Auto-build ramp in runtime.js reaches this slider sync helper
  // through hostCallbacks so it doesn't have to import studio.js.
  hostCallbacks.mvSyncCobAttrSlidersFromPorts = mvSyncCobAttrSlidersFromPorts
  // Per-tick refresh in refresh-tick.js pings these two studio-side
  // helpers each publish (lifecycle promote + COB-ribbon push).
  hostCallbacks.syncMvActionsRunning = syncMvActionsRunning
  hostCallbacks.syncCobRibbonRunning = syncCobRibbonRunning
  hostCallbacks.getUnitEditorAutoRotate = () => _unitEditorAutoRotate
  hostCallbacks.sharedModelViewerCanvas = sharedModelViewerCanvas
  // ── Tab registrar seams (Phase A).  Map descriptor reads these
  // from its activate / deactivate / canClose hooks.  Other tab
  // types route through `getActiveModelViewer` + the per-tab
  // viewer's own dispose() instead.
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
  // /ui/map-editor/.  When a settings-section registrar lands these
  // move into the map editor's register-section call.
  hostCallbacks.getWorldOptions = () => WORLDS.map((w) => ({ key: w.slug, label: w.label }))
  hostCallbacks.setMinimapVisible = (v) => setMinimapVisible(!!v)
  // Register every tab type with the central registry.  Order
  // doesn't matter — the registry is data-only — but doing it after
  // the hostCallbacks block guarantees descriptor activate() hooks
  // see a populated host surface on the very first activation.
  registerMapTabType()
  registerUnitEditorTabType()
  registerSandboxTabType()
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

// openTab — single entry point for adding a tab to the host.  Each
// opener (openLoadedMap, openModelViewer, openSandboxStub,
// startEditor) builds its type-specific spec and routes here.
// The function:
//   1. Builds the registry instance via createTab(typeId, spec).
//   2. Pushes the host record (which carries the descriptor + spec +
//      instance) into tabs[].
//   3. Calls instance.attachTabRef so the descriptor can mirror
//      legacy fields onto the host record for back-compat.
//   4. Switches focus to the new tab (unless opts.defer is true,
//      in which case the caller is responsible for the switch —
//      used by openers that need to populate the spec further
//      before the first activation).
// Returns the freshly-attached host record.
function openTab(typeId, spec = {}, opts = {}) {
  const record = createTab(typeId, spec)
  tabs.push(record)
  if (typeof record.instance.attachTabRef === 'function') {
    record.instance.attachTabRef(record)
  }
  tabState.activeIndex = tabs.length - 1
  if (!opts.defer) void switchToTab(tabState.activeIndex, { fresh: true, force: true })
  return record
}

// _ensureTabInstance backfills the registry-managed
// `tab.typeId` + `tab.descriptor` + `tab.instance` fields onto tab
// records the legacy openers push with the old shape.  After every
// opener routes through openTab() this shim should be dead — keep
// it defensive in case any external path still pushes legacy
// records into tabs[].
function _ensureTabInstance(tab) {
  if (!tab) return
  if (tab.instance) return
  // Map legacy discriminator -> typeId.  'model' tabs split into
  // 'sandbox' or 'unit-editor' based on the sandbox flag.
  let typeId = tab.typeId
  if (!typeId) {
    if (tab.type === 'model') typeId = tab.sandbox ? 'sandbox' : 'unit-editor'
    else if (tab.type === 'map') typeId = 'map'
  }
  if (!typeId) return
  const desc = getTabType(typeId)
  if (!desc) return
  // Build the descriptor's spec from whatever legacy fields the
  // opener stashed onto the tab record.  This is the only place
  // legacy-field reads survive in the new dispatch — once openers
  // migrate, spec is what they pass to createTab.
  let spec
  if (typeId === 'map') {
    spec = { map: tab.map }
  } else if (typeId === 'unit-editor') {
    spec = { name: tab.name, meta: tab.meta, displayName: tab.displayName }
  } else if (typeId === 'sandbox') {
    spec = { displayName: tab.displayName || tab.name || 'Sandbox' }
  } else {
    spec = {}
  }
  const instance = desc.create(spec)
  if (typeof instance.attachTabRef === 'function') instance.attachTabRef(tab)
  tab.typeId = typeId
  tab.descriptor = desc
  tab.instance = instance
}

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
  const snap = getMinimapBaseSnapshot()
  m.minimapBase = snap.canvas
  m.minimapBaseStale = snap.stale
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
  setMinimapBaseSnapshot({ canvas: m.minimapBase, stale: m.minimapBaseStale })
  // Scroll restored AFTER the new canvases are sized — see switchToTab.
}

function abortTransientGestureState() {
  cancelPan()
  resetPaintStroke()
  resetHmHoldTimer()
  resetPaintPlacement()
  resetTerrainDrag()
  resetFeatureDrag()
  resetStartPosDrag()
  resetPickerDrag()
}

// unsavedChangesDialog moved to /ui/dialogs/unsaved-changes.js.

// closeTab routes through the tab registry.  Each tab type's
// instance owns its canClose (dirty prompt) and dispose semantics —
// the host's only responsibilities are bringing focus to the
// closing tab BEFORE the prompt (so the user sees what they're
// about to discard), and re-activating the next tab in line once
// the splice is done.
async function closeTab(idx) {
  if (idx < 0 || idx >= tabs.length) return
  const tab = tabs[idx]
  _ensureTabInstance(tab)
  // Bring focus to the closing tab first so the dirty-confirm modal
  // shows the right canvas behind it AND the save() inside
  // canClose() operates on the right active state.
  if (idx !== tabState.activeIndex) {
    await switchToTab(idx, { force: true })
  }
  const ok = await tab.instance.canClose({})
  if (!ok) return
  // Deactivate before dispose so the per-tab renderer / runtime
  // releases its hold cleanly before dispose tears down GPU buffers.
  if (idx === tabState.activeIndex) tab.instance.deactivate({})
  tab.instance.dispose({})
  tabs.splice(idx, 1)
  if (tabs.length === 0) {
    tabState.activeIndex = -1
    $('#model-viewer-dialog')?.classList.add('hidden')
    showWelcomeAfterLastTabClose()
    return
  }
  // Pick the previous tab if we closed the active one; otherwise
  // stay on the same active tab (its index shifts left when the
  // closed one was to its left).
  if (idx < tabState.activeIndex) tabState.activeIndex -= 1
  if (tabState.activeIndex >= tabs.length) tabState.activeIndex = tabs.length - 1
  if (tabState.activeIndex < 0) tabState.activeIndex = 0
  await switchToTab(tabState.activeIndex, { fresh: false, force: true })
}

function showWelcomeAfterLastTabClose() {
  // Hide the editor surface and bring back the welcome modal.
  $('#app')?.classList.add('hidden')
  const wel = $('#welcome-dialog')
  if (wel) wel.classList.remove('hidden')
  destroyEditorView()
  renderMapTabs()
}

// switchToTab routes focus through the tab registry.  The dispatcher
// is type-agnostic — every per-type decision (DOM toggles, renderer
// start/stop, audio silence, panel show/hide, module-let snapshot /
// restore) lives in the tab descriptor's activate / deactivate.
//
// Lifecycle guarantee: when this returns, exactly one tab's
// instance.activate has been called and every other tab's
// instance.deactivate is in a quiescent state.  Deactivate is
// idempotent + cheap so the framework can call it across every
// non-active tab on each swap to enforce that invariant.
async function switchToTab(nextIdx, { fresh = false, force = false } = {}) {
  if (nextIdx < 0 || nextIdx >= tabs.length) return
  if (!force && nextIdx === tabState.activeIndex) return
  const outgoing = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  const incoming = tabs[nextIdx]
  _ensureTabInstance(incoming)

  // Close every open thread-debugger panel — they point at the
  // outgoing tab's COB binding, which is either about to be
  // replaced (switching between models) or hidden behind the map
  // editor (switching to a map tab).  Reopening from the Threads
  // inspector is one click.
  closeAllMvThreadCodePanels()

  const ctx = {
    fromTypeId: outgoing?.typeId || null,
    toTypeId: incoming?.typeId || null,
    isFresh: !!fresh,
  }

  // Deactivate EVERY non-incoming tab so the framework can
  // guarantee only the incoming holds the canvas / audio / RAF
  // loop on the way out.  Deactivate is idempotent.
  for (const t of tabs) {
    if (t === incoming) continue
    _ensureTabInstance(t)
    try { t.instance.deactivate(ctx) } catch { /* ignore */ }
  }

  abortTransientGestureState()
  tabState.activeIndex = nextIdx
  renderMapTabs()

  // Per-descriptor activation does its own DOM + renderer + audio
  // wiring.  Errors here are intentionally allowed to surface so a
  // broken tab doesn't silently fail to mount.
  await incoming.instance.activate(ctx)
}

// pauseOutgoingTabRuntime — replaced by each tab descriptor's
// deactivate() (Phase A).  Studio.js's switchToTab no longer
// branches by type; the framework calls instance.deactivate() on
// every non-incoming tab on every swap, and each instance owns the
// pause / silence / renderer-stop sequence.

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
  // Push the new map tab through the registry but DEFER activation —
  // the load code below mutates `state` (the active MapDoc proxy)
  // to hydrate the tile / heights / features arrays.  Activating
  // now would mount the editor against an empty MapDoc and force a
  // second renderCanvas pass once the hydration completes.  We
  // explicitly switchToTab once the MapDoc is fully populated +
  // finishEditorBoot has wired the canvas.
  openTab('map', { map: new MapDoc() }, { defer: true })
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
  // Push a fresh map tab through the registry with deferred
  // activation — the hydration below mutates `state` to set up the
  // new MapDoc's dimensions / planet / schemas, and the
  // finishEditorBoot call further down owns the visual mount.
  openTab('map', { map: new MapDoc() }, { defer: true })
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


// ── Sidebar drawer ─────────────────────────────────────────────────────────

// wireTabs / wireModeToolbar / wireViewMenu / switchTab moved to
// /ui/map-editor/wire-toolbar.js (Phase 4) — imported at the top of
// this file.  setMode / modeHint / syncDrawerToMode live in
// /ui/map-editor/mode.js.  wireKeyboard / handleDeleteKey /
// rotateActive / flipActive live in /ui/map-editor/keyboard.js +
// /ui/map-editor/mode.js.  isWreckageFeature lives in
// /ui/map-editor/helpers.js.

// loadSections / loadFeatures fetch the per-tileset catalog of
// stampable sections + the master feature list, then re-render the
// drawer if it's currently showing that side.  loadFeatures also
// awaits the GAF hotspot fetch so the very first render shows the
// correct sub-tile origins instead of the bottom-centred fallback.

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

// featureUsage + the full drawer rendering pipeline (renderDrawer,
// renderSectionsDrawer, renderFeaturesDrawer, virtualisedDrawerBody,
// the world/group sort + collapsible chrome, the item factories, +
// the per-render IntersectionObserver) all moved to
// /ui/map-editor/drawer.js (R41a).  setActiveWorld + selectSection +
// selectFeature + beginSectionDrag + beginFeatureDrag (drag-from-
// row + click-to-select + the world picker + the viewport-centre /
// asset-preload helpers they depend on) moved to
// /ui/map-editor/drawer-actions.js — imported at the top of this
// file.  The hostCallbacks registrations below still point at those
// names so the drawer module reaches them through the bridge.

// whenImageReady + preloadFeatureImage moved to
// /ui/map-editor/feature-assets.js — imported at the top of this
// file.

// ── Canvas ─────────────────────────────────────────────────────────────────

// Tracks the cell under the cursor for hotkey actions that don't
// fire from a mouse event (notably Ctrl+V paste, which wants to
// drop the pasted rectangle at the user's last hover point).  The
// authoritative store is hostCallbacks.cursor.lastHover so the
// extracted clipboard module can read it without an import cycle;
// this file just writes to it from the mouse-move/leave handlers.
// paintState (paint+erase+heightmap stroke flags) lives in
// /ui/map-editor/paint-state.js — imported at the top of this
// file so the extracted mode modules can share the same object
// (R40d.0).

// panState + spacePanHotkey moved to /ui/map-editor/cursor.js
// (R40g).  Accessors (isPanning / getSpacePanHotkey /
// setSpacePanHotkey) are imported above.

// Undo / redo + transaction wrapper now live in
// ./ui/map-editor/undo.js — imports at the top of this file pull
// `undoStack`, `redoStack`, `begin/commit/abortTransaction`, `undo`,
// `redo`, `updateUndoButtons`, `refreshHistoryFlyouts`, plus
// `captureSnapshot` / `restoreSnapshot` / `cloneOTA` (re-exported
// for callers that snapshot OTA into a tab swap).


// wireZoomButtons moved to /ui/map-editor/wire-toolbar.js (Phase 4).

// pickCell + pickFeatureAttrCell + pickAttrCellForVoid moved to
// /ui/map-editor/mouse-coords.js — imported at the top of this
// file.

// updateHoverLabel + setCanvasHoverFeature moved to
// /ui/map-editor/cursor.js (R40g).

// ── Mouse routing ──────────────────────────────────────────────────────────
// onCanvasMouseDown / Move / Up moved to
// /ui/map-editor/mouse-router.js (R40f).  The dispatcher consults
// a Map<mode, { down, move, up }> and the pan / hover / cursor
// bookkeeping is folded in there; studio.js exposes shouldPan +
// beginPan + endPan + isPanning + updateHoverLabel through
// hostCallbacks so the router can short-circuit before the
// per-mode dispatch.

// shouldPan inspects the mousedown event and current editor state to
// decide whether this drag should pan the view instead of running the
// active tool.  Triggers:
//   - middle-click (button 1)
//   - left-click with the Space hotkey held
//   - left-click in Paint mode with no active selection or placement
//   - left-click in Select Features mode over empty space
// selectAllContent moved to /ui/map-editor/mode.js — imported at the
// top of this file.

// tryAutoSwitchAt + shouldPan + beginPan + updatePan + endPan moved
// to /ui/map-editor/cursor.js (R40g) — imported at the top of
// this file.

// placementAnchor moved to /ui/map-editor/wire-toolbar.js (Phase 4) —
// imported at the top of this file and re-registered on hostCallbacks
// in the boot block so the drag-drop + paste paths still resolve.

// updatePlacementHover, handlePaintModeClick, commitAnchoredPlacement,
// stampSectionWithRotation + copyTileHeights moved to
// /ui/map-editor/modes/paint.js (R40d) — imported at the top of
// this file.  placementAnchor (just below) is exposed to that
// module through hostCallbacks because the drag-drop + paste
// paths in this file consume the same helper from different call
// sites.

// ── Select Terrain mode ────────────────────────────────────────────────────
// onTerrainMouseDown / Move / Up + the in-flight drag/move state
// moved to /ui/map-editor/modes/terrain-select.js (R40b).  Imported
// at the top of this file.

// Terrain clipboard (capture / rotate / drop / cancel) and system
// clipboard (Ctrl+C / Ctrl+V / Ctrl+X) + the region-clear helpers
// (clearRegion, clearAllFeatures, clearFeaturesInSelection) now
// live in ./ui/map-editor/clipboard.js — imported at the top of
// this file.  Call sites in mouse routing / ribbon / keyboard
// hand-off to those functions unchanged.

// ── Select Features mode ───────────────────────────────────────────────────
// onFeatureMouseDown / Move / Up + the in-flight drag state moved
// to /ui/map-editor/modes/feature-select.js (R40c) — imported at
// the top of this file.  tryAutoSwitchAt above seeds the drag
// through beginFeatureDragFromAutoSwitch so an auto-mode-switch
// click flows into a drag without a second mousedown.

// findFeatureAt hit-tests in canvas-pixel space against the feature's
// drawn footprint, accounting for the GAF hotspot offset so the
// hit-box matches the sprite as drawn (not bottom-centred).  We
// re-iterate in z-order (drawn last = on top) so the topmost feature
// wins overlaps.
// FEATURE_HIT_SEARCH_TILES lives in ./ui/map-editor/constants.js
// (how far from the click tile we scan for candidate features).

// findFeatureAt + findStartPositionAt moved to
// /ui/map-editor/mouse-coords.js.  featureRenderRect moved to
// /ui/map-editor/feature-assets.js.

// ── Start positions ────────────────────────────────────────────────────────
// Game pixel coords use 32 game-px per tile.  We convert between game
// pixels and canvas pixels via the TILE_PX scale.
// START_POS_RADIUS lives in ./ui/map-editor/constants.js.

// gameToCanvas / canvasToGame live in /ui/map-editor/helpers.js —
// imported at the top of this file.

// activeSchema moved to /ui/map-editor/wire-toolbar.js (Phase 4) —
// imported at the top of this file.  The hostCallbacks registration
// below points at the imported function so mode.js's start-position
// delete path still resolves through the bridge.

// onStartPosMouseDown / Move / Up + the in-flight drag state moved
// to /ui/map-editor/modes/start-points.js (R40a) — imported at the
// top of this file.  tryAutoSwitchAt above seeds the drag through
// beginStartPosDragFromAutoSwitch so an auto-mode-switch click
// flows into a drag without a second mousedown.

// drawStartPositions moved to /ui/map-editor/canvas/start-positions.js.
// drawEraseBrush + drawHeightmapBrush moved to
// /ui/map-editor/canvas/brush-cursors.js.  Both imported at the top of
// this file.

// ── Picker mode ────────────────────────────────────────────────────────────
// onPickerMouseDown / Move / Up + pickerDragStart all moved to
// /ui/map-editor/modes/picker.js — imported at the top of this
// file.

// ── Voids mode ──────────────────────────────────────────────────────────
// onVoidsMouseDown / Move / Up + the paint-brush helper +
// voidsDragState all moved to /ui/map-editor/modes/voids.js —
// imported at the top of this file.
// onFillMouseDown (flood-fill + shift-click global replace) moved
// to /ui/map-editor/modes/fill.js (R40e.1) — imported at the top
// of this file.

// ── Ruler mode ─────────────────────────────────────────────────────────
//
// Click once to drop the start point, then move the cursor — the end
// point follows.  A second click locks the measurement; a third click
// starts a new one.  Esc clears.  Distances are reported in attr cells
// (16-px resolution, matching the heightmap grid) AND tiles AND map
// pixels, plus the min / max / delta heightmap value sampled along the
// line so the user can sanity-check cliffs and start-position fairness.

// onRulerMouseDown + onRulerMouseMove + rulerStats +
// drawRulerOverlay all live in /ui/map-editor/canvas/ruler.js —
// imported at the top of this file.

// onHeightmapMouseDown / Move / Up + paintHeightAt /
// paintHeightAtSingle + the hold-timer moved to
// /ui/map-editor/modes/heightmap.js (R40e) — imported at the top
// of this file.  resetHmHoldTimer is called from
// abortTransientGestureState so a stuck hold-tick doesn't survive
// a mode swap.

// handlePaint moved to /ui/map-editor/modes/paint.js (R40d) —
// imported at the top of this file.  The drag-drop fallback below
// still calls handlePaint(e) to share the stamp dispatch between
// click-driven paint strokes and drag-drop completions.

// clearStampSelection moved to /ui/map-editor/mode.js — imported at
// the top of this file.

// eraseAt + eraseAtSingle moved to /ui/map-editor/modes/erase.js
// (R40d.1) — imported at the top of this file.

// stampSection moved to /ui/map-editor/modes/paint.js (R40d) —
// the symmetry-aware per-tile section stamp now lives next to its
// only consumer (handlePaint).

// placeFeature moved to /ui/map-editor/wire-toolbar.js (Phase 4) —
// imported at the top of this file.  The hostCallbacks registration
// below points at the imported function so feature-select.js's drop
// path still resolves through the bridge.

// renderCanvas moved to /ui/map-editor/canvas/render.js —
// imported at the top of this file.

// updateFeatureInfoPanel populates the floating callout that appears
// while the user has a single feature selected.  It shows the data
// you'd want to round-trip through the TNT file — map tile, attribute
// sub-cell, world pixel, terrain height byte, footprint, category.
// Hidden on no-selection or multi-select (Picker mode).
// updateFeatureInfoPanel moved to
// /ui/map-editor/feature-info.js — imported at the top of this
// file.

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
//
// drawTiles + drawRotatedTile moved to
// /ui/map-editor/canvas/tiles.js.  visibleTileBounds /
// visiblePixelBounds live in /ui/map-editor/viewport.js.
// drawHeightmap / drawHeightContours / drawHeightmapOverlay live
// in /ui/map-editor/canvas/heightmap.js.  All imported at the top
// of this file.

// drawFeatures / drawDropPreview / drawFeatureDragPreview moved to
// /ui/map-editor/canvas/features.js — imported at the top of this
// file.  featureAnchorOffset / featureAnchorWorld /
// featureGroundHeight live in /ui/map-editor/feature-assets.js.

// drawPlacementPreview + drawPlacementEdgeHints +
// PLACEMENT_ALIGN_TOLERANCE + evaluatePlacementRingDeltas +
// countPlacementMismatches + tryAutoRotatePlacement +
// updateRotationBadge / drawRotationBadge / hideRotationBadge
// moved to /ui/map-editor/canvas/placement.js — imported at
// the top of this file.

// drawTerrainOverlays + drawTerrainClipboard +
// drawTerrainEdgeHints moved to
// /ui/map-editor/canvas/terrain.js — imported at the top of
// this file.


// drawGridlines / drawVoidOverlay / drawBuildableOverlay /
// drawVoidsDragRect (and GRIDLINE_BANDS) moved to
// /ui/map-editor/canvas/overlays.js — imported at the top of
// this file.

// drawSelectedFeatureOutline + drawHighlightedFeatureOutlines
// moved to /ui/map-editor/canvas/feature-overlays.js — imported
// at the top of this file.  FEATURE_HIGHLIGHT_LIMIT and the
// shared featureRenderRect helper live in constants.js +
// feature-assets.js respectively.

// normalizedRect lives in ./ui/map-editor/helpers.js.

// Minimap pipeline (minimapBase + sectionThumb + patchMinimapTile +
// invalidateMinimapBase + renderMinimap + drawMinimapStartPositions +
// updateMinimapViewport + wireMinimap) moved to
// /ui/map-editor/minimap.js — imported at the top of this file.

// scheduleMinimapRender / scheduleRenderCanvas moved to
// /ui/map-editor/render-queue.js — imported at the top of this file.


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

// Dev-stats helpers (computeDevStats, scheduleDevStatsRefresh,
// refreshDevStats, renderDevDiagnostics, renderDevTilesGrid,
// wireDeveloperPanel, openDeveloperDialog, closeDeveloperDialog)
// moved to /ui/map-editor/dev-stats.js — imported at the top of
// this file.

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

// openHelpDialog / closeHelpDialog moved to /ui/dialogs/help.js.

// Settings dialog (DEFAULT_SETTINGS + open/close) moved to
// /ui/dialogs/settings.js — imported at the top of this file.

// Zoom + scroll-pan controls (setZoom / applyOverscrollPadding /
// zoomAtPointer / fitZoom + the continuous-pan loop) moved to
// /ui/map-editor/zoom-pan.js — imported at the top of this file.
// overscrollPadding lives in the same module and is exported back
// for the read sites (visible-bounds, minimap, mouse routing).

// ── Toolbar ────────────────────────────────────────────────────────────────
// wireToolbar moved to /ui/map-editor/wire-toolbar.js (Phase 4) —
// imported at the top of this file.  The wirer reaches the schema-
// dropdown wiring (wireSchemaSelector / refreshSchemaSelector) and the
// File-menu New / Open handlers through hostCallbacks because those
// pieces still live in studio.js.

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

// Scatter dialog moved to /ui/map-editor/dialogs/scatter.js
// (openScatterDialog, closeScatterDialog, applyScatter).
// mulberry32 (the seeded PRNG) and isWreckageFeature live in
// /ui/map-editor/helpers.js; the new module imports both
// directly.


// PNG export handlers (heightmap / minimap / full render / map
// image / buildmap / voidmap) + the heightmap import counterpart
// moved to /ui/map-editor/exports.js.  buildSavePayload — the
// shared JSON snapshot — lives in /ui/map-editor/save-payload.js.
// Both imported at the top of this file.

// Quality Checker moved to /ui/map-editor/dialogs/quality-checker.js.
// ── Modelling tab ──────────────────────────────────────────────────────────
//
// The welcome dialog's "Modelling" tab is a thin shell over the model3d/
// module: clicking "Open a 3DO model" loads /api/studio/models, the
// browser presents a familiar list-with-filter (same shape as the map
// picker), and the chosen model opens in a full-screen WebGL viewer.

let modelViewerInstance = null
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
  // Read off the registered typeId (set by openTab / _ensureTabInstance)
  // rather than the legacy `tab.type` discriminator.  Both stay in
  // sync for now via attachTabRef; once readers migrate the legacy
  // field can drop.
  if (tab.typeId === 'unit-editor' || tab.typeId === 'sandbox') {
    titleEl.textContent = tab.instance?.displayName?.() || tab.name || ''
    const meta = tab.spec?.meta || tab.meta
    const parts = [meta?.unitTitle, meta?.side, meta?.category, meta?.description].filter(Boolean)
    metaEl.textContent = parts.join(' · ')
    if (hintsEl) hintsEl.innerHTML = MODEL_HINTS
  } else {
    const m = tab.spec?.map || tab.map
    titleEl.textContent = mapDisplayName(m)
    const parts = [
      m?.tileW && m?.tileH ? `${m.tileW}×${m.tileH}` : null,
      m?.planet || null,
    ].filter(Boolean)
    metaEl.textContent = parts.join(' · ')
    if (hintsEl) hintsEl.innerHTML = MAP_HINTS
  }
}

// activateModelTab moved to /ui/unit-editor/tab.js.  The
// per-tab ModelViewer + MvControls lifecycle, the onModelLoaded
// closure, and the canvas-stage staging all live there now.  This
// file still owns the modelViewerInstance + _mvControls module-level
// lets the rest of the studio reads from; the extracted activator
// promotes the right tab through hostCallbacks.setActive* below.



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

// MV_INSPECTOR_IDS + inspector chrome (drag/collapse/clamp/visibility)
// moved to /ui/unit-editor/inspectors.js.  Per-panel DATA refresh logic
// (refreshMvInspectors etc.) still lives in this file — it shares
// throttle state + sandbox/viewer proxying with the debugger code below
// which moves in R43c–e.



// ── Archaeology: panel renderers that moved to React ───────────────
// All of the per-panel render / wire / refresh functions that used to
// live in this section migrated to focused Preact components under
// /ui/panels/ (rounds 14–18).  External callers route through
// hostCallbacks / hostBridge / the inspector-store signals, so the
// migration was transparent from the rest of studio.js.  Mapping:
//   RuntimePanel              → /ui/panels/runtime-panel.js
//   StaticVarsPanel           → /ui/panels/static-vars-panel.js
//   EffectsPanel              → /ui/panels/effects-panel.js
//   AudioPanel                → /ui/panels/audio-panel.js
//   RendererPanel             → /ui/panels/renderer-panel.js
//   ControlsPanel             → /ui/panels/controls-panel.js
//   ScriptCommandsPanel       → /ui/panels/script-commands-panel.js
//   port-rows                 → /ui/unit-editor/panels/port-rows.js
// The thread code-view debugger ported to React in R44; the host
// bridge `openThreadCodeModal` opens a ThreadDebugger React mount
// (see /ui/unit-editor/debugger/thread-debugger.js).


// COB-state-to-React sync helpers (mvSyncCobAttrSlidersFromPorts,
// syncMvActionsRunning, syncCobRibbonRunning, _collectRunningCobScripts,
// refreshCobPanel, isCobScriptRunning) moved to
// /ui/unit-editor/cob-sync.js (see archaeology block above).
// Particle / audio aggregation across sandbox bindings lives in
// sandbox-view.js — studio.js just consumes the proxy through
// SandboxView.getInspectorMv().

// runCobEntry moved to /ui/unit-editor/cob-sync.js — it reaches the
// active MvControls / ModelViewer via hostCallbacks (registered
// alongside setActiveMvControls / getActiveModelViewer above).

// openModelPicker / closeModelPicker moved to /ui/pickers/open-unit-flow.js.
// External callers (configureReactUi's host bridge for "Open another
// model…", the sandbox spawn-picker swatch click, the welcome card)
// either import them directly or reach for `hostCallbacks.openModelPicker`.
// openModelViewer below + getActiveTab are registered into hostCallbacks
// at boot so the new module can dispatch the user's pick.

// openSandboxStub / sharedModelViewerCanvas / activateSandboxTab +
// the _sandboxViewInstance live reference all moved to
// /ui/sandbox/tab.js.  Studio.js still owns the tabs[] array +
// switchToTab dispatcher; the extracted activator reaches both
// through hostCallbacks.getTabs / hostCallbacks.openTab.

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

// ── Archaeology: dropdown sync helpers that moved to React ─────────
// The sandbox ribbon's Developer Controls row + the unit-editor View
// dropdown both read the persisted preferences directly off the
// inspector-store + panel-store signals now, so the cross-channel
// sync helpers (handleSandboxDevToggle, setControlsDevSectionVisible,
// applyControlsDevSectionVisibility, syncPanelToggleRows,
// syncSandboxDevtoolsDropdown) are gone — flipping the matching
// signal is enough to re-render every subscriber.

// _activeRendererView — which view currently owns the canvas.  The
// React Renderer panel's Tracking + Auto-Rotate toggles route through
// the host bridge here so they hit the right view's setTracking /
// renderer.setAutoRotate, mirroring the legacy wireMvRendererPanel
// `activeView()` helper.
function _activeRendererView() {
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode')
  return sandboxActive
    ? (hostCallbacks.getActiveSandboxView?.() || null)
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
          // syncBinding) + the shared smoke-trail advance through
          // the SmokeTrailManager that view-helpers stashed on
          // sv._smokeTrails.
          const sv = hostCallbacks.getActiveSandboxView?.() || null
          if (sv && sv.scene && typeof sv.scene.tick === 'function') sv.scene.tick(25)
          if (sv && sv._smokeTrails) {
            const rt = sv.runtime
            const rate = !rt ? 1 : (rt.paused ? 0 : (rt.playbackRate || 1))
            try { sv._smokeTrails.tick(25 * rate) } catch { /* ignore */ }
          }
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
        // Wipe the debugger's coverage hints so the next run paints
        // a clean dim/lit map.  Without this, lines that ran before
        // the reset stay lit even though execution starts over.
        if (typeof unit.clearExecutedOffsets === 'function') unit.clearExecutedOffsets()
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

async function openModelViewer(name) {
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
  if (modelOpenIntent === 'replace' && activeTab?.typeId === 'unit-editor') {
    activeTab.spec.name = name
    activeTab.spec.meta = meta
    activeTab.name = name
    activeTab.meta = meta
    modelOpenIntent = 'add'
    switchToTab(tabState.activeIndex, { fresh: false, force: true })
    return
  }
  modelOpenIntent = 'add'
  openTab('unit-editor', { name, meta })
}

// closeModelViewer — replaced by the React ribbon's "Open another
// model…" routing through openModelPicker (intent=add), which pushes
// the new unit into a fresh tab instead of dropping the current one.
// Tab close gestures (× on the tab strip + the tab bar's keyboard
// shortcut) still flow through closeTab directly.

// setStatus / clamp / escapeHTML / sanitiseFilename now live in
// ./ui/host-context.js so subsystem modules can pull them in
// without re-importing studio.js.
