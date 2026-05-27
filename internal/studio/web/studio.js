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
  TILE_PX,
  SCHEMA_PLAYER_COUNTS,
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
  activeMap,
  state,
  hostCallbacks,
  setReactUi,
  $,
  $$,
  setStatus,
  clamp,
  escapeHTML,
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
  refreshHistoryFlyouts,
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
import { resetGL } from './ui/map-editor/canvas/webgl.js'

// Pure rotation + flip helpers shared by the 2D draw path, the GL
// renderer, and the stamp pipeline.  No state, no DOM — just
// algebra over (origW, origH, rotation, flipH, flipV).
import {
  rotatedFootprint,
} from './ui/map-editor/rotation.js'

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
  makePanelDraggable,
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
  onImportHeightmapFile,
} from './ui/map-editor/exports.js'

// Symmetry helpers (Vertical / Horizontal / Both) — pure mate
// generators used by every brush + stamp tool to mirror strokes
// onto the matching half of the map.  The DOM wiring
// (wireSymmetryGroup) stays in studio.js for now.
import {
  SYMMETRY_LABELS,
  symmetryMatesAttr,
} from './ui/map-editor/symmetry.js'

// Scatter dialog — drops N features into the map honouring a
// minimum spacing halo.  Self-contained subsystem; the React
// dialog chrome is mounted separately.
import {
  openScatterDialog,
  closeScatterDialog,
  applyScatter,
} from './ui/map-editor/dialogs/scatter.js'

// Map Properties (.ota) dialog — mission name, planet, wind, tidal,
// gravity, sea level, lava-world flags.  Apply commits a single
// undo transaction and mirrors mission name + planet onto state.
import {
  openOTADialog,
  closeOTADialog,
  wireOTADialog,
} from './ui/map-editor/dialogs/ota.js'

// Per-schema editor — opened by the gear icon on each schema row in
// the schema dropdown.  Edits the matching state.ota.schemas[i] in
// a single undo transaction.
import {
  openSchemaEditor,
  closeSchemaEditor,
  wireSchemaEditor,
} from './ui/map-editor/dialogs/schema-editor.js'

// Resize-map dialog — anchor-grid + Crop-to-content path.  Rebuilds
// tiles / heights / voids / features at the new size and tears out
// the canvas DOM so no stale GL buffers survive.
import {
  openResizeDialog,
  closeResizeDialog,
  wireResizeDialog,
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
  startMapPan,
  stopMapPan,
  stopAllMapPan,
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
// directly any more.
import { tryAutoRotatePlacement } from './ui/map-editor/canvas/placement.js'

// Per-mode handler modules — the canvas mouse-router (imported
// further below) owns the actual mousedown/move/up dispatch.
// Studio.js only pulls in the cleanup hooks the abort path needs
// (each mode's reset for in-flight drag state) + the auto-switch
// seeders that tryAutoSwitchAt below pokes when a click in one
// mode lands on a different mode's pickable.
import { resetVoidsDrag } from './ui/map-editor/modes/voids.js'
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
  getSpacePanHotkey, setSpacePanHotkey,
} from './ui/map-editor/cursor.js'

// Drawer (left sidebar) — renders the Sections + Features panels
// with virtualised collapsible groups.  Studio.js owns selection
// + drag + active-world side effects; the module reaches those
// through hostCallbacks (R41a).
import { renderDrawer } from './ui/map-editor/drawer.js'

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
  DEFAULT_SETTINGS,
  openSettingsDialog,
  closeSettingsDialog,
} from './ui/dialogs/settings.js'

// Per-tab unit-editor lifecycle — activateModelTab promotes one tab's
// ModelViewer + MvControls into the active slot the rest of the studio
// reads from.  The active-instance lets remain in studio.js (this file
// reads them in dozens of places) and the module flips them through
// hostCallbacks.setActiveModelViewer / setActiveMvControls below.
import { activateModelTab } from './ui/unit-editor/tab.js'

