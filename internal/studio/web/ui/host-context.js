// host-context.js
//
// The kbot studio's shared module-level state, factored out of
// studio.js so other /ui/* subsystems can import it without dragging
// the whole legacy host along.  Anything here is the load-bearing
// runtime context every subsystem (map editor, unit editor, sandbox)
// needs to read or mutate.
//
// Rules
// -----
//   - No DOM beyond the `$` / `$$` helpers; no React; no Preact.
//   - No imports from /ui/map-editor/, /ui/unit-editor/, /ui/sandbox/
//     — that direction is reserved for *those* trees to import from
//     here, never back.
//   - Mutable state that needs cross-module writes lives on plain
//     objects (`tabState`, `editorState`) so importers can do
//     `tabState.activeIndex = i` — ES module `let` exports are
//     read-only on the import side, so the indirection is required.
//
// Anything in this module is part of the studio's public host API as
// far as the subsystem modules are concerned.  Bumping a field name
// here is a breaking change for every subsystem.

// ── Per-map state model ─────────────────────────────────────────────
//
// MapDoc owns one map's per-map state.  The editor maintains an array
// of these (one per open tab); the active tab's MapDoc backs every
// `state.X` read for any X in PER_MAP_FIELDS.  Switching tabs swaps
// which MapDoc the Proxy points to — no data movement, just a pointer
// flip — so nothing per-map can survive a tab change.
//
// Module-level lets that hold per-map editing state (undoStack /
// redoStack / pendingTransaction / minimapBase, the scroll position)
// snapshot to / restore from the MapDoc on every tab swap, since they
// can't be expressed through the Proxy.

export const PER_MAP_FIELDS = new Set([
  'tileW', 'tileH', 'name', 'planet',
  'tiles', 'heights', 'voids', 'features',
  'zoom', 'mode',
  'ota', 'activeSchema',
  'selected', 'placement', 'terrainClipboard', 'dragging', 'dropPreview',
  'selectedFeature', 'selectedFeatures', 'selectedStartPos',
  'rectSelection', 'pickerRect',
  'featureJustMoved', 'startPosJustMoved',
  'highlightFeatureName', 'hoveredFeatureName',
  'eraseCursor', 'hmCursor', 'voidsCursor',
  'hmLevelHeight',
  // Sidebar drawer filter strings — typing "tree" while editing TabOne
  // shouldn't carry over to TabTwo (#36).
  'drawerFilters',
  // Ruler measurement (per tab so the line doesn't follow you between
  // maps).
  'ruler',
])

export class MapDoc {
  constructor() {
    this.tileW = 128
    this.tileH = 128
    this.name = 'newmap'
    this.planet = 'Green'
    this.tiles = []
    this.heights = []
    this.voids = []
    this.features = []
    this.zoom = 1
    this.mode = 'select-terrain'
    this.ota = null
    this.activeSchema = 0
    this.selected = null
    this.placement = null
    this.terrainClipboard = null
    this.dragging = null
    this.dropPreview = null
    this.selectedFeature = -1
    this.selectedFeatures = new Set()
    this.selectedStartPos = -1
    this.rectSelection = null
    this.pickerRect = null
    this.featureJustMoved = -1
    this.startPosJustMoved = -1
    this.highlightFeatureName = null
    this.hoveredFeatureName = null
    this.eraseCursor = null
    this.hmCursor = null
    this.voidsCursor = null
    this.hmLevelHeight = 80
    this.drawerFilters = { sections: '', features: '' }
    // Ruler tool state — { a: {tx, ty}, b: {tx, ty}, locked }.  When
    // null, no measurement is on screen.  Cleared on Escape.
    this.ruler = null
    // dirty flips to true on every commitTransaction and resets after a
    // successful Save / Save-loose.  Closing a dirty tab triggers the
    // unsaved-changes prompt (#40).
    this.dirty = false
    // Quality Checker fixes the user has already accepted for this map.
    // Seeded into runQualityChecker() so subsequent saves don't keep
    // re-prompting for the same approvals — once "Fix" sticks, the
    // dialog auto-passes those checks and closes through to the save.
    this.appliedFixes = new Set()
    // Snapshotted module-level lets — see snapshot/restore helpers.
    this.undoStack = []
    this.redoStack = []
    this.pendingTransaction = null
    this.minimapBase = null
    this.minimapBaseStale = true
    this.scrollLeft = 0
    this.scrollTop = 0
  }
}

