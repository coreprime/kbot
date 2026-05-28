// bridge.js
//
// React MapRibbon + MapSidebar bridge wiring, plus the minimap-pan
// helper the ribbon's React MinimapPanel routes through.  Owns:
//
//   - publishMapRibbonState() — pushes every map-editor ribbon-relevant
//     flag / label into the React store on each refresh so the
//     migrated ribbon re-renders on the next signal commit.
//   - publishMapSidebarState() — same idea for the React MapSidebar's
//     active drawer / filter / used+wreckage signals.
//   - wireMapRibbonBridge(reactUi) — installs the
//     configureSidebarBridge + configureMapRibbonBridge callback
//     bundles on the loaded React UI module so every ribbon button /
//     sidebar gesture routes back through the host helpers.
//   - _miniPanActive (module-private) + _doMinimapPan(...) — mirrors
//     the legacy wireMinimap pan logic, driven from the React
//     component's own listeners through the ribbon bridge.
//
// All cross-module deps come in through direct imports (the helpers
// listed below) or the shared host-context (`state` + `hostCallbacks`
// for the host functions that still live in studio.js).

import { state, getReactUi, hostCallbacks } from '../../host-context.js'
import { splitActivePane, closeActivePane, canCloseActivePane } from '../../common/split-host.js'
import { persistPrefs } from '../../common/prefs.js'
import { isConnected } from '../../common/heartbeat.js'
import { setMode } from '../mode.js'
import { switchTab } from '../wire-toolbar.js'
import {
  deleteSchema,
  addSchemaWithPlayers,
  schemaPlayerCount,
  schemaPickerLabel,
} from '../schema-selector.js'
import {
  startNewMapFromEditor,
  openExistingMapFromEditor,
} from '../dialogs/size.js'
import { undo, redo, undoStack, redoStack } from '../undo.js'
import {
  cutSelection,
  copyToClipboard,
  pasteFromClipboard,
  clearRegion,
  clearFeaturesInSelection,
  clearAllFeatures,
} from '../clipboard.js'
import { setZoom, fitZoom, overscrollPadding } from '../zoom-pan.js'
import {
  setMinimapVisible,
  setFeaturesVisible,
  setStartPositionsVisible,
  setVoidsVisible,
} from '../view-toggles.js'
import { setCameraInfoVisible } from '../camera-info.js'
import {
  exportHeightmap,
  exportMinimap,
  exportFullRender,
  exportMapImage,
  exportBuildmap,
  exportVoidmap,
} from '../exports.js'
import { save, saveLoose } from '../save.js'
import { buildSavePayload } from '../save-payload.js'
import { openSettingsDialog } from '../../dialogs/settings.js'
import { openHelpDialog } from '../../dialogs/help.js'
import { openOTADialog } from '../dialogs/ota.js'
import { openResizeDialog } from '../dialogs/resize.js'
import { openScatterDialog } from '../dialogs/scatter.js'
import { openSchemaEditor } from '../dialogs/schema-editor.js'
import { runQualityChecker } from '../dialogs/quality-checker.js'
import { openDeveloperDialog } from '../dev-stats.js'
import { pickedPlayerCounts } from '../dialogs/dice-picker.js'
import { playerCountLabel } from '../helpers.js'
import { renderCanvas } from '../canvas/render.js'
import { renderDrawer } from '../drawer.js'
import { scheduleMinimapRender } from '../render-queue.js'

// publishMapRibbonState — push every map-editor ribbon-relevant
// flag/label into the React store so the migrated ribbon re-renders
// on the next signal commit.  Cheap when the React UI hasn't loaded
// (early no-op) so calling unconditionally is safe.
export function publishMapRibbonState() {
  const reactUi = getReactUi()
  if (!reactUi || typeof reactUi.publishRibbonState !== 'function') return
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
  reactUi.publishRibbonState({
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
export function publishMapSidebarState() {
  const reactUi = getReactUi()
  if (!reactUi) return
  if (typeof reactUi.setSidebarDrawer === 'function') {
    reactUi.setSidebarDrawer(state.drawer || 'sections')
  }
  if (typeof reactUi.setSidebarFilter === 'function') {
    reactUi.setSidebarFilter((state.drawerFilters || {})[state.drawer] || '')
  }
  if (typeof reactUi.setSidebarUsedOnly === 'function') {
    reactUi.setSidebarUsedOnly(!!state.usedOnly)
  }
  if (typeof reactUi.setSidebarWreckage === 'function') {
    reactUi.setSidebarWreckage(!!state.includeWreckage)
  }
  if (typeof reactUi.setSidebarUsedOnlyVisible === 'function') {
    reactUi.setSidebarUsedOnlyVisible(state.drawer === 'features')
  }
  if (typeof reactUi.setSidebarWreckageVisible === 'function') {
    reactUi.setSidebarWreckageVisible(state.drawer === 'features')
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

// wireMapRibbonBridge — installs the sidebar + map-ribbon callback
// bundles on the loaded React UI module.  Called from
// configureReactUi() once the /ui/mount.js module has resolved.  All
// ~50 ribbon callbacks (File / Edit / Mode / Actions / View /
// Map Settings / Configure / Advanced / Help + the minimap pan
// triplet) route through here so the host's behaviour stays in one
// place.  Each callback is a thin wrapper — the real work lives in
// the imported helpers above (or studio.js host functions reached
// through hostCallbacks).
export function wireMapRibbonBridge(reactUi) {
  if (!reactUi) return
  if (typeof reactUi.configureSidebarBridge === 'function') {
    reactUi.configureSidebarBridge({
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
  if (typeof reactUi.configureMapRibbonBridge === 'function') {
    reactUi.configureMapRibbonBridge({
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
      // Pane layout (View ▸ Split).  Drive the active map tab's split
      // tree from the menu, mirroring the SHIFT+right-click gesture.
      splitView:    (orient) => {
        const tab = hostCallbacks.getActiveTab?.()
        if (tab) splitActivePane(tab, orient)
      },
      closeView:    () => {
        const tab = hostCallbacks.getActiveTab?.()
        if (tab) closeActivePane(tab)
      },
      canCloseView: () => {
        const tab = hostCallbacks.getActiveTab?.()
        return tab ? canCloseActivePane(tab) : false
      },
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
}