// Floating inspector chrome (drag/collapse/close/clamp + visibility
// persistence) for the unit-editor's Scripts/Actions/Ports/StaticVars/
// Camera/Effects/Audio overlays.  The per-panel data-refresh logic
// (refreshMvInspectors etc.) still lives in this file — moves out in
// a follow-up round once the debugger code it shares state with
// (R43c–e) has also been pulled.
import {
  wireMvInspectors,
  setMvInspectorVisible,
} from './ui/unit-editor/inspectors.js'

// Thread-debugger modal lifecycle + chrome.  The asm renderer +
// bracket overlay + per-tick PC highlight still live in this file
// (R43e); the modal reaches them through host-callback seams below.
import {
  _mvThreadCodePanels,
  openMvThreadCodeModal,
  closeAllMvThreadCodePanels,
} from './ui/unit-editor/debugger/modal.js'

// BOS-pane renderer + cross-reference map + per-tick BOS highlight.
// The asm pane's mvBuildAsmLine reaches applyMvThreadCodeCrossHover
// directly via import; the modal lifecycle reaches the others
// (renderMvThreadCodeDecompiled in particular) through hostCallbacks.
import {
  renderMvThreadCodeDecompiled,
} from './ui/unit-editor/debugger/bos.js'

// Asm-pane renderer + bracket overlay + lockstep scroll sync +
// PC-drag editor.  Re-exported through hostCallbacks below so the
// modal lifecycle in debugger/modal.js can still call them via the
// same seams used before extraction.
import {
  renderMvThreadCodeSource,
  refreshMvThreadCodeHighlight,
  wireMvThreadCodeBrackets,
  redrawMvThreadCodeBrackets,
} from './ui/unit-editor/debugger/asm.js'

// Unit-editor sidebar — the React-managed Pieces / Textures / Weapons
// tab bridges + the host-side helpers (selectPiece, filterPieceTree,
// playWeaponSound) the legacy DOM still triggers.  Weapon picker +
// catalogue cache live here too since they're scoped to the unit
// editor's sidebar.
import {
  refreshPieceTreeEyes,
  renderPieceTree,
  renderTexturesTab,
  renderMvWeaponsTab,
  refreshMvWeaponsLive,
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
  hostCallbacks.publishMapRibbonState = publishMapRibbonState
  hostCallbacks.setMode = setMode
  hostCallbacks.invalidateMinimapBase = invalidateMinimapBase
  hostCallbacks.whenImageReady = whenImageReady
  hostCallbacks.preloadFeatureImage = preloadFeatureImage
  hostCallbacks.featureAnchorOffset = featureAnchorOffset
  hostCallbacks.featureAnchorWorld = featureAnchorWorld
  hostCallbacks.configureReactUi = configureReactUi
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
  // Unit-editor seams — /ui/unit-editor/tab.js calls these to flip
  // the host-owned modelViewerInstance / _mvControls aliases when
  // activating a tab.
  hostCallbacks.getActiveModelViewer = () => modelViewerInstance
  hostCallbacks.setActiveModelViewer = (v) => {
    modelViewerInstance = v
    window.__modelViewer = v
  }
  hostCallbacks.setActiveMvControls = (c) => { _mvControls = c }
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
  hostCallbacks.getUnitEditorAutoRotate = () => _unitEditorAutoRotate
  hostCallbacks.sharedModelViewerCanvas = sharedModelViewerCanvas
  // Thread-debugger render hooks — extracted modal.js calls these
  // back to ask studio.js to repaint the BOS source / asm decomp /
  // bracket overlay / PC highlight when it opens a panel or processes
  // user actions (Step button, vars-collapse).
  hostCallbacks.renderMvThreadCodeSource = renderMvThreadCodeSource
  hostCallbacks.renderMvThreadCodeDecompiled = renderMvThreadCodeDecompiled
  hostCallbacks.wireMvThreadCodeBrackets = wireMvThreadCodeBrackets
  hostCallbacks.refreshMvThreadCodeHighlight = refreshMvThreadCodeHighlight
  hostCallbacks.redrawMvThreadCodeBrackets = redrawMvThreadCodeBrackets
  // asm.js' refreshMvThreadCodeHighlight calls this back to repaint
  // the Locals/Globals/Stack tray (R43g moves the var-row factories).
  hostCallbacks.renderMvThreadCodeLocals = renderMvThreadCodeLocals
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
  destroyEditorView()
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
  bumpContentVersion()
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
    resetVoidsDrag()
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
    if (e.key === ' ' && !getSpacePanHotkey()) {
      setSpacePanHotkey(true)
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
      setSpacePanHotkey(false)
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
// selectFeature + beginSectionDrag + beginFeatureDrag stay here
// because they touch mode dispatch / placement / asset preloads;
// the drawer module reaches them through hostCallbacks.

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


// wireZoomButtons binds the three Zoom ribbon buttons.  Lives outside
// EditorView because the buttons sit in the toolbar (which is mounted
// once for the session) rather than the canvas stack.
function wireZoomButtons() {
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * (state.settings?.zoomStep || 1.25)))
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / (state.settings?.zoomStep || 1.25)))
  $('#zoom-fit').addEventListener('click', fitZoom)
}

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