// ── Tab registry ────────────────────────────────────────────────────
//
// tabs[] holds one entry per open map / model / sandbox.
// tabState.activeIndex picks which is currently shown.
//
// activeIndex lives on an object instead of being exported as a plain
// `let` because ES-module bindings are read-only on the import side —
// other subsystems need to *write* the index when they switch tabs.

export const tabs = []
export const tabState = {
  activeIndex: -1,
}

// activeMap returns the MapDoc backing the currently-active tab, or
// null when no map tab is active (welcome screen, model tab on top).
// All map-editor code routes through this; never index into tabs
// directly for the active map's state.
export function activeMap() {
  const t = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  // Model tabs deliberately have no .map — callers all gracefully
  // handle the null so the editor's map-only state stays inert when
  // a 3DO tab is on top.
  return t && t.type !== 'model' ? t.map : null
}

// ── Session-level state ─────────────────────────────────────────────
//
// Shared across every tab: drawer filters, view-menu toggles, panel
// layout, the section / feature catalogs and their image caches, and
// the user prefs the PrefsStore persists.  PER_MAP_FIELDS are NOT on
// this object — the Proxy below forwards them to activeMap().

export const sessionState = {
  drawer: 'sections',
  sectionsList: [],
  featuresList: [],
  sectionImages: new Map(),         // path → HTMLImageElement (raw, rotation=0)
  sectionImagesRotated: new Map(),  // `${path}|${rot}` → HTMLCanvasElement
  sectionHeights: new Map(),        // path → { w, h, heights[(w*2)*(h*2)] }
  featureImages: new Map(),         // lowercased name → HTMLImageElement (animated)
  collapsedGroups: new Set(),
  usedOnly: false,
  includeWreckage: false,
  viewMode: 'map',
  showGridlines: true,
  animateFeatures: true,
  showFeatures: true,
  showMinimap: true,
  showVoids: true,
  showContours: false,
  showBuildable: false,
  showStartPositions: true,
  showCameraInfo: true,
  minimapPos: null,
  panelLayout: {},
  eraseSize: 1,
  eraseScope: 'all',
  hmTool: 'raise',
  hmRadius: 4,
  hmStrength: 4,
  voidsBrushSize: 1,
  symmetry: 'off',
  // Centralised user-tunable settings.  Surfaced in the Settings
  // dialog; persisted via PrefsStore alongside the visibility toggles.
  settings: {
    zoomStep: 1.25,
    heartbeatIdleMs: 5000,
    heartbeatReconnectMs: 1000,
    defaultEraseSize: 1,
    defaultVoidsSize: 1,
    defaultHmRadius: 4,
    defaultHmStrength: 4,
  },
}

// `state` Proxy: per-map fields forward to activeMap(); everything
// else reads/writes sessionState.  Keeps every existing `state.X`
// call site working without rewriting it — the data has moved into
// MapDoc, but the access surface is unchanged.
export const state = new Proxy(sessionState, {
  get(target, prop) {
    if (PER_MAP_FIELDS.has(prop)) return activeMap()?.[prop]
    return target[prop]
  },
  set(target, prop, value) {
    if (PER_MAP_FIELDS.has(prop)) {
      const m = activeMap()
      if (m) m[prop] = value
      // Silently drop writes when no tab is active (boot / welcome screen).
      return true
    }
    target[prop] = value
    return true
  },
  has(target, prop) {
    return PER_MAP_FIELDS.has(prop) || prop in target
  },
})

