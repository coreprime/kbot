// store.js
//
// Signals + setters for the React-managed map editor surface
// (sidebar tabs, floating panels, ribbon).  Mirrors the same
// pattern the unit-editor uses (inspector-store): the host
// publishes snapshots through small setters; React components
// subscribe to the signals via `.value` reads inside their render
// bodies.
//
// Why a separate store from inspector-store: the map editor's
// per-tick read-outs (stats, camera/cursor pose, minimap tick)
// live on a totally different cadence than the unit-editor's mv
// signal.  Sharing inspector-store would mean every map-editor
// publish ticks the unit-editor's per-frame subscribers (and vice
// versa).
//
// Lives under /ui/map-editor/ because it's map-specific — common/
// is reserved for view-agnostic infrastructure.

import { signal } from '@preact/signals'

// ── Stats panel ────────────────────────────────────────────────────
// distinctTiles / distinctFeatures / totalFeatures are pushed from
// studio.js's computeDevStats whenever content changes.

export const mapStats = signal({
  distinctTiles: 0,
  distinctFeatures: 0,
  totalFeatures: 0,
})

export function publishMapStats(s) {
  if (!s) return
  mapStats.value = {
    distinctTiles: s.distinctTiles | 0,
    distinctFeatures: s.distinctFeatures | 0,
    totalFeatures: s.totalFeatures | 0,
  }
}

// ── Camera + Cursor panel ──────────────────────────────────────────
// Host writes camera pose (viewport-centre tile, zoom) and the live
// cursor position (tile / sub-tile / height) on every redraw + every
// mousemove.  React reads the snapshot on next render — no per-key
// imperative refresh needed.

export const cameraInfo = signal({
  cameraTx: null, cameraTy: null,
  cursorTx: null, cursorTy: null,
  subTx: null,    subTy: null,
  height: null,
  zoomPct: 100,
})

export function publishMapCameraInfo(next) {
  cameraInfo.value = { ...cameraInfo.value, ...next }
}

// ── Sidebar (Sections / Features) ──────────────────────────────────
// activeDrawer flips between 'sections' / 'features' so the tab strip
// + the host's renderDrawer dispatch read off ONE source of truth.

export const sidebarDrawer = signal('sections')

// Drawer filter text + used-only / include-wreckage checkboxes.  The
// values are stored here so the React tabs component renders them, and
// the host bridge writes them back through setters that fire renderDrawer
// + persistence.
export const sidebarFilter      = signal('')
export const sidebarUsedOnly    = signal(false)
export const sidebarWreckage    = signal(false)
// Visibility of the two extra-checkbox rows — the host hides
// "Used only" / "Include wreckage" on the Sections drawer (they only
// apply to Features) by flipping these flags after switchTab.
export const sidebarUsedOnlyVisible    = signal(false)
export const sidebarWreckageVisible    = signal(false)

// _bridge — host installs the click/change handlers so the React
// component doesn't reach into studio.js's renderDrawer / persistPrefs
// directly.  Default no-ops keep the module importable in tests.
const _sidebarBridge = {
  onTabChange:     (_tab) => {},
  onFilterChange:  (_text) => {},
  onUsedOnlyChange:    (_on) => {},
  onWreckageChange:    (_on) => {},
}

export function configureSidebarBridge(impl) {
  Object.assign(_sidebarBridge, impl)
}

export const sidebarBridge = _sidebarBridge

// ── Ribbon: mode + view + brushes + history ────────────────────────
// All driven from a single ribbonState signal so a host publish
// re-renders every dependent button (mode label, undo enabled, schema
// name, etc.) in one go.