// tryAutoSwitchAt + shouldPan + beginPan + updatePan + endPan moved
// to /ui/map-editor/cursor.js (R40g) — imported at the top of
// this file.

// placementAnchor returns the top-left tile coordinate where the section
// should land so that the cursor cell ends up at the centre of the
// section's footprint.  For a W×H section, the cursor at (cx, cy) maps
// to a top-left at (cx - floor(W/2), cy - floor(H/2)).
function placementAnchor(cursorTX, cursorTY, p) {
  const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, p.rotation)
  return { tx: cursorTX - Math.floor(fw / 2), ty: cursorTY - Math.floor(fh / 2) }
}

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

function activeSchema() {
  if (!state.ota || !state.ota.schemas[state.activeSchema]) return null
  return state.ota.schemas[state.activeSchema]
}

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

// eraseAt + eraseAtSingle moved to /ui/map-editor/modes/erase.js
// (R40d.1) — imported at the top of this file.

// stampSection moved to /ui/map-editor/modes/paint.js (R40d) —
// the symmetry-aware per-tile section stamp now lives next to its
// only consumer (handlePaint).

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
// SYMMETRY_LABELS + the pure symmetryMatesTile / symmetryMatesAttr
// helpers moved to /ui/map-editor/symmetry.js — imported above.

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

// symmetryMatesTile + symmetryMatesAttr moved to
// /ui/map-editor/symmetry.js — imported at the top of this file.

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

// activateModelTab moved to /ui/unit-editor/tab.js.  The
// per-tab ModelViewer + MvControls lifecycle, the onModelLoaded
// closure, and the canvas-stage staging all live there now.  This
// file still owns the modelViewerInstance + _mvControls module-level
// lets the rest of the studio reads from; the extracted activator
// promotes the right tab through hostCallbacks.setActive* below.

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
// /ui/unit-editor/panels/port-rows.js (round 17; relocated in R48b).

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
// React-owned Reset attribute via /ui/unit-editor/panels/port-rows.js + /ui/panels/controls-panel.js.

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
  // Route through setMvInspectorVisible (NOT a direct DOM class
  // toggle) so the React panel-store's visible signal flips in
  // lockstep — the Runtime panel's per-tick ThreadsBody is gated on
  // that signal and would render empty if we let the chrome go
  // visible while the signal said hidden.  `persist: false` keeps
  // the user's saved choice from being clobbered by sandbox-mode's
  // forced show.
  for (const id of ['mv-inspector-actions']) {
    setMvInspectorVisible(id, false, { persist: false })
  }
  for (const id of ['mv-inspector-camera', 'mv-inspector-scripts', 'mv-inspector-staticvars', 'mv-inspector-ports', 'mv-inspector-effects', 'mv-inspector-audio']) {
    setMvInspectorVisible(id, true, { persist: false })
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
