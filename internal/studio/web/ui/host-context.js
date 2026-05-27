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