export const ribbonState = signal({
  // Active editor mode (matches state.mode in studio.js).
  mode: 'select-terrain',
  // View dropdown — display mode + the per-toggle on/off bits.
  viewMode: 'map',
  showGridlines: true,
  animateFeatures: true,
  showMinimap: true,
  showCameraInfo: true,
  showVoids: true,
  showContours: false,
  showBuildable: false,
  showFeatures: true,
  showStartPositions: true,
  // Mode-submenu state (each shows a "current" badge on its row).
  symmetry: 'off',
  voidsBrushSize: 1,
  eraseSize: 1,
  eraseScope: 'all',
  hmTool: 'raise',
  hmRadius: 4,
  hmStrength: 4,
  // Undo / redo labels + enabled flags drive the Editing Tools
  // dropdown's top rows.
  undoLabel: 'Undo',
  undoEnabled: false,
  redoLabel: 'Redo',
  redoEnabled: false,
  undoHistory: [],  // array of { label, depth } for the popout list
  redoHistory: [],
  // Schema dropdown current selection — name + players-summary.
  schemaName: 'Schema',
  schemaList: [],      // [{ index, label, active }]
  schemaAddCounts: [], // [{ count, label, label2 }]
  // Connection state for ribbon-driven actions that shouldn't fire
  // while disconnected (Save, Resize, etc.).  Host flips on heartbeat.
  connected: true,
})

export function publishRibbonState(next) {
  ribbonState.value = { ...ribbonState.value, ...next }
}

// _ribbonBridge — host installs every click action the ribbon fires.
// Names mirror studio.js's existing functions so wiring is just
// passing references.

const _ribbonBridge = {
  // File
  fileNew:        () => {},
  fileNewWindow:  () => {},
  fileOpen:       () => {},
  fileSave:       () => {},
  fileSaveLoose:  () => {},
  // Edit
  editCut:                  () => {},
  editCopy:                 () => {},
  editPaste:                () => {},
  editPasteFeatures:        () => {},
  editPasteTiles:           () => {},
  editClearRegion:          () => {},
  editClearFeaturesInSel:   () => {},
  editClearAllFeatures:     () => {},
  // Mode
  setMode:           (_m) => {},
  setSymmetry:       (_s) => {},
  setVoidsBrush:     (_n) => {},
  setEraseScope:     (_s) => {},
  setEraseSize:      (_n) => {},
  setHmTool:         (_t) => {},
  setHmRadius:       (_n) => {},
  setHmStrength:     (_n) => {},
  // Actions
  undo:                  () => {},
  redo:                  () => {},
  jumpUndoTo:            (_depth) => {},
  jumpRedoTo:            (_depth) => {},
  openResize:            () => {},
  openScatter:           () => {},
  exportHeightmap:       () => {},
  importHeightmap:       () => {},
  // Zoom
  zoomIn:    () => {},
  zoomOut:   () => {},
  zoomFit:   () => {},
  // View
  setDisplayMode:    (_m) => {},
  toggleGridlines:   () => {},
  toggleAnimate:     () => {},
  toggleMinimap:     () => {},
  toggleCameraInfo:  () => {},
  toggleVoids:       () => {},
  toggleContours:    () => {},
  toggleBuildable:   () => {},
  toggleFeatures:    () => {},
  toggleStartPos:    () => {},
  // Map Settings
  openOTA:              () => {},
  pickSchema:           (_index) => {},
  deleteSchema:         (_index) => {},
  addSchema:            (_count) => {},
  openSchemaEditor:     (_index) => {},
  // Configure
  openSettings:    () => {},
  // Advanced
  exportMinimap:      () => {},
  exportFullRender:   () => {},
  exportMapImage:     () => {},
  exportBuildmap:     () => {},
  exportVoidmap:      () => {},
  runQualityCheck:    () => {},
  openDeveloper:      () => {},
  // Help
  openHelp:    () => {},
  // Minimap panning + redraws
  minimapPan:        (_clientX, _clientY) => {},
  minimapBeginPan:   (_clientX, _clientY) => {},
  minimapEndPan:     () => {},
  scheduleMinimapRender: () => {},
}

export function configureMapRibbonBridge(impl) {
  Object.assign(_ribbonBridge, impl)
}

export const mapRibbonBridge = _ribbonBridge

// ── Minimap render tick ──────────────────────────────────────────
// The host bumps this every time renderMinimap re-paints the cached
// base or the viewport overlay needs to move.  The React Minimap
// panel reads `minimapTick.value` so it re-renders (and the legacy
// renderMinimap canvas-into-DOM write is the only side effect).

export const minimapTick = signal(0)
export function bumpMinimapTick() { minimapTick.value = minimapTick.value + 1 }