// ── Cross-module callback registry ──────────────────────────────────
//
// During the multi-round extraction of studio.js, some extracted
// modules need to call host functions that haven't moved yet (and
// vice versa).  Rather than risk circular ES-module imports, the
// host registers its callbacks here at boot and extracted modules
// look them up via `hostCallbacks.foo?.()`.  Every entry is optional:
// the caller MUST tolerate a missing callback (early boot, headless
// runs) by no-op'ing when the registered value is null.
//
// Once everything has moved out of studio.js this registry becomes
// the API surface; until then it's a transition aid.
export const hostCallbacks = {
  // Map editor — set by studio.js after the editor wiring runs.
  cancelPlacement: null,        // () => void
  showPlacementHint: null,      // (label, kind) => void
  hidePlacementHint: null,      // () => void
  renderCanvas: null,           // () => void
  renderMapTabs: null,          // () => void
  recreateEditorView: null,     // () => void
  refreshSchemaSelector: null,  // () => void
  publishMapRibbonState: null,  // () => void
  setMode: null,                // (mode) => void
  invalidateMinimapBase: null,  // () => void
  // Image-cache callbacks the GL renderer needs while waiting for
  // async section / feature decodes to complete.  whenImageReady
  // registers a one-shot redraw; preloadFeatureImage kicks off a
  // missing feature fetch.  Both no-op safely until studio.js
  // populates them.
  whenImageReady: null,         // (img, kind, cb) => void
  preloadFeatureImage: null,    // (feature) => void
  // Feature anchor helpers — the GL renderer needs these to project
  // a feature's attribute-grid coords to world pixels and its sprite
  // origin pixel offset.  Same implementations are still called from
  // the 2D draw path in studio.js.
  featureAnchorOffset: null,    // (feature, img) => { dx, dy }
  featureAnchorWorld: null,     // (feature, heightOverride?) => { px, py }
  // Latest mouse-hover cell in tile coords — null when the cursor is
  // outside the canvas.  Paste uses this to anchor the dropped
  // clipboard at the user's last hover point.  An object instead of
  // a plain `let` so subsystems can both read and write it.
  cursor: { lastHover: null },  // { lastHover: { tx, ty } | null }
  // React/Preact UI bridge exports (from /ui/mount.js) — populated
  // by configureReactUi() once the dynamic import resolves.  Modules
  // that talk to React (open-map dialog, confirm dialog, ribbon
  // bridge, …) reach the API through getReactUi() so they tolerate
  // the bridge not being mounted yet (early boot, headless harness).
  reactUi: null,                // module exports of /ui/mount.js, or null
  // Boots the React UI bridge.  Returns a Promise<reactUi> that
  // resolves once /ui/mount.js has loaded + configureUi has run.
  // Called from openMapDialog / wireMapTabBar / debugger modals
  // when they need the bridge before its first natural use.
  configureReactUi: null,       // () => Promise<reactUi>
  // openLoadedMap hydrates editor state from a /api/studio/load
  // response and switches into the editor.  Called by the open-map
  // dialog flow + the drag-drop handler + the ?initial_map=… URL
  // shortcut.
  openLoadedMap: null,          // (data, card) => Promise<void>
  // Forces a synchronous minimap repaint.  Used by exportMinimap
  // to guarantee the exported PNG matches the current map state
  // even when the visible minimap was awaiting a debounced
  // redraw.
  renderMinimap: null,          // () => void
  // Bumps the content-version counter that drives the dev-stats
  // panel + minimap base-canvas invalidation.  Called from any
  // edit that changes tile data or feature placements but isn't
  // already routed through commitTransaction.
  bumpContentVersion: null,     // () => void
  // Camera-info panel visibility toggle.  Settings dialog flips
  // it through this callback because the panel itself is still
  // legacy (non-React) — once it migrates the callback can drop.
  setCameraInfoVisible: null,   // (visible: boolean) => void
  // Viewport-centre tile coord (honouring scroll + zoom).  Used by
  // the camera-info panel to publish the current centre; defined
  // in studio.js because it touches the live canvas-scroll wrapper.
  viewportCellCenter: null,     // () => { tx, ty }
  // rAF-batched re-render queues.  scheduleRenderCanvas defers a
  // main-canvas repaint to the next animation frame so a burst of
  // scroll events doesn't fan out into dozens of renders; the
  // minimap variant does the same for the floating minimap panel.
  // Both no-op safely when the editor view hasn't mounted yet.
  scheduleRenderCanvas: null,   // () => void
  scheduleMinimapRender: null,  // () => void
  // Auto-mode-switch helper.  On a left-click in any non-matching
  // mode, the studio's `tryAutoSwitchAt` decides whether the click
  // should swap into start-points or select-features mode (e.g.
  // clicking a start-position marker while in terrain-select).
  // Returns true when it consumed the click — extracted mode
  // handlers early-return on that signal.  Wires in studio.js's
  // implementation, which already encodes the space-pan + visibility
  // checks; mode modules don't reproduce that logic locally.
  tryAutoSwitchAt: null,        // (e) => boolean
  // Drop a copy of state.selected at the given attribute cell, with
  // symmetry mates.  Shared between feature-select mouse-drop and
  // the paint-mode auto-stamp so the feature factory + symmetry
  // expansion live in one place (studio.js for now — moves with
  // paint mode in a later round).
  placeFeature: null,           // (ax, ay) => void
  // placementAnchor returns the top-left tile coordinate where a
  // section placement should land so the cursor cell ends up at
  // the centre of the section's rotated footprint.  Lives in
  // studio.js because the drag-drop handler + the paint-mode
  // click flow + the paste handler all consume it from different
  // call sites; the helper itself is pure rotation math.
  placementAnchor: null,        // (cursorTX, cursorTY, placement) => { tx, ty }
  // clearStampSelection deselects the active drawer
  // section/feature so subsequent clicks no longer stamp.
  // Studio-side because it updates DOM (drawer paint) + status
  // bar in one shot; the paint module calls it after a productive
  // stroke commits.
  clearStampSelection: null,    // () => void
  // renderDrawer repaints the sections / features drawer body.
  // Studio-side because the legacy renderDrawer paints directly
  // into the static <div id="drawer"> outside the React tree;
  // the paint module calls it after dropping the selection so
  // the row de-highlights immediately.
  renderDrawer: null,           // () => void
  // Mouse-router pan bridge — the extracted dispatcher uses these
  // to short-circuit pan gestures before consulting the per-mode
  // handler map.  Implemented in /ui/map-editor/cursor.js; the
  // bridge entries are populated from studio.js's init wiring.
  shouldPan: null,              // (e) => boolean
  beginPan: null,               // (e) => void
  updatePan: null,              // (e) => void
  endPan: null,                 // () => void
  isPanning: null,              // () => boolean
  updateHoverLabel: null,       // (e) => void  (status-bar live cursor read-out)
  // activeSchema returns the OTA schema record for the active
  // map's selected schema slot, or null if there isn't one.  The
  // cursor module consumes it from tryAutoSwitchAt to test
  // whether a click landed on a placed start-position marker —
  // OTA / schema lookups still live studio-side.
  activeSchema: null,           // () => Schema | null
  // Drawer interaction bridge — the extracted drawer module owns
  // the rendering side, but selection + drag-from-row + the world
  // pill click all run through studio.js because they touch
  // mode dispatch + placement state + asset preloads.
  selectSection: null,          // (section) => void  (sets state.selected + placement, switches to paint mode)
  selectFeature: null,          // (feature) => void  (sets state.selected, switches to select-features mode)
  beginSectionDrag: null,       // (e, section) => void  (dragstart handler)
  beginFeatureDrag: null,       // (e, feature) => void   (dragstart handler)
  setActiveWorld: null,         // (worldRec) => void  (drawer-pill click → state.planet)
}

// ── React UI bridge accessor ────────────────────────────────────────
//
// Subsystem modules that need to talk to React (open-map dialog,
// confirm dialog, ribbon bridges) call `getReactUi()` rather than
// reaching for a global.  Returns null when the React island hasn't
// loaded yet — every caller must tolerate that and either no-op or
// await configureReactUi().
export function getReactUi() { return hostCallbacks.reactUi }
export function setReactUi(ui) { hostCallbacks.reactUi = ui }

// ── DOM helpers ─────────────────────────────────────────────────────

export const $ = (sel) => document.querySelector(sel)
export const $$ = (sel) => Array.from(document.querySelectorAll(sel))

// ── Utilities ───────────────────────────────────────────────────────
//
// Tiny helpers used by every subsystem.  setStatus targets the host
// status-bar element so subsystem code never needs to know it's
// #status — that lets us repaint the status line via React without
// breaking dozens of call sites.

export function setStatus(msg) { $('#status').textContent = msg }

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

export function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

export function sanitiseFilename(s) {
  return s.replace(/[^a-zA-Z0-9_ -]+/g, '').trim() || 'newmap'
}
