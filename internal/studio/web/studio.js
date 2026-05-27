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

const TILE_PX = 32 // map render resolution (1 map tile = 32×32 css px)
const VOID_COLOR = '#1d3045' // colour shown for unstamped cells

// MAX_START_POSITIONS — the hard upper bound on how many StartPos entries
// a schema can hold.  TA caps multiplayer at 10 players so the editor
// never lets you place more than this.  Bump here if a future spinoff
// supports more than 10.
const MAX_START_POSITIONS = 10

// Quality Checker pacing.  The server can finish every check in tens of
// ms which makes the dialog feel like a placebo — the user clicks Save
// and the window flashes once.  These two minimums give every check
// visible breathing room (250ms of "running" before its result is
// revealed) and guarantee the window itself sticks around long enough
// to read (1.5s total).  Bump if the dialog still feels rushed.
const QUALITY_CHECK_MIN_MS = 250
const QUALITY_WINDOW_MIN_MS = 1500

// Buildable-area overlay tuning.  Matches TA's per-attribute-cell
// build-grid rules well enough for an editor preview:
//   - The cell can't be a void.
//   - The cell can't be submerged below sea level (land structures
//     are the common case; ship-pad cells light up only when the
//     map has no impassible water, which the editor doesn't model
//     here — close enough for a quick overlay).
//   - The slope into every cardinal neighbour must stay within
//     BUILDABLE_MAX_SLOPE height units.  12 is the middle of the
//     stock TA structure MaxSlope range (3 for tank pads, 25 for
//     KBot factories) and gives a generic "any builder could plant
//     a factory here" answer.
const BUILDABLE_MAX_SLOPE = 12
const BUILDABLE_FILL = 'rgba(96, 180, 255, 0.34)'

// Keyboard map navigation.  Held arrow keys pan continuously via a
// requestAnimationFrame loop with a linear acceleration ramp from
// 1× to MAP_PAN_ACCEL_MAX_MULT over MAP_PAN_ACCEL_TIME_MS — quick
// taps stay precise, long holds race across big maps.  Speed is in
// canvas-pixel space (i.e. pre-zoom) so the on-screen panning rate
// stays constant regardless of zoom level.  Zoom step matches the
// +/- toolbar buttons via state.settings.zoomStep.
const MAP_PAN_RATE_PX_S = 720
const MAP_PAN_ACCEL_MAX_MULT = 3
const MAP_PAN_ACCEL_TIME_MS = 2000

// ── Worlds ─────────────────────────────────────────────────────────────────
// WORLDS is the single source of truth for the distinct worlds the editor
// recognises.  One entry per world — Mars and Moon are their own rows
// rather than being collapsed into "Mars / Desert" or "Moon / Lunar"
// pairs.  Used to populate the New-map + OTA Properties planet pickers
// AND to translate "Set as active" clicks on the sections drawer into a
// state.planet value.
//   slug:           matches the section drawer's world folder + the
//                   value stored in state.planet (lowercased).
//   label:          shown in pickers + drawer pills.
//   defaultTileset: the canonical value written to the .ota's planet
//                   field for this world (TA's stock OTAs use these
//                   display-cased names).
//   aliases:        additional strings (beyond slug + defaultTileset)
//                   that should still resolve to this world on read.
const WORLDS = [
  { slug: 'greenworld',  label: 'Green',       defaultTileset: 'Green',  aliases: [] },
  { slug: 'metal',       label: 'Metal',       defaultTileset: 'Metal',  aliases: [] },
  { slug: 'mars',        label: 'Mars',        defaultTileset: 'Desert', aliases: [] },
  { slug: 'moon',        label: 'Moon',        defaultTileset: 'Lunar',  aliases: [] },
  { slug: 'archipelago', label: 'Archipelago', defaultTileset: 'Water',  aliases: [] },
  { slug: 'lava',        label: 'Lava',        defaultTileset: 'Lava',   aliases: [] },
  { slug: 'acid',        label: 'Acid',        defaultTileset: 'Acid',   aliases: [] },
  { slug: 'slate',       label: 'Slate',       defaultTileset: 'Slate',  aliases: [] },
]

// worldFor resolves a world string (a slug, a default-tileset name, or
// an alias) to its WORLDS entry.  Returns null when nothing matches.
// Normalises whitespace/dashes so "Green World" → "greenworld".
function worldFor(name) {
  const w = (name || '').toLowerCase().replace(/[\s_-]+/g, '')
  if (!w) return null
  for (const t of WORLDS) {
    if (t.slug === w) return t
    if (t.defaultTileset.toLowerCase() === w) return t
    for (const a of t.aliases) if (a.toLowerCase() === w) return t
  }
  return null
}

// ── Per-map state model ────────────────────────────────────────────────
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

const PER_MAP_FIELDS = new Set([
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

class MapDoc {
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

// Tabs[] holds one entry per open map.  activeTabIndex picks which is
// currently shown / edited.  activeMap() is the only legitimate way to
// reach the active per-map state inside this module.
const tabs = []
let activeTabIndex = -1
function activeMap() {
  const t = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
  // Model tabs deliberately have no .map — callers all gracefully
  // handle the null so the editor's map-only state stays inert when
  // a 3DO tab is on top.
  return t && t.type !== 'model' ? t.map : null
}

// Session-level state lives here.  These fields are shared across all
// tabs: drawer filters, view-menu toggles, panel layout, the section /
// feature catalogs and their image caches, and the user prefs the
// PrefsStore persists.  PER_MAP_FIELDS are NOT on this object — the
// Proxy below forwards them to activeMap().
const sessionState = {
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

// `state` Proxy: per-map fields forward to activeMap(); everything else
// reads/writes sessionState.  Keeps every existing `state.X` call site
// working without rewriting it — the data has moved into MapDoc, but
// the access surface is unchanged.
const state = new Proxy(sessionState, {
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

// ── OTA defaults ───────────────────────────────────────────────────────────
//
// The OTA (Online Total Annihilation map metadata) ships alongside the
// TNT in the saved .hpi.  We mirror the fields the in-game lobby reads
// (mission name + planet + multiplayer schemas + start positions) so
// the user has full control without hand-editing the file.

function defaultOTAState(mapName, planet, tileW, tileH) {
  return {
    missionName: mapName || 'newmap',
    missionDescription: 'Created with KBot Studio.',
    missionHint: '',
    brief: '',
    narration: '',
    glamour: '',
    planet: planet || 'Green',
    numPlayers: '2, 3, 4',
    size: `${Math.max(1, Math.round(tileW / 16))} x ${Math.max(1, Math.round(tileH / 16))}`,
    memory: '8 mb',
    lineOfSight: 0,
    mapping: 0,
    tidalStrength: 20,
    solarStrength: 20,
    lavaWorld: planet?.toLowerCase() === 'lava' ? 1 : 0,
    killmul: 50,
    timemul: 0,
    minWindSpeed: 200,
    maxWindSpeed: 2500,
    gravity: 112,
    seaLevel: 63,
    impassibleWater: 0,
    waterDoesDamage: 0,
    schemas: [defaultSchema('Default', 'Network 1', tileW, tileH)],
  }
}

function defaultSchema(name, type, tileW, tileH) {
  return {
    name,
    type,
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
    startPositions: defaultStartPositionsForSchema(tileW, tileH),
  }
}

// 10 default start spots spread around the map (corners → edge midpoints
// → centre fills).  Game pixel coords: 1 tile = 32 game-px.
function defaultStartPositionsForSchema(tileW, tileH) {
  const px = tileW * 32
  const py = tileH * 32
  const margin = Math.max(64, Math.min(px, py) / 8)
  return [
    { number: 1, x: Math.round(margin), z: Math.round(margin) },
    { number: 2, x: Math.round(px - margin), z: Math.round(py - margin) },
    { number: 3, x: Math.round(px - margin), z: Math.round(margin) },
    { number: 4, x: Math.round(margin), z: Math.round(py - margin) },
    { number: 5, x: Math.round(px / 2), z: Math.round(margin) },
    { number: 6, x: Math.round(px / 2), z: Math.round(py - margin) },
    { number: 7, x: Math.round(margin), z: Math.round(py / 2) },
    { number: 8, x: Math.round(px - margin), z: Math.round(py / 2) },
    { number: 9, x: Math.round(px / 3), z: Math.round(py / 2) },
    { number: 10, x: Math.round(px * 2 / 3), z: Math.round(py / 2) },
  ]
}

// activeWorldsFor resolves a planet/tileset string to the list of
// section worlds that count as "matching".  state.planet can hold
// either a slug ("mars") or a default-tileset name ("Desert"); WORLDS
// covers both so we route through worldFor.
function activeWorldsFor(planet) {
  const t = worldFor(planet)
  if (t) return [t.slug]
  const p = (planet || '').toLowerCase()
  return p ? [p] : []
}

// featureWorldMatches returns true when a feature's world string should
// count as part of the active tileset.  Feature TDFs use slightly different
// world names (e.g. "Green World", "All Worlds") than the section folder
// layout, so we normalise both sides before comparing and consult WORLDS
// for the default-tileset + alias spellings of each active slug.
function featureWorldMatches(featureWorld, activeWorlds) {
  if (!activeWorlds.length) return true
  const w = (featureWorld || '').toLowerCase().replace(/[\s_-]+/g, '')
  if (w.includes('allworlds')) return true
  for (const a of activeWorlds) {
    const norm = a.toLowerCase().replace(/[\s_-]+/g, '')
    if (w.includes(norm)) return true
    const t = worldFor(norm)
    if (!t) continue
    if (w.includes(t.defaultTileset.toLowerCase())) return true
    for (const alias of t.aliases) {
      if (w.includes(alias.toLowerCase())) return true
    }
  }
  return false
}

// ── DOM helpers ────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

// ── Boot ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
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
  wireWelcomeTabs()
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
  // Open-map dialog.
  $('#open-back').addEventListener('click', closeOpenDialog)
  $('#open-filter').addEventListener('input', () => renderOpenList())
  $('#open-confirm').addEventListener('click', confirmOpenMap)
  wireOpenDialogKeyboard()
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

// ── Persisted prefs ──────────────────────────────────────────────────
// A handful of UI state lives outside any specific map and is worth
// remembering across reloads: drawer filters, the usedOnly / wreckage
// toggles, the animation + gridlines toggles, view mode, and the
// floating-panel visibility.  Stored as one JSON blob under a single
// localStorage key so we don't pollute the user's storage namespace.
const PREFS_KEY = 'kbot-studio:prefs:v1'
const PREF_FIELDS = ['usedOnly', 'includeWreckage', 'animateFeatures',
  'showGridlines', 'showMinimap', 'showCameraInfo', 'showFeatures', 'showVoids', 'showContours', 'showBuildable', 'showStartPositions',
  'viewMode', 'panelLayout', 'settings',
  // Model-viewer inspector panels.  Without these the close /
  // collapse / drag positions are written to state.* but never
  // serialised, so the panels would forget every preference on
  // reload — including a user's explicit close, which is exactly
  // the signal the "default visible" logic uses to decide whether
  // to auto-show next time.
  'mvInspectorVisible', 'mvInspectorCollapsed', 'mvInspectorPos',
  // Actions inspector's "Include Private" filter — preserved across
  // sessions so a user debugging internal helpers doesn't have to
  // re-tick the box on every reload.
  'mvActionsIncludePrivate']

// createPrefsStore returns a {load, save} interface backed by a Web
// Storage implementation (defaults to window.localStorage).  The
// abstraction lets the editor pass in a different backing store for
// tests, throw-away sessions ("Open in new tab" with prefs disabled),
// or future server-side sync.  All localStorage access in this file
// goes through this interface — nothing else calls window.localStorage
// directly.
function createPrefsStore({ key, storage } = {}) {
  const k = key || PREFS_KEY
  const s = storage !== undefined ? storage : (typeof window !== 'undefined' ? window.localStorage : null)
  return {
    load() {
      try {
        const raw = s?.getItem(k)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return (parsed && typeof parsed === 'object') ? parsed : null
      } catch { return null }
    },
    save(blob) {
      try { s?.setItem(k, JSON.stringify(blob)) } catch { /* incognito / quota / disabled */ }
    },
  }
}

// Module-level singleton for prefs persistence.  Swappable for tests by
// reassigning this to a different createPrefsStore() return value, or
// to a `{ load: () => null, save: () => {} }` no-op stub.
let prefsStore = createPrefsStore()

function loadPersistedPrefs() {
  const parsed = prefsStore.load()
  if (!parsed) return
  for (const k of PREF_FIELDS) {
    if (parsed[k] === undefined) continue
    state[k] = parsed[k]
  }
  // Push the loaded values onto any DOM mirrors so the menu rows
  // reflect them on first render.
  syncDomFromPrefs()
}

function syncDomFromPrefs() {
  const setOn = (id, on) => { const el = $(id); if (el) el.dataset.on = on ? '1' : '0' }
  setOn('#opt-gridlines', state.showGridlines)
  setOn('#opt-animate', state.animateFeatures)
  setOn('#opt-minimap', state.showMinimap)
  setOn('#opt-camera-info', state.showCameraInfo)
  setOn('#opt-voids', state.showVoids)
  setOn('#opt-contours', state.showContours)
  setOn('#opt-buildable', state.showBuildable)
  setOn('#opt-features', state.showFeatures)
  setOn('#opt-startpoints', state.showStartPositions)
  const used = $('#filter-used'); if (used) used.checked = !!state.usedOnly
  const wrk = $('#filter-wreckage'); if (wrk) wrk.checked = !!state.includeWreckage
  // View mode active row.
  $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r.dataset.display === state.viewMode))
  const viewLbl = $('#view-current-lbl')
  if (viewLbl) {
    const row = $$('#display-mode-group .menu-row').find((r) => r.dataset.display === state.viewMode)
    const span = row?.querySelector('span:not(.ico)')
    if (span) viewLbl.textContent = span.textContent
  }
  // Apply panel visibility flags.
  const mini = $('#minimap-panel')
  if (mini) mini.classList.toggle('hidden', !state.showMinimap)
  const cam = $('#camera-info-panel')
  if (cam) cam.classList.toggle('hidden', !state.showCameraInfo)
}

let prefsSaveTimer = null
function persistPrefs() {
  if (prefsSaveTimer) return
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null
    const blob = {}
    for (const k of PREF_FIELDS) blob[k] = state[k]
    prefsStore.save(blob)
  }, 250)
}

// ── Multi-tab management ────────────────────────────────────────────
//
// Each open map has one entry in `tabs` ({ map: MapDoc }) and one
// chip in the #map-tabs row.  activeTabIndex picks which is currently
// shown; the state Proxy forwards per-map field reads/writes to
// tabs[activeTabIndex].map.
//
// On a tab swap we:
//   1) Snapshot module-level lets (undoStack/redoStack/pending
//      transaction/minimapBase/minimapBaseStale + scroll position)
//      into the outgoing tab.
//   2) Abort transient gesture state (panning, painting in progress,
//      drag offsets) — switching tabs always cancels mid-gesture work.
//   3) Move activeTabIndex.
//   4) Restore the new tab's module-level lets.
//   5) Recreate the canvas DOM + GL context via recreateEditorView()
//      so the new map renders from a clean surface.
//   6) Render + restore scroll.

function snapshotActiveTabModuleLets() {
  if (activeTabIndex < 0) return
  const tab = tabs[activeTabIndex]
  // Model tabs have no .map / undo stack — bail out so we don't
  // throw on `m.undoStack = ...` when the outgoing tab is a 3DO.
  if (!tab || !tab.map) return
  const m = tab.map
  m.undoStack = undoStack.slice()
  m.redoStack = redoStack.slice()
  m.pendingTransaction = pendingTransaction
  m.minimapBase = minimapBase
  m.minimapBaseStale = minimapBaseStale
  const scroll = document.querySelector('#canvas-scroll')
  if (scroll) {
    m.scrollLeft = scroll.scrollLeft
    m.scrollTop = scroll.scrollTop
  }
}

function restoreActiveTabModuleLets() {
  if (activeTabIndex < 0) return
  const tab = tabs[activeTabIndex]
  // Same guard as snapshot — model tabs carry no map state.
  if (!tab || !tab.map) return
  const m = tab.map
  undoStack.length = 0
  for (const x of m.undoStack) undoStack.push(x)
  redoStack.length = 0
  for (const x of m.redoStack) redoStack.push(x)
  pendingTransaction = m.pendingTransaction
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
  // Model tabs have no dirty/save concept — just unhook GPU buffers
  // (the model3d module handles disposal when the next open() runs
  // or on viewer dispose) and drop the entry.
  if (tab.type === 'model') {
    tabs.splice(idx, 1)
    if (tabs.length === 0) {
      activeTabIndex = -1
      $('#model-viewer-dialog').classList.add('hidden')
      showWelcomeAfterLastTabClose()
      return
    }
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1
    switchToTab(activeTabIndex, { fresh: false, force: true })
    return
  }
  // Prompt before closing a dirty tab.  Move focus to that tab first
  // so the user can see what they're about to lose AND so a 'Save'
  // choice operates on this tab's data (save() reads state).
  if (tab.map.dirty) {
    if (idx !== activeTabIndex) switchToTab(idx, { force: true })
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
  if (idx === activeTabIndex) snapshotActiveTabModuleLets()
  tabs.splice(idx, 1)
  if (tabs.length === 0) {
    activeTabIndex = -1
    showWelcomeAfterLastTabClose()
    return
  }
  // Pick the previous tab if we closed the active one; otherwise stay
  // on the same active map.
  if (idx <= activeTabIndex) activeTabIndex = Math.max(0, activeTabIndex - (idx === activeTabIndex ? 0 : 0))
  if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1
  // Re-activate with restore semantics so the now-front tab repaints.
  switchToTab(activeTabIndex, { fresh: false, force: true })
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
  if (!force && nextIdx === activeTabIndex) return
  const outgoing = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
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
  abortTransientGestureState()
  activeTabIndex = nextIdx

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
    void activateModelTab(incoming)
    return
  }

  // Map tab: tear down any visible model overlay before the editor
  // takes the screen.
  $('#model-viewer-dialog')?.classList.add('hidden')

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
  const tab = tabs[activeTabIndex]
  if (tab) {
    const scroll = document.querySelector('#canvas-scroll')
    if (scroll) {
      scroll.scrollLeft = tab.map.scrollLeft || 0
      scroll.scrollTop = tab.map.scrollTop || 0
    }
  }
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
  // Single tab bar now — the .app's .map-tabs is shared between the
  // map editor and the 3DO viewer (the viewer's overlay sits under
  // the tabs row).
  const list = document.querySelector('#map-tabs-list')
  if (!list) return
  list.replaceChildren()
  for (let i = 0; i < tabs.length; i++) {
    list.appendChild(buildTabElement(tabs[i], i))
  }
}

function buildTabElement(tab, i) {
  const el = document.createElement('button')
  el.type = 'button'
  el.dataset.tabIndex = String(i)
  el.setAttribute('role', 'tab')

  let display
  let title
  let dirty = false
  let closeTitle
  if (tab.type === 'model') {
    display = tab.meta?.unitTitle || tab.name || '(model)'
    const metaBits = [tab.meta?.unitName?.toUpperCase(), tab.meta?.side, tab.meta?.category].filter(Boolean).join(' · ')
    title = `${display}${metaBits ? ` · ${metaBits}` : ''}`
    closeTitle = 'Close this model'
  } else {
    const m = tab.map
    display = mapDisplayName(m)
    dirty = !!m?.dirty
    title = `${display}${dirty ? ' (unsaved changes)' : ''} · ${m?.name || '(no file)'} · ${m?.tileW}×${m?.tileH}`
    closeTitle = 'Close this map'
  }

  el.className = 'map-tab'
    + (i === activeTabIndex ? ' active' : '')
    + (dirty ? ' dirty' : '')
    + (tab.type === 'model' ? ' map-tab-model' : '')
  el.title = title

  // Type icon: 3DO tabs get a tool glyph so map and model tabs are
  // distinguishable at a glance.
  if (tab.type === 'model') {
    const ico = document.createElement('span')
    ico.className = 'map-tab-icon'
    ico.textContent = '🛠'
    el.appendChild(ico)
  }
  const lbl = document.createElement('span')
  lbl.className = 'map-tab-label'
  lbl.textContent = dirty ? `${display}*` : display
  el.appendChild(lbl)
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'map-tab-close'
  close.textContent = '×'
  close.title = closeTitle
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i) })
  el.appendChild(close)
  el.addEventListener('click', () => switchToTab(i))
  return el
}

function wireMapTabBar() {
  const popup = document.querySelector('#map-tab-add-popup')
  if (!popup) return
  // The shared tab bar's "+" anchors the popup below it.  Position
  // uses fixed coords so the popup escapes its host bar's
  // overflow clip and overlays the model viewer dialog when that's
  // on top.
  const anchorPopup = (anchor) => {
    const r = anchor.getBoundingClientRect()
    popup.style.top = `${Math.round(r.bottom + 2)}px`
    popup.style.left = `${Math.round(r.left)}px`
  }
  const wireAddButton = (id) => {
    const btn = document.querySelector(id)
    if (!btn) return
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const willShow = popup.classList.contains('hidden')
      if (willShow) anchorPopup(btn)
      popup.classList.toggle('hidden')
    })
  }
  wireAddButton('#map-tab-add')

  document.querySelector('#map-tab-add-new')?.addEventListener('click', () => {
    popup.classList.add('hidden')
    // Open the size dialog in "append a tab" mode.  When the user
    // confirms, startEditor() pushes a brand-new tab.
    sizeDialogSource = 'tabbar'
    openSizeDialog()
  })
  document.querySelector('#map-tab-add-open')?.addEventListener('click', () => {
    popup.classList.add('hidden')
    openMapDialog('tabbar')
  })
  document.querySelector('#map-tab-add-model')?.addEventListener('click', () => {
    popup.classList.add('hidden')
    // 'add' so openModelViewer pushes a fresh model tab instead of
    // overwriting the active one — works from either tab bar.
    modelOpenIntent = 'add'
    openModelPicker()
  })
  // "New 3DO" is intentionally disabled today — the placeholder is
  // a click-through to nothing.  Wire it as a defensive no-op so
  // accidental clicks don't leave the popup open.
  document.querySelector('#map-tab-add-new-model')?.addEventListener('click', () => {
    popup.classList.add('hidden')
  })
  document.addEventListener('click', (e) => {
    if (popup.classList.contains('hidden')) return
    const addBtns = ['#map-tab-add'].map((id) => document.querySelector(id)).filter(Boolean)
    if (addBtns.some((b) => e.target === b || b.contains(e.target))) return
    if (popup.contains(e.target)) return
    popup.classList.add('hidden')
  })
}

async function maybeAutoOpenFromQuery() {
  let target
  try {
    target = new URLSearchParams(window.location.search).get('initial_map')
  } catch { return }
  if (!target) return
  const wanted = target.trim().toLowerCase()
  if (!wanted) return
  try {
    // Poll until the server's map catalogue has finished preloading —
    // the entry we're looking for may not be in the partial response
    // delivered before /api/studio/maps flips loading=false.
    let entries = []
    for (let i = 0; i < 30; i++) {
      const resp = await fetch('/api/studio/maps')
      const data = await resp.json()
      entries = data.maps || []
      const match = pickMapByName(entries, wanted)
      if (match) {
        const loadResp = await fetch('/api/studio/load?path=' + encodeURIComponent(match.path))
        if (!loadResp.ok) throw new Error(await loadResp.text() || `HTTP ${loadResp.status}`)
        const loaded = await loadResp.json()
        await openLoadedMap(loaded, match)
        return
      }
      if (!data.loading) break
      await new Promise(r => setTimeout(r, 250))
    }
    setStatus(`initial_map="${target}" not found in this kbot context.`)
  } catch (err) {
    setStatus(`Failed to auto-open ${target}: ${err.message || err}`)
  }
}

function pickMapByName(entries, wanted) {
  for (const m of entries) {
    if ((m.name || '').toLowerCase() === wanted) return m
    if ((m.missionName || '').toLowerCase() === wanted) return m
  }
  // Substring fallback so partial names like "metal heck" still match
  // a fuller "Metal Heck (Free)" if the catalogue carries the suffix.
  for (const m of entries) {
    const hay = `${m.name || ''} ${m.missionName || ''}`.toLowerCase()
    if (hay.includes(wanted)) return m
  }
  return null
}

// ── Server heartbeat ──────────────────────────────────────────────────────
// Polls /api/studio/heartbeat every HEARTBEAT_INTERVAL_MS to detect when
// the `kbot studio` CLI has been killed (or hit a deeper error).  Two
// consecutive failures flip the UI into a "disconnected" state — an
// orange card in the bottom-right and a translucent overlay that
// swallows clicks so the user doesn't try to edit against a dead
// backend.  Subsequent successful pings dismiss both immediately.

// Two cadences: idle polls slowly when everything's fine, then the
// moment we detect a drop switch to a faster retry rate so the
// reconnect feels snappy and the user knows the page is actively
// trying.  Both cadences come from settings (Settings dialog) so the
// user can tune them; the defaults match the original constants.
const HEARTBEAT_TIMEOUT_OK_MS = 4000
const HEARTBEAT_TIMEOUT_RETRY_MS = 1500
const DISCONNECT_THRESHOLD = 2 // consecutive failures before showing "disconnected"

let heartbeatState = 'connecting' // 'connecting' | 'connected' | 'disconnected'
let heartbeatFailures = 0
let heartbeatTimer = null
// Monotonically increases each time the status card is shown; the
// retry-counter UI reads this to display "retry N…" while the
// server is down so the user can see we're actually polling.
let heartbeatRetryCount = 0

function startServerHeartbeat() {
  // The first ping fires immediately so we know about a dead server
  // before the user takes any action.
  pingHeartbeat()
}

function scheduleNextHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  const idle = state.settings?.heartbeatIdleMs ?? 5000
  const retry = state.settings?.heartbeatReconnectMs ?? 1000
  const delay = heartbeatState === 'disconnected' ? retry : idle
  heartbeatTimer = setTimeout(pingHeartbeat, delay)
}

async function pingHeartbeat() {
  const ctrl = new AbortController()
  const timeoutMs = heartbeatState === 'disconnected' ? HEARTBEAT_TIMEOUT_RETRY_MS : HEARTBEAT_TIMEOUT_OK_MS
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let ok
  try {
    const resp = await fetch('/api/studio/heartbeat', {
      cache: 'no-store',
      signal: ctrl.signal,
    })
    ok = resp.ok
  } catch { ok = false }
  clearTimeout(timer)
  if (ok) {
    heartbeatFailures = 0
    if (heartbeatState !== 'connected') {
      heartbeatState = 'connected'
      heartbeatRetryCount = 0
      applyConnectionUI()
    }
  } else {
    heartbeatFailures++
    if (heartbeatFailures >= DISCONNECT_THRESHOLD && heartbeatState !== 'disconnected') {
      heartbeatState = 'disconnected'
      heartbeatRetryCount = 0
      applyConnectionUI()
    }
    if (heartbeatState === 'disconnected') {
      heartbeatRetryCount++
      const detail = document.querySelector('#connection-detail')
      if (detail) detail.textContent = `Reconnecting… (try ${heartbeatRetryCount})`
    }
  }
  scheduleNextHeartbeat()
}

function applyConnectionUI() {
  const card = $('#connection-card')
  const overlay = $('#disconnect-overlay')
  if (!card || !overlay) return
  const offline = heartbeatState === 'disconnected'
  card.classList.toggle('hidden', !offline)
  overlay.classList.toggle('hidden', !offline)
  if (!offline) {
    const detail = document.querySelector('#connection-detail')
    if (detail) detail.textContent = 'Reconnecting…'
  }
}

// ── Open Existing Map flow ────────────────────────────────────────────────

let availableMaps = []
let mapsLoading = false
let mapsPollTimer = null
let selectedMapPath = null
let openMapSource = 'welcome' // 'welcome' or 'editor' — controls where Back returns to
let sizeDialogSource = 'welcome' // same idea for the New-map size dialog

async function openMapDialog(source = 'welcome') {
  openMapSource = source
  // Hide every surface that might be in front of the picker — the
  // welcome screen on first boot, the 3DO viewer dialog when the
  // user clicks "Open Map" from a model tab.  Without this the
  // open list would render behind a higher-z-index dialog and look
  // like the click did nothing.
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog').classList.add('hidden')
  $('#open-dialog').classList.remove('hidden')
  $('#open-confirm').disabled = true
  selectedMapPath = null
  // Clear any text the user typed in a previous session — the filter
  // is session-scoped, not persisted, so each open is a clean start.
  const filter = $('#open-filter')
  if (filter) filter.value = ''
  if (mapsPollTimer) { clearTimeout(mapsPollTimer); mapsPollTimer = null }
  // Show skeleton immediately so the dialog never appears empty, then
  // start fetching.  fetchMaps polls until the server marks the catalog
  // as fully loaded.
  if (availableMaps.length === 0) mapsLoading = true
  renderOpenList()
  fetchMaps()
  // Cursor lands in the filter every open so the user can start
  // typing immediately — keeps the keyboard-driven flow alive.
  // A requestAnimationFrame deferral lets the dialog actually become
  // visible before we steal focus (Chrome ignores focus() on a
  // display:none ancestor).
  requestAnimationFrame(() => $('#open-filter')?.focus())
}

async function fetchMaps() {
  try {
    const resp = await fetch('/api/studio/maps')
    const data = await resp.json()
    availableMaps = data.maps || []
    mapsLoading = !!data.loading
  } catch (err) {
    availableMaps = []
    mapsLoading = false
    $('#open-list').innerHTML = `<div class="loading">Failed to load maps: ${escapeHTML(String(err))}</div>`
    return
  }
  renderOpenList()
  if (mapsLoading) {
    mapsPollTimer = setTimeout(fetchMaps, 500)
  }
}

// closeOpenDialog returns the user to whichever surface they came from —
// the Welcome modal on first boot, the 3DO viewer if the active tab is a
// model, or back to the map editor when they hit File → Open mid-session.
function closeOpenDialog() {
  $('#open-dialog').classList.add('hidden')
  if (mapsPollTimer) { clearTimeout(mapsPollTimer); mapsPollTimer = null }
  if (openMapSource === 'welcome') {
    $('#welcome-dialog').classList.remove('hidden')
    return
  }
  // Dialog opened from the editor / tabbar — pop back to whatever was
  // in front before.  Without this an active model tab leaves the
  // editor's .app on screen with no map loaded, which the user reads
  // as "the viewer broke".
  const active = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
  if (active?.type === 'model') {
    $('#model-viewer-dialog').classList.remove('hidden')
  } else if (active?.type === 'map') {
    $('#app')?.classList.remove('hidden')
  }
}

function renderOpenList() {
  const list = $('#open-list')
  const q = ($('#open-filter').value || '').trim().toLowerCase()
  const filtered = availableMaps.filter((m) => {
    if (!q) return true
    const hay = `${m.name} ${m.missionName || ''} ${m.planet || ''} ${m.numPlayers || ''}`.toLowerCase()
    return hay.includes(q)
  })
  if (filtered.length === 0) {
    // While the catalog is still loading, paint skeleton tiles instead
    // of "no matches" — even when the user is mid-type — so the filter
    // result doesn't lie about the empty result.
    if (mapsLoading) {
      const frag = document.createDocumentFragment()
      for (let i = 0; i < 8; i++) {
        const sk = document.createElement('div')
        sk.className = 'open-list-skeleton'
        sk.innerHTML = '<div class="thumb"></div><div class="line"></div><div class="line short"></div>'
        frag.appendChild(sk)
      }
      list.replaceChildren(frag)
      return
    }
    list.innerHTML = '<div class="loading">No maps in this context match.</div>'
    return
  }
  const frag = document.createDocumentFragment()
  for (const m of filtered) {
    const card = document.createElement('button')
    card.className = 'open-list-item'
    card.dataset.path = m.path
    if (m.path === selectedMapPath) card.classList.add('selected')
    const title = m.missionName || m.name
    const meta = [
      m.tileW && m.tileH ? `${m.tileW}×${m.tileH}` : null,
      m.planet || null,
      m.numPlayers ? `${m.numPlayers} players` : null,
    ].filter(Boolean).join(' · ')
    const thumb = m.minimapUrl
      ? `<img class="thumb" src="${m.minimapUrl}" alt="" loading="lazy" />`
      : `<div class="thumb"></div>`
    card.innerHTML = `${thumb}<div class="title">${escapeHTML(title)}</div><div class="meta">${escapeHTML(meta)}</div>`
    card.addEventListener('click', () => {
      selectedMapPath = m.path
      $$('.open-list-item').forEach((el) => el.classList.toggle('selected', el.dataset.path === m.path))
      $('#open-confirm').disabled = false
    })
    frag.appendChild(card)
  }
  list.replaceChildren(frag)
}

async function confirmOpenMap() {
  if (!selectedMapPath) return
  const card = availableMaps.find((x) => x.path === selectedMapPath)
  const confirmBtn = $('#open-confirm')
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Loading…' }
  try {
    const resp = await fetch('/api/studio/load?path=' + encodeURIComponent(selectedMapPath))
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
    const data = await resp.json()
    await openLoadedMap(data, card)
  } catch (err) {
    setStatus(`Failed to open ${card?.name || selectedMapPath}: ${err.message || err}`)
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Open' }
    return
  }
  if (confirmBtn) confirmBtn.textContent = 'Open'
}

// wireOpenDialogKeyboard makes the open-map list keyboard-navigable:
// Tab from the filter lands on the list, arrow keys move the
// kbd-focus marker through the visible cards (no DOM focus shuffling
// — that would scroll the dialog while typing), Enter loads the
// current selection.  Falls back gracefully when no cards are
// rendered (skeleton / empty state).
function wireOpenDialogKeyboard() {
  const filter = $('#open-filter')
  const list = $('#open-list')
  const dlg = $('#open-dialog')
  if (!filter || !list || !dlg) return
  // Escape dismisses the dialog from any focus location inside it.
  // The main editor-mode Escape handler in wireKeyboard() only mounts
  // after finishEditorBoot, so on the welcome → Open flow that path
  // isn't wired yet — handle it here so Esc works either way.
  // Capture phase ensures we beat the search-input's native
  // clear-on-escape behaviour.
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (dlg.classList.contains('hidden')) return
    e.preventDefault()
    e.stopPropagation()
    closeOpenDialog()
  }, true)

  function visibleCards() {
    return Array.from(list.querySelectorAll('.open-list-item'))
  }
  function setKbdFocus(idx) {
    const cards = visibleCards()
    if (cards.length === 0) return
    const wrapped = ((idx % cards.length) + cards.length) % cards.length
    cards.forEach((c, i) => c.classList.toggle('kbd-focus', i === wrapped))
    const target = cards[wrapped]
    // selectedMapPath also tracks the kbd cursor so Open Selected lights up.
    selectedMapPath = target.dataset.path
    cards.forEach((c) => c.classList.toggle('selected', c.dataset.path === selectedMapPath))
    $('#open-confirm').disabled = false
    target.scrollIntoView({ block: 'nearest' })
  }
  function currentIdx() {
    const cards = visibleCards()
    const i = cards.findIndex((c) => c.classList.contains('kbd-focus'))
    if (i >= 0) return i
    return cards.findIndex((c) => c.dataset.path === selectedMapPath)
  }
  // When focus first lands on the list (Tab from filter, or click on
  // empty list area), light up the first card so arrow keys have an
  // anchor immediately.  Without this the user would have to press
  // Arrow once "blind" to make the first selection visible.
  list.addEventListener('focus', () => {
    if (currentIdx() < 0) {
      const cards = visibleCards()
      if (cards.length > 0) setKbdFocus(0)
    }
  })
  // Type-ahead jump.  Letters / digits typed while the list has focus
  // accumulate into a small buffer and the first card whose visible
  // title starts with that buffer (case-insensitive) is highlighted.
  // Arrow keys clear the buffer so a "ME → ↑K" sequence ends up at
  // K, not "MEK".  TYPEAHEAD_TIMEOUT_MS also resets the buffer once
  // the user has paused — typical OS picker behaviour.
  const TYPEAHEAD_TIMEOUT_MS = 1000
  let typeaheadBuf = ''
  let typeaheadTimer = 0
  function resetTypeahead() {
    typeaheadBuf = ''
    if (typeaheadTimer) { clearTimeout(typeaheadTimer); typeaheadTimer = 0 }
  }
  function cardTitle(card) {
    // .title element holds the rendered name (mission or filename).
    return (card.querySelector('.title')?.textContent || '').toLowerCase()
  }
  function jumpToPrefix(buf) {
    const needle = buf.toLowerCase()
    const cards = visibleCards()
    const hit = cards.findIndex((c) => cardTitle(c).startsWith(needle))
    if (hit >= 0) setKbdFocus(hit)
  }
  // Arrow + Enter on the list itself.
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (selectedMapPath) { e.preventDefault(); confirmOpenMap() }
      return
    }
    const cards = visibleCards()
    if (cards.length === 0) return
    const cols = 4 // matches .open-list grid-template-columns
    const cur = currentIdx()
    let next
    if (e.key === 'ArrowDown')      next = cur < 0 ? 0 : cur + cols
    else if (e.key === 'ArrowUp')   next = cur < 0 ? 0 : cur - cols
    else if (e.key === 'ArrowRight')next = cur < 0 ? 0 : cur + 1
    else if (e.key === 'ArrowLeft') next = cur < 0 ? 0 : cur - 1
    else if (e.key === 'Home')      next = 0
    else if (e.key === 'End')       next = cards.length - 1
    else {
      // Type-ahead: any single printable character feeds the prefix
      // buffer.  Filtering modifier+key combos (Ctrl+A, Alt+X) keeps
      // the dialog's other shortcuts working.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /[a-z0-9 \-_]/i.test(e.key)) {
        e.preventDefault()
        typeaheadBuf += e.key
        jumpToPrefix(typeaheadBuf)
        if (typeaheadTimer) clearTimeout(typeaheadTimer)
        typeaheadTimer = setTimeout(resetTypeahead, TYPEAHEAD_TIMEOUT_MS)
      } else if (e.key === 'Backspace') {
        // Shorten the buffer one char at a time so the user can fix
        // a typo without starting over.
        e.preventDefault()
        typeaheadBuf = typeaheadBuf.slice(0, -1)
        if (typeaheadBuf) {
          jumpToPrefix(typeaheadBuf)
          if (typeaheadTimer) clearTimeout(typeaheadTimer)
          typeaheadTimer = setTimeout(resetTypeahead, TYPEAHEAD_TIMEOUT_MS)
        } else {
          resetTypeahead()
        }
      }
      return
    }
    e.preventDefault()
    // Any arrow key clears the type-ahead — "ME ↑ K" ends at K.
    resetTypeahead()
    setKbdFocus(next)
  })
  // Enter on the filter — if the current filter narrows to one map,
  // pressing Enter opens it.  Saves a Tab → Enter round-trip when
  // the user already knows what they want.
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const cards = visibleCards()
    if (cards.length === 0) return
    // Pick the kbd-focused card if any, else the first.
    const cur = currentIdx()
    const idx = cur >= 0 ? cur : 0
    e.preventDefault()
    setKbdFocus(idx)
    confirmOpenMap()
  })
  // Arrow down from the filter jumps into the list with the first
  // card focused — quicker than Tab for keyboard-only users.
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      const cards = visibleCards()
      if (cards.length === 0) return
      e.preventDefault()
      list.focus()
      setKbdFocus(currentIdx() >= 0 ? currentIdx() : 0)
    }
  })
}

// openLoadedMap hydrates editor state from a /api/studio/load response
// and jumps straight into the editor (skipping the New-map size
// dialog).  The TNT's tile pool is fetched as a synthetic "section"
// keyed `tnt:<path>` — the rest of the render/save path treats it like
// any other section thanks to the `tnt:` prefix branch in builder.go.
// wireWelcomeKeyboard makes the welcome dialog navigable from the
// keyboard.  ArrowLeft / ArrowRight toggle focus between the New
// and Open cards; Enter activates whichever is focused.  Focus
// lands on New the first time the dialog becomes visible, so the
// user can drive the whole picker without touching the mouse.
// Ctrl+Up / Ctrl+Left/Right are reserved for future tab switching
// (Mapping / Modelling / Scripting / Other) — not wired yet.
function wireWelcomeKeyboard() {
  const wel = $('#welcome-dialog')
  const cards = [$('#welcome-new'), $('#welcome-open')]
  if (!wel || cards.some((c) => !c)) return
  const focusCard = (i) => {
    const idx = ((i % cards.length) + cards.length) % cards.length
    cards[idx].focus()
  }
  wel.addEventListener('keydown', (e) => {
    if (wel.classList.contains('hidden')) return
    const i = cards.indexOf(document.activeElement)
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusCard(i < 0 ? 0 : i - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusCard(i < 0 ? 0 : i + 1)
    } else if (e.key === 'Enter') {
      // Enter is already native button activation when a card has
      // focus.  We only intercept when nothing's focused so the
      // user gets a sensible default (the New card).
      if (i < 0) {
        e.preventDefault()
        cards[0].click()
      }
    }
  })
  // Focus New on first show.  MutationObserver fires whenever the
  // welcome dialog's class list changes so re-shows (closing a map
  // back to welcome) re-focus too.
  const sync = () => {
    if (wel.classList.contains('hidden')) return
    // rAF defers the focus call until the dialog is actually
    // displayed — Chrome ignores focus() on a hidden ancestor.
    requestAnimationFrame(() => {
      if (!wel.classList.contains('hidden')) cards[0].focus()
    })
  }
  new MutationObserver(sync).observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}

// wireWelcomeDropZone binds dragover/drop on the welcome modal so the
// user can drop a .tnt (+ optional .ota sibling) from their desktop
// ── Welcome dialog nanolathe FX ───────────────────────────────────────
//
// Two emitters at the bottom-left + bottom-right of the viewport fire
// bright-green particle streams toward the centre of the welcome
// dialog card.  On impact the particles burst into short-lived sparks
// that scatter along the card edge, and the card itself briefly
// pulses a green glow via a CSS animation.  Pure visual fluff while
// the user picks New vs Open.
//
// The whole thing runs on requestAnimationFrame only while the
// welcome dialog is visible — wireWelcomeNanoFX() starts the loop at
// boot, and the loop self-suspends when #welcome-dialog gets the
// `hidden` class.

const NANO_GREEN_CORE = 'rgba(220, 255, 200, 1)'
const NANO_GREEN_BODY = 'rgba(127, 255, 102, 0.9)'
const NANO_GREEN_TAIL = 'rgba(80, 220, 80, 0.0)'

function wireWelcomeNanoFX() {
  const wel = document.querySelector('#welcome-dialog')
  const cv = document.querySelector('#welcome-nanofx')
  if (!wel || !cv) return
  const ctx = cv.getContext('2d')
  let particles = []    // beam particles fired from the emitters
  let sparks = []       // short-lived sparks at the impact points
  let hotspots = []     // localised border glow at recent impacts
  let cardRect = null   // cached card bounding rect for impact checks
  let running = false
  let rafId = 0
  // Emission budget — fractional carry-over so the rate is frame-rate
  // independent.  ~180 beams/sec/side so the cloud reads as a true
  // spray, paired with the smaller per-particle size below so the
  // total ink on screen stays manageable.
  const EMIT_RATE_PER_SIDE = 180
  let emitBudgetL = 0, emitBudgetR = 0
  // Sweep phase — drives the aim point left↔right across the card so
  // each emitter behaves like a spray-can sweeping a stripe of
  // particles onto the dialog edge.  Counter-phase per side.
  let sweepT = 0

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = Math.round(window.innerWidth * dpr)
    cv.height = Math.round(window.innerHeight * dpr)
    cv.style.width = window.innerWidth + 'px'
    cv.style.height = window.innerHeight + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  function emitterPoint(side) {
    const margin = 40
    return side === 'left'
      ? { x: margin, y: window.innerHeight - margin }
      : { x: window.innerWidth - margin, y: window.innerHeight - margin }
  }
  function cardCentre() {
    const card = wel.querySelector('.dialog-card')
    if (!card) return null
    const r = card.getBoundingClientRect()
    cardRect = r
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  // sweepAim returns the per-side target on the card.  Phase is
  // offset 180° between sides so the two streams sweep in opposite
  // directions (each painting from its near edge across).
  function sweepAim(side) {
    if (!cardRect) return null
    // Sweep nearly the full card width, capped so very wide viewports
    // don't send the streams off to the corners.
    const range = Math.min(cardRect.width * 0.65, 420)
    const phase = side === 'left' ? sweepT : sweepT + Math.PI
    const tx = cardRect.left + cardRect.width / 2 + Math.sin(phase) * range
    const ty = cardRect.top + cardRect.height * 0.5 + Math.cos(phase * 1.7) * Math.min(cardRect.height * 0.45, 110)
    return { x: tx, y: ty }
  }

  function emit(side) {
    const src = emitterPoint(side)
    const target = sweepAim(side)
    if (!target) return
    // Big cone of jitter — turns each emission into a dust cloud
    // rather than a tracked beam.  The wider the jitter, the more
    // the per-particle paths fan out across the card edge.
    const tx = target.x + (Math.random() - 0.5) * 320
    const ty = target.y + (Math.random() - 0.5) * 220
    const dx = tx - src.x, dy = ty - src.y
    const len = Math.max(1, Math.hypot(dx, dy))
    // Speed and TTL both scale with the actual flight distance — on
    // a 4K display the corner-to-card hop is ~1500px, well past the
    // old fixed 800px reach, so the beams used to fizzle in mid-air.
    // Target flight time of ~0.9s regardless of viewport: speed ≈
    // distance / 0.9, clamped to keep small-screen speeds reasonable.
    const targetFlightSec = 0.9
    const speed = Math.max(360, Math.min(2200, len / targetFlightSec)) * (0.85 + Math.random() * 0.3)
    // TTL has to outlast the actual flight or the particle dies en
    // route.  Headroom of ~30% covers the random speed variance.
    const ttl = Math.max(0.85, (len / speed) * 1.3) + Math.random() * 0.2
    particles.push({
      x: src.x, y: src.y,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      life: 0, ttl,
      // Far smaller dots so the higher density doesn't read as a
      // solid green plate — individual sparks of nanolathe dust.
      size: 0.4 + Math.random() * 0.6,
      side,
    })
  }

  function spawnSparks(x, y) {
    const count = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const s = 70 + Math.random() * 130
      sparks.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 60,
        life: 0, ttl: 0.30 + Math.random() * 0.30,
        size: 1.2 + Math.random() * 1.2,
      })
    }
  }

  // Hotspot = a soft glow blob anchored to a specific point on the
  // card edge.  Replaces the previous "entire card flashes" CSS
  // animation — only the bit of border the particle actually hit
  // brightens, and it fades over ~350ms.
  function spawnHotspot(x, y, edge) {
    hotspots.push({ x, y, edge, life: 0, ttl: 0.35 })
  }

  function step(dt) {
    sweepT += dt * 1.6 // rad/sec; full sweep cycle ≈ 4s

    emitBudgetL += dt * EMIT_RATE_PER_SIDE
    emitBudgetR += dt * EMIT_RATE_PER_SIDE
    while (emitBudgetL >= 1) { emit('left'); emitBudgetL -= 1 }
    while (emitBudgetR >= 1) { emit('right'); emitBudgetR -= 1 }

    const keep = []
    for (const p of particles) {
      p.life += dt
      if (p.life >= p.ttl) continue
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (cardRect && p.x >= cardRect.left && p.x <= cardRect.right
          && p.y >= cardRect.top && p.y <= cardRect.bottom) {
        const dl = p.x - cardRect.left
        const dr = cardRect.right - p.x
        const dt2 = p.y - cardRect.top
        const db = cardRect.bottom - p.y
        const m = Math.min(dl, dr, dt2, db)
        let ix = p.x, iy = p.y, edge
        if (m === dl) { ix = cardRect.left; edge = 'left' }
        else if (m === dr) { ix = cardRect.right; edge = 'right' }
        else if (m === dt2) { iy = cardRect.top; edge = 'top' }
        else { iy = cardRect.bottom; edge = 'bottom' }
        spawnSparks(ix, iy)
        spawnHotspot(ix, iy, edge)
        continue
      }
      keep.push(p)
    }
    particles = keep

    const keepSparks = []
    for (const s of sparks) {
      s.life += dt
      if (s.life >= s.ttl) continue
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.vy += 220 * dt
      keepSparks.push(s)
    }
    sparks = keepSparks

    const keepHots = []
    for (const h of hotspots) {
      h.life += dt
      if (h.life >= h.ttl) continue
      keepHots.push(h)
    }
    hotspots = keepHots
  }

  function draw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

    // Beam trails first so sparks + hotspots layer on top.
    for (const p of particles) {
      const src = emitterPoint(p.side)
      const tailDX = src.x - p.x
      const tailDY = src.y - p.y
      const tlen = Math.max(1, Math.hypot(tailDX, tailDY))
      // Shorter tail — the dots are far smaller now, so a long
      // streak would dominate the frame and undo the dust look.
      const tailLen = Math.min(14, tlen * 0.08)
      const tx = p.x + (tailDX / tlen) * tailLen
      const ty = p.y + (tailDY / tlen) * tailLen
      const grad = ctx.createLinearGradient(p.x, p.y, tx, ty)
      grad.addColorStop(0, NANO_GREEN_CORE)
      grad.addColorStop(0.3, NANO_GREEN_BODY)
      grad.addColorStop(1, NANO_GREEN_TAIL)
      ctx.strokeStyle = grad
      ctx.lineWidth = p.size
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
    }

    // Hotspots — soft radial glow stuck to the impacted edge segment.
    // Only the bit of border the particle hit brightens; the rest of
    // the card frame stays dark.
    for (const h of hotspots) {
      const t = 1 - (h.life / h.ttl)
      const radius = 22
      const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, radius)
      g.addColorStop(0, `rgba(220, 255, 200, ${0.85 * t})`)
      g.addColorStop(0.4, `rgba(127, 255, 102, ${0.55 * t})`)
      g.addColorStop(1, 'rgba(80, 220, 80, 0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(h.x, h.y, radius, 0, Math.PI * 2)
      ctx.fill()
      // Thin bright line along the impacted edge to read as a flash on
      // the dialog border, not just a generic blob in mid-air.
      const segLen = 26
      ctx.strokeStyle = `rgba(180, 255, 150, ${0.7 * t})`
      ctx.lineWidth = 2
      ctx.beginPath()
      if (h.edge === 'top' || h.edge === 'bottom') {
        ctx.moveTo(h.x - segLen / 2, h.y)
        ctx.lineTo(h.x + segLen / 2, h.y)
      } else {
        ctx.moveTo(h.x, h.y - segLen / 2)
        ctx.lineTo(h.x, h.y + segLen / 2)
      }
      ctx.stroke()
    }

    // Sparks last.
    for (const s of sparks) {
      const t = 1 - (s.life / s.ttl)
      ctx.fillStyle = `rgba(180, 255, 150, ${t * 0.95})`
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.size * t + 0.4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  let lastTime = 0
  function frame(now) {
    if (!running) return
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0)
    lastTime = now
    cardCentre() // refresh cardRect
    step(dt)
    draw()
    rafId = requestAnimationFrame(frame)
  }

  function start() {
    if (running) return
    running = true
    lastTime = performance.now()
    rafId = requestAnimationFrame(frame)
  }
  function stop() {
    if (!running) return
    running = false
    cancelAnimationFrame(rafId)
    particles.length = 0
    sparks.length = 0
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  }

  // Drive start/stop off the welcome dialog's `hidden` class so the
  // loop only burns frames while the user is actually looking at the
  // dialog.  MutationObserver catches programmatic class changes from
  // startEditor / openLoadedMap.
  const sync = () => {
    if (wel.classList.contains('hidden')) stop(); else start()
  }
  const obs = new MutationObserver(sync)
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}

// Welcome glamour slideshow — TA ships ~50 splash PCXs under
// bitmaps/glamour/.  We fade through them behind the welcome card,
// rotating every WELCOME_GLAMOUR_INTERVAL_MS.  The next image is
// fetched into a hidden <img> first; only after `decode()` resolves
// do we cross-fade, so the user never sees a partial paint.
const WELCOME_GLAMOUR_INTERVAL_MS = 15000

// One-shot "construction" cue on the welcome screen.  Plays once
// when the user first interacts with the page (autoplay gate), then
// stays silent — the looping ambient was too persistent so we
// reduced it to a single bookend that lines up with the dialog's
// "particles constructing the display" theme.
//
// Implementation goes through Web Audio (not HTMLAudioElement) for
// two reasons: TA's WAVs are 8-bit PCM at 11025 Hz and Chrome's
// <audio> element handles those unreliably (silent-decode bugs that
// vary by version); and AudioContext.resume() is the
// canonical way to satisfy the autoplay gate via a user gesture.
const WELCOME_AMBIENT_VOLUME = 0.18

function wireWelcomeAmbient() {
  const wel = $('#welcome-dialog')
  if (!wel) return
  const AudioCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioCtor) return // older browsers — silently skip
  let ctx = null
  let buffer = null
  let activeSrc = null
  let kicked = false
  let visible = !wel.classList.contains('hidden')

  // Fetch + decode at boot so playback on first gesture is instant.
  async function loadBuffer() {
    try {
      const resp = await fetch('/api/studio/sound/build1')
      if (!resp.ok) return
      const data = await resp.arrayBuffer()
      ctx = ctx || new AudioCtor()
      buffer = await new Promise((resolve, reject) => {
        // Use the callback form — Safari historically didn't return a
        // Promise from decodeAudioData even though the modern signature
        // does.  Either form works in Chrome / Firefox.
        ctx.decodeAudioData(data, resolve, reject)
      })
    } catch { /* decode failed — silently no-op */ }
  }
  loadBuffer()

  function tryPlay() {
    if (!buffer || !ctx) return
    if (ctx.state === 'suspended') ctx.resume()
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    gain.gain.value = WELCOME_AMBIENT_VOLUME
    src.connect(gain).connect(ctx.destination)
    src.start()
    activeSrc = src
    src.addEventListener('ended', () => { if (activeSrc === src) activeSrc = null })
  }
  function stop() {
    if (!activeSrc) return
    try { activeSrc.stop() } catch { /* already stopped */ }
    activeSrc = null
  }

  const onGesture = () => {
    if (kicked) return
    kicked = true
    if (visible) tryPlay()
  }
  // First user input anywhere in the page satisfies the autoplay gate.
  for (const ev of ['pointerdown', 'pointermove', 'keydown']) {
    document.addEventListener(ev, onGesture, { once: true, passive: true })
  }

  // Stop on dialog hide so closing the welcome screen mid-play
  // cuts the sound cleanly.  No restart on re-show — it's a one-
  // shot bookend, not an ambient loop.
  const obs = new MutationObserver(() => {
    visible = !wel.classList.contains('hidden')
    if (!visible) stop()
  })
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
}

function wireWelcomeGlamour() {
  const wel = $('#welcome-dialog')
  const imgA = $('#welcome-glamour-a')
  const imgB = $('#welcome-glamour-b')
  if (!wel || !imgA || !imgB) return
  let slugs = []
  let order = []          // shuffled index list — exhausted before reshuffle so we cycle without repeats
  let active = imgA       // currently-visible <img>
  let standby = imgB      // the one we paint into next
  let timer = 0
  let started = false

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }
  const nextSlug = () => {
    if (slugs.length === 0) return null
    if (order.length === 0) {
      order = shuffle([...slugs.keys()])
      // Avoid repeating the just-shown slug back-to-back when the
      // reshuffle happens to put it first.
      const lastSrc = active.src
      if (slugs.length > 1 && order.length > 0) {
        const top = slugs[order[0]]
        if (top && lastSrc.endsWith('/' + top)) {
          // Rotate one off the front to break the repeat.
          order.push(order.shift())
        }
      }
    }
    return slugs[order.shift()]
  }
  const swap = () => {
    const tmp = active
    active = standby
    standby = tmp
  }
  async function loadInto(img, slug) {
    img.src = `/api/studio/glamour/image/${encodeURIComponent(slug)}`
    if (typeof img.decode === 'function') {
      try { await img.decode() } catch { /* fall back to natural load */ }
    } else {
      await new Promise((r) => { img.onload = r; img.onerror = r })
    }
  }
  async function tick() {
    const slug = nextSlug()
    if (!slug) return
    await loadInto(standby, slug)
    if (wel.classList.contains('hidden')) return // dialog closed mid-load
    standby.classList.add('visible')
    active.classList.remove('visible')
    swap()
  }
  async function start() {
    if (started) return
    started = true
    try {
      const resp = await fetch('/api/studio/glamour/list')
      if (!resp.ok) return
      const data = await resp.json()
      slugs = Array.isArray(data.images) ? data.images : []
    } catch { return }
    if (slugs.length === 0) return
    // First image: load, then fade in.
    const slug = nextSlug()
    if (!slug) return
    await loadInto(active, slug)
    if (wel.classList.contains('hidden')) return
    active.classList.add('visible')
    timer = setInterval(tick, WELCOME_GLAMOUR_INTERVAL_MS)
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = 0 }
  }
  // Drive start/stop off the dialog's `hidden` class — same pattern
  // the nanofx loop uses.  The slideshow only fires while the user
  // is actually looking at the welcome screen.
  const sync = () => {
    if (wel.classList.contains('hidden')) stop()
    else start()
  }
  const obs = new MutationObserver(sync)
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}

// and have the editor load it without going through VFS.  The drop
// targets are the welcome-options grid; the body is a fallback so the
// page doesn't navigate away when a file misses the modal.
function wireWelcomeDropZone() {
  const wel = $('#welcome-dialog')
  if (!wel) return
  const block = (e) => { e.preventDefault(); e.stopPropagation() }
  for (const ev of ['dragenter', 'dragover']) {
    wel.addEventListener(ev, (e) => { block(e); wel.classList.add('drop-hover') })
  }
  for (const ev of ['dragleave', 'drop']) {
    wel.addEventListener(ev, (e) => { block(e); wel.classList.remove('drop-hover') })
  }
  wel.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length === 0) return
    let tntFile = null
    let otaFile = null
    for (const f of files) {
      const lower = (f.name || '').toLowerCase()
      if (lower.endsWith('.tnt')) tntFile = f
      else if (lower.endsWith('.ota')) otaFile = f
    }
    if (!tntFile) {
      setStatus('Drop a .tnt file (and optionally a sibling .ota) to load.')
      return
    }
    const form = new FormData()
    form.append('tnt', tntFile)
    if (otaFile) form.append('ota', otaFile)
    try {
      const resp = await fetch('/api/studio/load-upload', { method: 'POST', body: form })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      $('#welcome-dialog').classList.add('hidden')
      $('#app').classList.remove('hidden')
      await openLoadedMap(data, null)
      setStatus(`Loaded ${tntFile.name}.`)
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`)
    }
  })
}

async function openLoadedMap(data, card) {
  const w = data.tileW || 128
  const h = data.tileH || 128
  // Push a brand-new MapDoc as the active tab.  Snapshot the
  // outgoing tab first so its undo stack / minimap cache survive,
  // then restore from the fresh MapDoc so the previous map's
  // minimap doesn't leak across.  Subsequent state.X writes land
  // in this new MapDoc — the prior tab keeps its own state intact
  // in tabs[], reachable by clicking back.
  if (activeTabIndex >= 0) snapshotActiveTabModuleLets()
  tabs.push({ type: 'map', map: new MapDoc() })
  activeTabIndex = tabs.length - 1
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
  updateTopbarDocInfo(tabs[activeTabIndex])

  // Wire up the canvas + drawer just like startEditor would have done
  // for a fresh map.
  await finishEditorBoot()
  // Belt-and-braces: snap state.zoom back to 1.0 in case any wheel
  // event leaked between map loads (e.g. while the user was clicking
  // through the Open dialog), then force one more GL render with the
  // clean state so the new map's atlas texture is guaranteed to be
  // uploaded before the user looks at it.
  if (Math.abs((state.zoom || 1) - 1) < 0.05) state.zoom = 1
  if (gl && gl.ctx && gl.textures) {
    for (const t of gl.textures.values()) {
      if (t && t.tex) gl.ctx.deleteTexture(t.tex)
    }
    gl.textures.clear()
  }
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
  if (activeTabIndex >= 0) snapshotActiveTabModuleLets()
  tabs.push({ type: 'map', map: new MapDoc() })
  activeTabIndex = tabs.length - 1
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
  updateTopbarDocInfo(tabs[activeTabIndex])

  await finishEditorBoot()
}

// ── Dice-face player-count picker (size dialog) ────────────────────────
//
// Lives inside #size-dialog.  Selecting multiple counts seeds that many
// Network N schemas when the editor starts.  At least one count must
// stay selected so the editor always has a schema to render.

const DICE_PLAYER_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10]
const dicePicked = new Set([8]) // sensible default — a single 8-player schema

function pickedPlayerCounts() {
  const sorted = Array.from(dicePicked).sort((a, b) => a - b)
  return sorted.length > 0 ? sorted : [4]
}

// PLAYER_COUNT_NAMES — used for both the dice picker caption and the
// schema row labels so the wording stays consistent everywhere.
const PLAYER_COUNT_NAMES = {
  2: 'Two Players',
  3: 'Three Players',
  4: 'Four Players',
  5: 'Five Players',
  6: 'Six Players',
  7: 'Seven Players',
  8: 'Eight Players',
  9: 'Nine Players',
  10: 'Ten Players',
}
function playerCountLabel(n) { return PLAYER_COUNT_NAMES[n] || `${n} Players` }

// populateWorldSelect rewrites a <select>'s options from the WORLDS
// table.  `valueKind` picks whether the option value is the slug
// (matches state.planet — used by the New-map picker) or the
// default-tileset string (matches .ota.planet — used by the
// Properties dialog).  Called once at boot for each picker.
function populateWorldSelect(el, valueKind) {
  if (!el) return
  el.replaceChildren(...WORLDS.map((t) => {
    const opt = document.createElement('option')
    opt.value = valueKind === 'slug' ? t.slug : t.defaultTileset
    opt.textContent = t.label
    return opt
  }))
}

function renderDiceGrid() {
  const grid = $('#size-dice-grid')
  if (!grid) return
  const frag = document.createDocumentFragment()
  for (const n of DICE_PLAYER_COUNTS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dice-face' + (dicePicked.has(n) ? ' selected' : '')
    btn.dataset.count = String(n)
    btn.title = `${playerCountLabel(n)} (Network ${n})`
    const art = document.createElement('div')
    art.className = 'dice-face-art'
    art.appendChild(buildDicePips(n))
    btn.appendChild(art)
    const caption = document.createElement('span')
    caption.className = 'dice-caption'
    caption.textContent = playerCountLabel(n)
    btn.appendChild(caption)
    btn.addEventListener('click', () => {
      if (dicePicked.has(n)) {
        if (dicePicked.size <= 1) return // keep at least one selected
        dicePicked.delete(n)
      } else {
        dicePicked.add(n)
      }
      renderDiceGrid()
    })
    frag.appendChild(btn)
  }
  grid.replaceChildren(frag)
}

// buildDicePips returns a domino-style face with exactly N pips.  Pips
// are absolutely positioned (in % within the 44px art square) so we
// don't run into the 4×4-grid problem where the centre dot needs 4
// cells to look centred and the count ends up wrong.
function buildDicePips(n) {
  const wrap = document.createElement('div')
  wrap.className = 'dice-pips'
  const positions = DICE_PIP_POSITIONS[n] || []
  for (const [px, py] of positions) {
    const dot = document.createElement('span')
    dot.style.left = (px * 100) + '%'
    dot.style.top = (py * 100) + '%'
    wrap.appendChild(dot)
  }
  return wrap
}

// DICE_PIP_POSITIONS — each entry is a list of [x, y] normalised to
// the pip area (0..1).  Faces 1..6 are the canonical d6 layouts; 7..10
// extend the pattern dominos-style (3-1-3, 3-2-3, 3-3-3, 4-2-4).  The
// arrays here are what's actually rendered, so the dot count matches
// the player count by construction.
const DICE_PIP_POSITIONS = {
  1:  [[0.50, 0.50]],
  2:  [[0.25, 0.25], [0.75, 0.75]],
  3:  [[0.22, 0.22], [0.50, 0.50], [0.78, 0.78]],
  4:  [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5:  [[0.22, 0.22], [0.78, 0.22], [0.50, 0.50], [0.22, 0.78], [0.78, 0.78]],
  6:  [[0.25, 0.18], [0.75, 0.18], [0.25, 0.50], [0.75, 0.50], [0.25, 0.82], [0.75, 0.82]],
  7:  [[0.22, 0.18], [0.50, 0.18], [0.78, 0.18], [0.50, 0.50], [0.22, 0.82], [0.50, 0.82], [0.78, 0.82]],
  8:  [[0.22, 0.18], [0.50, 0.18], [0.78, 0.18], [0.22, 0.50], [0.78, 0.50], [0.22, 0.82], [0.50, 0.82], [0.78, 0.82]],
  9:  [[0.22, 0.18], [0.50, 0.18], [0.78, 0.18], [0.22, 0.50], [0.50, 0.50], [0.78, 0.50], [0.22, 0.82], [0.50, 0.82], [0.78, 0.82]],
  10: [[0.18, 0.18], [0.39, 0.18], [0.61, 0.18], [0.82, 0.18], [0.32, 0.50], [0.68, 0.50], [0.18, 0.82], [0.39, 0.82], [0.61, 0.82], [0.82, 0.82]],
}

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
  // into the new map's empty filter (#36).
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
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  })
  $('#filter').addEventListener('input', (e) => {
    // Remember the filter per-tab — typing on Sections shouldn't
    // narrow what's visible on Features when the user switches.
    state.drawerFilters[state.drawer] = e.target.value
    renderDrawer()
    persistPrefs()
  })
  $('#filter-used').addEventListener('change', (e) => {
    state.usedOnly = e.target.checked
    renderDrawer()
    persistPrefs()
  })
  $('#filter-wreckage').addEventListener('change', (e) => {
    state.includeWreckage = e.target.checked
    renderDrawer()
    persistPrefs()
  })
}

// ── Mode toolbar + View menu wiring ────────────────────────────────────────

function wireModeToolbar() {
  // Mode is now a dropdown — the popup hosts the menu rows, and the
  // visible button shows the current selection.
  const btn = $('#mode-dropdown-btn')
  const popup = $('#mode-dropdown-popup')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    closeAllRibbonDropdowns(popup)
    positionRibbonPopup(btn, popup)
    popup.classList.toggle('hidden')
  })
  $$('#mode-dropdown-popup .menu-row').forEach((row) => {
    row.addEventListener('click', () => {
      setMode(row.dataset.mode)
      popup.classList.add('hidden')
    })
  })
  refreshModeDropdown()
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
  const btn = $('#view-dropdown-btn')
  const popup = $('#view-dropdown-popup')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    closeAllRibbonDropdowns(popup)
    positionRibbonPopup(btn, popup)
    popup.classList.toggle('hidden')
  })
  const gridBtn = $('#opt-gridlines')
  const animBtn = $('#opt-animate')
  gridBtn.addEventListener('click', () => {
    state.showGridlines = !state.showGridlines
    gridBtn.dataset.on = state.showGridlines ? '1' : '0'
    renderCanvas()
    persistPrefs()
  })
  animBtn.addEventListener('click', () => {
    state.animateFeatures = !state.animateFeatures
    animBtn.dataset.on = state.animateFeatures ? '1' : '0'
    renderDrawer()
    renderCanvas()
    persistPrefs()
  })
  const miniBtn = $('#opt-minimap')
  if (miniBtn) {
    miniBtn.addEventListener('click', () => {
      setMinimapVisible(!state.showMinimap)
    })
  }
  const camBtn = $('#opt-camera-info')
  if (camBtn) {
    camBtn.addEventListener('click', () => {
      setCameraInfoVisible(!state.showCameraInfo)
    })
  }
  const voidsBtn = $('#opt-voids')
  if (voidsBtn) {
    voidsBtn.addEventListener('click', () => {
      setVoidsVisible(!state.showVoids)
    })
  }
  const contoursBtn = $('#opt-contours')
  if (contoursBtn) {
    contoursBtn.addEventListener('click', () => {
      state.showContours = !state.showContours
      contoursBtn.dataset.on = state.showContours ? '1' : '0'
      persistPrefs()
      renderCanvas()
    })
  }
  const buildableBtn = $('#opt-buildable')
  if (buildableBtn) {
    buildableBtn.addEventListener('click', () => {
      state.showBuildable = !state.showBuildable
      buildableBtn.dataset.on = state.showBuildable ? '1' : '0'
      persistPrefs()
      renderCanvas()
    })
  }
  $('#opt-features')?.addEventListener('click', () => setFeaturesVisible(!state.showFeatures))
  $('#opt-startpoints')?.addEventListener('click', () => setStartPositionsVisible(!state.showStartPositions))
  const camToggle = $('#camera-info-toggle')
  if (camToggle) {
    camToggle.addEventListener('click', () => {
      const panel = $('#camera-info-panel')
      if (!panel) return
      panel.classList.toggle('collapsed')
      camToggle.textContent = panel.classList.contains('collapsed') ? '+' : '−'
      persistPanelCollapsed('camera-info-panel', panel.classList.contains('collapsed'))
    })
  }
  // Drag handle on the camera-info panel header — mirrors the dev-stats
  // and minimap panels so all three behave the same way.
  makePanelDraggable($('#camera-info-panel'), $('#camera-info-header'))
  // Same drag handle on the feature-info panel so the user can move
  // the callout away from whatever they're working on.
  makePanelDraggable($('#feature-info-panel'), $('#feature-info-header'))
  $$('#display-mode-group .menu-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.viewMode = row.dataset.display
      $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r === row))
      const lbl = $('#view-current-lbl')
      if (lbl) lbl.textContent = row.querySelector('span:not(.ico)').textContent
      renderCanvas()
      persistPrefs()
    })
  })
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
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  // The "Used only" and wreckage toggles are only meaningful on the features tab.
  const isFeatures = tab === 'features'
  $('#filter-used-wrap').classList.toggle('hidden', !isFeatures)
  $('#filter-wreckage-wrap').classList.toggle('hidden', !isFeatures)
  // Restore this tab's remembered filter so each tab keeps its own
  // search context.
  const filterInput = $('#filter')
  if (filterInput) filterInput.value = state.drawerFilters[tab] || ''
  filterInput.placeholder = tab === 'features'
    ? 'Filter features by name, world, category'
    : 'Filter sections by name, world, group'
  renderDrawer()
}

// isWreckageFeature returns true for corpses/wreckage entries we'd
// rather hide by default.  TA's TDFs flag these in two ways: the
// category ends in "_corpses" (case-insensitive), or the feature
// declares a "Wreckage" description.  Some unit-corpse names also end
// in "_dead" — catch those as a final safety net.
function isWreckageFeature(f) {
  const cat = (f.category || '').toLowerCase()
  if (cat.includes('corpse') || cat.includes('wreck')) return true
  const desc = (f.description || '').toLowerCase()
  if (desc === 'wreckage' || desc.includes('wreckage')) return true
  const name = (f.name || '').toLowerCase()
  if (name.endsWith('_dead') || name.endsWith('dead')) return true
  return false
}

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

// Per-row height (in CSS px) used when reserving space for groups whose
// items haven't been materialised yet.  Keeps the drawer's scrollbar
// honest while items render lazily — see virtualisedDrawerBody.
const DRAWER_ITEM_HEIGHT = 60
const DRAWER_OBSERVER_MARGIN = '400px 0px'

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

// Tracks the cell under the cursor for hotkey actions that don't fire
// from a mouse event (notably Ctrl+V paste, which wants to drop the
// pasted rectangle at the user's last hover point).  Null while the
// cursor is outside the canvas.
let lastHoverCell = null
let painting = false
let paintedDuringStroke = false

// Pan state — populated while the user is mid-drag panning the canvas.
let panState = null
// True while the spacebar is held; engages pan mode regardless of tool.
let spacePanHotkey = false

// ── Undo / redo ────────────────────────────────────────────────────────────
//
// History is captured as snapshot pairs (before/after) of the parts of
// state that the user can mutate: tile stamps, attribute heights, and
// feature placements, plus the map dimensions in case a resize happened.
// We share tile-entry references between snapshots because tile entries
// are always *replaced*, never mutated in place; feature entries are
// deep-cloned because drag-move edits ax/ay directly.

const UNDO_MAX = 50
const undoStack = []
const redoStack = []
let pendingTransaction = null

function captureSnapshot() {
  return {
    tiles: state.tiles.slice(),
    heights: state.heights.slice(),
    voids: state.voids.slice(),
    features: state.features.map((f) => ({ ...f })),
    tileW: state.tileW,
    tileH: state.tileH,
    name: state.name,
    planet: state.planet,
    activeSchema: state.activeSchema,
    ota: cloneOTA(state.ota),
  }
}

// cloneOTA deep-clones the OTA state.  Required for undo snapshots —
// captureSnapshot freezes a moment in time, and the OTA object's
// schemas + startPositions are mutated in place by the editor, so a
// shallow copy would let the snapshot drift.
function cloneOTA(ota) {
  if (!ota) return null
  return {
    ...ota,
    schemas: (ota.schemas || []).map((s) => ({
      ...s,
      startPositions: (s.startPositions || []).map((sp) => ({ ...sp })),
    })),
  }
}

function restoreSnapshot(snap) {
  if (typeof invalidateMinimapBase === 'function') invalidateMinimapBase()
  state.tiles = snap.tiles.slice()
  state.heights = snap.heights.slice()
  state.voids = (snap.voids || []).slice()
  state.features = snap.features.map((f) => ({ ...f }))
  if (snap.tileW !== state.tileW || snap.tileH !== state.tileH) {
    state.tileW = snap.tileW
    state.tileH = snap.tileH
    // Undo across a resize: rebuild the canvas stack at the restored
    // dimensions.  EditorView's destroy+mount path handles all the GL
    // teardown that the old in-place resize code used to do by hand.
    recreateEditorView()
  }
  if (snap.ota) {
    state.ota = cloneOTA(snap.ota)
    state.activeSchema = clamp(snap.activeSchema || 0, 0, state.ota.schemas.length - 1)
    refreshSchemaSelector()
  }
  if (typeof snap.name === 'string') state.name = snap.name
  if (typeof snap.planet === 'string') state.planet = snap.planet
  renderMapTabs()
}

// beginTransaction snapshots the current state before the caller mutates
// it.  Re-entrant — nested begins are ignored so callers can layer.
function beginTransaction() {
  if (pendingTransaction) return
  pendingTransaction = captureSnapshot()
}

// commitTransaction pushes a {before, after} pair onto the undo stack if
// the snapshots differ.  Clears the redo stack — any in-progress
// alternate future is invalidated by the new edit.
function commitTransaction(label) {
  if (!pendingTransaction) return
  const before = pendingTransaction
  pendingTransaction = null
  const after = captureSnapshot()
  if (snapshotsEqual(before, after)) return
  undoStack.push({ before, after, label: label || 'Edit' })
  while (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack.length = 0
  updateUndoButtons()
  // The active tab now diverges from its last saved state; the tab
  // chip's close button will pop the unsaved-changes prompt.
  const m = activeMap()
  if (m) m.dirty = true
  renderMapTabs()
  // Any committed edit can change the tile data → the cached minimap
  // base needs to be rebuilt on the next render.
  if (typeof invalidateMinimapBase === 'function') invalidateMinimapBase()
}

function abortTransaction() {
  pendingTransaction = null
}

function snapshotsEqual(a, b) {
  if (a.tileW !== b.tileW || a.tileH !== b.tileH) return false
  if (a.tiles.length !== b.tiles.length) return false
  if (a.features.length !== b.features.length) return false
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) return false
  for (let i = 0; i < a.heights.length; i++) if (a.heights[i] !== b.heights[i]) return false
  // Features are deep-cloned, so reference equality won't work — compare
  // by structural fingerprint.
  for (let i = 0; i < a.features.length; i++) {
    const af = a.features[i], bf = b.features[i]
    if (af.name !== bf.name || af.ax !== bf.ax || af.ay !== bf.ay) return false
  }
  if (a.name !== b.name || a.planet !== b.planet) return false
  if (a.activeSchema !== b.activeSchema) return false
  // OTA: deep-clone makes reference equality useless.  Stringify is a
  // simple and correct enough comparison since the shape is small.
  if (otaSignature(a.ota) !== otaSignature(b.ota)) return false
  return true
}

function otaSignature(o) { return o ? JSON.stringify(o) : '' }

function undo() {
  if (undoStack.length === 0) return
  cancelPlacement()
  if (state.terrainClipboard) state.terrainClipboard = null
  state.selectedFeature = -1
  const entry = undoStack.pop()
  redoStack.push(entry)
  restoreSnapshot(entry.before)
  renderCanvas()
  updateUndoButtons()
  setStatus(`Undone: ${entry.label}`)
}

function redo() {
  if (redoStack.length === 0) return
  cancelPlacement()
  state.selectedFeature = -1
  const entry = redoStack.pop()
  undoStack.push(entry)
  restoreSnapshot(entry.after)
  renderCanvas()
  updateUndoButtons()
  setStatus(`Redone: ${entry.label}`)
}

function updateUndoButtons() {
  const u = $('#btn-undo')
  const r = $('#btn-redo')
  if (u) {
    u.disabled = undoStack.length === 0
    u.title = undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].label} (Ctrl+Z)` : 'Nothing to undo'
  }
  if (r) {
    r.disabled = redoStack.length === 0
    r.title = redoStack.length ? `Redo: ${redoStack[redoStack.length - 1].label} (Ctrl+Shift+Z)` : 'Nothing to redo'
  }
  refreshHistoryFlyouts()
}

// refreshHistoryFlyouts populates the undo / redo hover flyouts with
// the next HISTORY_FLYOUT_N labels from each stack.  Top of undoStack
// is the next undo (LIFO), top of redoStack is the next redo.
const HISTORY_FLYOUT_N = 5
function refreshHistoryFlyouts() {
  const fillList = (containerId, source, emptyText) => {
    const el = $('#' + containerId)
    if (!el) return
    el.innerHTML = ''
    if (source.length === 0) {
      const row = document.createElement('div')
      row.className = 'menu-row history-empty'
      row.textContent = emptyText
      el.appendChild(row)
      return
    }
    // Walk back from the top of the stack so the first row is the
    // very next action that would fire.
    const start = source.length - 1
    const end = Math.max(-1, start - HISTORY_FLYOUT_N)
    for (let i = start; i > end; i--) {
      const row = document.createElement('div')
      row.className = 'menu-row history-row'
      const step = document.createElement('span')
      step.className = 'history-step'
      step.textContent = String(start - i + 1)
      const label = document.createElement('span')
      label.textContent = source[i].label
      row.appendChild(step)
      row.appendChild(label)
      el.appendChild(row)
    }
  }
  fillList('undo-history-list', undoStack, 'Nothing to undo')
  fillList('redo-history-list', redoStack, 'Nothing to redo')
}

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
      $('#hover-cell').textContent = '—'
      updateCameraInfoCursor(null)
      if (state.eraseCursor) { state.eraseCursor = null; renderCanvas() }
      lastHoverCell = null
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
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) {
    $('#hover-cell').textContent = '—'
    setCanvasHoverFeature(null)
    updateCameraInfoCursor(null)
    return
  }
  $('#hover-cell').textContent = `(${tx}, ${ty})`
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
    lastHoverCell = cell
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
// rotation r ∈ {0,1,2,3}: count of 90° clockwise quarter-turns.
// For rotated cell (rx, ry) in a footprint that is (rotW, rotH) tiles
// (where rotW = origH and rotH = origW for r ∈ {1,3}), the original
// section cell is:
//   r=0: ox=rx, oy=ry                                 (footprint origW × origH)
//   r=1: ox=ry, oy=(origW-1)-rx                       (footprint origH × origW)
//   r=2: ox=(origW-1)-rx, oy=(origH-1)-ry             (footprint origW × origH)
//   r=3: ox=(origH-1)-ry, oy=rx                       (footprint origH × origW)
function rotatedFootprint(origW, origH, rotation) {
  return (rotation & 1) ? { w: origH, h: origW } : { w: origW, h: origH }
}
function rotatedSourceCell(rx, ry, origW, origH, rotation) {
  switch (rotation & 3) {
    case 0: return { sx: rx, sy: ry }
    case 1: return { sx: ry, sy: (origW - 1) - rx }
    case 2: return { sx: (origW - 1) - rx, sy: (origH - 1) - ry }
    case 3: return { sx: (origH - 1) - ry, sy: rx }
  }
}

// transformedSourceCell extends rotatedSourceCell with optional H/V
// flips on top.  Flips are applied to the *post-rotation* destination
// grid: flipH mirrors across the vertical centre, flipV across the
// horizontal centre.  This keeps the user's mental model simple — Q/E
// rotate, then F/G mirror what they see.
function transformedSourceCell(rx, ry, origW, origH, rotation, flipH, flipV) {
  const { w: fw, h: fh } = rotatedFootprint(origW, origH, rotation)
  const px = flipH ? (fw - 1 - rx) : rx
  const py = flipV ? (fh - 1 - ry) : ry
  return rotatedSourceCell(px, py, origW, origH, rotation)
}

// drawTransformedTile composes rotation + flip in canvas-space so a
// single tile pixel pattern is drawn rotated and/or mirrored.  The
// flip is applied *after* the rotation in pixel terms (matching what
// the user sees in the preview).
function drawTransformedTile(ctx, img, sx, sy, rotation, flipH, flipV, dx, dy) {
  if ((rotation & 3) === 0 && !flipH && !flipV) {
    ctx.drawImage(img, sx * 32, sy * 32, 32, 32, dx, dy, TILE_PX, TILE_PX)
    return
  }
  ctx.save()
  ctx.translate(dx + TILE_PX / 2, dy + TILE_PX / 2)
  if (flipV) ctx.scale(1, -1)
  if (flipH) ctx.scale(-1, 1)
  if ((rotation & 3) !== 0) ctx.rotate((rotation & 3) * Math.PI / 2)
  ctx.drawImage(img, sx * 32, sy * 32, 32, 32, -TILE_PX / 2, -TILE_PX / 2, TILE_PX, TILE_PX)
  ctx.restore()
}

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

// shrinkRectToContent returns the tightest tile-grid bounding box of
// any stamped tile or placed feature inside the given rectangle.  When
// the rectangle is empty (nothing inside it) we return null so the
// caller can no-op the capture.
function shrinkRectToContent(x, y, w, h) {
  let minTX = Infinity, maxTX = -Infinity
  let minTY = Infinity, maxTY = -Infinity
  let found = false

  const x2 = x + w, y2 = y + h
  for (let ty = y; ty < y2; ty++) {
    if (ty < 0 || ty >= state.tileH) continue
    for (let tx = x; tx < x2; tx++) {
      if (tx < 0 || tx >= state.tileW) continue
      if (state.tiles[ty * state.tileW + tx]) {
        if (tx < minTX) minTX = tx
        if (tx > maxTX) maxTX = tx
        if (ty < minTY) minTY = ty
        if (ty > maxTY) maxTY = ty
        found = true
      }
    }
  }

  // Features live on the 16-px attribute grid.  Convert to tile coords
  // via floor(ax/2), floor(ay/2) and fold them into the bounding box.
  const minAX = x * 2, maxAX = x2 * 2
  const minAY = y * 2, maxAY = y2 * 2
  for (const f of state.features) {
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      const fTX = Math.floor(f.ax / 2)
      const fTY = Math.floor(f.ay / 2)
      if (fTX < minTX) minTX = fTX
      if (fTX > maxTX) maxTX = fTX
      if (fTY < minTY) minTY = fTY
      if (fTY > maxTY) maxTY = fTY
      found = true
    }
  }
  if (!found) return null
  return { x: minTX, y: minTY, w: maxTX - minTX + 1, h: maxTY - minTY + 1 }
}

// captureTerrain pulls a rectangle of tiles + heights into a floating
// "clipboard" the user can drag around the map.  The source region on
// the map is cleared (so the drag visibly lifts the terrain off).
//
// Features whose attribute position falls inside the rectangle are
// also lifted off the map and stored with positions relative to the
// rectangle's top-left, so rotation/move acts on them as a group.
function captureTerrain(x, y, w, h) {
  const tiles = new Array(w * h).fill(null)
  const heights = new Array(w * 2 * h * 2).fill(80)
  const mapAttrW = state.tileW * 2
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const mx = x + dx, my = y + dy
      const cell = state.tiles[my * state.tileW + mx]
      if (cell) tiles[dy * w + dx] = { ...cell }
      state.tiles[my * state.tileW + mx] = null
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const srcAY = my * 2 + qy
          const srcAX = mx * 2 + qx
          heights[(dy * 2 + qy) * (w * 2) + (dx * 2 + qx)] = state.heights[srcAY * mapAttrW + srcAX]
          state.heights[srcAY * mapAttrW + srcAX] = 80
        }
      }
    }
  }

  // Pick up features inside the rectangle (attribute coords).
  const minAX = x * 2, maxAX = (x + w) * 2 // exclusive on the upper end
  const minAY = y * 2, maxAY = (y + h) * 2
  const features = []
  state.features = state.features.filter((f) => {
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      features.push({ ...f, ax: f.ax - minAX, ay: f.ay - minAY })
      return false
    }
    return true
  })

  state.terrainClipboard = { tx: x, ty: y, w, h, tiles, heights, features, rotation: 0 }
  // The placement hint pill normally hides the rotation row for
  // features — explicitly pass 'section' so the Q/E hint stays visible
  // for terrain selections too.
  showPlacementHint(`Moving ${w}×${h} terrain selection`, 'section')
  const fNote = features.length > 0 ? ` plus ${features.length} feature${features.length === 1 ? '' : 's'}` : ''
  setStatus(`Captured ${w}×${h} terrain${fNote}.  Drag to move, Q/E to rotate, click outside to drop, Esc to put back.`)
  renderCanvas()
}

// rotateTerrainClipboard rotates the captured rectangle in place by ±90°.
// Each cell's stored rotation is also updated so the section graphics
// still face the right way after the rectangle is dropped.
function rotateTerrainClipboard(dir) {
  const c = state.terrainClipboard
  if (!c) return
  const oldW = c.w, oldH = c.h
  const newW = oldH, newH = oldW
  const newTiles = new Array(newW * newH).fill(null)
  const newHeights = new Array(newW * 2 * newH * 2).fill(80)
  const oldAttrW = oldW * 2
  const newAttrW = newW * 2

  for (let ry = 0; ry < newH; ry++) {
    for (let rx = 0; rx < newW; rx++) {
      // 90° CW: new(rx, ry) ← old(oy=oldH-1-rx, ox=ry) — equivalently
      // ox=ry, oy=oldW-1-rx.  CCW is its inverse.
      const ox = dir > 0 ? ry : (oldH - 1 - ry)
      const oy = dir > 0 ? (oldW - 1 - rx) : rx
      const cell = c.tiles[oy * oldW + ox]
      if (cell) {
        newTiles[ry * newW + rx] = {
          ...cell,
          rotation: ((cell.rotation || 0) + (dir > 0 ? 1 : 3)) & 3,
        }
      }
      // Rotate the 2×2 attribute sub-cells along with the tile so the
      // alignment hints stay accurate after the rotation.
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          let sqx, sqy
          if (dir > 0) { sqx = qy; sqy = 1 - qx }
          else { sqx = 1 - qy; sqy = qx }
          const srcAY = oy * 2 + sqy
          const srcAX = ox * 2 + sqx
          if (srcAX >= 0 && srcAY >= 0 && srcAY * oldAttrW + srcAX < c.heights.length) {
            newHeights[(ry * 2 + qy) * newAttrW + (rx * 2 + qx)] = c.heights[srcAY * oldAttrW + srcAX]
          }
        }
      }
    }
  }
  c.tiles = newTiles
  c.heights = newHeights

  // Rotate the carried features' attribute positions so they stay
  // aligned with the tiles they were sitting on.  Coordinates are
  // (ax, ay) in attr cells, range [0..oldW*2) × [0..oldH*2).
  if (c.features && c.features.length) {
    const oldAW = oldW * 2
    const oldAH = oldH * 2
    c.features = c.features.map((f) => {
      let nax, nay
      if (dir > 0) {
        // 90° CW: (ax, ay) → ((oldAH-1) - ay, ax)
        nax = (oldAH - 1) - f.ay
        nay = f.ax
      } else {
        // 90° CCW: (ax, ay) → (ay, (oldAW-1) - ax)
        nax = f.ay
        nay = (oldAW - 1) - f.ax
      }
      // Asymmetric footprints rotate too — swap the X/Z extents.
      const newFootprintX = f.footprintZ || 1
      const newFootprintZ = f.footprintX || 1
      return {
        ...f,
        ax: nax,
        ay: nay,
        footprintX: newFootprintX,
        footprintZ: newFootprintZ,
      }
    })
  }

  c.w = newW
  c.h = newH
  c.rotation = ((c.rotation || 0) + (dir > 0 ? 1 : 3)) & 3
}

// dropTerrainClipboard pastes the floating selection back into the map
// at its current (tx, ty) position, clipping anything that hangs off
// the edge.
function dropTerrainClipboard() {
  const c = state.terrainClipboard
  if (!c) return
  const mapAttrW = state.tileW * 2
  const mapAttrH = state.tileH * 2
  // A "paste features only" clipboard intentionally carries no tile or
  // heightmap data; skip the tile overlay so the existing map under the
  // dropped rectangle stays intact.  Features still re-attach below.
  if (!c.skipTiles) {
    for (let dy = 0; dy < c.h; dy++) {
      for (let dx = 0; dx < c.w; dx++) {
        const mx = c.tx + dx, my = c.ty + dy
        if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
        const cell = c.tiles[dy * c.w + dx]
        if (cell) state.tiles[my * state.tileW + mx] = { ...cell }
        for (let qy = 0; qy < 2; qy++) {
          for (let qx = 0; qx < 2; qx++) {
            const h = c.heights[(dy * 2 + qy) * (c.w * 2) + (dx * 2 + qx)]
            state.heights[(my * 2 + qy) * mapAttrW + (mx * 2 + qx)] = h
          }
        }
      }
    }
  }
  // Re-attach the carried features.  Features whose anchor lands off-map
  // after the move are dropped on the floor so they don't pollute the
  // saved file.
  if (c.features) {
    for (const f of c.features) {
      const nax = c.tx * 2 + f.ax
      const nay = c.ty * 2 + f.ay
      if (nax < 0 || nay < 0 || nax >= mapAttrW || nay >= mapAttrH) continue
      state.features.push({ ...f, ax: nax, ay: nay })
    }
  }
  state.terrainClipboard = null
  hidePlacementHint()
  setStatus('Terrain dropped.')
  renderCanvas()
}

function cancelTerrainClipboard() {
  if (!state.terrainClipboard) return
  // We don't track the original capture origin, so cancelling just
  // drops the clipboard back at its current position.
  dropTerrainClipboard()
}

// ── System clipboard (Ctrl+C / Ctrl+V) ────────────────────────────────
//
// Serialises a terrain-rectangle selection to the OS clipboard so the
// user can paste it back in the same tab — or in another KBot Studio
// tab inside the same Chrome session — via Ctrl+V.  The payload is a
// magic-prefixed JSON string; non-KBot clipboard contents are ignored
// on paste.

const CLIP_PREFIX = 'KBOTSTUDIO_CLIP_V1:'

// extractTerrainRect pulls a non-destructive copy of a tile rectangle
// + its attribute-cell heights + any features whose anchor lies inside
// it.  Used by copyToClipboard so a Ctrl+C doesn't disturb the map the
// way captureTerrain() (drag-to-move) does.
function extractTerrainRect(x, y, w, h) {
  const tiles = new Array(w * h).fill(null)
  const heights = new Array(w * 2 * h * 2).fill(80)
  const mapAttrW = state.tileW * 2
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const mx = x + dx, my = y + dy
      const cell = state.tiles[my * state.tileW + mx]
      if (cell) tiles[dy * w + dx] = { ...cell }
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const srcAY = my * 2 + qy
          const srcAX = mx * 2 + qx
          heights[(dy * 2 + qy) * (w * 2) + (dx * 2 + qx)] = state.heights[srcAY * mapAttrW + srcAX]
        }
      }
    }
  }
  const minAX = x * 2, maxAX = (x + w) * 2
  const minAY = y * 2, maxAY = (y + h) * 2
  const features = []
  for (const f of state.features) {
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      features.push({ ...f, ax: f.ax - minAX, ay: f.ay - minAY })
    }
  }
  return { w, h, tiles, heights, features }
}

// clearRegion wipes tiles + heights + features inside the current
// Select-Terrain rectangle.  Different from the Erase brush: this
// clears the entire selection in one transactional shot, with a
// status update and undo support.  No-op when nothing is selected.
function clearRegion() {
  const r = state.rectSelection
  if (!r || r.w <= 0 || r.h <= 0) {
    setStatus('Nothing to clear — make a Select-Terrain rectangle first.')
    return
  }
  beginTransaction()
  const mapAttrW = state.tileW * 2
  let tilesCleared = 0
  let heightsTouched = 0
  for (let dy = 0; dy < r.h; dy++) {
    for (let dx = 0; dx < r.w; dx++) {
      const mx = r.x + dx, my = r.y + dy
      const idx = my * state.tileW + mx
      if (state.tiles[idx]) { state.tiles[idx] = null; tilesCleared++ }
      for (let qy = 0; qy < 2; qy++) {
        for (let qx = 0; qx < 2; qx++) {
          const ay = my * 2 + qy
          const ax = mx * 2 + qx
          const ai = ay * mapAttrW + ax
          if (state.heights[ai] !== 80) { state.heights[ai] = 80; heightsTouched++ }
        }
      }
    }
  }
  const minAX = r.x * 2, maxAX = (r.x + r.w) * 2
  const minAY = r.y * 2, maxAY = (r.y + r.h) * 2
  const before = state.features.length
  state.features = state.features.filter((f) => !(f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY))
  const featuresRemoved = before - state.features.length
  // Reset feature selection if any of its members disappeared.
  if (state.selectedFeature >= 0 && state.selectedFeature >= state.features.length) state.selectedFeature = -1
  if (state.selectedFeatures?.size) state.selectedFeatures.clear()
  commitTransaction(`Clear ${r.w}×${r.h} region`)
  setStatus(`Cleared ${r.w}×${r.h} region — ${tilesCleared} tile(s), ${heightsTouched} height cell(s), ${featuresRemoved} feature(s).`)
  renderCanvas()
}

// cutSelection = Copy + Clear region, all in one transactional shot.
// Falls through cleanly if there's nothing to act on.
async function cutSelection() {
  // Build the clipboard payload synchronously so it survives any
  // events that fire during the async clipboard write below.  Doing
  // it in this order also means an aborted clipboard write doesn't
  // leave the user with an unexpected "selection cleared but no
  // paste available" state — the clear only happens once the payload
  // is locked in.
  let payload = null
  if (state.terrainClipboard) {
    const c = state.terrainClipboard
    payload = { w: c.w, h: c.h, tiles: c.tiles, heights: c.heights, features: c.features }
  } else if (state.rectSelection) {
    const r = state.rectSelection
    payload = extractTerrainRect(r.x, r.y, r.w, r.h)
  }
  if (!payload) {
    setStatus('Nothing to cut — make a Select-Terrain rectangle first.')
    return
  }
  // Clear synchronously *before* the clipboard write.  This way, an
  // event firing during the await can't sneak in and lose
  // state.rectSelection out from under clearRegion().  When the
  // selection was already a terrainClipboard (drag-lifted), the
  // source cells are already empty so no extra clear is needed.
  const hadRectSelection = !!state.rectSelection
  if (hadRectSelection) {
    clearRegion()
  } else if (state.terrainClipboard) {
    // Drag-lifted content already has its source cells cleared (the
    // captureTerrain that lifted it did that).  Cut should discard
    // the lifted clipboard *without* re-pasting it — that's the
    // point of cut vs. cancel.  Run inside a transaction so the
    // operation is undoable.
    beginTransaction()
    state.terrainClipboard = null
    hidePlacementHint()
    commitTransaction(`Cut ${payload.w}×${payload.h} terrain`)
    renderCanvas()
  }
  try {
    await navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload))
    setStatus(`Cut ${payload.w}×${payload.h} terrain rectangle to clipboard.`)
  } catch (err) {
    // Clipboard permissions can deny the write (no document focus,
    // sandbox, etc.).  The local clear already happened — flag it so
    // the user knows their content isn't on the system clipboard.
    setStatus(`Cut cleared the selection, but clipboard write failed: ${err.message || err}`)
  }
}

// clearAllFeatures wipes every placed feature from the map.  Voids,
// tiles and heights are left alone.  Annihilator names this
// "Features → Clear All".
function clearAllFeatures() {
  if (!state.features || state.features.length === 0) {
    setStatus('No features placed.')
    return
  }
  beginTransaction()
  const removed = state.features.length
  state.features = []
  state.selectedFeature = -1
  if (state.selectedFeatures?.size) state.selectedFeatures.clear()
  commitTransaction(`Clear ${removed} feature(s)`)
  setStatus(`Removed ${removed} feature(s) from the map.`)
  renderCanvas()
}

// clearFeaturesInSelection removes only the features whose anchor
// lies inside the current Select-Terrain rectangle.  Tiles + heights
// untouched.  Annihilator's "Features → Clear Selection".
function clearFeaturesInSelection() {
  const r = state.rectSelection
  if (!r || r.w <= 0 || r.h <= 0) {
    setStatus('Nothing to clear — make a Select-Terrain rectangle first.')
    return
  }
  const minAX = r.x * 2, maxAX = (r.x + r.w) * 2
  const minAY = r.y * 2, maxAY = (r.y + r.h) * 2
  const inside = state.features.filter((f) => f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY)
  if (inside.length === 0) {
    setStatus('No features inside the current selection.')
    return
  }
  beginTransaction()
  state.features = state.features.filter((f) => !(f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY))
  state.selectedFeature = -1
  if (state.selectedFeatures?.size) state.selectedFeatures.clear()
  commitTransaction(`Clear ${inside.length} feature(s) in selection`)
  setStatus(`Removed ${inside.length} feature(s) inside the selection.`)
  renderCanvas()
}

async function copyToClipboard() {
  let payload = null
  if (state.terrainClipboard) {
    const c = state.terrainClipboard
    payload = { w: c.w, h: c.h, tiles: c.tiles, heights: c.heights, features: c.features }
  } else if (state.rectSelection) {
    const r = state.rectSelection
    payload = extractTerrainRect(r.x, r.y, r.w, r.h)
  }
  if (!payload) {
    setStatus('Nothing to copy — make a Select-Terrain rectangle first.')
    return
  }
  try {
    await navigator.clipboard.writeText(CLIP_PREFIX + JSON.stringify(payload))
    setStatus(`Copied ${payload.w}×${payload.h} terrain rectangle to clipboard.`)
  } catch (err) {
    setStatus(`Copy failed: ${err.message || err}`)
  }
}

// pasteFromClipboard stages the clipboard payload as a terrainClipboard
// the user can position then drop.  `mode` filters what comes along:
//   'all'      — tiles + heights + features (default)
//   'tiles'    — tiles + heights only; features dropped on the floor
//   'features' — features only; tiles and heightmap left blank so a
//                drop overlays the existing map without disturbing it
async function pasteFromClipboard(mode = 'all') {
  let text
  try { text = await navigator.clipboard.readText() }
  catch (err) { setStatus(`Paste failed: ${err.message || err}`); return }
  if (!text || !text.startsWith(CLIP_PREFIX)) {
    setStatus('Clipboard does not contain a KBot Studio selection.')
    return
  }
  let payload
  try { payload = JSON.parse(text.slice(CLIP_PREFIX.length)) }
  catch { setStatus('Clipboard data is corrupted.'); return }
  if (!payload || !Number.isInteger(payload.w) || !Number.isInteger(payload.h) || payload.w <= 0 || payload.h <= 0) {
    setStatus('Clipboard data is invalid.')
    return
  }
  // Drop any in-flight selection / placement so the pasted clipboard
  // is the only thing the user has to drag around.
  if (state.terrainClipboard) cancelTerrainClipboard()
  cancelPlacement()
  state.rectSelection = null
  // Anchor at the cursor's last hover cell when available, else the
  // map centre.  The user can drag from there before clicking outside
  // to commit.
  const w = payload.w, h = payload.h
  let tx, ty
  if (lastHoverCell) {
    tx = clamp(lastHoverCell.tx - Math.floor(w / 2), 0, Math.max(0, state.tileW - w))
    ty = clamp(lastHoverCell.ty - Math.floor(h / 2), 0, Math.max(0, state.tileH - h))
  } else {
    tx = Math.max(0, Math.floor((state.tileW - w) / 2))
    ty = Math.max(0, Math.floor((state.tileH - h) / 2))
  }
  const includeTiles = mode === 'all' || mode === 'tiles'
  const includeFeatures = mode === 'all' || mode === 'features'
  state.terrainClipboard = {
    tx, ty, w, h,
    tiles: includeTiles
      ? (payload.tiles || new Array(w * h).fill(null))
      : new Array(w * h).fill(null),
    heights: includeTiles
      ? (payload.heights || new Array(w * 2 * h * 2).fill(80))
      : new Array(w * 2 * h * 2).fill(80),
    features: includeFeatures ? (payload.features || []) : [],
    rotation: 0,
    // When pasting tiles-only or features-only, mark the clipboard so
    // dropTerrainClipboard can skip overlaying the empty layer the user
    // didn't ask for.
    skipTiles: !includeTiles,
  }
  if (state.mode !== 'select-terrain') setMode('select-terrain')
  const what = mode === 'tiles' ? 'tiles' : mode === 'features' ? 'features' : 'terrain'
  showPlacementHint(`Pasting ${w}×${h} ${what} rectangle`, 'section')
  setStatus(`Pasted ${w}×${h} ${what}.  Drag to move, Q/E to rotate, click outside to drop, Esc to cancel.`)
  renderCanvas()
}

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
// FEATURE_HIT_SEARCH_TILES — how far from the click tile we look for
// candidate features.  Sprites can extend off their anchor; this is
// the upper bound for typical TA sprites (5 tiles ≈ 160 game pixels).
const FEATURE_HIT_SEARCH_TILES = 6

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

const START_POS_RADIUS = 26 // canvas-px hit radius when picking a start

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
let hmHoldTimer = null
const HM_HOLD_INTERVAL_MS = 60

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
  const panel = $('#camera-info-panel')
  if (panel) panel.classList.toggle('hidden', !visible)
  const btn = $('#opt-camera-info')
  if (btn) btn.dataset.on = visible ? '1' : '0'
  if (visible) updateCameraInfoPanel()
  persistPrefs()
}

// updateCameraInfoPanel populates the panel with the current camera
// (viewport-centre) tile, the cursor's tile + sub-tile when the mouse
// is over the canvas, and the zoom level as a percentage.  Called from
// renderCanvas (camera + zoom) and from updateHoverLabel (cursor).
function updateCameraInfoPanel() {
  const panel = $('#camera-info-panel')
  if (!panel || panel.classList.contains('hidden')) return
  // Camera centre — viewportCellCenter returns the tile at the centre
  // of the visible viewport, taking overscroll padding + zoom into
  // account.  Out-of-range falls back to the map centre.
  const cam = viewportCellCenter()
  const camEl = $('#ci-camera')
  if (camEl) camEl.textContent = `${cam.tx}, ${cam.ty}`
  const zEl = $('#ci-zoom')
  if (zEl) zEl.textContent = `${Math.round((state.zoom || 1) * 100)}%`
  // Cursor info is populated by setCanvasHoverFeature / updateHoverLabel
  // when the mouse moves over the canvas; this function just keeps the
  // camera + zoom rows in sync after pan/zoom.
}

// updateCameraInfoCursor writes the cursor tile + sub-tile fields when
// the user is hovering the canvas.  Called from updateHoverLabel.
function updateCameraInfoCursor(tx, ty, ax, ay) {
  const panel = $('#camera-info-panel')
  if (!panel || panel.classList.contains('hidden')) return
  const cursorEl = $('#ci-cursor')
  const subEl = $('#ci-subtile')
  const hEl = $('#ci-height')
  if (tx == null) {
    if (cursorEl) cursorEl.textContent = '—'
    if (subEl) subEl.textContent = '—'
    if (hEl) hEl.textContent = '—'
    return
  }
  if (cursorEl) cursorEl.textContent = `${tx}, ${ty}`
  if (subEl) subEl.textContent = `${ax & 1}, ${ay & 1}`
  // Height byte at the precise attribute cell under the cursor.
  if (hEl) {
    const aw = state.tileW * 2
    const ah = state.tileH * 2
    if (ax >= 0 && ay >= 0 && ax < aw && ay < ah && state.heights) {
      hEl.textContent = String(state.heights[ay * aw + ax] | 0)
    } else {
      hEl.textContent = '—'
    }
  }
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

// ── WebGL renderer (tile + feature batches) ───────────────────────────────
//
// The 2D drawImage path hit a wall at ~17k tile cells × per-cell
// drawImage overhead.  This renderer collapses every tile sharing a
// source texture into one batched draw call (a tightly-packed vertex
// buffer of triangles + UVs), and does the same for feature sprites.
// Each section image becomes a texture; the shader samples it for
// every quad.  Pan/scroll only re-uploads the vertex buffer for the
// new visible viewport — no per-frame `drawImage` JS↔C++ crossings.
//
// The 2D overlay canvas still draws on top for placement previews,
// gridlines, selection rectangles, etc., which are low-volume and
// don't benefit from the GL rewrite.

const gl = { ctx: null, prog: null, posLoc: -1, uvLoc: -1, texLoc: -1, projLoc: -1, vbo: null, textures: new Map(), failed: false }

// resetGL drops the WebGL context, textures, and program references so
// the next ensureGLRenderer() call rebuilds everything against the
// freshly-mounted #canvas-gl element.  EditorView.destroy() calls this
// before removing the canvas from the DOM.
function resetGL() {
  if (gl.ctx) {
    try {
      for (const t of gl.textures.values()) if (t && t.tex) gl.ctx.deleteTexture(t.tex)
      if (gl.vbo) gl.ctx.deleteBuffer(gl.vbo)
      if (gl.prog) gl.ctx.deleteProgram(gl.prog)
      gl.ctx.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { /* the context may already be lost */ }
  }
  gl.textures.clear()
  gl.ctx = null
  gl.prog = null
  gl.vbo = null
  gl.posLoc = -1
  gl.uvLoc = -1
  gl.texLoc = -1
  gl.projLoc = -1
  // Clear `failed` so a fresh GL context gets a real attempt — the
  // previous failure could have been transient (e.g. a lost context
  // during a map switch).
  gl.failed = false
}

// ensureGLRenderer is called from renderCanvas; returns true when the
// WebGL context is live and ready to draw.  Returns false (and only
// the first time logs a warning) when WebGL isn't supported, so the
// 2D fallback path stays in play.
function ensureGLRenderer() {
  if (gl.ctx) return true
  if (gl.failed) return false
  const canvas = $('#canvas-gl')
  if (!canvas) return false
  const ctx = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
    || canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false })
  if (!ctx) {
    gl.failed = true
    console.warn('WebGL unavailable — falling back to 2D rendering')
    return false
  }
  // Vertex shader: per-vertex pixel position + UV.  An ortho projection
  // maps map-pixel coords (0..mapW, 0..mapH) into clip space, with Y
  // flipped so (0,0) sits at the top-left like the 2D canvas.
  const vsrc = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    uniform vec2 uProj;
    varying vec2 vUV;
    void main() {
      vec2 ndc = vec2(aPos.x / uProj.x * 2.0 - 1.0, 1.0 - aPos.y / uProj.y * 2.0);
      gl_Position = vec4(ndc, 0.0, 1.0);
      vUV = aUV;
    }
  `
  // Fragment shader: sample the bound texture.  We keep fully-transparent
  // pixels around (no discard) so the GPU's blend stage handles the
  // composite — discarding was eating opaque section tiles whose blue
  // channel happened to coincide with the alpha threshold in tests.
  const fsrc = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    void main() {
      gl_FragColor = texture2D(uTex, vUV);
    }
  `
  const vs = ctx.createShader(ctx.VERTEX_SHADER)
  ctx.shaderSource(vs, vsrc); ctx.compileShader(vs)
  if (!ctx.getShaderParameter(vs, ctx.COMPILE_STATUS)) {
    console.warn('vertex shader compile failed:', ctx.getShaderInfoLog(vs))
    gl.failed = true; return false
  }
  const fs = ctx.createShader(ctx.FRAGMENT_SHADER)
  ctx.shaderSource(fs, fsrc); ctx.compileShader(fs)
  if (!ctx.getShaderParameter(fs, ctx.COMPILE_STATUS)) {
    console.warn('fragment shader compile failed:', ctx.getShaderInfoLog(fs))
    gl.failed = true; return false
  }
  const prog = ctx.createProgram()
  ctx.attachShader(prog, vs); ctx.attachShader(prog, fs); ctx.linkProgram(prog)
  if (!ctx.getProgramParameter(prog, ctx.LINK_STATUS)) {
    console.warn('program link failed:', ctx.getProgramInfoLog(prog))
    gl.failed = true; return false
  }
  gl.ctx = ctx
  gl.prog = prog
  gl.posLoc = ctx.getAttribLocation(prog, 'aPos')
  gl.uvLoc = ctx.getAttribLocation(prog, 'aUV')
  gl.texLoc = ctx.getUniformLocation(prog, 'uTex')
  gl.projLoc = ctx.getUniformLocation(prog, 'uProj')
  gl.vbo = ctx.createBuffer()
  ctx.enable(ctx.BLEND)
  ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA)
  return true
}

// glTextureFor uploads an HTMLImageElement to a GPU texture once and
// returns the cached handle.  Images that haven't decoded yet return
// null; callers should fall through and let the load listener retry
// the render once the pixels are available.
function glTextureFor(key, img) {
  if (!gl.ctx || !img || !img.complete || img.naturalWidth === 0) return null
  const cached = gl.textures.get(key)
  if (cached) return cached
  const ctx = gl.ctx
  const tex = ctx.createTexture()
  ctx.bindTexture(ctx.TEXTURE_2D, tex)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.NEAREST)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.NEAREST)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
  ctx.pixelStorei(ctx.UNPACK_FLIP_Y_WEBGL, false)
  ctx.pixelStorei(ctx.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, img)
  gl.textures.set(key, { tex, w: img.naturalWidth, h: img.naturalHeight })
  return gl.textures.get(key)
}

// glClearViewport fills the GL canvas with the void colour so the
// non-GL view modes (heightmap) see a clean backdrop.
function glClearViewport() {
  if (!gl.ctx) return
  const ctx = gl.ctx
  ctx.viewport(0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
  ctx.clearColor(0x1d / 255, 0x30 / 255, 0x45 / 255, 1)
  ctx.clear(ctx.COLOR_BUFFER_BIT)
}

// glRenderTilesAndFeatures repaints the GL layer.  Walks visible tiles
// grouped by section path, builds one batched vertex buffer per group,
// and draws each group with a single drawArrays call.  Features are
// batched the same way, keyed by feature name.
function glRenderTilesAndFeatures(vp) {
  if (!gl.ctx) return
  const ctx = gl.ctx
  ctx.viewport(0, 0, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
  ctx.clearColor(0x1d / 255, 0x30 / 255, 0x45 / 255, 1)
  ctx.clear(ctx.COLOR_BUFFER_BIT)

  ctx.useProgram(gl.prog)
  ctx.uniform2f(gl.projLoc, ctx.drawingBufferWidth, ctx.drawingBufferHeight)
  ctx.bindBuffer(ctx.ARRAY_BUFFER, gl.vbo)
  ctx.enableVertexAttribArray(gl.posLoc)
  ctx.enableVertexAttribArray(gl.uvLoc)
  // Each vertex is 4 floats: x, y, u, v.  Stride 16 bytes.
  ctx.vertexAttribPointer(gl.posLoc, 2, ctx.FLOAT, false, 16, 0)
  ctx.vertexAttribPointer(gl.uvLoc, 2, ctx.FLOAT, false, 16, 8)

  // ── Tiles ────────────────────────────────────────────────────
  // Group visible tile stamps by section path so each section image
  // turns into exactly one batched draw call.
  const tileGroups = new Map()
  const tw = state.tileW
  for (let ty = vp.minTY; ty <= vp.maxTY; ty++) {
    for (let tx = vp.minTX; tx <= vp.maxTX; tx++) {
      const stamp = state.tiles[ty * tw + tx]
      if (!stamp || !stamp.sectionPath) continue
      let list = tileGroups.get(stamp.sectionPath)
      if (!list) { list = []; tileGroups.set(stamp.sectionPath, list) }
      list.push({ tx, ty, stamp })
    }
  }
  for (const [path, list] of tileGroups) {
    const img = state.sectionImages.get(path)
    const t = glTextureFor(path, img)
    if (!t) {
      whenImageReady(img, 'render', renderCanvas)
      continue
    }
    const verts = buildTileBatch(list, t.w, t.h)
    ctx.bufferData(ctx.ARRAY_BUFFER, verts, ctx.DYNAMIC_DRAW)
    ctx.activeTexture(ctx.TEXTURE0)
    ctx.bindTexture(ctx.TEXTURE_2D, t.tex)
    ctx.uniform1i(gl.texLoc, 0)
    ctx.drawArrays(ctx.TRIANGLES, 0, list.length * 6)
  }

  // ── Features ─────────────────────────────────────────────────
  // Painted in Y-order (anchor py ascending) so a sprite further south
  // always overlays sprites to its north.  Without this an unsorted
  // batch would let an earlier-in-array tree paint on top of a tree
  // anchored visually below it.  Same-texture features are batched in
  // contiguous runs so the typical "cluster of identical trees" still
  // hits the GPU as one draw call.
  if (!state.showFeatures || state.viewMode === 'tiles') return
  const pxMinX = vp.minTX * TILE_PX, pxMaxX = (vp.maxTX + 1) * TILE_PX
  const pxMinY = vp.minTY * TILE_PX, pxMaxY = (vp.maxTY + 1) * TILE_PX
  const visible = []
  for (const f of state.features) {
    if (!f.previewUrl) continue
    const { px, py } = featureAnchorWorld(f)
    const img = state.featureImages.get((f.name || '').toLowerCase())
    if (!img || !img.complete || img.naturalWidth === 0) {
      if (img) whenImageReady(img, 'render', renderCanvas)
      else preloadFeatureImage(f)
      continue
    }
    const { dx, dy } = featureAnchorOffset(f, img)
    const x = px - dx, y = py - dy
    if (x + img.naturalWidth < pxMinX || x > pxMaxX || y + img.naturalHeight < pxMinY || y > pxMaxY) continue
    visible.push({ key: (f.name || '').toLowerCase(), x, y, py, img })
  }
  // Sort by anchor py (tie-break on px so order is deterministic).
  visible.sort((a, b) => a.py === b.py ? a.x - b.x : a.py - b.py)
  // Emit batches of same-key contiguous runs.
  let i = 0
  while (i < visible.length) {
    const key = visible[i].key
    const img = visible[i].img
    const run = []
    while (i < visible.length && visible[i].key === key) {
      run.push({ x: visible[i].x, y: visible[i].y })
      i++
    }
    const t = glTextureFor('feature:' + key, img)
    if (!t) continue
    const verts = buildFeatureBatch(run, img.naturalWidth, img.naturalHeight)
    ctx.bufferData(ctx.ARRAY_BUFFER, verts, ctx.DYNAMIC_DRAW)
    ctx.activeTexture(ctx.TEXTURE0)
    ctx.bindTexture(ctx.TEXTURE_2D, t.tex)
    ctx.uniform1i(gl.texLoc, 0)
    ctx.drawArrays(ctx.TRIANGLES, 0, run.length * 6)
  }
}

// buildTileBatch assembles the vertex array for every tile in a batch.
// Each tile becomes two triangles (6 verts).  The 32×32 source rect
// inside the section image is determined by the rotated/flipped
// transformedSourceCell logic — the four corners are emitted in an
// order that bakes the same rotation+flip the 2D path would apply,
// so the sampled UVs hit the right pixels.
function buildTileBatch(list, imgW, imgH) {
  const out = new Float32Array(list.length * 6 * 4)
  let o = 0
  for (const { tx, ty, stamp } of list) {
    const dx0 = tx * TILE_PX, dy0 = ty * TILE_PX
    const dx1 = dx0 + TILE_PX, dy1 = dy0 + TILE_PX
    const src = stamp.sectionPath
      ? transformedSourceCell(0, 0, 1, 1, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV)
      : { sx: stamp.sx, sy: stamp.sy }
    // The source cell from the stamp is already pre-rotated (it was
    // baked at stamp-time), but the per-tile rotation/flip still
    // controls how the *pixels* sit inside that source slot.
    const sx0 = stamp.sx * 32 / imgW
    const sy0 = stamp.sy * 32 / imgH
    const sx1 = (stamp.sx + 1) * 32 / imgW
    const sy1 = (stamp.sy + 1) * 32 / imgH
    void src
    // Compute the four UV corners after applying rotation + flips so
    // the texture is sampled the same way the 2D drawTransformedTile
    // would paint it.
    let uTL = sx0, vTL = sy0, uTR = sx1, vTR = sy0, uBR = sx1, vBR = sy1, uBL = sx0, vBL = sy1
    const rot = (stamp.rotation || 0) & 3
    for (let i = 0; i < rot; i++) {
      // 90° CW: TL←BL, TR←TL, BR←TR, BL←BR
      const nuTL = uBL, nvTL = vBL
      const nuTR = uTL, nvTR = vTL
      const nuBR = uTR, nvBR = vTR
      const nuBL = uBR, nvBL = vBR
      uTL = nuTL; vTL = nvTL; uTR = nuTR; vTR = nvTR; uBR = nuBR; vBR = nvBR; uBL = nuBL; vBL = nvBL
    }
    if (stamp.flipH) {
      // Mirror across the vertical axis: swap left↔right UVs.
      let t = uTL; uTL = uTR; uTR = t
      t = vTL; vTL = vTR; vTR = t
      t = uBL; uBL = uBR; uBR = t
      t = vBL; vBL = vBR; vBR = t
    }
    if (stamp.flipV) {
      let t = uTL; uTL = uBL; uBL = t
      t = vTL; vTL = vBL; vBL = t
      t = uTR; uTR = uBR; uBR = t
      t = vTR; vTR = vBR; vBR = t
    }
    // Triangle 1: TL, TR, BR
    out[o++] = dx0; out[o++] = dy0; out[o++] = uTL; out[o++] = vTL
    out[o++] = dx1; out[o++] = dy0; out[o++] = uTR; out[o++] = vTR
    out[o++] = dx1; out[o++] = dy1; out[o++] = uBR; out[o++] = vBR
    // Triangle 2: TL, BR, BL
    out[o++] = dx0; out[o++] = dy0; out[o++] = uTL; out[o++] = vTL
    out[o++] = dx1; out[o++] = dy1; out[o++] = uBR; out[o++] = vBR
    out[o++] = dx0; out[o++] = dy1; out[o++] = uBL; out[o++] = vBL
  }
  return out
}

// buildFeatureBatch produces the vertex array for every feature in a
// group.  Each feature is one quad sized to the sprite's natural
// dimensions; no rotation/flip support since the GAF sprites we serve
// for the canvas are already the final pose.
function buildFeatureBatch(items, w, h) {
  const out = new Float32Array(items.length * 6 * 4)
  let o = 0
  for (const { x, y } of items) {
    const x1 = x + w, y1 = y + h
    out[o++] = x;   out[o++] = y;   out[o++] = 0; out[o++] = 0
    out[o++] = x1;  out[o++] = y;   out[o++] = 1; out[o++] = 0
    out[o++] = x1;  out[o++] = y1;  out[o++] = 1; out[o++] = 1
    out[o++] = x;   out[o++] = y;   out[o++] = 0; out[o++] = 0
    out[o++] = x1;  out[o++] = y1;  out[o++] = 1; out[o++] = 1
    out[o++] = x;   out[o++] = y1;  out[o++] = 0; out[o++] = 1
  }
  return out
}

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

function updateRotationBadge(tx, ty, fw, fh, rotation, flipH = false, flipV = false) {
  const badge = $('#rotation-badge')
  if (!badge) return
  badge.classList.remove('hidden')
  const angleEl = $('#rb-angle')
  if (angleEl) angleEl.textContent = ((rotation & 3) * 90) + '°'
  const flipEl = $('#rb-flip')
  if (flipEl) {
    const tags = []
    if (flipH) tags.push('⇋H')
    if (flipV) tags.push('⥯V')
    flipEl.textContent = tags.length ? ' · ' + tags.join(' ') : ''
  }
  // Position in scroll-content coords: the canvas-style is scaled by
  // state.zoom, and the badge is a sibling absolutely positioned in
  // the same scroll container, so multiply by zoom to match.
  const z = state.zoom
  const left = (tx + fw) * TILE_PX * z + 8
  const top = ty * TILE_PX * z
  badge.style.left = left + 'px'
  badge.style.top = top + 'px'
}

function hideRotationBadge() {
  const badge = $('#rotation-badge')
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

function normalizedRect(r) {
  const x = Math.min(r.x, r.x + r.w - 1)
  const y = Math.min(r.y, r.y + r.h - 1)
  return {
    x: Math.min(r.x, r.x + r.w - 1),
    y: Math.min(r.y, r.y + r.h - 1),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
    _: x + y, // silence "unused" if linter quibbles
  }
}

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
  const mini = $('#minimap')
  const toggle = $('#minimap-toggle')
  const panel = $('#minimap-panel')
  const wrap = $('#canvas-scroll')
  if (!mini || !toggle || !panel || !wrap) return

  // Click/drag on the minimap pans the main canvas.
  let panning = false
  const panTo = (e) => {
    const rect = mini.getBoundingClientRect()
    const cx = (e.clientX - rect.left) / rect.width
    const cy = (e.clientY - rect.top) / rect.height
    const canvas = $('#canvas')
    const fullW = canvas.width * state.zoom
    const fullH = canvas.height * state.zoom
    // Convert minimap fraction → map-pixel → stack-pixel by adding the
    // overscroll padding (the canvas's offset within .canvas-stack).
    wrap.scrollLeft = cx * fullW - wrap.clientWidth / 2 + overscrollPadding.x
    wrap.scrollTop = cy * fullH - wrap.clientHeight / 2 + overscrollPadding.y
  }
  mini.addEventListener('mousedown', (e) => { panning = true; panTo(e) })
  window.addEventListener('mousemove', (e) => { if (panning) panTo(e) })
  window.addEventListener('mouseup', () => { panning = false })

  // Re-position the viewport overlay as the user scrolls.
  wrap.addEventListener('scroll', () => {
    // Newly-visible tiles need to be drawn (the main canvas is now
    // viewport-culled, so off-viewport content is blank until rendered).
    scheduleRenderCanvas()
    scheduleMinimapRender()
  })

  toggle.addEventListener('click', () => {
    panel.classList.toggle('collapsed')
    toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−'
    persistPanelCollapsed('minimap-panel', panel.classList.contains('collapsed'))
  })

  // Close button — fully hides the panel.  The user gets it back via
  // the Minimap toggle in the View dropdown.
  const closeBtn = $('#minimap-close')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => setMinimapVisible(false))
  }

  // Drag to reposition.  We grab via the header (which already has
  // `cursor: grab`) and update top/left in pixels.  Positions are
  // clamped to the canvas-wrap so the panel can't be flung off-screen.
  const header = $('#minimap-header')
  if (header) {
    let dragOffset = null
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return // ignore clicks on the toggle/close buttons
      e.preventDefault()
      const panelRect = panel.getBoundingClientRect()
      dragOffset = { dx: e.clientX - panelRect.left, dy: e.clientY - panelRect.top }
      header.classList.add('dragging')
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragOffset) return
      const wrapWrap = $('.canvas-wrap')
      if (!wrapWrap) return
      const wrapRect = wrapWrap.getBoundingClientRect()
      const w = panel.offsetWidth || 216
      const h = panel.offsetHeight || 240
      const left = clamp(e.clientX - dragOffset.dx - wrapRect.left, 4, Math.max(4, wrapRect.width - w - 4))
      const top = clamp(e.clientY - dragOffset.dy - wrapRect.top, 4, Math.max(4, wrapRect.height - h - 4))
      state.minimapPos = { top, left }
      applyMinimapPosition()
    })
    window.addEventListener('mouseup', () => {
      if (dragOffset) {
        dragOffset = null
        header.classList.remove('dragging')
        // Persist via the same shared layout map the other panels
        // use, so the minimap reopens in the same spot next session.
        persistPanelLayout(panel)
      }
    })
  }
}

function setMinimapVisible(visible) {
  state.showMinimap = visible
  const panel = $('#minimap-panel')
  if (panel) panel.classList.toggle('hidden', !visible)
  const toggle = $('#opt-minimap')
  if (toggle) toggle.dataset.on = visible ? '1' : '0'
  persistPrefs()
}

// setFeaturesVisible / setStartPositionsVisible mirror setMinimapVisible
// but cover the two new View toggles.  Toggling features off while the
// user is in a feature-centric mode (select-features or picker) drops
// them back to Select, since a tool that can't see its targets is
// useless.  Same for start-positions mode.
function setFeaturesVisible(visible) {
  state.showFeatures = visible
  const t = $('#opt-features')
  if (t) t.dataset.on = visible ? '1' : '0'
  persistPrefs()
  if (!visible && (state.mode === 'select-features' || state.mode === 'picker')) {
    setMode('select-terrain')
  } else {
    renderCanvas()
  }
}

function setStartPositionsVisible(visible) {
  state.showStartPositions = visible
  const t = $('#opt-startpoints')
  if (t) t.dataset.on = visible ? '1' : '0'
  persistPrefs()
  if (!visible && state.mode === 'start-points') {
    setMode('select-terrain')
  } else {
    renderCanvas()
  }
}

// setVoidsVisible toggles the view-menu pref.  The actual draw call
// in drawVoidOverlay reads state.showVoids AND the active mode, so a
// user in Voids mode still sees what they're painting.
function setVoidsVisible(visible) {
  state.showVoids = visible
  const toggle = $('#opt-voids')
  if (toggle) toggle.dataset.on = visible ? '1' : '0'
  persistPrefs()
  // Hiding voids while the user is still in Voids paint mode would
  // leave them with an invisible tool — drop back to Select so the
  // editor stays in a coherent state.
  if (!visible && state.mode === 'voids') {
    setMode('select-terrain')
  } else {
    renderCanvas()
  }
}

function applyMinimapPosition() {
  const panel = $('#minimap-panel')
  if (!panel || !state.minimapPos) return
  panel.style.top = state.minimapPos.top + 'px'
  panel.style.left = state.minimapPos.left + 'px'
  panel.style.right = 'auto'
}

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
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = String(v) }
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
// .canvas-wrap.  Used for both the dev-stats panel and the camera-info
// panel — both share the same DOM shape (header bar + grip handle).
function makePanelDraggable(panel, header) {
  if (!panel || !header) return
  let dragOffset = null
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    const rect = panel.getBoundingClientRect()
    dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    header.classList.add('dragging')
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragOffset) return
    const wrap = $('.canvas-wrap')
    if (!wrap) return
    const wr = wrap.getBoundingClientRect()
    const w = panel.offsetWidth || 216
    const h = panel.offsetHeight || 100
    const left = clamp(e.clientX - dragOffset.dx - wr.left, 4, Math.max(4, wr.width - w - 4))
    const top = clamp(e.clientY - dragOffset.dy - wr.top, 4, Math.max(4, wr.height - h - 4))
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  })
  window.addEventListener('mouseup', () => {
    if (dragOffset) {
      dragOffset = null
      header.classList.remove('dragging')
      // Save the final position so the panel reopens in the same
      // spot on the next session.
      persistPanelLayout(panel)
    }
  })
}

// persistPanelLayout snapshots the panel's current position into the
// shared panelLayout map, then writes prefs.  Vertical position is
// stored as a viewport-height fraction so a wider/taller window on
// the next launch still puts the panel roughly where the user
// expects.  Horizontal position is stored as a px offset from
// whichever edge the panel is closer to.
function persistPanelLayout(panel) {
  if (!panel || !panel.id) return
  const wrap = $('.canvas-wrap')
  if (!wrap) return
  const wr = wrap.getBoundingClientRect()
  const pr = panel.getBoundingClientRect()
  if (wr.height <= 0 || wr.width <= 0) return
  const top = pr.top - wr.top
  const leftDist = pr.left - wr.left
  const rightDist = wr.right - pr.right
  const hSide = leftDist <= rightDist ? 'left' : 'right'
  const hOffset = hSide === 'left' ? Math.round(leftDist) : Math.round(rightDist)
  const vRatio = clamp(top / wr.height, 0, 1)
  state.panelLayout = state.panelLayout || {}
  const cur = state.panelLayout[panel.id] || {}
  state.panelLayout[panel.id] = {
    vRatio,
    hSide,
    hOffset,
    collapsed: !!cur.collapsed,
  }
  persistPrefs()
}

// persistPanelCollapsed updates only the collapsed flag for a panel
// (called from collapse-toggle handlers) without touching position.
function persistPanelCollapsed(panelId, collapsed) {
  if (!panelId) return
  state.panelLayout = state.panelLayout || {}
  const cur = state.panelLayout[panelId] || {}
  state.panelLayout[panelId] = { ...cur, collapsed: !!collapsed }
  persistPrefs()
}

// applyPanelLayout positions and (un)collapses every panel that has
// a saved layout entry.  Called once at the end of finishEditorBoot
// so the canvas-wrap dimensions are settled before we read them.
function applyPanelLayout() {
  const map = state.panelLayout || {}
  const wrap = $('.canvas-wrap')
  if (!wrap) return
  const wr = wrap.getBoundingClientRect()
  for (const id of Object.keys(map)) {
    const panel = document.getElementById(id)
    if (!panel) continue
    const saved = map[id]
    if (saved.collapsed) panel.classList.add('collapsed')
    else panel.classList.remove('collapsed')
    // Reflect the collapse state on the matching toggle button label,
    // if there is one (dev-stats / camera-info follow the +/− pattern).
    const toggle = panel.querySelector('.minimap-toggle')
    if (toggle) toggle.textContent = saved.collapsed ? '+' : '−'
    if (typeof saved.vRatio === 'number' && wr.height > 0) {
      const top = clamp(saved.vRatio * wr.height, 4, Math.max(4, wr.height - panel.offsetHeight - 4))
      panel.style.top = top + 'px'
      panel.style.bottom = 'auto'
    }
    if (typeof saved.hOffset === 'number') {
      if (saved.hSide === 'right') {
        panel.style.right = saved.hOffset + 'px'
        panel.style.left = 'auto'
      } else {
        panel.style.left = saved.hOffset + 'px'
        panel.style.right = 'auto'
      }
    }
  }
}

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
  // Close button on the settings dialog now also saves — the dialog
  // is small enough that a separate Apply offered no value, just a
  // surface for "I clicked Close but my changes vanished" confusion.
  $('#settings-apply')?.addEventListener('click', applySettingsDialog)
  $('#settings-reset')?.addEventListener('click', resetSettingsDialog)
  // ESC closes the settings dialog (saves nothing — same as before).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const dlg = $('#settings-dialog')
    if (dlg && !dlg.classList.contains('hidden')) {
      e.stopPropagation()
      closeSettingsDialog()
    }
  })
  // Settings dialog tab strip — same pattern as the Help dialog's
  // tabs.  Clicking a tab activates the matching body pane.
  $$('#settings-dialog .settings-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.settingsTab
      $$('#settings-dialog .settings-tab').forEach((t) => {
        const on = t.dataset.settingsTab === key
        t.classList.toggle('active', on)
        t.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      $$('#settings-dialog .settings-tab-body').forEach((b) => {
        b.classList.toggle('active', b.dataset.settingsTabBody === key)
      })
    })
  })
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

function openSettingsDialog() {
  const dlg = $('#settings-dialog')
  if (!dlg) return
  const s = state.settings || DEFAULT_SETTINGS
  $('#set-zoom-step').value = s.zoomStep ?? 1.25
  $('#set-erase-size').value = s.defaultEraseSize ?? 1
  $('#set-voids-size').value = s.defaultVoidsSize ?? 1
  $('#set-hm-radius').value = s.defaultHmRadius ?? 4
  $('#set-hm-strength').value = s.defaultHmStrength ?? 4
  $('#set-hb-idle').value = s.heartbeatIdleMs ?? 5000
  $('#set-hb-retry').value = s.heartbeatReconnectMs ?? 1000
  // Visibility defaults read from the live state booleans (they're
  // the same flags the View menu toggles).
  $('#set-show-minimap').checked = !!state.showMinimap
  $('#set-show-camera-info').checked = !!state.showCameraInfo
  $('#set-show-gridlines').checked = !!state.showGridlines
  $('#set-animate-features').checked = !!state.animateFeatures
  $('#set-show-voids').checked = !!state.showVoids
  $('#set-show-contours').checked = !!state.showContours
  $('#set-show-buildable').checked = !!state.showBuildable
  $('#set-show-features').checked = !!state.showFeatures
  $('#set-show-startpos').checked = !!state.showStartPositions
  // Unit Editor tab — defaults for newly-opened model tabs.
  if ($('#set-unit-env')) $('#set-unit-env').value = s.unitDefaultEnv ?? 'greenworld'
  if ($('#set-unit-reflections')) $('#set-unit-reflections').checked = s.unitDefaultReflections !== false
  if ($('#set-unit-bob')) $('#set-unit-bob').checked = s.unitDefaultBob !== false
  if ($('#set-unit-water-reflections')) $('#set-unit-water-reflections').checked = s.unitDefaultWaterReflections !== false
  if ($('#set-unit-specular')) $('#set-unit-specular').checked = s.unitDefaultSpecular !== false
  if ($('#set-unit-godbeams')) $('#set-unit-godbeams').checked = s.unitDefaultGodBeams !== false
  // Smart-default the active tab to whatever workspace the user is
  // currently in.  Model tab open → Unit Editor; map tab → Map
  // Editor; nothing open → General.
  const activeTab = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
  const wantTab = activeTab?.type === 'model' ? 'unit'
    : activeTab?.type === 'map' ? 'map'
    : 'general'
  $$('#settings-dialog .settings-tab').forEach((t) => {
    const on = t.dataset.settingsTab === wantTab
    t.classList.toggle('active', on)
    t.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  $$('#settings-dialog .settings-tab-body').forEach((b) => {
    b.classList.toggle('active', b.dataset.settingsTabBody === wantTab)
  })
  dlg.classList.remove('hidden')
  // Focus the first input in the active tab body so keyboard users
  // can start typing right away.  Falls back to the first body's
  // input if the matcher misses (defensive).
  const firstInput = dlg.querySelector('.settings-tab-body.active input, .settings-tab-body.active select')
  if (firstInput) firstInput.focus()
}

function closeSettingsDialog() {
  $('#settings-dialog')?.classList.add('hidden')
}

function applySettingsDialog() {
  const num = (id, fb) => {
    const v = parseFloat($(id).value)
    return Number.isFinite(v) ? v : fb
  }
  const s = { ...DEFAULT_SETTINGS, ...(state.settings || {}) }
  s.zoomStep = clamp(num('#set-zoom-step', 1.25), 1.05, 2)
  s.defaultEraseSize = clamp(Math.round(num('#set-erase-size', 1)), 1, 16)
  s.defaultVoidsSize = clamp(Math.round(num('#set-voids-size', 1)), 1, 32)
  s.defaultHmRadius = clamp(Math.round(num('#set-hm-radius', 4)), 1, 32)
  s.defaultHmStrength = clamp(Math.round(num('#set-hm-strength', 4)), 1, 32)
  s.heartbeatIdleMs = clamp(Math.round(num('#set-hb-idle', 5000)), 500, 60000)
  s.heartbeatReconnectMs = clamp(Math.round(num('#set-hb-retry', 1000)), 200, 10000)
  // Unit Editor defaults — picked up by the next openModelViewer().
  if ($('#set-unit-env')) s.unitDefaultEnv = $('#set-unit-env').value
  if ($('#set-unit-reflections')) s.unitDefaultReflections = $('#set-unit-reflections').checked
  if ($('#set-unit-bob')) s.unitDefaultBob = $('#set-unit-bob').checked
  if ($('#set-unit-water-reflections')) s.unitDefaultWaterReflections = $('#set-unit-water-reflections').checked
  if ($('#set-unit-specular')) s.unitDefaultSpecular = $('#set-unit-specular').checked
  if ($('#set-unit-godbeams')) s.unitDefaultGodBeams = $('#set-unit-godbeams').checked
  state.settings = s
  // Visibility flags: push through the existing setters so the View
  // menu rows + canvas re-render in step.
  setMinimapVisible($('#set-show-minimap').checked)
  setCameraInfoVisible($('#set-show-camera-info').checked)
  state.showGridlines = $('#set-show-gridlines').checked
  state.animateFeatures = $('#set-animate-features').checked
  state.showVoids = $('#set-show-voids').checked
  state.showContours = $('#set-show-contours').checked
  state.showBuildable = $('#set-show-buildable').checked
  state.showFeatures = $('#set-show-features').checked
  state.showStartPositions = $('#set-show-startpos').checked
  syncDomFromPrefs()
  persistPrefs()
  renderCanvas()
  closeSettingsDialog()
  setStatus('Settings applied and saved.')
}

function resetSettingsDialog() {
  state.settings = { ...DEFAULT_SETTINGS }
  // Re-open so the form repaints with the defaults — saves the user
  // a second click to verify what changed.
  openSettingsDialog()
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
  $('#btn-save').addEventListener('click', save)
  $('#btn-save-loose')?.addEventListener('click', saveLoose)
  $('#btn-resize').addEventListener('click', openResizeDialog)
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
  $('#btn-import-heightmap')?.addEventListener('click', () => $('#import-heightmap-file').click())
  $('#import-heightmap-file')?.addEventListener('change', onImportHeightmapFile)
  $('#btn-undo').addEventListener('click', undo)
  $('#btn-redo').addEventListener('click', redo)
  wireHistoryFlyout($('#btn-undo'), $('#undo-history-popup'))
  wireHistoryFlyout($('#btn-redo'), $('#redo-history-popup'))
  $('#btn-new').addEventListener('click', startNewMapFromEditor)
  $('#btn-open').addEventListener('click', openExistingMapFromEditor)
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
  $('#btn-ota').addEventListener('click', openOTADialog)

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
// be added with one click.
const SCHEMA_PLAYER_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10]

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
  const active = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
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

// confirmDialog shows the in-app confirm modal and resolves with the
// user's choice.  Replaces the native window.confirm() so the prompt
// looks like the rest of the editor and isn't a browser-skinned blocker.
function confirmDialog({ title = 'Confirm', message = '', okLabel = 'OK', cancelLabel = 'Cancel', okDanger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = $('#confirm-dialog')
    const titleEl = $('#confirm-title')
    const msgEl = $('#confirm-message')
    const okBtn = $('#confirm-ok')
    const cancelBtn = $('#confirm-cancel')
    if (!dialog || !titleEl || !msgEl || !okBtn || !cancelBtn) {
      resolve(window.confirm(`${title}\n\n${message}`))
      return
    }
    titleEl.textContent = title
    msgEl.textContent = message
    okBtn.textContent = okLabel
    cancelBtn.textContent = cancelLabel
    okBtn.classList.toggle('danger', !!okDanger)
    dialog.classList.remove('hidden')
    const cleanup = (result) => {
      dialog.classList.add('hidden')
      okBtn.classList.remove('danger')
      okBtn.removeEventListener('click', onOK)
      cancelBtn.removeEventListener('click', onCancel)
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onOK = () => cleanup(true)
    const onCancel = () => cleanup(false)
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(false) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(true) }
    }
    okBtn.addEventListener('click', onOK)
    cancelBtn.addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey, true)
    okBtn.focus()
  })
}

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

// mulberry32: tiny seeded PRNG so users can reproduce a scatter.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
let selectedModelName = null

function wireWelcomeTabs() {
  const tabs = $$('.welcome-tab')
  const panels = $$('.welcome-tab-panel')
  if (!tabs.length || !panels.length) return
  for (const tab of tabs) {
    if (tab.disabled) continue
    tab.addEventListener('click', () => {
      const key = tab.dataset.welcomeTab
      if (!key) return
      for (const t of tabs) {
        t.classList.toggle('active', t === tab)
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false')
      }
      for (const p of panels) {
        p.classList.toggle('hidden', p.dataset.welcomeTabPanel !== key)
      }
    })
  }
}

function wireModelDialogs() {
  const openBtn = $('#welcome-model-open')
  if (openBtn) openBtn.addEventListener('click', openModelPicker)
  const back = $('#model-open-back')
  if (back) back.addEventListener('click', closeModelPicker)
  const filter = $('#model-filter')
  if (filter) filter.addEventListener('input', renderModelList)
  const confirm = $('#model-open-confirm')
  if (confirm) confirm.addEventListener('click', () => {
    if (selectedModelName) openModelViewer(selectedModelName)
  })
  // No "Close" button on the viewer overlay any more — the user
  // closes the model tab via the × in the shared tab bar, same
  // gesture they use for maps.
  // Camera dropdown: reset + auto-rotate toggle.
  const reset = $('#mv-act-reset')
  if (reset) reset.addEventListener('click', () => {
    if (modelViewerInstance && modelViewerInstance.model) {
      const cam = modelViewerInstance.camera
      cam.frameBounds(
        modelViewerInstance.model.bounds.min,
        modelViewerInstance.model.bounds.max,
      )
      // Restore default angle too — auto-rotate may have walked
      // yaw around the unit; reset means "back to the entry view".
      cam.yaw = 215 * Math.PI / 180
      cam.pitch = 18 * Math.PI / 180
      cam.distance *= 1.25
      modelViewerInstance.renderer.requestRedraw()
    }
  })
  const auto = $('#mv-act-autorotate')
  if (auto) auto.addEventListener('click', (e) => {
    // Auto-Rotate now lives inside the Camera dropdown.  Stop the
    // click from bubbling out to the dropdown's outside-click
    // handler, otherwise the dropdown closes the instant the user
    // toggles the row.
    e.stopPropagation()
    const on = auto.dataset.on !== '1'
    auto.dataset.on = on ? '1' : '0'
    auto.classList.toggle('active', on)
    if (modelViewerInstance) modelViewerInstance.setAutoRotate(on)
  })
  // Tree filter — typing narrows the visible pieces to those whose
  // name matches.  Match is case-insensitive substring, applied to
  // both group and leaf rows.
  const treeFilter = $('#mv-tree-filter')
  if (treeFilter) treeFilter.addEventListener('input', () => filterPieceTree(treeFilter.value))
  // Model dropdown actions.
  wireModelRibbonDropdown('mv-model-dropdown')
  wireModelRibbonDropdown('mv-anim-dropdown')
  wireModelRibbonDropdown('mv-camera-dropdown')
  wireModelRibbonDropdown('mv-render-dropdown')
  wireModelRibbonDropdown('mv-ground-dropdown')
  wireModelRibbonDropdown('mv-options-dropdown')
  wireModelRibbonDropdown('mv-view-dropdown')
  wireMvInspectors()
  wireModelViewMenu()
  wireModelTabBar()
  wireModelChromeButtons()
  // Copyright year now lives in the shared #copyright-year in the
  // editor's footer — no per-viewer year stamp needed.
  const openAgain = $('#mv-act-open')
  if (openAgain) openAgain.addEventListener('click', () => {
    closeModelViewer()
  })
  const showStats = $('#mv-act-pieces')
  if (showStats) showStats.addEventListener('click', () => {
    if (!modelViewerInstance || !modelViewerInstance.model) return
    const m = modelViewerInstance.model
    const triCount = m.flat.reduce((n, p) => n + p.drawGroups.reduce((s, g) => s + (g.mode === modelViewerInstance.renderer.gl.TRIANGLES ? g.vertexCount / 3 : 0), 0), 0)
    setModelViewerStatus(`${m.name} · ${m.flat.length} pieces · ${Math.round(triCount)} triangles`)
  })
}

// rowNameText pulls just the human-readable name out of a menu-row.
// The row's structure is <span ico><span name><span check><span chev>;
// row.textContent concatenates all of them, so a naive textContent
// read picks up the icon emoji + the check glyph and ends up
// painting "🌊🌊Sea" on the dropdown button.  This helper grabs
// just the children that aren't icon / check / chev / lbl spans.
function rowNameText(row) {
  if (!row) return ''
  const parts = [...row.children].filter((c) => (
    c.tagName === 'SPAN' &&
    !c.classList.contains('ico') &&
    !c.classList.contains('menu-check') &&
    !c.classList.contains('chev-right') &&
    !c.classList.contains('chev-down') &&
    !c.classList.contains('lbl') &&
    !c.classList.contains('env-current-lbl')
  ))
  if (parts.length === 0) return row.textContent.trim()
  return parts.map((c) => c.textContent).join(' ').trim()
}

// wireToggleSubmenu wires a menu row that does both:
//   * Body click → toggles a boolean effect on/off (the menu-check
//     glyph shows the state)
//   * Hover or click on the row → reveals a submenu of sliders
// The Waves and Bobbing/Swaying rows in Studio Options use this.
function wireToggleSubmenu({ rowId, submenuId, onToggle }) {
  const row = document.getElementById(rowId)
  const sub = document.getElementById(submenuId)
  if (!row || !sub) return
  // Default state — start with toggle on (data-on already "1" in HTML).
  row.dataset.on = row.dataset.on || '1'
  row.classList.toggle('active', row.dataset.on === '1')
  let suppress = false
  row.addEventListener('click', (e) => {
    e.stopPropagation()
    // Clicks on the slider thumb itself bubble up — ignore so dragging
    // doesn't flip the toggle.
    if (e.target.tagName === 'INPUT') return
    if (suppress) { suppress = false; return }
    const on = row.dataset.on !== '1'
    row.dataset.on = on ? '1' : '0'
    row.classList.toggle('active', on)
    onToggle(on)
  })
  // Mouse over the chev opens the submenu without firing the toggle.
  // Use mouseenter on the row to reveal; mouseleave hides.  This
  // matches the Environment row's hover behaviour.
  row.addEventListener('mouseenter', () => sub.classList.remove('hidden'))
  row.addEventListener('mouseleave', (e) => {
    // Keep open if the cursor moved onto the submenu itself.
    if (e.relatedTarget && sub.contains(e.relatedTarget)) return
    sub.classList.add('hidden')
  })
  sub.addEventListener('mouseleave', () => sub.classList.add('hidden'))
  // Stop submenu clicks from closing the parent dropdown.
  sub.addEventListener('click', (e) => e.stopPropagation())
}

// wireSliderInput hooks a range input + value label.  The input
// value is divided by 100 before being handed to the callback so
// HTML can use integer steps for cleaner scrub behaviour and the
// renderer still gets a smooth float multiplier.  An optional
// formatter overrides the default "1.0×" label - used by sliders
// that want a "12%" or other-unit display.  The formatter receives
// the post-scaling float so 12 (% step) reads as 0.12 to the
// callback but 12% to the user.
function wireSliderInput(inputId, valueId, cb, format) {
  const inp = document.getElementById(inputId)
  const lbl = document.getElementById(valueId)
  if (!inp) return
  const update = () => {
    const v = parseInt(inp.value, 10) / 100
    if (lbl) lbl.textContent = format ? format(parseInt(inp.value, 10), v) : (v.toFixed(1) + '×')
    cb(v)
  }
  inp.addEventListener('input', update)
  // Stop clicks on the slider from bubbling to the parent row's
  // toggle handler.
  inp.addEventListener('click', (e) => e.stopPropagation())
  inp.addEventListener('pointerdown', (e) => e.stopPropagation())
}

// wireModelRibbonDropdown opens / closes a ribbon-style popup,
// positioning it below the button.  Mirrors the editor's ribbon
// behaviour without re-using its handlers (the editor's wireRibbon()
// is bound to its own button IDs).
function wireModelRibbonDropdown(id) {
  const root = document.getElementById(id)
  if (!root) return
  const btn = root.querySelector('.ribbon-dropdown-btn')
  const popup = root.querySelector('.ribbon-dropdown-popup')
  if (!btn || !popup) return
  const close = () => popup.classList.add('hidden')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasOpen = !popup.classList.contains('hidden')
    document.querySelectorAll('#model-viewer-dialog .ribbon-dropdown-popup').forEach((p) => p.classList.add('hidden'))
    if (wasOpen) return
    const r = btn.getBoundingClientRect()
    popup.style.top = `${r.bottom + 4}px`
    popup.style.left = `${r.left}px`
    popup.classList.remove('hidden')
  })
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target)) close()
  })
  popup.addEventListener('click', (e) => {
    // Close after a click on a menu-row that finishes the user's
    // intent (mode pick, ground pick, env pick, COB action).  Skip
    // close for toggle rows + submenu wrappers — those are sticky
    // controls the user often flips repeatedly without wanting the
    // dropdown to vanish between flips.
    const row = e.target.closest('.menu-row')
    if (!row || row.disabled) return
    if (row.classList.contains('toggle-row')) return
    if (row.classList.contains('menu-row-submenu')) return
    if (row.classList.contains('menu-row-slider')) return
    close()
  })
}

function setModelViewerStatus(msg) {
  // Shared statusbar — same element the map editor's setStatus
  // writes to.  Lets the viewer report "armack · 16 pieces" or
  // "Loading…" in the very same spot the editor uses for tile
  // commits.
  const el = $('#status')
  if (el) el.textContent = msg
}

// wireModelViewMenu binds the model viewer's Rendering and Camera
// dropdown menus + the Ground segmented control.  Selecting a Mode
// row updates both the renderer and the parent button's label so
// the closed dropdown shows the current choice (matches the map
// editor's "Display mode" dropdown).
function wireModelViewMenu() {
  const applyMode = (mode) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setRenderMode(mode)
  }
  const applyOverlay = (on) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setWireframeOverlay(on)
  }
  const applyGround = (mode) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setGroundMode(mode)
  }
  const applyWireWidth = (px) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setWireframeWidth(px)
  }
  const modeLabel = $('#mv-render-current-lbl')
  const modeIco = $('#mv-render-current-ico')
  const wireOverlay = $('#mv-act-wire-overlay')
  // applyWireOverlayLock: in Wireframe Only mode the wireframe IS the
  // image — the Show Wireframe toggle must be on (and locked) so the
  // user can't render an empty frame.  Switching out of wireframe
  // automatically clears the overlay so the deck of cards lines
  // don't keep cluttering the Full/Flat render the user just picked.
  const applyWireOverlayLock = (mode) => {
    if (!wireOverlay) return
    if (mode === 'wireframe') {
      wireOverlay.dataset.on = '1'
      wireOverlay.classList.add('active', 'disabled-locked')
      wireOverlay.setAttribute('aria-disabled', 'true')
      applyOverlay(true)
    } else {
      wireOverlay.classList.remove('disabled-locked')
      wireOverlay.removeAttribute('aria-disabled')
      // Clear the overlay when leaving wireframe so the freshly-
      // selected mode renders cleanly.  If the user wants overlay
      // on top of Studio Mode they re-tick the toggle themselves.
      wireOverlay.dataset.on = '0'
      wireOverlay.classList.remove('active')
      applyOverlay(false)
    }
  }
  for (const row of $$('.mv-mode-row')) {
    row.addEventListener('click', () => {
      const mode = row.dataset.mvMode
      if (!mode) return
      $$('.mv-mode-row').forEach((r) => r.classList.toggle('active', r === row))
      if (modeLabel) modeLabel.textContent = rowNameText(row)
      // Mirror the row's icon onto the dropdown button so the
      // closed dropdown shows the picked mode at a glance.
      const rowIco = row.querySelector('.ico')
      if (modeIco && rowIco) modeIco.textContent = rowIco.textContent
      applyMode(mode)
      applyWireOverlayLock(mode)
    })
  }
  const groundLabel = $('#mv-ground-current-lbl')
  const groundIco = $('#mv-ground-current-ico')
  for (const row of $$('.mv-ground-row')) {
    row.addEventListener('click', () => {
      const mode = row.dataset.mvGround
      if (!mode) return
      $$('.mv-ground-row').forEach((r) => r.classList.toggle('active', r === row))
      // Update the dropdown button face so the closed menu shows
      // the current ground at a glance, matching Rendering's pattern.
      const ico = row.querySelector('.ico')
      if (groundLabel) groundLabel.textContent = rowNameText(row)
      if (groundIco && ico) groundIco.textContent = ico.textContent
      applyGround(mode)
    })
  }
  // Studio Options toggles — each one drives a ModelRenderer setter.
  const wireToggleRow = (id, applyFn) => {
    const el = $('#' + id)
    if (!el) return
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const on = el.dataset.on !== '1'
      el.dataset.on = on ? '1' : '0'
      el.classList.toggle('active', on)
      applyFn(on)
    })
  }
  wireToggleRow('mv-opt-reflections', (on) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setReflectionsEnabled(on)
  })
  // Bobbing/Swaying — body click toggles on/off; chev opens slider
  // submenu.  Same pattern is used for the Waves row.  wireToggleSubmenu
  // factors out the duplicated wiring for both.
  wireToggleSubmenu({
    rowId: 'mv-opt-bob-row',
    submenuId: 'mv-bob-submenu',
    onToggle: (on) => {
      if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setBobEnabled(on)
    },
  })
  wireSliderInput('mv-bob-amount', 'mv-bob-amount-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setBobAmount(v)
  })
  wireSliderInput('mv-bob-speed', 'mv-bob-speed-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setBobSpeed(v)
  })
  // Waves — toggles wave animation on/off; slider scales amplitude.
  wireToggleSubmenu({
    rowId: 'mv-opt-waves-row',
    submenuId: 'mv-waves-submenu',
    onToggle: (on) => {
      if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setWavesEnabled(on)
    },
  })
  wireSliderInput('mv-waves-intensity', 'mv-waves-intensity-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setWavesIntensity(v)
  })
  // Background terrain — the procedural mountain ring on non-sea
  // worlds.  Toggle controls visibility; sliders feed scalars
  // through to the env preset's mountainHeight / mountainScale.
  wireToggleSubmenu({
    rowId: 'mv-opt-bgterrain-row',
    submenuId: 'mv-bgterrain-submenu',
    onToggle: (on) => {
      if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setBgTerrainEnabled(on)
    },
  })
  wireSliderInput('mv-bgterrain-height', 'mv-bgterrain-height-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setBgTerrainHeight(v)
  })
  wireSliderInput('mv-bgterrain-scale', 'mv-bgterrain-scale-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setBgTerrainScale(v)
  })
  // Seabed features — same idea for the underwater rocks + dunes.
  // No on/off toggle here (seabed always exists in Sea mode); just
  // height / scale / rock-density sliders.  The parent row is
  // hover-driven via the env-style mouseenter pattern.
  const seabedParent = document.querySelector('#mv-opt-seabed-row')
  const seabedSubmenu = document.querySelector('#mv-seabed-submenu')
  if (seabedParent && seabedSubmenu) {
    seabedParent.addEventListener('mouseenter', () => {
      seabedSubmenu.classList.remove('hidden')
      seabedParent.classList.add('open')
    })
    seabedParent.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget && seabedSubmenu.contains(e.relatedTarget)) return
      seabedSubmenu.classList.add('hidden')
      seabedParent.classList.remove('open')
    })
    seabedSubmenu.addEventListener('mouseleave', () => {
      seabedSubmenu.classList.add('hidden')
      seabedParent.classList.remove('open')
    })
  }
  wireSliderInput('mv-seabed-height', 'mv-seabed-height-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setSeabedHeight(v)
  })
  wireSliderInput('mv-seabed-scale', 'mv-seabed-scale-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setSeabedScale(v)
  })
  // Rocks slider's raw value (0..100) is the probability percent;
  // wireSliderInput divides by 100 before calling the callback, so
  // `v` here is already 0..1 - exactly what setSeabedRockChance
  // wants.  Custom formatter shows the raw int with a % suffix.
  wireSliderInput('mv-seabed-rocks', 'mv-seabed-rocks-val', (v) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setSeabedRockChance(v)
  }, (raw) => `${raw}%`)
  wireToggleRow('mv-opt-water-reflections', (on) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setWaterReflectionsEnabled(on)
  })
  wireToggleRow('mv-opt-specular', (on) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setSpecularEnabled(on)
  })
  wireToggleRow('mv-opt-godbeams', (on) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setGodBeamsEnabled(on)
  })
  wireToggleRow('mv-opt-dof', (on) => {
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setDoFEnabled(on)
  })
  // Environment parent row — click toggles the .open class on the
  // row, which CSS uses to show/hide the submenu.  Clicking again
  // (or clicking outside the dropdown) closes it.  Snapshot the
  // currently-committed environment so the hover-preview can revert
  // to it if the user dismisses the submenu without a click.
  const envParent = $('#mv-opt-env-row')
  const envSubmenu = $('#mv-env-submenu')
  // Track whether we're hover-previewing.  The committed env is the
  // .active row's data-mv-env value — that survives across helpers
  // (applyUnitEditorDefaults flips .active too) so we always have a
  // canonical "what should the scene revert to" reference.
  let envPreviewing = false
  const getCommittedEnv = () => {
    const r = [...$$('.mv-env-row')].find((row) => row.classList.contains('active'))
    return r?.dataset.mvEnv || 'earth'
  }
  const revertEnvIfPreviewing = () => {
    if (!envPreviewing) return
    envPreviewing = false
    if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setEnvironment(getCommittedEnv())
  }
  if (envSubmenu) {
    // Mouse out of the submenu without clicking a row → revert any
    // active preview so the scene snaps back to the committed env.
    envSubmenu.addEventListener('mouseleave', () => revertEnvIfPreviewing())
  }
  if (envParent && envSubmenu) {
    // Hover the env row → submenu pops out automatically.  No
    // click required; the user is already deep in a dropdown so
    // saving them a click is a clear win.
    envParent.addEventListener('mouseenter', () => {
      envSubmenu.classList.remove('hidden')
      envParent.classList.add('open')
    })
    // Cursor moves out of the row AND off the submenu → close it.
    envParent.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget && envSubmenu.contains(e.relatedTarget)) return
      envSubmenu.classList.add('hidden')
      envParent.classList.remove('open')
      revertEnvIfPreviewing()
    })
    // Click is still accepted as a fallback (e.g. keyboard / touch).
    envParent.addEventListener('click', (e) => {
      if (e.target.closest('.mv-env-row')) return
      e.stopPropagation()
      const wasHidden = envSubmenu.classList.contains('hidden')
      envSubmenu.classList.toggle('hidden', !wasHidden)
      envParent.classList.toggle('open', wasHidden)
      if (!wasHidden) revertEnvIfPreviewing()
    })
    // Closing the parent dropdown popup also dismisses the submenu —
    // listen for that on the popup element via mouseleave.  Anything
    // that hides the popup without picking an env should revert.
    const popup = document.querySelector('#mv-options-dropdown-popup')
    if (popup) {
      const obs = new MutationObserver(() => {
        if (popup.classList.contains('hidden') && envPreviewing) {
          // Popup got closed (e.g. user clicked outside) — revert.
          revertEnvIfPreviewing()
          envSubmenu.classList.add('hidden')
          envParent.classList.remove('open')
        }
      })
      obs.observe(popup, { attributes: true, attributeFilter: ['class'] })
    }
  }
  // Environment submenu rows — hover previews live, click commits.
  const envLabel = $('#mv-env-current-lbl')
  const envIco = $('#mv-env-current-ico')
  for (const row of $$('.mv-env-row')) {
    row.addEventListener('mouseenter', () => {
      const env = row.dataset.mvEnv
      if (!env) return
      envPreviewing = (env !== getCommittedEnv())
      if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setEnvironment(env)
    })
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      const env = row.dataset.mvEnv
      if (!env) return
      $$('.mv-env-row').forEach((r) => r.classList.toggle('active', r === row))
      if (envLabel) envLabel.textContent = rowNameText(row)
      const rowIco = row.querySelector('.ico')
      if (envIco && rowIco) envIco.textContent = rowIco.textContent
      envPreviewing = false
      if (modelViewerInstance?.renderer) modelViewerInstance.renderer.setEnvironment(env)
      if (envParent) envParent.classList.remove('open')
      if (envSubmenu) envSubmenu.classList.add('hidden')
    })
  }

  // ── Team Colour picker ───────────────────────────────────────────
  // Mirrors the env-row mechanism: hover opens the submenu, hover on
  // a row previews via setTeamColor, click commits, mouseleave on the
  // submenu reverts to whichever row is .active.  Blue is the ARM
  // default — picking it disables the shader's hue shift entirely.
  const TEAM_COLOURS = {
    blue:   null, // sentinel — original blue, no recolour
    red:    [0.92, 0.18, 0.16],
    green:  [0.20, 0.78, 0.28],
    yellow: [0.95, 0.85, 0.20],
    purple: [0.62, 0.30, 0.85],
    cyan:   [0.20, 0.80, 0.92],
    orange: [0.98, 0.55, 0.18],
    white:  [0.95, 0.95, 0.95],
    black:  [0.10, 0.10, 0.12],
  }
  const teamParent = $('#mv-opt-team-row')
  const teamSubmenu = $('#mv-team-submenu')
  const teamLabel = $('#mv-team-current-lbl')
  const teamIco = $('#mv-team-current-ico')
  let teamPreviewing = false
  const getCommittedTeam = () => {
    const r = [...$$('.mv-team-row')].find((row) => row.classList.contains('active'))
    return r?.dataset.mvTeam || 'blue'
  }
  const applyTeam = (key) => {
    if (!modelViewerInstance?.renderer) return
    modelViewerInstance.renderer.setTeamColor(TEAM_COLOURS[key] ?? null)
  }
  const revertTeamIfPreviewing = () => {
    if (!teamPreviewing) return
    teamPreviewing = false
    applyTeam(getCommittedTeam())
  }
  if (teamSubmenu) {
    teamSubmenu.addEventListener('mouseleave', () => revertTeamIfPreviewing())
  }
  if (teamParent && teamSubmenu) {
    teamParent.addEventListener('mouseenter', () => {
      teamSubmenu.classList.remove('hidden')
      teamParent.classList.add('open')
    })
    teamParent.addEventListener('mouseleave', (e) => {
      if (e.relatedTarget && teamSubmenu.contains(e.relatedTarget)) return
      teamSubmenu.classList.add('hidden')
      teamParent.classList.remove('open')
      revertTeamIfPreviewing()
    })
    teamParent.addEventListener('click', (e) => {
      if (e.target.closest('.mv-team-row')) return
      e.stopPropagation()
      const wasHidden = teamSubmenu.classList.contains('hidden')
      teamSubmenu.classList.toggle('hidden', !wasHidden)
      teamParent.classList.toggle('open', wasHidden)
      if (!wasHidden) revertTeamIfPreviewing()
    })
  }
  for (const row of $$('.mv-team-row')) {
    row.addEventListener('mouseenter', () => {
      const key = row.dataset.mvTeam
      if (!key) return
      teamPreviewing = (key !== getCommittedTeam())
      applyTeam(key)
    })
    row.addEventListener('click', (e) => {
      e.stopPropagation()
      const key = row.dataset.mvTeam
      if (!key) return
      $$('.mv-team-row').forEach((r) => r.classList.toggle('active', r === row))
      if (teamLabel) teamLabel.textContent = rowNameText(row)
      const rowIco = row.querySelector('.ico')
      if (teamIco && rowIco) teamIco.textContent = rowIco.textContent
      teamPreviewing = false
      applyTeam(key)
      if (teamParent) teamParent.classList.remove('open')
      if (teamSubmenu) teamSubmenu.classList.add('hidden')
    })
  }
  const overlay = $('#mv-act-wire-overlay')
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      e.stopPropagation()
      // When locked-on by Wireframe Only mode, ignore clicks — the
      // overlay HAS to be on for that mode to render anything.
      if (overlay.classList.contains('disabled-locked')) return
      const on = overlay.dataset.on !== '1'
      overlay.dataset.on = on ? '1' : '0'
      overlay.classList.toggle('active', on)
      applyOverlay(on)
    })
  }
  // Wireframe thickness slider — live-updates as the user drags so
  // they see the effect immediately.  Range 1–6 px (clamped by the
  // GPU to its supported width range; most drivers cap at 1 px for
  // standard line rendering, which is why we offer thickness only
  // as a hint and the renderer fakes thicker lines via a second
  // overlay pass on top of the first).
  const slider = $('#mv-wire-thickness')
  const sliderVal = $('#mv-wire-thickness-val')
  if (slider) {
    slider.addEventListener('input', (e) => {
      e.stopPropagation()
      const v = parseInt(slider.value, 10)
      if (sliderVal) sliderVal.textContent = String(v)
      applyWireWidth(v)
    })
  }
}

// wireModelChromeButtons wires the Settings + Help buttons in the
// model viewer's right-ribbon to the same dialogs the map editor's
// chrome opens — sharing dialogs keeps the user out of two parallel
// UIs and lets them tune brushes / shortcuts in one place.
function wireModelChromeButtons() {
  $('#mv-btn-settings')?.addEventListener('click', () => {
    // openSettingsDialog is defined in the main settings module; if
    // not yet, click the editor's hidden button as a fallback so the
    // dialog always reaches whatever wiring lives elsewhere.
    if (typeof openSettingsDialog === 'function') openSettingsDialog()
    else $('#btn-settings')?.click()
  })
  $('#mv-btn-help')?.addEventListener('click', () => {
    if (typeof openHelpDialog === 'function') openHelpDialog()
    else $('#btn-help')?.click()
  })
}

// wireModelTabBar — only one tab bar exists now (the shared
// .map-tabs in the .app shell, populated by renderMapTabs).  Kept
// as a no-op so the boot sequence stays explicit about which
// surfaces have tab bars wired.
function wireModelTabBar() {
  // intentionally empty — see wireMapTabBar
}

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
// the shared topbar info and asks the viewer to load that 3DO.
async function activateModelTab(tab) {
  // Lazy-import the model3d module so users who never click a
  // model tab don't pay for the shader / matrix code.
  const mod = await import('./model3d/index.js')
  if (!modelViewerInstance) {
    modelViewerInstance = new mod.ModelViewer({
      canvas: $('#model-viewer-canvas'),
      // The shared statusbar's #status element now hosts model
      // viewer messages too — same DOM element the map editor
      // writes into.
      statusEl: $('#status'),
      onModelLoaded: (model, cob) => {
        renderPieceTree(model)
        renderTexturesTab(model)
        wireMvSidebarTabs()
        // Initial lifecycle state.  Units that ship with a Create
        // script start in 'unborn' — every other action button is
        // gated off until Create finishes (matches real TA, where a
        // unit can't do anything until its Create script has built
        // the initial pose).  Units without a Create just start
        // 'created' so nothing is gated.
        if (cob) cob._lifecycle = (cob.hasScript && cob.hasScript('Create')) ? 'unborn' : 'created'
        refreshCobPanel(cob)
        // The Actions inspector lists every COB entry-point — re-
        // render whenever a new unit loads so the buttons reflect
        // THIS unit's scripts (not whatever was open before).
        renderMvActionsPanel(cob)
        // Ports panel bindings target this unit's cobPorts object;
        // rebuild controls so they write into the right state.
        renderMvPortsPanel(modelViewerInstance)
        // Controls overlay (Move + Aim/Fire).  Spin up a fresh
        // instance per model load and kick off the unit-meta fetch
        // so the action buttons enable/disable correctly.
        if (_mvControls) _mvControls.dispose()
        _mvControls = new MvControls(modelViewerInstance)
        modelViewerInstance._mvControls = _mvControls
        mvFetchUnitMeta(modelViewerInstance)
        // Hook the inspector refresh into the renderer's per-frame
        // callback.  Done here (not at construction) because the
        // renderer is created lazily inside ModelViewer.open(), so
        // it doesn't exist when activateModelTab first runs.  By
        // the time onModelLoaded fires the renderer is live.
        // Idempotent — reassignment is cheap.
        if (modelViewerInstance.renderer) {
          modelViewerInstance.renderer.onAfterFrame = (dtMs) => {
            refreshMvInspectors(dtMs)
            _mvControls?.tick(dtMs)
          }
        }
      },
    })
    // Expose the viewer + its renderer/camera on window so external
    // tooling (the preview eval harness, dev console) can poke camera
    // angles or sky presets without having to chase closures.
    window.__modelViewer = modelViewerInstance
  }
  // Wire the per-frame inspector refresh callback the first time
  // the renderer is alive.  Idempotent — re-assignment is cheap.
  if (modelViewerInstance.renderer && !modelViewerInstance.renderer.onAfterFrame) {
    modelViewerInstance.renderer.onAfterFrame = (dtMs) => {
      refreshMvInspectors(dtMs)
      _mvControls?.tick(dtMs)
    }
  }
  const autoBtn = $('#mv-act-autorotate')
  if (autoBtn) modelViewerInstance.setAutoRotate(autoBtn.dataset.on === '1')
  // open() lazily constructs the renderer the first time, then loads
  // geometry.  Wait for that before applying the ground hint so
  // setGroundMode lands on a live renderer.
  await modelViewerInstance.open(tab.name)
  applyDefaultGroundFor(tab.meta)
  // Apply Unit Editor defaults from the persisted Settings — the user's
  // chosen environment + effect toggles, picked up here once the
  // renderer is live.  Keeps each freshly opened model consistent
  // with what they set in Settings → Unit Editor.
  applyUnitEditorDefaults()
}

// applyUnitEditorDefaults pushes settings.unitDefault* through the
// renderer's setters + ticks the matching menu rows so the Studio
// Options dropdown reflects the actual state.
function applyUnitEditorDefaults() {
  if (!modelViewerInstance?.renderer) return
  const s = state.settings || DEFAULT_SETTINGS
  const r = modelViewerInstance.renderer
  // Environment first because it swaps the sky scheme; the toggles
  // below operate on flags the env doesn't touch.
  r.setEnvironment(s.unitDefaultEnv || 'greenworld')
  const env = s.unitDefaultEnv || 'greenworld'
  const envRow = [...$$('.mv-env-row')].find((row) => row.dataset.mvEnv === env)
  if (envRow) {
    $$('.mv-env-row').forEach((row) => row.classList.toggle('active', row === envRow))
    const envLbl = $('#mv-env-current-lbl')
    const envIco2 = $('#mv-env-current-ico')
    if (envLbl) envLbl.textContent = rowNameText(envRow)
    const rIco = envRow.querySelector('.ico')
    if (envIco2 && rIco) envIco2.textContent = rIco.textContent
  }
  const togglePairs = [
    ['mv-opt-reflections', s.unitDefaultReflections !== false, (v) => r.setReflectionsEnabled(v)],
    ['mv-opt-bob-row', s.unitDefaultBob !== false, (v) => r.setBobEnabled(v)],
    ['mv-opt-water-reflections', s.unitDefaultWaterReflections !== false, (v) => r.setWaterReflectionsEnabled(v)],
    ['mv-opt-specular', s.unitDefaultSpecular !== false, (v) => r.setSpecularEnabled(v)],
    ['mv-opt-godbeams', s.unitDefaultGodBeams !== false, (v) => r.setGodBeamsEnabled(v)],
  ]
  for (const [id, on, apply] of togglePairs) {
    const el = $('#' + id)
    if (el) {
      el.dataset.on = on ? '1' : '0'
      el.classList.toggle('active', on)
    }
    apply(on)
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
    // Re-render the Controls panel so its per-port visibility picks
    // up the freshly-loaded capability flags (canMove, isBuilder,
    // onoffable).  Otherwise the panel renders with empty unitMeta
    // at model-load time and the gated rows never appear once the
    // async FBI fetch resolves.
    renderMvPortsPanel(mv)
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
  const activeRow = [...$$('.mv-ground-row')].find((r) => r.dataset.mvGround === want)
  $$('.mv-ground-row').forEach((r) => r.classList.toggle('active', r === activeRow))
  // Sync the dropdown button face so the closed dropdown shows
  // what's actually applied (ship default sets Sea programmatically;
  // the user never clicked the row so the label wouldn't otherwise
  // update).
  const groundLabel = $('#mv-ground-current-lbl')
  const groundIco = $('#mv-ground-current-ico')
  if (activeRow) {
    const ico = activeRow.querySelector('.ico')
    // rowNameText strips the .ico / .menu-check / .chev-right spans
    // so the button face shows "Terrain" not "🌱 Terrain 🌱 Terrain" -
    // the raw textContent of the row included the icon emoji and we
    // were already painting the icon separately into groundIco.
    if (groundLabel) groundLabel.textContent = rowNameText(activeRow)
    if (groundIco && ico) groundIco.textContent = ico.textContent
  }
}

// refreshPieceTreeEyes resyncs every eye-toggle button in the piece
// tree from its piece's current `visible` flag.  Called after a
// cascading hide/show so all descendant rows reflect the new state
// without rebuilding the entire tree DOM.
function refreshPieceTreeEyes() {
  document.querySelectorAll('#model-viewer-tree .piece-eye').forEach((btn) => {
    const piece = btn._piece
    if (!piece) return
    btn.classList.toggle('off', !piece.visible)
    btn.title = piece.visible ? 'Hide piece (Shift: this piece only)' : 'Show piece (Shift: this piece only)'
    btn.textContent = piece.visible ? '👁' : '⊘'
  })
  refreshPieceTreeStatus()
}

// refreshPieceTreeStatus syncs the per-piece status indicators
// (shade / cache / shadow) from the live COB runtime state.  Each
// icon's `data-flag` says which flag it reflects.  Called on every
// inspector refresh tick so the icons update as scripts call
// shade / dont-shade / cache / dont-cache / dont-shadow.
//
// Glyphs chosen so each flag reads instantly without text:
//   * 💡 lightbulb — shade ON (lit, scene light affects the piece)
//     ; greyed bulb when `dont-shade` flips it
//   * 💾 floppy — cache ON (transform baked / frozen)
//   * 🌗 half-moon — shadow ON (piece is in the lit half, casting
//     a shadow); greyed when `dont-shadow` opts out
function refreshPieceTreeStatus() {
  const cob = modelViewerInstance?.cob
  const pieceMap = cob?._pieceMap
  const unit = cob?.unit
  if (!unit) return
  document.querySelectorAll('#model-viewer-tree .piece-status').forEach((btn) => {
    const piece = btn._piece
    if (!piece || !pieceMap) return
    const idx = pieceMap.get(piece)
    if (typeof idx !== 'number' || idx < 0) return
    const flag = btn.dataset.flag
    let on, label, glyph
    if (flag === 'shade') {
      on = unit.isPieceShade(idx)
      glyph = '💡'
      label = on ? 'Shaded (click to dont-shade — cascades; ⇧ = this piece only)' : 'Unshaded (click to shade — cascades; ⇧ = this piece only)'
    } else if (flag === 'cache') {
      on = unit.isPieceCache(idx)
      glyph = '💾'
      label = on ? 'Cached (click to dont-cache — cascades; ⇧ = this piece only)' : 'Not cached (click to cache — cascades; ⇧ = this piece only)'
    } else if (flag === 'shadow') {
      on = unit.isPieceShadow(idx)
      glyph = '🌗'
      label = on ? 'Casts shadow (click to dont-shadow — cascades; ⇧ = this piece only)' : 'No shadow (click to enable — cascades; ⇧ = this piece only)'
    } else return
    btn.classList.toggle('on', on)
    btn.classList.toggle('off', !on)
    if (btn.textContent !== glyph) btn.textContent = glyph
    btn.title = label
  })
}

// pieceDisplayName humanises piece names that follow TA conventions
// the user won't recognise out of context.  "GP" is the universal
// "Ground Plate" — the flat shadow polygon every TA model carries
// for its projected ground shadow — so we expand it inline.
function pieceDisplayName(piece) {
  const name = piece.name || '<unnamed>'
  if (name === 'GP' || name === 'gp') return 'Ground Plate (GP)'
  return name
}

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

const MV_INSPECTOR_IDS = ['mv-inspector-scripts', 'mv-inspector-actions', 'mv-inspector-ports', 'mv-inspector-staticvars', 'mv-inspector-camera', 'mv-inspector-effects']

function wireMvInspectors() {
  // Wire drag + collapse + close on each panel + the View menu
  // toggle that brings the panel back when it was closed.  Order
  // matters: the drag handler reads from state.mvInspectorPos so
  // we restore positions FIRST, then attach listeners.
  for (const id of MV_INSPECTOR_IDS) wireMvInspector(id)
  for (const btn of document.querySelectorAll('#mv-view-dropdown-popup .toggle-row')) {
    const panelId = btn.dataset.panel
    if (!panelId) continue
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const panel = document.getElementById(panelId)
      if (!panel) return
      const next = panel.classList.contains('hidden')
      setMvInspectorVisible(panelId, next)
    })
  }
  // Threads panel's "Stop All" header button — wired ONCE at boot.
  // stopPropagation so a click inside the draggable header doesn't
  // start a drag gesture or fire the collapse/close buttons.
  const stopAll = document.getElementById('mv-threads-stopall')
  if (stopAll && stopAll.dataset.wired !== '1') {
    stopAll.dataset.wired = '1'
    stopAll.addEventListener('click', (e) => {
      e.stopPropagation()
      modelViewerInstance?.cob?.runtime?.killAllThreads?.()
    })
    stopAll.addEventListener('pointerdown', (e) => e.stopPropagation())
    stopAll.addEventListener('mousedown', (e) => e.stopPropagation())
  }
  // Threads-panel debug controls: Pause/Resume toggle + Step One.
  // Same drag-suppression pattern as Stop All.  Merged from two
  // separate Pause + Resume buttons so the toggle action takes one
  // click and the user (or the Space hotkey) doesn't have to pick
  // the matching button each time.
  const toggleBtn = document.getElementById('mv-threads-toggle')
  if (toggleBtn && toggleBtn.dataset.wired !== '1') {
    toggleBtn.dataset.wired = '1'
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      mvToggleRuntimePaused()
    })
    toggleBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation())
  }
  const stepBtn = document.getElementById('mv-threads-step')
  if (stepBtn && stepBtn.dataset.wired !== '1') {
    stepBtn.dataset.wired = '1'
    stepBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const cob = modelViewerInstance?.cob
      if (!cob) return
      // Force one tick even when paused.  Clear all breakpointHit
      // flags so any BP-stopped thread can take its one step.
      for (const t of cob.unit._threads) if (!t.dead) t.breakpointHit = false
      const wasPaused = cob.runtime.paused
      cob.runtime.paused = false
      cob.tick(25)
      cob.runtime.paused = wasPaused || true  // step always leaves runtime paused
    })
    stepBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
    stepBtn.addEventListener('mousedown', (e) => e.stopPropagation())
  }
  // Actions panel's "Reset State" header button — full COB reset:
  // threads, static vars, animator slots, lifecycle, particles.
  // Same drag-suppression rules as Stop All.
  const actionsReset = document.getElementById('mv-actions-reset')
  if (actionsReset && actionsReset.dataset.wired !== '1') {
    actionsReset.dataset.wired = '1'
    actionsReset.addEventListener('click', (e) => {
      e.stopPropagation()
      modelViewerInstance?.resetState?.()
    })
    actionsReset.addEventListener('pointerdown', (e) => e.stopPropagation())
    actionsReset.addEventListener('mousedown', (e) => e.stopPropagation())
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
      const stage = document.querySelector('.model-viewer-stage')
      if (!stage) return
      const sr = stage.getBoundingClientRect()
      const w = panel.offsetWidth || 220
      const h = panel.offsetHeight || 100
      const left = clamp(e.clientX - dragOff.dx - sr.left, 4, Math.max(4, sr.width - w - 4))
      const top = clamp(e.clientY - dragOff.dy - sr.top, 4, Math.max(4, sr.height - h - 4))
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
}

function setMvInspectorVisible(panelId, visible, opts = {}) {
  const panel = document.getElementById(panelId)
  if (!panel) return
  panel.classList.toggle('hidden', !visible)
  // Mirror the toggle state into the View menu button.
  const btn = document.querySelector(`#mv-view-dropdown-popup [data-panel="${panelId}"]`)
  if (btn) {
    btn.dataset.on = visible ? '1' : '0'
    btn.classList.toggle('active', visible)
  }
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
function refreshMvInspectors(dtMs = 16) {
  _mvInspectorThrottleMs += dtMs
  if (_mvInspectorThrottleMs < 250) return
  _mvInspectorThrottleMs = 0
  const mv = modelViewerInstance
  if (!mv) return
  // COB Scripts panel
  const scriptsPanel = document.getElementById('mv-inspector-scripts')
  if (scriptsPanel && !scriptsPanel.classList.contains('hidden')) {
    const body = document.getElementById('mv-inspector-scripts-body')
    if (body) renderMvScriptsPanel(body, mv.cob)
  }
  // Static Vars panel
  const svPanel = document.getElementById('mv-inspector-staticvars')
  if (svPanel && !svPanel.classList.contains('hidden')) {
    const body = document.getElementById('mv-inspector-staticvars-body')
    if (body) renderMvStaticVarsPanel(body, mv.cob)
  }
  // Camera panel
  const camPanel = document.getElementById('mv-inspector-camera')
  if (camPanel && !camPanel.classList.contains('hidden')) {
    renderMvCameraPanel(mv)
  }
  // Ports panel — only refreshes the LIVE values (read-only chips +
  // slider labels).  The interactive controls keep their own state
  // via wireMvPortsPanel and aren't rebuilt every tick.
  const portsPanel = document.getElementById('mv-inspector-ports')
  if (portsPanel && !portsPanel.classList.contains('hidden')) {
    refreshMvPortsLiveValues(mv)
  }
  // Effects panel — live read-out of the particle pool.  Cheap
  // when no particles are alive (early-out on count = 0).
  const fxPanel = document.getElementById('mv-inspector-effects')
  if (fxPanel && !fxPanel.classList.contains('hidden')) {
    const body = document.getElementById('mv-inspector-effects-body')
    if (body) renderMvEffectsPanel(body, mv)
  }
  // Grey out action / COB-entry buttons whose script has a live
  // thread, so the user can see at a glance what's running and
  // can't double-trigger something that would jerk pieces.
  // Called BEFORE refreshMvControlsGating because syncMvActionsRunning
  // is the function that promotes cob._lifecycle from 'creating' to
  // 'created' once the Create thread dies — running it first lets
  // the gating react on the SAME tick instead of one frame later.
  syncMvActionsRunning(mv.cob)
  syncCobRibbonRunning(mv.cob)
  // Whole-Controls-panel gating — disable EVERY input under the
  // overlay until the unit's Create script has completed.  Mirrors
  // the Actions panel's button gating (real TA blocks all unit
  // commands until Create finishes).  Cheap enough to run every
  // refresh tick — toggles a single class on the panel root.
  refreshMvControlsGating(mv)
  // Runtime stats — tick counter, last-tick ms, units, threads.
  // Pulled straight off the runtime object so the numbers reflect
  // the live state, not whatever snapshot the panel was built with.
  refreshMvRuntimeStats(mv)
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

// _mvCollapsedUnits — module-scoped Set of unit IDs the user has
// collapsed in the Runtime overlay.  Survives the inspector's 4 Hz
// re-render so collapse state persists.  Cleared explicitly when
// the model viewer disposes its runtime (each new tab gets a fresh
// runtime, so the IDs don't collide).
const _mvCollapsedUnits = new Set()

// applyMvUnitCollapseState walks the Runtime overlay's body and
// shows / hides each thread row based on the unit it belongs to.
// Called after every renderMvScriptsPanel + after a chevron click.
// Also updates the chevron glyph on each unit header to reflect
// the current state (+ vs −).
function applyMvUnitCollapseState() {
  const body = document.getElementById('mv-inspector-scripts-body')
  if (!body) return
  for (const row of body.querySelectorAll('.mv-cob-thread-row[data-unit-id]')) {
    const id = parseInt(row.dataset.unitId, 10)
    row.classList.toggle('mv-thread-collapsed', _mvCollapsedUnits.has(id))
  }
  for (const hdr of body.querySelectorAll('.mv-unit-header[data-unit-id]')) {
    const id = parseInt(hdr.dataset.unitId, 10)
    const chev = hdr.querySelector('.mv-unit-header-collapse')
    if (!chev) continue
    const collapsed = _mvCollapsedUnits.has(id)
    chev.textContent = collapsed ? '+' : '−'
    chev.title = collapsed ? `Expand Unit ${id}` : `Collapse Unit ${id}`
  }
}

// renderMvScriptsPanel renders the Runtime overlay — threads grouped
// by the unit they belong to.  In the studio tab one unit is loaded
// at a time so there's exactly one "Unit N" section; the grouping
// matters once the runtime hosts multiple units (game-style sim).
// The function keeps the historical name because every call site
// already references it; the overlay's user-facing label is now
// "Runtime".
function renderMvScriptsPanel(body, cob) {
  body.replaceChildren()
  if (!cob || !cob.unit) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No COB loaded.'
    body.appendChild(empty)
    return
  }
  // Iterate the runtime's units.  Each gets its own section header
  // + thread list + (if any) recently-killed list.  An empty runtime
  // still shows a "no units" message rather than a blank panel so
  // the user knows the overlay is wired correctly.
  const units = [...cob.runtime.units()]
  if (units.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'Runtime has no units loaded.'
    body.appendChild(empty)
    return
  }
  let totalShown = 0
  for (const unit of units) {
    const live = unit._threads
    const killed = unit._recentlyKilled || []
    if (live.length === 0 && killed.length === 0) {
      // Still draw the header so the user sees the unit exists, but
      // dim it.  Helps in multi-unit scenarios to spot "unit X is
      // idle" without it disappearing entirely.
      body.appendChild(buildMvUnitGroupHeader(unit, cob, /*empty*/ true))
      continue
    }
    body.appendChild(buildMvUnitGroupHeader(unit, cob, /*empty*/ false))
    // Render killed threads first so the red-flash animation sits
    // at the top of the group while it plays.  Each row is tagged
    // with the owning unit's id so the collapse handler can hide
    // every row belonging to a single group with one query.
    for (const k of killed) {
      const row = renderMvThreadRow({
        script: k.script,
        pc: k.pc,
        sleepMs: 0,
        waitOn: null,
        signalMask: k.signalMask,
        _killedBy: k.killedBySignal,
      }, true, null)
      row.dataset.unitId = String(unit.id)
      body.appendChild(row)
      totalShown++
    }
    for (const t of live) {
      const row = renderMvThreadRow(t, false, cob)
      row.dataset.unitId = String(unit.id)
      body.appendChild(row)
      totalShown++
    }
  }
  // Re-apply the per-unit collapse state to the newly-rendered rows.
  // The Set survives panel rebuilds (which happen every 250ms via
  // the inspector throttle); without re-applying, an expanded panel
  // would forget which units the user had collapsed.
  applyMvUnitCollapseState()
  if (totalShown === 0) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No active threads on any unit.'
    body.appendChild(empty)
  }
}

// buildMvUnitGroupHeader builds a "Unit N · <scriptOriginName>"
// section divider for the Runtime overlay.  Hosts the per-unit
// mini-actions (currently Stop + Reset) so they live next to the
// unit they target — separate from the runtime-wide controls bar
// at the top of the panel.  When `empty` the header renders muted
// to indicate the unit has no live work.
function buildMvUnitGroupHeader(unit, cob, empty) {
  const hdr = document.createElement('div')
  hdr.className = empty ? 'mv-unit-header mv-unit-header-empty' : 'mv-unit-header'
  hdr.dataset.unitId = String(unit.id)
  // Collapse chevron — first element so it reads as the "twirl
  // arrow" pattern users expect from tree controls.  Persistence
  // lives in the module-scoped _mvCollapsedUnits Set so the state
  // survives panel re-renders (every 4 Hz tick) and tab switches
  // within a runtime.  Clicking flips the state + immediately
  // hides/shows the unit's thread rows below.
  const collapsed = _mvCollapsedUnits.has(unit.id)
  const chev = document.createElement('button')
  chev.className = 'mv-unit-header-collapse'
  chev.textContent = collapsed ? '+' : '−'
  chev.title = collapsed ? `Expand Unit ${unit.id}` : `Collapse Unit ${unit.id}`
  chev.addEventListener('click', (e) => {
    e.stopPropagation()
    if (_mvCollapsedUnits.has(unit.id)) _mvCollapsedUnits.delete(unit.id)
    else _mvCollapsedUnits.add(unit.id)
    applyMvUnitCollapseState()
  })
  hdr.appendChild(chev)
  const name = unit.name || unit.scriptOriginName || ''
  const label = document.createElement('span')
  label.className = 'mv-unit-header-label'
  label.textContent = name ? `Unit ${unit.id} · ${name}` : `Unit ${unit.id}`
  hdr.appendChild(label)
  const count = document.createElement('span')
  count.className = 'mv-unit-header-count'
  const n = unit._threads.length
  count.textContent = n === 0 ? 'idle' : `${n} thread${n === 1 ? '' : 's'}`
  hdr.appendChild(count)
  // Per-unit Reset — kills threads, zeroes static vars, drops
  // animator slots, restores piece visibility, re-engages Create
  // gating.  Currently scoped to the binding's one unit (single-
  // unit studio tab); the modelViewer.resetState() helper is shared
  // with the COB-ribbon Reset button so behaviour stays in sync.
  const resetBtn = document.createElement('button')
  resetBtn.className = 'mv-unit-header-action'
  resetBtn.textContent = '↺'
  resetBtn.title = `Reset Unit ${unit.id} — kill its threads, zero static vars, snap every piece back to its rest pose, and re-engage Create gating.`
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    mvResetUnit(unit, cob)
  })
  hdr.appendChild(resetBtn)
  // Per-unit kill-all — stops every thread on this unit only.
  // Visible even when idle because the user might want to clear
  // stale state.
  const killBtn = document.createElement('button')
  killBtn.className = 'mv-unit-header-action danger'
  killBtn.textContent = '⏹'
  killBtn.title = `Stop every running thread on Unit ${unit.id}.  Animators keep their last pose.`
  killBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    unit.killAllThreads()
  })
  hdr.appendChild(killBtn)
  return hdr
}

// mvResetUnit reverts a single unit to its post-load state.  When
// the unit belongs to the active model viewer's binding the full
// modelViewer.resetState() runs (it also clears particles + flips
// renderer flags); otherwise we fall back to the runtime-side
// reset (threads, vars, animators, visibility) so future
// multi-unit sims still have a working button.
function mvResetUnit(unit, cob) {
  if (cob && modelViewerInstance && modelViewerInstance.cob === cob && cob.unit === unit) {
    modelViewerInstance.resetState()
    return
  }
  unit.killAllThreads()
  unit._threads.length = 0
  unit._recentlyKilled.length = 0
  for (let i = 0; i < unit.staticVars.length; i++) unit.staticVars[i] = 0
  unit._moveAnims.length = 0
  unit._rotAnims.length = 0
  for (let i = 0; i < unit._pieceVisible.length; i++) unit._pieceVisible[i] = true
}

// renderMvThreadRow builds one row for the scripts overlay.
// `killed=true` adds the .killed class which triggers the red
// flash animation.  Signal chips matching the killing mask get
// their own `.killed` class so the user can spot which bit took
// the row down.  Each thread renders THREE lines:
//   1. script name + PC + byte offset
//   2. waiting/sleeping/running status, indented
//   3. signal mask, indented
function renderMvThreadRow(t, killed, cob) {
  const row = document.createElement('div')
  row.className = killed ? 'mv-cob-thread-row killed' : 'mv-cob-thread-row'
  // Clicking anywhere on the row (except the kill button) opens
  // the code-view modal for live execution inspection.  Killed
  // rows skip this since their thread object is a snapshot — no
  // live PC to track.
  if (cob && !killed) {
    row.addEventListener('click', (e) => {
      // Trash icon's stopPropagation handles its own click; defensively
      // skip when the click landed on the kill button anyway.
      if (e.target.closest('.mv-cob-thread-kill')) return
      openMvThreadCodeModal(cob, t)
    })
  }
  const name = document.createElement('div')
  name.className = 'mv-cob-thread-name'
  const left = document.createElement('span')
  left.textContent = t.script.name
  const pc = document.createElement('span')
  pc.className = 'mv-cob-thread-pc'
  const inst = t.script.instructions[t.pc] || t.script.instructions[t.script.instructions.length - 1]
  const off = inst ? `0x${inst.offset.toString(16)}` : '—'
  pc.textContent = `#${t.pc} @ ${off}`
  name.appendChild(left)
  name.appendChild(pc)
  // Per-row trash-can — only on LIVE rows (kill replays already
  // dead).  Click drops just this thread; killed status flashes
  // red briefly via the existing _recentlyKilled buffer on the
  // next render tick.  stopPropagation so clicking inside the
  // (potentially draggable) panel header doesn't start a drag.
  if (cob && !killed) {
    const kill = document.createElement('button')
    kill.className = 'mv-cob-thread-kill'
    kill.title = `Terminate this ${t.script.name} thread`
    kill.textContent = '🗑'
    kill.addEventListener('click', (e) => {
      e.stopPropagation()
      cob.unit.killThreadById(t.id)
    })
    kill.addEventListener('pointerdown', (e) => e.stopPropagation())
    name.appendChild(kill)
  }
  row.appendChild(name)
  // Status line — sleep / wait / running, in a sentence the user
  // can read at a glance.  Indented (CSS padding-left on
  // .mv-cob-thread-detail) so it visually groups under the name.
  const statusDetail = document.createElement('div')
  statusDetail.className = 'mv-cob-thread-detail'
  let statusText
  if (killed) {
    statusText = `killed by signal ${t._killedBy}`
  } else if (t.sleepMs > 0) {
    // Show whole-second precision when long; ms when short.  The
    // user wanted to "see it's waiting" — give a concrete value.
    statusText = t.sleepMs >= 1000
      ? `Sleeping ${(t.sleepMs / 1000).toFixed(1)}s remaining`
      : `Sleeping ${t.sleepMs | 0}ms remaining`
  } else if (t.waitOn) {
    // waitOn.type is 'turn' or 'move'.  We translate to a human
    // sentence; piece + axis would be ideal but the runtime
    // doesn't store them post-wait.  TODO if anyone wants that.
    statusText = t.waitOn.type === 'turn'
      ? 'Waiting for turn to complete'
      : 'Waiting for move to complete'
  } else {
    statusText = 'Running'
  }
  statusDetail.textContent = `status: ${statusText}`
  row.appendChild(statusDetail)
  // Signal mask line (also indented).
  const sigDetail = document.createElement('div')
  sigDetail.className = 'mv-cob-thread-detail'
  if (t.signalMask !== 0) {
    sigDetail.appendChild(document.createTextNode('signals: '))
    for (let b = 0; b < 16; b++) {
      const bit = 1 << b
      if (t.signalMask & bit) {
        const chip = document.createElement('span')
        chip.className = killed && (t._killedBy & bit) ? 'mv-sig-bit killed' : 'mv-sig-bit'
        chip.textContent = String(bit)
        sigDetail.appendChild(chip)
      }
    }
  } else {
    sigDetail.textContent = 'signals: —'
  }
  row.appendChild(sigDetail)
  return row
}

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
      if (!rt) return
      const t = rt._threads.find((x) => x.id === state.threadId && !x.dead)
      if (!t) return
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
function mvSetThreadPc(state, lineEl) {
  const newIdx = parseInt(lineEl.dataset.idx, 10)
  const newScript = lineEl.dataset.script
  if (!Number.isFinite(newIdx) || !newScript) return
  const rt = state.cob?.runtime
  const t = rt?._threads.find((x) => x.id === state.threadId && !x.dead)
  if (!t) return
  if (newScript !== t.script.name.toLowerCase()) {
    const sIdx = rt.scriptNames.findIndex((n) => n && n.toLowerCase() === newScript)
    if (sIdx >= 0 && rt.scripts[sIdx]) t.script = rt.scripts[sIdx]
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

function renderMvStaticVarsPanel(body, cob) {
  body.replaceChildren()
  if (!cob || !cob.unit) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No COB loaded.'
    body.appendChild(empty)
    return
  }
  const vars = cob.unit.staticVars
  if (vars.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No static vars.'
    body.appendChild(empty)
    return
  }
  for (let i = 0; i < vars.length; i++) {
    const row = document.createElement('div')
    row.className = 'mv-staticvar-row'
    const name = document.createElement('span')
    name.className = 'mv-sv-name'
    name.textContent = `global_${i}`
    const val = document.createElement('span')
    val.className = 'mv-sv-value'
    val.textContent = String(vars[i] | 0)
    row.appendChild(name)
    row.appendChild(val)
    body.appendChild(row)
  }
}

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

// _mvFxCollapsed — module-scoped set of section labels that the
// user has collapsed.  Persists across the inspector's 4 Hz refresh
// so toggling doesn't snap back open.  Reset when no panel exists.
const _mvFxCollapsed = new Set()

// renderMvEffectsPanel populates the Effects overlay with a live
// snapshot of the cob particle pool.  Layout:
//   1. Per-kind summary chip strip (LASER ×N, SMOKE_GREY ×M, …),
//      projectile chips highlighted ahead of SFX chips.
//   2. PROJECTILES & BEAMS section — collapsible — bullets / shells
//      / plasma / dgun / laser / missile (kind ≥ 200).
//   3. OTHER EFFECTS section — collapsible — smoke / sparks / fire
//      flash / nano / wake.  Everything else.
// Each particle renders as a card (kind header with colour swatch,
// then a stat grid: position, direction unit-vector, speed, life).
// Section headers act as collapse toggles and remember their state
// across re-renders via _mvFxCollapsed.
function renderMvEffectsPanel(body, mv) {
  if (!mv || !mv.cob || !mv.cob.particles) {
    body.replaceChildren()
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No particle pool.'
    body.appendChild(empty)
    return
  }
  const pool = mv.cob.particles
  // Kind name + classification.  Numeric ids match cob-particles.js
  // exports; kept inline so the panel is self-contained.  Any new
  // kind added in the future falls back to "K{n}" + the EFFECT
  // bucket — the user still sees it, just without the friendly name.
  const KIND_NAMES = {
    1: 'SMOKE_GREY', 2: 'SMOKE_WHITE', 3: 'SPARK', 4: 'FIRE_FLASH',
    16: 'NANO', 257: 'WAKE',
    200: 'BULLET', 201: 'SHELL', 202: 'PLASMA',
    203: 'DGUN', 204: 'LASER', 205: 'MISSILE',
  }
  // PROJECTILE_* kinds start at 200 — easy classifier.
  const isProjectile = (k) => k >= 200 && k <= 299
  body.replaceChildren()
  if (pool.count === 0) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No particles in flight.'
    body.appendChild(empty)
    return
  }
  // Tally per-kind.  Two passes: one to count for the chip strip,
  // one to assign each alive slot to a section while we render.
  const counts = new Map()
  for (let i = 0; i < pool.count; i++) {
    if (!pool.alive[i]) continue
    const k = pool.kind[i] | 0
    counts.set(k, (counts.get(k) || 0) + 1)
  }
  // Chip strip — projectile chips first (highlighted), then SFX.
  const chips = document.createElement('div')
  chips.className = 'mv-fx-chips'
  const sortedKinds = [...counts.entries()].sort((a, b) => {
    const aProj = isProjectile(a[0]) ? 0 : 1
    const bProj = isProjectile(b[0]) ? 0 : 1
    return aProj - bProj || b[1] - a[1]
  })
  for (const [k, n] of sortedKinds) {
    const chip = document.createElement('span')
    chip.className = isProjectile(k) ? 'mv-fx-chip mv-fx-chip-proj' : 'mv-fx-chip'
    chip.textContent = `${KIND_NAMES[k] || ('K' + k)} ×${n}`
    chips.appendChild(chip)
  }
  body.appendChild(chips)
  // Two sections: projectiles + beams (priority), then other SFX.
  // Bucket the alive slots first so each section renders contiguously
  // and the cap can be applied per-section.
  const projSlots = []
  const fxSlots = []
  for (let i = 0; i < pool.count; i++) {
    if (!pool.alive[i]) continue
    if (isProjectile(pool.kind[i] | 0)) projSlots.push(i)
    else fxSlots.push(i)
  }
  const SECTION_CAP = 60
  const renderSection = (label, slots) => {
    if (slots.length === 0) return
    const collapsed = _mvFxCollapsed.has(label)
    // Collapsible header — click toggles.  Chevron indicates state.
    const sh = document.createElement('div')
    sh.className = 'mv-fx-section'
    sh.dataset.fxSection = label
    const chev = document.createElement('span')
    chev.className = 'mv-fx-chev'
    chev.textContent = collapsed ? '▸' : '▾'
    const labelEl = document.createElement('span')
    labelEl.textContent = `${label} (${slots.length})`
    sh.appendChild(chev)
    sh.appendChild(labelEl)
    sh.addEventListener('click', () => {
      if (_mvFxCollapsed.has(label)) _mvFxCollapsed.delete(label)
      else _mvFxCollapsed.add(label)
      // Force an immediate re-render — don't wait for the 4 Hz tick
      // since the user wants instant feedback on the toggle.
      const mv2 = modelViewerInstance
      if (mv2) renderMvEffectsPanel(body, mv2)
    })
    body.appendChild(sh)
    if (collapsed) return
    const grid = document.createElement('div')
    grid.className = 'mv-fx-cards'
    const shown = Math.min(slots.length, SECTION_CAP)
    for (let n = 0; n < shown; n++) {
      const i = slots[n]
      const k = pool.kind[i] | 0
      const card = document.createElement('div')
      card.className = 'mv-fx-card'
      // Card header — colour swatch + kind name.
      const head = document.createElement('div')
      head.className = 'mv-fx-card-head'
      const sw = document.createElement('span')
      sw.className = 'mv-fx-swatch'
      const sr = Math.max(0, Math.min(255, Math.round(pool.r[i] * 127)))
      const sg = Math.max(0, Math.min(255, Math.round(pool.g[i] * 127)))
      const sb = Math.max(0, Math.min(255, Math.round(pool.b[i] * 127)))
      sw.style.background = `rgb(${sr},${sg},${sb})`
      const kindEl = document.createElement('span')
      kindEl.className = 'mv-fx-card-kind'
      kindEl.textContent = KIND_NAMES[k] || ('K' + k)
      head.appendChild(sw)
      head.appendChild(kindEl)
      card.appendChild(head)
      // Two-column stat grid: position, direction, speed, life.
      const stats = document.createElement('div')
      stats.className = 'mv-fx-card-stats'
      const vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i]
      const speed = Math.hypot(vx, vy, vz)
      const dirText = speed > 0.001
        ? `${(vx/speed).toFixed(2)}, ${(vy/speed).toFixed(2)}, ${(vz/speed).toFixed(2)}`
        : '—'
      const lifeFrac = pool.life0[i] > 0 ? (pool.life[i] / pool.life0[i]) : 0
      const addStat = (k, v) => {
        const row = document.createElement('div')
        row.className = 'mv-fx-stat'
        const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k
        const vEl = document.createElement('span'); vEl.className = 'v'; vEl.textContent = v
        row.appendChild(kEl); row.appendChild(vEl)
        stats.appendChild(row)
      }
      addStat('pos',  `${pool.x[i].toFixed(0)}, ${pool.y[i].toFixed(0)}, ${pool.z[i].toFixed(0)}`)
      addStat('dir',  dirText)
      addStat('spd',  `${speed.toFixed(0)} wu/s`)
      addStat('life', `${(pool.life[i] / 1000).toFixed(2)}s / ${(pool.life0[i] / 1000).toFixed(1)}s`)
      card.appendChild(stats)
      // Life bar — visual fraction of remaining life so the user
      // doesn't have to parse "0.18s / 0.22s" in their head.
      const bar = document.createElement('div')
      bar.className = 'mv-fx-life-bar'
      const fill = document.createElement('div')
      fill.className = 'mv-fx-life-fill'
      fill.style.width = `${Math.max(0, Math.min(1, lifeFrac)) * 100}%`
      bar.appendChild(fill)
      card.appendChild(bar)
      grid.appendChild(card)
    }
    body.appendChild(grid)
    if (slots.length > shown) {
      const more = document.createElement('div')
      more.className = 'mv-fx-more'
      more.textContent = `+${slots.length - shown} more…`
      body.appendChild(more)
    }
  }
  renderSection('Projectiles & beams', projSlots)
  renderSection('Other effects',       fxSlots)
}

// renderMvCameraPanel populates the Renderer overlay — historically a
// camera-only read-out, now also displays the GL canvas's smoothed
// FPS so the user can spot rendering hitches.  Function name kept
// because every call site already references it; the panel's
// user-facing label is "Renderer".
function renderMvCameraPanel(mv) {
  wireMvRendererPanel()
  const cam = mv.camera
  if (!cam) return
  const fmt = (a, p = 2) => Array.isArray(a) ? `(${a.map(v => v.toFixed(p)).join(', ')})` : a.toFixed(p)
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text }
  // FPS is computed from the render loop's per-frame timestamps —
  // see model-renderer.js for the rolling-window average that
  // backs `getFPS()`.  Returns 0 when the loop isn't running
  // (paused, no model), so we show "—" in that case.
  const fps = mv.renderer && typeof mv.renderer.getFPS === 'function' ? mv.renderer.getFPS() : 0
  set('mv-ci-fps', fps > 0 ? fps.toFixed(0) + ' fps' : '—')
  set('mv-ci-eye', fmt(cam.eye, 1))
  set('mv-ci-target', fmt(cam.target, 1))
  set('mv-ci-yaw', `${(cam.yaw * 180 / Math.PI).toFixed(1)}°`)
  set('mv-ci-pitch', `${(cam.pitch * 180 / Math.PI).toFixed(1)}°`)
  set('mv-ci-dist', cam.distance.toFixed(1) + ' wu')
  if (cam.fov !== undefined) set('mv-ci-fov', `${(cam.fov * 180 / Math.PI).toFixed(0)}°`)
  else set('mv-ci-fov', '—')
  // Track checkbox — mirror the live state from MvControls each
  // tick.  Without this the checkbox would silently desync when
  // the T key or a shift-pan flipped tracking.
  const trackCb = document.getElementById('mv-ci-track')
  if (trackCb && _mvControls) {
    if (trackCb.checked !== _mvControls.tracking) trackCb.checked = _mvControls.tracking
  }
}

// wireMvRendererPanel attaches the Tracking checkbox change handler
// once on first render of the Renderer panel.  Wired separately
// from the value-only refresh path so we don't re-bind on every
// 4 Hz tick.  Also seeds the checkbox to the live MvControls state
// on first wire so the default-on tracking doesn't render as a
// blank checkbox until the user opens the panel.
function wireMvRendererPanel() {
  const cb = document.getElementById('mv-ci-track')
  if (!cb || cb.dataset.wired === '1') {
    // Already wired — just resync (the panel-open path may run
    // before the Controls overlay has its MvControls).
    if (cb && _mvControls && cb.checked !== _mvControls.tracking) {
      cb.checked = _mvControls.tracking
    }
    return
  }
  cb.dataset.wired = '1'
  if (_mvControls) cb.checked = _mvControls.tracking
  cb.addEventListener('change', () => {
    if (_mvControls) _mvControls.setTracking(cb.checked)
  })
  // Clicking the row label shouldn't bubble into the panel-drag
  // handler — that would start a drag instead of toggling.
  cb.addEventListener('pointerdown', (e) => e.stopPropagation())
  cb.addEventListener('mousedown', (e) => e.stopPropagation())
}

// renderMvPortsPanel builds the Ports overlay body.  Called once on
// a new model load (so the controls bind to the new cobPorts object)
// and on Reset, NOT every refresh tick — the live-only values
// (health %, build %, chips) are patched by refreshMvPortsLiveValues
// without rebuilding the controls.  Editing a control writes back
// into mv.cobPorts (or mv.cobDamage / mv.cobBuildPercent for the
// two values the COB ribbon's Unit Attributes also drives) so the
// scripts pick up the new value on their next `get <port>`.
function renderMvPortsPanel(mv) {
  wireMvPortsPanel()
  const body = document.getElementById('mv-inspector-ports-body')
  if (!body) return
  body.replaceChildren()
  if (!mv || !mv.cob) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No COB loaded.'
    body.appendChild(empty)
    return
  }
  const ports = mv.cobPorts
  // Per-port capability gating.  The TA UnitValue ports are a long
  // list but the studio surfaces only the subset that's meaningful
  // for THIS unit — driven by a mix of FBI hints and COB usage
  // detection.  Rendering the un-applicable rows just clutters the
  // panel + invites the user to flip a value the unit will ignore.
  //
  //   activation        - onoffable=1 in FBI, OR the COB ships an
  //                       Activate/Deactivate script (which gives
  //                       the user something to drive ON/OFF).
  //   moveOrders/fire   - unit can move (CanMove from FBI) OR is a
  //                       factory (Builder=1 — produced units inherit
  //                       the factory's standing orders).
  //   inBuildStance     - Builder=1 (factories + construction units
  //                       flip this while assembling).
  //   health/build%     - always shown.  Every unit has HP + build
  //                       progress in TA.
  //   armoured          - COB references the ARMORED port (port 20)
  //                       via GET/SET — caught by scanning the
  //                       compiled instruction stream.  Solar panels
  //                       are the canonical example.
  const um = mv.unitMeta || {}
  const cob = mv.cob
  // ACTIVATION port is shown ONLY when the FBI explicitly flags the
  // unit as player-toggleable (onoffable=1).  Aircraft like the
  // Hawk ship Activate/Deactivate scripts — but those are engine-
  // driven for the take-off / landing sequence, NOT player commands;
  // in the game UI a Hawk has no on/off button.  Earlier the check
  // also OR'd on Activate-script presence, which mis-classified
  // every aircraft as "toggleable".  onoffable=1 is the canonical
  // signal (Radar, Solar, Adv Fusion etc).
  const showActive = (um.onoffable === true || um.onoffable === 1)
  const showMoveFire = !!(um.canMove || um.isBuilder)
  const showBuildStance = !!um.isBuilder
  const showArmoured = !!(cob.unit && cob.unit.usesUnitValuePort && cob.unit.usesUnitValuePort(20 /* UV_ARMORED */))
  if (showActive) {
    body.appendChild(buildPortToggleRow('Active', 'activation', ports.activation === 1,
      'GET ACTIVATION returns 1 when the unit is "on" (factory producing, radar broadcasting, etc.).',
      (on) => { ports.activation = on ? 1 : 0 }))
  }
  if (showMoveFire) {
    body.appendChild(buildPortChoiceRow('Move orders', 'moveOrders', ports.moveOrders,
      [['Hold', 0, 'Hold Position — never leave the spot'],
       ['Maneuver', 1, 'Maneuver — move only to gain line of sight'],
       ['Roam', 2, 'Roam — chase enemies freely (default)']],
      'GET STANDINGMOVEORDERS — patrol AI scripts read this to decide whether to step toward an enemy.  Factories pass the value to units they produce.',
      (v) => { ports.moveOrders = v }))
    body.appendChild(buildPortChoiceRow('Fire orders', 'fireOrders', ports.fireOrders,
      [['Hold', 0, 'Hold Fire — never engage'],
       ['Return', 1, 'Return Fire — only shoot back when attacked'],
       ['Fire at will', 2, 'Fire at Will — engage anything in range (default)']],
      'GET STANDINGFIREORDERS — weapon scripts read this to gate Fire* threads.  Factories pass the value to units they produce.',
      (v) => { ports.fireOrders = v }))
  }
  body.appendChild(buildPortSliderRow('Health', 'health',
    Math.max(0, 100 - (mv.cobDamage | 0)), 0, 100, '%',
    'GET HEALTH returns this 0–100 value.  Drives SmokeUnit + damage-state scripts.  Synced with the COB ribbon\'s Damage slider.',
    (v) => {
      mv.cobDamage = Math.max(0, Math.min(100, 100 - v))
      mvSyncCobAttrSlidersFromPorts(mv)
    }))
  if (showBuildStance) {
    body.appendChild(buildPortChipRow('In build stance', 'inBuildStance', ports.inBuildStance === 1,
      'GET INBUILDSTANCE — set by factory scripts via SET_VALUE while assembling a unit.  Read-only here; toggled by the running script.'))
  }
  body.appendChild(buildPortSliderRow('Build % left', 'buildPercentLeft',
    Math.max(0, 100 - (mv.cobBuildPercent | 0)), 0, 100, '%',
    'GET BUILD_PERCENT_LEFT — 100 means nothing built yet, 0 means fully built.  Synced with the COB ribbon\'s Build slider.',
    (v) => {
      mv.cobBuildPercent = Math.max(0, Math.min(100, 100 - v))
      mvSyncCobAttrSlidersFromPorts(mv)
    }))
  if (showArmoured) {
    body.appendChild(buildPortChipRow('Armoured', 'armoured', ports.armoured === 1,
      'GET ARMORED returns 1 when the unit\'s armour plating is engaged.  Read-only here; flipped by damage scripts via SET_VALUE.'))
  }
}

// refreshMvPortsLiveValues updates the value-only widgets (read-only
// chips + slider labels) without rebuilding the row controls.  Called
// every inspector tick so scripts that call SET_VALUE (factories
// flipping IN_BUILD_STANCE, for instance) reflect on the panel live.
function refreshMvPortsLiveValues(mv) {
  const body = document.getElementById('mv-inspector-ports-body')
  if (!body || !mv?.cob) return
  const ports = mv.cobPorts
  const setChip = (key, on) => {
    const chip = body.querySelector(`[data-port="${key}"] .mv-port-chip`)
    if (!chip) return
    chip.textContent = on ? 'Yes' : 'No'
    chip.classList.toggle('yes', on)
    chip.classList.toggle('no', !on)
  }
  setChip('inBuildStance', ports.inBuildStance === 1)
  setChip('armoured', ports.armoured === 1)
  // Health + build sliders reflect script-driven changes too (a
  // damage script could SET_VALUE HEALTH).  Skip when the user is
  // mid-drag to avoid yanking the thumb.
  const syncSlider = (key, current) => {
    const row = body.querySelector(`[data-port="${key}"]`)
    if (!row) return
    const input = row.querySelector('input[type=range]')
    const valEl = row.querySelector('.mv-port-slider-val')
    if (input && document.activeElement !== input && parseInt(input.value, 10) !== current) {
      input.value = String(current)
    }
    if (valEl) valEl.textContent = `${current}%`
  }
  syncSlider('health', Math.max(0, 100 - (mv.cobDamage | 0)))
  syncSlider('buildPercentLeft', Math.max(0, 100 - (mv.cobBuildPercent | 0)))
  // Active toggle reflects state changes too.
  const actBtn = body.querySelector('[data-port="activation"] .mv-port-toggle')
  if (actBtn) {
    const on = ports.activation === 1
    actBtn.textContent = on ? 'On' : 'Off'
    actBtn.classList.toggle('on', on)
  }
  // Move/Fire choice rows: highlight the active selection.
  for (const key of ['moveOrders', 'fireOrders']) {
    const cur = ports[key]
    for (const b of body.querySelectorAll(`[data-port="${key}"] .mv-port-choice > button`)) {
      const isActive = parseInt(b.dataset.value, 10) === cur
      b.classList.toggle('active', isActive)
    }
  }
}

// refreshMvControlsGating disables the entire Controls overlay
// (action buttons + every port input) until the unit's Create
// script has finished.  The Actions panel + COB ribbon already
// gate their individual buttons; this mirrors the same rule for
// the Controls panel as a single class on the root so the user
// can see at a glance that nothing in there responds yet.
//
// 'unborn' (Create never started) and 'creating' (Create thread
// is mid-flight) both block input.  Anything else — 'created',
// 'activated', 'deactivated' — lets the user drive.  When there's
// no COB at all the panel stays disabled (no scripts to wire to).
function refreshMvControlsGating(mv) {
  const panel = document.getElementById('mv-inspector-ports')
  if (!panel) return
  const cob = mv?.cob
  const lifecycle = cob?._lifecycle
  const blocked = !cob || lifecycle === 'unborn' || lifecycle === 'creating'
  // .mv-controls-gated drops opacity and disables pointer events on
  // the action-button row + the port-rows body via CSS — the panel
  // header (drag grip + collapse + close) stays interactive so the
  // user can still move/dismiss the overlay while waiting for Create.
  // Per-button capability gating done by _refreshButtons stays
  // untouched: when Create completes, the class drops and each
  // button's own disabled state takes over again.
  panel.classList.toggle('mv-controls-gated', blocked)
  // Tooltip on the action row explains WHY the panel is unresponsive,
  // so the user doesn't think the buttons are broken.
  const actions = panel.querySelector('#mv-controls-actions')
  if (actions) {
    if (blocked) {
      actions.title = 'Run Create first — these controls activate once the unit\'s Create script has finished.'
    } else {
      actions.removeAttribute('title')
    }
  }
}

// refreshMvRuntimeStats updates the four telemetry spans in the
// Runtime overlay header.  Reads directly off the runtime object
// — tickCount + lastTickMs are written by CobRuntime.tick(),
// unitCount() + threadCount() walk the unit map each call (cheap
// at studio scale).  When no runtime exists the spans show 0/—.
function refreshMvRuntimeStats(mv) {
  const panel = document.getElementById('mv-inspector-scripts')
  if (!panel || panel.classList.contains('hidden')) return
  const rt = mv?.cob?.runtime || mv?._runtime
  const tickEl    = document.getElementById('mv-runtime-stat-tick')
  const lastEl    = document.getElementById('mv-runtime-stat-last')
  const unitsEl   = document.getElementById('mv-runtime-stat-units')
  const threadsEl = document.getElementById('mv-runtime-stat-threads')
  const instEl    = document.getElementById('mv-runtime-stat-inst')
  if (!tickEl || !lastEl || !unitsEl || !threadsEl || !instEl) return
  if (!rt) {
    tickEl.textContent = '0'
    lastEl.textContent = '— ms'
    unitsEl.textContent = '0'
    threadsEl.textContent = '0'
    instEl.textContent = '0'
    return
  }
  tickEl.textContent = String(rt.tickCount | 0)
  lastEl.textContent = `${(rt.lastTickMs || 0).toFixed(1)} ms`
  unitsEl.textContent = String(rt.unitCount ? rt.unitCount() : 0)
  threadsEl.textContent = String(rt.threadCount ? rt.threadCount() : 0)
  instEl.textContent = String(rt.lastInstCount | 0)
  // Keep the Pause/Resume toggle label honest — the Step button
  // toggles paused on each press, and a hot-reload may rebuild the
  // panel mid-pause.  Sync every refresh so the caption can never
  // drift from the runtime's actual state.
  mvRefreshRuntimeToggle()
}

// ── Ports panel — row builders ────────────────────────────────────

function buildPortRowShell(label, portKey) {
  const row = document.createElement('div')
  row.className = 'mv-port-row'
  row.dataset.port = portKey
  const lbl = document.createElement('span')
  lbl.className = 'mv-port-label'
  lbl.textContent = label
  row.appendChild(lbl)
  return row
}

function buildPortToggleRow(label, portKey, initialOn, tip, onChange) {
  const row = buildPortRowShell(label, portKey)
  const btn = document.createElement('button')
  btn.className = initialOn ? 'mv-port-toggle on' : 'mv-port-toggle'
  btn.textContent = initialOn ? 'On' : 'Off'
  btn.title = tip
  btn.addEventListener('click', () => {
    const wantOn = !btn.classList.contains('on')
    btn.classList.toggle('on', wantOn)
    btn.textContent = wantOn ? 'On' : 'Off'
    onChange(wantOn)
  })
  row.appendChild(btn)
  return row
}

function buildPortChipRow(label, portKey, isYes, tip) {
  const row = buildPortRowShell(label, portKey)
  const chip = document.createElement('span')
  chip.className = isYes ? 'mv-port-chip yes' : 'mv-port-chip no'
  chip.textContent = isYes ? 'Yes' : 'No'
  if (tip) chip.title = tip
  row.appendChild(chip)
  return row
}

function buildPortChoiceRow(label, portKey, current, options, tip, onChange) {
  const row = buildPortRowShell(label, portKey)
  const wrap = document.createElement('div')
  wrap.className = 'mv-port-choice'
  if (tip) wrap.title = tip
  for (const [name, value, optTip] of options) {
    const btn = document.createElement('button')
    btn.textContent = name
    btn.dataset.value = String(value)
    btn.title = optTip || `Set ${label.toLowerCase()} to ${name}`
    if (value === current) btn.classList.add('active')
    btn.addEventListener('click', () => {
      for (const sib of wrap.children) sib.classList.remove('active')
      btn.classList.add('active')
      onChange(value)
    })
    wrap.appendChild(btn)
  }
  row.appendChild(wrap)
  return row
}

function buildPortSliderRow(label, portKey, current, min, max, unit, tip, onInput) {
  const row = buildPortRowShell(label, portKey)
  const wrap = document.createElement('div')
  wrap.className = 'mv-port-slider'
  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min); input.max = String(max)
  input.value = String(current)
  if (tip) input.title = tip
  const val = document.createElement('span')
  val.className = 'mv-port-slider-val'
  val.textContent = `${current}${unit}`
  input.addEventListener('input', () => {
    const v = parseInt(input.value, 10) | 0
    val.textContent = `${v}${unit}`
    onInput(v)
  })
  wrap.appendChild(input)
  wrap.appendChild(val)
  row.appendChild(wrap)
  return row
}

// mvSyncCobAttrSlidersFromPorts copies cobDamage / cobBuildPercent
// (which the Ports panel edits) back into the COB ribbon's Unit
// Attributes sliders + their value labels.  The reverse direction
// (ribbon slider → ports panel) is handled by refreshMvPortsLiveValues
// which reads the same source-of-truth values.
function mvSyncCobAttrSlidersFromPorts(mv) {
  if (!mv) return
  const dmg = document.getElementById('mv-cob-damage')
  const dmgVal = document.getElementById('mv-cob-damage-val')
  if (dmg) dmg.value = String(mv.cobDamage | 0)
  if (dmgVal) dmgVal.textContent = `${mv.cobDamage | 0}%`
  const build = document.getElementById('mv-cob-build')
  const buildVal = document.getElementById('mv-cob-build-val')
  if (build) build.value = String(mv.cobBuildPercent | 0)
  if (buildVal) buildVal.textContent = `${mv.cobBuildPercent | 0}%`
}

// renderMvActionsPanel rebuilds the Actions inspector's button list
// from the currently-loaded COB.  Re-run when:
//   1) a new model loads (onModelLoaded hook in activateModelTab),
//   2) the Include-Private checkbox toggles (handler set by
//      wireMvActionsPanel below).
// Private filter is name-first-char-isLowercase — TA convention is
// CamelCase for public entry points (Create, Activate, FirePrimary)
// and lowercase for internal helpers (activatescr, deactivatescr,
// initstate).  Re-uses runCobEntry so the action buttons pass the
// same argument-injection logic the ribbon dropdown does — random
// heading/level pitch for Aim*, factory-redirect for Activate, etc.
function renderMvActionsPanel(cob) {
  // Wire the checkbox handler once.  Idempotent guard via dataset
  // flag avoids stacking listeners on each model reload.
  wireMvActionsPanel()
  const list = document.getElementById('mv-actions-list')
  if (!list) return
  list.replaceChildren()
  if (!cob || !cob.unit) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = 'No COB loaded.'
    list.appendChild(empty)
    return
  }
  const includePrivate = !!state.mvActionsIncludePrivate
  const names = cob.listScripts()
  // Alphabetical sort — case-insensitive so the lowercase private
  // helpers (activatescr, deactivatescr) interleave with their
  // CamelCase neighbours instead of clumping together at the end of
  // an ASCII-sorted list (where 'a' > 'Z').
  const visible = names
    .filter((n) => {
      const first = n.charAt(0)
      const isPrivate = first === first.toLowerCase() && first !== first.toUpperCase()
      return includePrivate || !isPrivate
    })
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  if (visible.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mv-inspector-empty'
    empty.textContent = includePrivate ? 'COB has no scripts.' : 'Only private helpers — tick Include Private.'
    list.appendChild(empty)
    return
  }
  for (const name of visible) {
    const first = name.charAt(0)
    const isPrivate = first === first.toLowerCase() && first !== first.toUpperCase()
    const btn = document.createElement('button')
    btn.className = isPrivate ? 'mv-actions-btn private' : 'mv-actions-btn'
    btn.textContent = name
    btn.dataset.script = name
    // Tooltip / disabled state get refreshed every inspector tick
    // by syncMvActionsRunning — what we set here is the initial
    // state at render time.
    const running = isCobScriptRunning(cob, name)
    btn.disabled = running
    btn.title = running
      ? `${name} is already running`
      : (isPrivate ? `Run ${name} (internal helper)` : `Run ${name} (one-shot)`)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      runCobEntry(cob, name)
    })
    list.appendChild(btn)
  }
}

// syncMvActionsRunning + syncCobRibbonRunning toggle the disabled
// attribute on action buttons based on which scripts currently have
// a live thread.  Called from refreshMvInspectors' 4 Hz tick so the
// greyed state tracks the runtime without us rebuilding the whole
// button DOM (which would interfere with the hover state mid-click).
function syncMvActionsRunning(cob) {
  if (!cob) return
  // Promote 'creating' → 'created' once the Create thread has died.
  // Cheap: just check if Create still has a live thread; if not,
  // Create has completed.
  if (cob._lifecycle === 'creating' && !isCobScriptRunning(cob, 'Create')) {
    cob._lifecycle = 'created'
  }
  const gated = cob._lifecycle === 'unborn' || cob._lifecycle === 'creating'
  for (const btn of document.querySelectorAll('#mv-actions-list .mv-actions-btn')) {
    const name = btn.dataset.script
    if (!name) continue
    const running = isCobScriptRunning(cob, name)
    const blockedByCreate = gated && !/^Create$/i.test(name)
    const disabled = running || blockedByCreate
    if (btn.disabled !== disabled) btn.disabled = disabled
    btn.title = running
      ? `${name} is already running`
      : blockedByCreate
        ? `Run Create first — it must finish before other scripts can fire`
        : `Run ${name}`
  }
}
function syncCobRibbonRunning(cob) {
  if (!cob) return
  const gated = cob._lifecycle === 'unborn' || cob._lifecycle === 'creating'
  // Static entry-point buttons in the ribbon (Activate / Deactivate /
  // Fire* etc.) carry data-cob-entry; the dynamic "All scripts" list
  // below uses data-cob-script.  Both render disabled while the
  // matching script has a live thread so the user can't pile on a
  // second invocation of a script that's mid-flight, AND while the
  // unit is still pre-Create so the user only triggers Create first.
  const sel = '.cob-entry, .cob-row[data-cob-script]'
  for (const btn of document.querySelectorAll(sel)) {
    const name = btn.dataset.cobEntry || btn.dataset.cobScript
    if (!name || !cob.hasScript(name)) continue
    const running = isCobScriptRunning(cob, name)
    const blockedByCreate = gated && !/^Create$/i.test(name)
    const disabled = running || blockedByCreate
    if (btn.disabled !== disabled) btn.disabled = disabled
    btn.title = running
      ? `${name} is already running`
      : blockedByCreate
        ? `Run Create first — it must finish before other scripts can fire`
        : `Run ${name}`
  }
}

function wireMvActionsPanel() {
  const cb = document.getElementById('mv-actions-private')
  if (!cb || cb.dataset.wired === '1') return
  cb.dataset.wired = '1'
  cb.checked = !!state.mvActionsIncludePrivate
  cb.addEventListener('change', () => {
    state.mvActionsIncludePrivate = !!cb.checked
    persistPrefs()
    renderMvActionsPanel(modelViewerInstance?.cob)
  })
  // Stop the click from bubbling out — without this, clicking the
  // checkbox inside the panel header bubbles up to the (potential)
  // drag handler or outside-click dismissers and feels jumpy.
  cb.addEventListener('click', (e) => e.stopPropagation())
  cb.addEventListener('pointerdown', (e) => e.stopPropagation())
}

// wireMvPortsPanel attaches the one-shot handlers for the Ports
// overlay's chrome (Reset button).  The per-row controls are wired
// at render time by buildPort*Row.  Idempotent via dataset.wired.
function wireMvPortsPanel() {
  const portsReset = document.getElementById('mv-ports-reset')
  if (!portsReset || portsReset.dataset.wired === '1') return
  portsReset.dataset.wired = '1'
  portsReset.addEventListener('click', (e) => {
    e.stopPropagation()
    const mv = modelViewerInstance
    if (!mv) return
    // Restore defaults — matches the cobPorts initial values from
    // the ModelViewer constructor.
    mv.cobPorts = {
      activation: 1,
      moveOrders: 2,
      fireOrders: 2,
      inBuildStance: 0,
      armoured: 0,
      yardOpen: 0,
      buggerOff: 0,
    }
    mv.cobDamage = 0
    mv.cobBuildPercent = 100
    mvSyncCobAttrSlidersFromPorts(mv)
    renderMvPortsPanel(mv)
  })
}

// wireCobAttributeSliders is idempotent — safe to call on every
// refreshCobPanel without rebinding handlers.  Uses an existence
// guard via a dataset flag so repeated invocations are no-ops.
function wireCobAttributeSliders() {
  const dmg = document.getElementById('mv-cob-damage')
  const dmgVal = document.getElementById('mv-cob-damage-val')
  if (dmg && dmg.dataset.wired !== '1') {
    dmg.addEventListener('input', () => {
      const v = parseInt(dmg.value, 10) | 0
      if (dmgVal) dmgVal.textContent = `${v}%`
      modelViewerInstance?.setDamage(v)
    })
    dmg.addEventListener('click', (e) => e.stopPropagation())
    dmg.addEventListener('pointerdown', (e) => e.stopPropagation())
    dmg.dataset.wired = '1'
  }
  const pb = document.getElementById('mv-cob-playback')
  if (pb && pb.dataset.wired !== '1') {
    pb.addEventListener('input', () => {
      mvSetSimulationSpeed((parseInt(pb.value, 10) | 0) / 100)
    })
    pb.addEventListener('click', (e) => e.stopPropagation())
    pb.addEventListener('pointerdown', (e) => e.stopPropagation())
    pb.dataset.wired = '1'
  }
  // Runtime overlay's Speed slider — same source-of-truth as the COB
  // ribbon's Playback slider above.  Both call mvSetSimulationSpeed,
  // which pushes the new rate to the runtime + updates both label
  // pairs so the two stay in lock-step regardless of which one the
  // user dragged.
  const speed = document.getElementById('mv-runtime-speed')
  if (speed && speed.dataset.wired !== '1') {
    speed.addEventListener('input', () => {
      mvSetSimulationSpeed((parseInt(speed.value, 10) | 0) / 100)
    })
    speed.dataset.wired = '1'
  }
  const build = document.getElementById('mv-cob-build')
  const buildVal = document.getElementById('mv-cob-build-val')
  if (build && build.dataset.wired !== '1') {
    build.addEventListener('input', () => {
      const v = parseInt(build.value, 10) | 0
      if (buildVal) buildVal.textContent = `${v}%`
      modelViewerInstance?.setBuildPercent(v)
    })
    build.addEventListener('click', (e) => e.stopPropagation())
    build.addEventListener('pointerdown', (e) => e.stopPropagation())
    build.dataset.wired = '1'
  }
  const reset = document.getElementById('mv-cob-reset')
  if (reset && reset.dataset.wired !== '1') {
    reset.addEventListener('click', (e) => {
      e.stopPropagation()
      modelViewerInstance?.resetState()
    })
    reset.dataset.wired = '1'
  }
}

// mvToggleRuntimePaused flips the runtime's paused state and
// refreshes the merged Pause/Resume button's label + tooltip so the
// caption always reflects what the NEXT click will do.  When un-
// pausing, also clears every thread's breakpointHit flag so threads
// stopped on a BP advance off the line (was the Resume button's
// behaviour before the merge — preserved here so debugger workflows
// still work).
function mvToggleRuntimePaused() {
  const rt = modelViewerInstance?.cob?.runtime
  if (!rt) return
  const willPause = !rt.paused
  if (!willPause) {
    // Resuming — sweep BPs the same way the old Resume button did.
    for (const u of rt.units()) {
      for (const t of u._threads.values()) if (!t.dead) t.breakpointHit = false
    }
  }
  rt.setPaused(willPause)
  mvRefreshRuntimeToggle()
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
  const v = Math.max(0.01, Math.min(10, +rate || 1))
  const cob = modelViewerInstance?.cob
  if (cob) cob.runtime.setPlaybackRate(v)
  // Slider values are percent units (1-1000 = 0.01× - 10×).  Label
  // uses 2 decimals so 0.05× and 0.25× both read cleanly; high end
  // (10.00×) doesn't lose precision.
  const pb = document.getElementById('mv-cob-playback')
  const pbVal = document.getElementById('mv-cob-playback-val')
  if (pb) pb.value = String(Math.round(v * 100))
  if (pbVal) pbVal.textContent = `${v.toFixed(2)}×`
  // Runtime-overlay slider + label.
  const speed = document.getElementById('mv-runtime-speed')
  const speedVal = document.getElementById('mv-runtime-speed-val')
  if (speed) speed.value = String(Math.round(v * 100))
  if (speedVal) speedVal.textContent = `${v.toFixed(2)}×`
}

// refreshCobPanel wires the Animation→COB dropdown buttons to the
// currently-loaded unit's runtime.  Entry-point buttons grey out
// when the script isn't present.  The "All scripts" list at the
// bottom enumerates every entry point the COB carries — useful
// for AimFromPrimary / QueryPrimary / RestoreAfterDelay and other
// less-common scripts the static button row doesn't enumerate.
function refreshCobPanel(cob) {
  wireCobAttributeSliders()
  // Sync slider displays to the new unit's state.
  const dmg = document.getElementById('mv-cob-damage')
  const dmgVal = document.getElementById('mv-cob-damage-val')
  if (dmg && dmgVal) {
    const v = modelViewerInstance?.cobDamage || 0
    dmg.value = String(v)
    dmgVal.textContent = `${v}%`
  }
  // Push the loaded unit's playback rate through the shared helper
  // so both the COB-menu slider AND the Runtime overlay slider land
  // on the same value.
  mvSetSimulationSpeed(cob ? cob.runtime.playbackRate : 1)
  const build = document.getElementById('mv-cob-build')
  const buildVal = document.getElementById('mv-cob-build-val')
  if (build && buildVal) {
    const v = modelViewerInstance?.cobBuildPercent ?? 100
    build.value = String(v)
    buildVal.textContent = `${v}%`
  }
  for (const btn of $$('.cob-entry')) {
    const name = btn.dataset.cobEntry
    const has = cob && cob.hasScript(name)
    // Hide rows the loaded COB doesn't define instead of greying
    // them out — a row of disabled buttons in the dropdown adds
    // noise without telling the user anything useful.  When no
    // COB is loaded at all, show every row (the global empty
    // state is communicated by the script list below).
    btn.classList.toggle('hidden', !!cob && !has)
    btn.disabled = false
    btn.onclick = has ? (e) => {
      e.stopPropagation()
      runCobEntry(cob, name)
    } : null
  }
  const list = $('#mv-cob-script-list')
  if (!list) return
  list.replaceChildren()
  if (!cob) {
    const empty = document.createElement('div')
    empty.className = 'cob-empty'
    empty.textContent = 'No COB attached.'
    list.appendChild(empty)
    return
  }
  const names = cob.listScripts()
  if (!names.length) {
    const empty = document.createElement('div')
    empty.className = 'cob-empty'
    empty.textContent = 'COB has no scripts.'
    list.appendChild(empty)
    return
  }
  for (const name of names) {
    const row = document.createElement('button')
    row.className = 'cob-row'
    row.textContent = name
    row.title = `Run ${name} (one-shot)`
    // dataset.cobScript lets syncCobRibbonRunning find the script
    // name without scraping textContent (which would include any
    // future decoration we add to the label).
    row.dataset.cobScript = name
    const running = isCobScriptRunning(cob, name)
    row.disabled = running
    if (running) row.title = `${name} is already running`
    row.onclick = (e) => { e.stopPropagation(); runCobEntry(cob, name) }
    list.appendChild(row)
  }
}

// isCobScriptRunning reports whether the named script has at least
// one live thread.  Case-insensitive, matches the runtime's own
// script lookup semantics.  Used by runCobEntry to no-op a click
// on a script that's already executing, and by refreshCobPanel +
// renderMvActionsPanel to grey out the corresponding buttons.
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
  const host = $('#model-viewer-tree')
  if (!host || !model) return
  host.replaceChildren()
  const gl = modelViewerInstance?.renderer?.gl
  const triMode = gl?.TRIANGLES
  const lineMode = gl?.LINES
  const collapsed = new Set()

  // Wire hover-to-highlight on the renderer.  Any row that carries
  // data-piece can light the model's wireframe in red so the user
  // can match abstract names back to geometry.
  const setHover = (name) => {
    if (modelViewerInstance?.renderer) {
      modelViewerInstance.renderer.setHoveredPieceName(name)
    }
  }

  // makeStatusIcon — clickable chip representing one of the
  // COB-driven render flags for a piece (shade / cache / shadow).
  // The icon glyph + .on/.off class are refreshed each inspector
  // tick from the live COB state (refreshPieceTreeStatus).  Click
  // flips that state — cascades through descendants by default,
  // shift-click suppresses the cascade.  Writing through to the
  // CobUnit's flag array means the next render frame + every
  // future runtime query sees the new value, matching how the
  // eye toggle behaves.
  const FLAG_FIELDS = {
    shade:  '_pieceShade',
    cache:  '_pieceCache',
    shadow: '_pieceShadow',
  }
  const makeStatusIcon = (piece, flag, _onTitle, _offTitle) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'piece-status'
    btn.dataset.flag = flag
    btn._piece = piece
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const unit = modelViewerInstance?.cob?.unit
      const pieceMap = modelViewerInstance?.cob?._pieceMap
      const field = FLAG_FIELDS[flag]
      if (!unit || !pieceMap || !field) return
      // Read current state from the unit, then flip + apply with
      // the same cascade rules as the eye toggle: shift-click =
      // this piece only, plain click = this piece + all descendants.
      const myIdx = pieceMap.get(piece)
      if (typeof myIdx !== 'number' || myIdx < 0) return
      // Cache uses default-off, shade + shadow default-on.  Whatever
      // the new target value is, every cascaded piece gets the same.
      const target = !unit[field][myIdx]
      const cascade = !e.shiftKey
      const apply = (p) => {
        const idx = pieceMap.get(p)
        if (typeof idx === 'number' && idx >= 0) unit[field][idx] = target
        if (cascade) for (const c of p.children) apply(c)
      }
      apply(piece)
      refreshPieceTreeStatus()
    })
    return btn
  }
  const makeEyeToggle = (piece) => {
    const eye = document.createElement('button')
    eye.type = 'button'
    eye.className = 'piece-eye' + (piece.visible ? '' : ' off')
    eye.title = piece.visible ? 'Hide piece (Shift: this piece only)' : 'Show piece (Shift: this piece only)'
    eye.textContent = piece.visible ? '👁' : '⊘'
    eye.addEventListener('click', (e) => {
      e.stopPropagation()
      // Default behaviour: toggle this piece AND every descendant so
      // hiding e.g. the torso also hides the gun arms attached to it.
      // Shift-click suppresses the cascade for fine-grained edits.
      const cascade = !e.shiftKey
      const target = !piece.visible
      // Write the user's choice through to the COB unit's per-piece
      // visibility table.  CobBinding._sync re-reads that table every
      // render frame and writes piece.visible = isPieceVisible(idx),
      // so without writing the override here the next sync flips the
      // piece back to "visible" and the user can never escape the
      // hide → re-show toggle (the bug this addresses).
      const unit = modelViewerInstance?.cob?.unit
      const pieceMap = modelViewerInstance?.cob?._pieceMap
      const apply = (p) => {
        p.visible = target
        if (unit && pieceMap) {
          const idx = pieceMap.get(p)
          if (typeof idx === 'number' && idx >= 0) unit._pieceVisible[idx] = target
        }
        if (cascade) for (const c of p.children) apply(c)
      }
      apply(piece)
      // Refresh all eye icons in the tree so cascading hides flip
      // every affected row's glyph in one go.
      refreshPieceTreeEyes()
      if (modelViewerInstance?.renderer) modelViewerInstance.renderer.requestRedraw()
    })
    eye._piece = piece
    return eye
  }

  const build = (piece) => {
    const primCount = piece.drawGroups.reduce((n, g) => {
      if (g.mode === triMode) return n + g.vertexCount / 3
      if (g.mode === lineMode) return n + g.vertexCount / 2
      return n + g.vertexCount
    }, 0)
    const hasKids = piece.children.length > 0
    const displayName = pieceDisplayName(piece)
    if (hasKids) {
      const groupEl = document.createElement('div')
      groupEl.className = 'drawer-group drawer-piece-group'
      groupEl.dataset.piece = piece.name
      const title = document.createElement('div')
      title.className = 'drawer-group-title'
      const chev = document.createElement('span')
      chev.className = 'chev'
      chev.textContent = '▾'
      const name = document.createElement('span')
      name.className = 'piece-name'
      name.textContent = displayName
      const stat = document.createElement('span')
      stat.className = 'drawer-group-count'
      stat.textContent = `${Math.round(primCount)} prim`
      title.appendChild(chev)
      title.appendChild(name)
      if (piece.isEmitterPoint) {
        const ico = document.createElement('span')
        ico.className = 'piece-emitter'
        ico.textContent = '✦'
        ico.title = 'Vertex-only piece (smoke / explosion anchor)'
        title.appendChild(ico)
      }
      title.appendChild(stat)
      title.appendChild(makeEyeToggle(piece))
      title.appendChild(makeStatusIcon(piece, 'shade',  'Shaded',       'Unshaded (dont-shade)'))
      title.appendChild(makeStatusIcon(piece, 'cache',  'Cached',       'Not cached'))
      title.appendChild(makeStatusIcon(piece, 'shadow', 'Casts shadow', 'No shadow (dont-shadow)'))
      // Chevron collapses; everything else jumps the camera.
      chev.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = piece.name
        if (collapsed.has(id)) {
          collapsed.delete(id)
          groupEl.classList.remove('collapsed')
        } else {
          collapsed.add(id)
          groupEl.classList.add('collapsed')
        }
      })
      title.addEventListener('click', () => selectPiece(piece.name))
      title.addEventListener('mouseenter', () => setHover(piece.name))
      title.addEventListener('mouseleave', () => setHover(null))
      groupEl.appendChild(title)
      const body = document.createElement('div')
      body.className = 'drawer-group-body'
      for (const c of piece.children) body.appendChild(build(c))
      groupEl.appendChild(body)
      return groupEl
    }
    const row = document.createElement('div')
    row.className = 'drawer-item-piece'
    row.dataset.piece = piece.name
    const name = document.createElement('span')
    name.className = 'piece-name'
    name.textContent = displayName
    row.appendChild(name)
    if (piece.isEmitterPoint) {
      const ico = document.createElement('span')
      ico.className = 'piece-emitter'
      ico.textContent = '✦'
      ico.title = 'Vertex-only piece (smoke / explosion anchor)'
      row.appendChild(ico)
    }
    const stat = document.createElement('span')
    stat.className = 'piece-stat'
    stat.textContent = `${Math.round(primCount)} prim`
    row.appendChild(stat)
    row.appendChild(makeEyeToggle(piece))
    row.appendChild(makeStatusIcon(piece, 'shade',  'Shaded',       'Unshaded (dont-shade)'))
    row.appendChild(makeStatusIcon(piece, 'cache',  'Cached',       'Not cached'))
    row.appendChild(makeStatusIcon(piece, 'shadow', 'Casts shadow', 'No shadow (dont-shadow)'))
    row.addEventListener('click', () => selectPiece(piece.name))
    row.addEventListener('mouseenter', () => setHover(piece.name))
    row.addEventListener('mouseleave', () => setHover(null))
    return row
  }
  host.appendChild(build(model.root))
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
  const host = document.getElementById('model-viewer-textures')
  if (!host || !model) return
  host.replaceChildren()
  // Count usage per texture by walking every piece's drawGroups —
  // this is the same source-of-truth the renderer uses for the
  // hover-highlight check, so the user's reported count matches
  // what they see flash red.
  const usage = new Map()   // textureLower → count of primitives
  const visit = (p) => {
    if (!p) return
    if (p.drawGroups) {
      for (const g of p.drawGroups) {
        // ModelLoader stores the atlas name as `textureName`; fall
        // back to `texture` so the function survives a future rename
        // in either direction without silent breakage.
        const t = g.textureName || g.texture
        if (!t) continue
        const k = t.toLowerCase()
        usage.set(k, (usage.get(k) || 0) + 1)
      }
    }
    for (const c of p.children || []) visit(c)
  }
  visit(model.root)
  if (usage.size === 0) {
    const empty = document.createElement('div')
    empty.className = 'loading'
    empty.textContent = 'No textures referenced.'
    host.appendChild(empty)
    return
  }
  // Group by source GAF — fall back to "(unknown)" when the
  // server didn't resolve a GAF for the texture (the renderer
  // substitutes a neutral grey fallback in that case).
  const sources = model.textureSources || {}
  const groups = new Map() // gafName → [{ name, count }]
  for (const [name, count] of usage) {
    const gaf = sources[name] || '(unknown)'
    if (!groups.has(gaf)) groups.set(gaf, [])
    groups.get(gaf).push({ name, count })
  }
  // Sort groups by TOTAL usage descending; within each group sort
  // textures by their own count descending, ties broken by name.
  const groupList = [...groups.entries()].map(([gaf, textures]) => {
    const total = textures.reduce((n, t) => n + t.count, 0)
    textures.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { gaf, textures, total }
  }).sort((a, b) => b.total - a.total || a.gaf.localeCompare(b.gaf))
  // Persist collapse state across re-renders of the same model
  // (Set lives on the function — fresh model load resets it via
  // the explicit clear in renderPieceTree's host.replaceChildren
  // path; if cross-tab persistence becomes a need, lift to a
  // module-scoped Set).
  if (!renderTexturesTab._collapsed) renderTexturesTab._collapsed = new Set()
  const collapsed = renderTexturesTab._collapsed
  for (const { gaf, textures, total } of groupList) {
    const groupEl = document.createElement('div')
    groupEl.className = 'mv-texture-group' + (collapsed.has(gaf) ? ' collapsed' : '')
    const hdr = document.createElement('div')
    hdr.className = 'mv-texture-group-header'
    const chev = document.createElement('span')
    chev.className = 'chev'
    chev.textContent = '▾'
    const nameEl = document.createElement('span')
    nameEl.className = 'mv-texture-group-name'
    nameEl.textContent = gaf
    const countEl = document.createElement('span')
    countEl.className = 'mv-texture-group-count'
    countEl.textContent = `${textures.length} tex · ${total}`
    hdr.appendChild(chev)
    hdr.appendChild(nameEl)
    hdr.appendChild(countEl)
    hdr.addEventListener('click', () => {
      if (collapsed.has(gaf)) collapsed.delete(gaf)
      else collapsed.add(gaf)
      groupEl.classList.toggle('collapsed')
    })
    groupEl.appendChild(hdr)
    const body = document.createElement('div')
    body.className = 'mv-texture-group-body'
    for (const { name, count } of textures) {
      const row = document.createElement('div')
      row.className = 'mv-texture-row'
      row.dataset.texture = name
      const img = document.createElement('img')
      img.src = `/api/studio/texture/${encodeURIComponent(name)}.png`
      img.alt = name
      img.loading = 'lazy'
      const lbl = document.createElement('span')
      lbl.className = 'mv-texture-name'
      lbl.textContent = name
      const cnt = document.createElement('span')
      cnt.className = 'mv-texture-count'
      cnt.textContent = `×${count}`
      row.appendChild(img)
      row.appendChild(lbl)
      row.appendChild(cnt)
      row.addEventListener('mouseenter', () => {
        modelViewerInstance?.renderer?.setHoveredTexture?.(name)
      })
      row.addEventListener('mouseleave', () => {
        modelViewerInstance?.renderer?.setHoveredTexture?.(null)
      })
      body.appendChild(row)
    }
    groupEl.appendChild(body)
    host.appendChild(groupEl)
  }
  // Wire the texture-filter input (idempotent — picks up the
  // current value if the user typed something then switched tabs
  // and came back).
  const filter = document.getElementById('mv-texture-filter')
  if (filter && filter.dataset.wired !== '1') {
    filter.dataset.wired = '1'
    filter.addEventListener('input', () => filterTexturesList(filter.value))
  }
  filterTexturesList(filter?.value || '')
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
function renderMvWeaponsTab(mv) {
  const host = document.getElementById('model-viewer-weapons')
  if (!host) return
  host.replaceChildren()
  const meta = mv && mv.unitMeta
  if (!meta || !meta.weapons) {
    const empty = document.createElement('div')
    empty.className = 'loading'
    empty.textContent = 'No weapons declared.'
    host.appendChild(empty)
    return
  }
  // Script names from the COB — a Set for fast membership checks.
  // Empty when the unit has no COB (orphan 3DOs / props).
  const scripts = new Set((mv.cob && mv.cob.unit && mv.cob.unit.scriptNames) || [])
  const slots = ['primary', 'secondary', 'tertiary']
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const w = meta.weapons.find((x) => x.slot === slot) || { slot, name: '', index: i + 1 }
    host.appendChild(buildMvWeaponCard(mv, slot, w, scripts))
  }
}

// buildMvWeaponCard renders ONE slot card.  Split out so the
// post-swap re-render can rebuild just the affected card in place
// (rather than re-rendering the whole panel) — keeps scroll position
// and avoids flicker on the unchanged slots.
function buildMvWeaponCard(mv, slot, w, scripts) {
  const cap = slot[0].toUpperCase() + slot.slice(1)
  const idx = w.index || (slot === 'primary' ? 1 : slot === 'secondary' ? 2 : 3)
  const card = document.createElement('div')
  card.className = 'mv-weapon-card'
  card.dataset.slot = slot
  card.dataset.slotIndex = String(idx)

  // ── Header: slot label + weapon ID + name + colour rectangle ──
  const head = document.createElement('div')
  head.className = 'mv-weapon-head'
  const title = document.createElement('div')
  title.className = 'mv-weapon-title'
  title.textContent = cap
  const idEl = document.createElement('span')
  idEl.className = 'mv-weapon-id'
  idEl.textContent = '#' + idx
  idEl.title = `FBI Weapon${idx} slot`
  title.appendChild(idEl)
  const nameEl = document.createElement('div')
  nameEl.className = 'mv-weapon-name'
  // Colour rectangle next to the weapon name when the weapon ships a
  // TDF `color=` (e.g. ARM laser = palette[232] = bright green).
  // Resolved through the model viewer's TAPalette — what's drawn
  // here is exactly what the beam will paint with.
  if (w.colorIdx > 0 && modelViewerInstance && modelViewerInstance.palette) {
    const c = modelViewerInstance.palette.colorFor(w.colorIdx)
    const rect = document.createElement('span')
    rect.className = 'mv-weapon-color-rect'
    rect.style.background = `rgb(${Math.round(c[0]*255)}, ${Math.round(c[1]*255)}, ${Math.round(c[2]*255)})`
    const hex = [c[0], c[1], c[2]].map(v => Math.round(v*255).toString(16).padStart(2, '0')).join('')
    rect.title = `palette[${w.colorIdx}] = #${hex}`
    nameEl.appendChild(rect)
  }
  const nameTxt = document.createElement('span')
  nameTxt.textContent = w.name || '—'
  nameEl.appendChild(nameTxt)
  head.appendChild(title)
  head.appendChild(nameEl)
  card.appendChild(head)

  // ── Action row: Change Weapon button (always available so users
  //    can populate empty slots too).
  const actions = document.createElement('div')
  actions.className = 'mv-weapon-actions'
  const change = document.createElement('button')
  change.className = 'btn mv-weapon-change'
  change.textContent = w.name ? 'Change Weapon' : 'Assign Weapon'
  change.addEventListener('click', () => openWeaponPicker(mv, idx))
  actions.appendChild(change)
  card.appendChild(actions)

  // ── Script presence indicators (Aim / Query / Fire) ──
  // Always rendered for every slot — even an empty slot benefits
  // from the indicator: if the user picks "Assign Weapon", the
  // chips tell them up front whether the unit's COB actually has
  // the matching firing scripts (because if not, the new weapon
  // won't fire correctly).  Compact ORDER chosen to match TA's
  // canonical aim → query → fire script call sequence so the
  // user reads the chain left-to-right.
  const slotCap = cap
  const required = [
    { name: `Aim${slotCap}`,   short: 'Aim',   key: 'aim'   },
    { name: `Query${slotCap}`, short: 'Query', key: 'query' },
    { name: `Fire${slotCap}`,  short: 'Fire',  key: 'fire'  },
  ]
  const chips = document.createElement('div')
  chips.className = 'mv-weapon-scripts'
  chips.setAttribute('role', 'group')
  chips.setAttribute('aria-label', `Required scripts for ${slot} weapon`)
  let missingQuery = false
  let anyMissing = false
  for (const r of required) {
    const present = scripts.has(r.name)
    if (!present) {
      anyMissing = true
      if (r.key === 'query') missingQuery = true
    }
    const chip = document.createElement('span')
    chip.className = `mv-weapon-script-chip ${present ? 'ok' : 'bad'}`
    chip.title = present
      ? `${r.name} is defined in the unit's COB`
      : `${r.name} is missing from the unit's COB`
    chip.innerHTML = `<span class="mark">${present ? '✓' : '✗'}</span><span class="lbl">${r.short}</span>`
    chips.appendChild(chip)
  }
  card.appendChild(chips)
  // The most actionable missing-script case is Query<X> — without
  // it the runtime can't resolve the muzzle piece and emit-sfx
  // calls fall through to a name-heuristic that frequently picks
  // the wrong piece.  Surface a single line of guidance when the
  // unit can't actually support this weapon — shown for every slot
  // (including empty ones) so the user knows in advance whether
  // assigning a weapon here would actually work.
  if (anyMissing) {
    const warn = document.createElement('div')
    warn.className = 'mv-weapon-warning'
    if (missingQuery) {
      warn.textContent = `⚠ This unit does not have the required functions to support a weapon.  (Missing Query${slotCap}.)`
    } else {
      warn.textContent = `⚠ Some firing scripts are missing — animations may not play correctly.`
    }
    card.appendChild(warn)
  }

  // ── Stats grid (only when a weapon is assigned) ──
  if (w.name) {
    const fmt = (v, unit) => (v == null || v === 0) ? '—' : `${(+v).toFixed(2).replace(/\.?0+$/, '')}${unit ? ' ' + unit : ''}`
    const stats = [
      ['Reload',   fmt(w.reloadSec, 's')],
      ['Range',    fmt(w.rangeWU, 'wu')],
      ['Velocity', fmt(w.velocityWU, 'wu/s')],
      ['Burst',    (w.burst > 1) ? `${w.burst}×${fmt(w.burstRateSec, 's')}` : '1'],
      ['Model',    w.model || '—'],
      ['Color',    w.colorIdx ? String(w.colorIdx) : '—'],
    ]
    const grid = document.createElement('div')
    grid.className = 'mv-weapon-stats'
    for (const [k, v] of stats) {
      const row = document.createElement('div')
      row.className = 'mv-weapon-stat'
      const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k
      const vEl = document.createElement('span'); vEl.className = 'v'; vEl.textContent = v
      // Color row gets an inline swatch matching the header rectangle
      // (same palette lookup) so the "232" number has a visual anchor.
      if (k === 'Color' && w.colorIdx > 0 && modelViewerInstance && modelViewerInstance.palette) {
        const c = modelViewerInstance.palette.colorFor(w.colorIdx)
        const sw = document.createElement('span')
        sw.className = 'mv-weapon-swatch'
        sw.style.background = `rgb(${Math.round(c[0]*255)}, ${Math.round(c[1]*255)}, ${Math.round(c[2]*255)})`
        sw.title = `palette[${w.colorIdx}] = #${[c[0], c[1], c[2]].map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('')}`
        row.appendChild(sw)
      }
      row.appendChild(kEl); row.appendChild(vEl)
      grid.appendChild(row)
    }
    card.appendChild(grid)

    // ── Sound rows with inline play buttons ──
    const sounds = [
      ['Sound', w.soundStart],
      ['Hit',   w.soundHit],
    ]
    for (const [k, snd] of sounds) {
      const row = document.createElement('div')
      row.className = 'mv-weapon-sound'
      const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = k
      const vEl = document.createElement('span'); vEl.className = 'v'; vEl.textContent = snd || '—'
      row.appendChild(kEl); row.appendChild(vEl)
      if (snd) {
        const play = document.createElement('button')
        play.className = 'mv-weapon-sound-play'
        play.title = `Play ${snd}.wav`
        play.setAttribute('aria-label', `Play ${snd}`)
        play.textContent = '▶'
        play.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation()
          playWeaponSound(snd)
        })
        row.appendChild(play)
      }
      card.appendChild(row)
    }

    // ── Classifier flag chips ──
    const flags = []
    if (w.beamWeapon)  flags.push('beam')
    if (w.smokeTrail)  flags.push('smoke trail')
    if (w.selfProp)    flags.push('self-prop')
    if (w.tracks)      flags.push('tracks')
    if (w.ballistic)   flags.push('ballistic')
    if (w.commandFire) flags.push('command-fire')
    if (flags.length) {
      const fchips = document.createElement('div')
      fchips.className = 'mv-weapon-chips'
      for (const f of flags) {
        const chip = document.createElement('span')
        chip.className = 'mv-weapon-chip'
        chip.textContent = f
        fchips.appendChild(chip)
      }
      card.appendChild(fchips)
    }
  }
  return card
}

// playWeaponSound triggers the named .wav via the existing
// /api/studio/sound endpoint.  Volume is matched to the Controls
// overlay's sample player so previews aren't louder than the
// in-session playback.  Errors are swallowed — autoplay rejection
// in some browsers happens on first interaction; the user just
// re-clicks.
function playWeaponSound(stem) {
  if (!stem) return
  try {
    const audio = new Audio(`/api/studio/sound/${encodeURIComponent(stem)}`)
    audio.volume = 0.6
    audio.play().catch(() => {})
  } catch (err) {
    console.warn(`[weapon-sound:${stem}] play failed:`, err)
  }
}

// ── Weapon picker dialog ────────────────────────────────────────
//
// Catalogue cache for the dialog list.  Fetched lazily on first open
// and reused thereafter — the VFS doesn't change after startup so a
// single fetch covers the whole session.
let _weaponCatalogue = null
let _weaponPickerSelected = null
let _weaponPickerWired = false

// openWeaponPicker shows the Change Weapon dialog scoped to one slot
// of one unit.  The slot index + unit name ride on the dialog's
// dataset so Apply can re-call /api/studio/unit/{name} with the
// proper override query param.
function openWeaponPicker(mv, slotIndex) {
  const dlg = document.getElementById('weapon-pick-dialog')
  if (!dlg || !mv) return
  const name = mv.cob && mv.cob.unit && mv.cob.unit.name
  if (!name) return
  dlg.dataset.unit = name
  dlg.dataset.slot = String(slotIndex)
  _weaponPickerSelected = null
  const confirm = document.getElementById('weapon-pick-confirm')
  if (confirm) confirm.disabled = true
  const filter = document.getElementById('weapon-pick-filter')
  if (filter) filter.value = ''
  wireWeaponPickerOnce(mv)
  dlg.classList.remove('hidden')
  loadWeaponCatalogue().then((list) => renderWeaponPickList(list, mv))
  if (filter) filter.focus()
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

function renderWeaponPickList(list, mv) {
  const host = document.getElementById('weapon-pick-list')
  if (!host) return
  host.replaceChildren()
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'loading'
    empty.textContent = 'No weapons found in this VFS.'
    host.appendChild(empty)
    return
  }
  // Filter against the search input — name, model, or sound name.
  const filter = document.getElementById('weapon-pick-filter')
  const q = (filter && filter.value || '').trim().toLowerCase()
  const filtered = q
    ? list.filter((w) => (w.name + ' ' + (w.model || '') + ' ' + (w.soundStart || '')).toLowerCase().includes(q))
    : list
  // Current weapon name for this slot — highlight it as the active
  // selection so the user has visual feedback for what's installed.
  const currentSlot = parseInt(document.getElementById('weapon-pick-dialog').dataset.slot || '0', 10)
  const currentMeta = mv && mv.unitMeta && mv.unitMeta.weapons
  const currentName = currentMeta && currentMeta[currentSlot - 1] ? currentMeta[currentSlot - 1].name : ''
  for (const w of filtered) {
    host.appendChild(buildWeaponPickRow(w, w.name === currentName))
  }
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'loading'
    empty.textContent = 'No weapons match the filter.'
    host.appendChild(empty)
  }
}

// buildWeaponPickRow renders one row in the picker — same .open-list-item
// styling as the Open Unit / Open Map dialogs so chrome stays unified.
function buildWeaponPickRow(w, isCurrent) {
  const btn = document.createElement('button')
  btn.className = 'open-list-item weapon-list-item' + (isCurrent ? ' active' : '')
  btn.dataset.name = w.name
  // Colour swatch on the left where the unit picker has its thumbnail.
  const sw = document.createElement('div')
  sw.className = 'thumb weapon-thumb'
  if (w.colorIdx > 0 && modelViewerInstance && modelViewerInstance.palette) {
    const c = modelViewerInstance.palette.colorFor(w.colorIdx)
    sw.style.background = `rgb(${Math.round(c[0]*255)}, ${Math.round(c[1]*255)}, ${Math.round(c[2]*255)})`
  } else {
    sw.classList.add('weapon-thumb-empty')
  }
  btn.appendChild(sw)
  const title = document.createElement('div')
  title.className = 'title'
  title.textContent = w.name + (isCurrent ? '  (current)' : '')
  btn.appendChild(title)
  const fmt = (v, unit) => (v == null || v === 0) ? '—' : `${(+v).toFixed(2).replace(/\.?0+$/, '')}${unit ? ' ' + unit : ''}`
  const meta1 = document.createElement('div')
  meta1.className = 'meta'
  meta1.textContent = `Reload ${fmt(w.reloadSec, 's')} · Range ${fmt(w.rangeWU, 'wu')} · Velocity ${fmt(w.velocityWU, 'wu/s')}`
  btn.appendChild(meta1)
  const meta2 = document.createElement('div')
  meta2.className = 'meta'
  const burst = (w.burst > 1) ? `Burst ${w.burst}×${fmt(w.burstRateSec, 's')}` : 'Single shot'
  meta2.textContent = `${burst} · Model ${w.model || '—'}`
  btn.appendChild(meta2)
  // Flag chips mirror the active-panel chips — beam/smoke/etc.
  const flags = []
  if (w.beamWeapon)  flags.push('beam')
  if (w.smokeTrail)  flags.push('smoke')
  if (w.selfProp)    flags.push('self-prop')
  if (w.tracks)      flags.push('tracks')
  if (w.ballistic)   flags.push('ballistic')
  if (w.commandFire) flags.push('cmd-fire')
  if (flags.length) {
    const chips = document.createElement('div')
    chips.className = 'model-chips'
    for (const f of flags) {
      const c = document.createElement('span')
      c.className = 'model-chip on'
      c.textContent = f
      chips.appendChild(c)
    }
    btn.appendChild(chips)
  }
  btn.addEventListener('click', () => {
    _weaponPickerSelected = w.name
    const list = document.getElementById('weapon-pick-list')
    if (list) {
      for (const child of list.querySelectorAll('.weapon-list-item')) {
        child.classList.toggle('selected', child === btn)
      }
    }
    const confirm = document.getElementById('weapon-pick-confirm')
    if (confirm) confirm.disabled = false
  })
  btn.addEventListener('dblclick', () => {
    _weaponPickerSelected = w.name
    document.getElementById('weapon-pick-confirm')?.click()
  })
  return btn
}

// wireWeaponPickerOnce attaches Cancel/Apply/filter handlers the
// FIRST time the picker is opened.  Subsequent opens reuse the wired
// handlers — the unit + slot ride on dataset so a single set of
// listeners covers every slot/unit combination.
function wireWeaponPickerOnce(mv) {
  if (_weaponPickerWired) return
  _weaponPickerWired = true
  const dlg = document.getElementById('weapon-pick-dialog')
  const cancel = document.getElementById('weapon-pick-cancel')
  const confirm = document.getElementById('weapon-pick-confirm')
  const filter = document.getElementById('weapon-pick-filter')
  cancel?.addEventListener('click', () => dlg?.classList.add('hidden'))
  // Escape closes the dialog — matches the Open Unit dialog UX.
  dlg?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dlg.classList.add('hidden')
  })
  filter?.addEventListener('input', () => {
    if (_weaponCatalogue) renderWeaponPickList(_weaponCatalogue, mv)
  })
  confirm?.addEventListener('click', async () => {
    if (!_weaponPickerSelected) return
    const dlg2 = document.getElementById('weapon-pick-dialog')
    if (!dlg2) return
    const unitName = dlg2.dataset.unit
    const slotIdx = parseInt(dlg2.dataset.slot || '0', 10)
    if (!unitName || slotIdx < 1 || slotIdx > 3) return
    // Build the override URL.  Keep existing slots untouched —
    // the server preserves any slot without an override.
    const params = new URLSearchParams()
    params.set(`weapon${slotIdx}`, _weaponPickerSelected)
    // Persist any prior swaps on the other slots so re-fetching
    // doesn't lose them.  Stored on the viewer for the session.
    const mv2 = modelViewerInstance
    mv2._weaponOverrides = mv2._weaponOverrides || {}
    mv2._weaponOverrides[slotIdx] = _weaponPickerSelected
    for (const [k, v] of Object.entries(mv2._weaponOverrides)) {
      if (parseInt(k, 10) !== slotIdx) params.set(`weapon${k}`, v)
    }
    try {
      const resp = await fetch(`/api/studio/unit/${encodeURIComponent(unitName)}?${params.toString()}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      mv2.unitMeta = await resp.json()
      renderMvWeaponsTab(mv2)
      if (_mvControls) _mvControls.onMetaLoaded()
    } catch (err) {
      console.warn('[weapon-swap] failed:', err)
    }
    dlg2.classList.add('hidden')
  })
}

// filterTexturesList hides rows whose texture name doesn't include
// the query (case-insensitive); groups stay visible whenever any
// descendant matches, mirroring the piece-tree filter behaviour.
function filterTexturesList(q) {
  q = (q || '').trim().toLowerCase()
  const host = document.getElementById('model-viewer-textures')
  if (!host) return
  for (const group of host.querySelectorAll('.mv-texture-group')) {
    let any = false
    for (const row of group.querySelectorAll('.mv-texture-row')) {
      const match = !q || row.dataset.texture.includes(q)
      row.style.display = match ? '' : 'none'
      if (match) any = true
    }
    group.style.display = any ? '' : 'none'
  }
}

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
  // Hide whichever surface was on top — the picker is its own
  // dialog and the user shouldn't see a half-z-fight between the
  // viewer + picker stacks while it's up.
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog').classList.add('hidden')
  $('#model-open-dialog').classList.remove('hidden')
  $('#model-open-confirm').disabled = true
  selectedModelName = null
  const filter = $('#model-filter')
  if (filter) filter.value = ''
  if (!modelsLoaded) {
    await fetchModels()
  }
  renderModelList()
  requestAnimationFrame(() => $('#model-filter')?.focus())
}

function closeModelPicker() {
  $('#model-open-dialog').classList.add('hidden')
  // Return to whichever surface the user came from: an active model
  // tab restores the viewer, an active map tab restores the editor,
  // otherwise the welcome dialog reappears.
  const activeTab = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
  if (activeTab?.type === 'model') {
    $('#model-viewer-dialog').classList.remove('hidden')
  } else if (activeTab?.type === 'map') {
    $('#app')?.classList.remove('hidden')
  } else {
    $('#welcome-dialog').classList.remove('hidden')
  }
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

function renderModelList() {
  const list = $('#model-list')
  if (!list) return
  const q = ($('#model-filter')?.value || '').trim().toLowerCase()
  const filtered = availableModels.filter((m) => {
    if (!q) return true
    const hay = `${m.name} ${m.unitName || ''} ${m.unitTitle || ''} ${m.side || ''} ${m.category || ''} ${m.description || ''}`.toLowerCase()
    return hay.includes(q)
  })
  if (filtered.length === 0) {
    list.innerHTML = modelsLoaded
      ? '<div class="loading">No models match.</div>'
      : '<div class="loading">Loading models…</div>'
    return
  }
  const frag = document.createDocumentFragment()
  for (const m of filtered) {
    const card = document.createElement('button')
    card.className = 'open-list-item model-list-item'
    card.dataset.name = m.name
    // Units missing the 3DO can't be viewed in 3D — gate selection
    // visually and via the confirm button.
    if (!m.has3DO) card.classList.add('disabled-entry')
    if (m.name === selectedModelName) card.classList.add('selected')
    const title = m.unitTitle || m.unitName || m.name
    const meta = [
      m.unitName ? m.unitName.toUpperCase() : m.name.toUpperCase(),
      m.side || null,
      m.category || null,
    ].filter(Boolean).join(' · ')
    const sub = m.description || ''
    // Build-picture thumbnail: only request when the index says one
    // exists (avoids a wave of 404s from <img> elements pointing at
    // missing pics).  Fallback is a muted blank tile.
    const thumb = m.hasBuildPic
      ? `<div class="thumb model-thumb"><img loading="lazy" alt="" src="/api/studio/buildpic/${encodeURIComponent(m.name)}"></div>`
      : '<div class="thumb model-thumb model-thumb-empty" title="No build picture in this VFS"></div>'
    // Presence chips — three small dots per row.  Each is colour-coded
    // and titled so a hover tells the user exactly what's missing.
    const chip = (on, label, longTitle) =>
      `<span class="model-chip ${on ? 'on' : 'off'}" title="${escapeHTML(longTitle)}">${escapeHTML(label)}</span>`
    const chips =
      chip(m.hasFBI, 'FBI', m.hasFBI ? 'unit definition (FBI) found in the VFS' : 'no FBI — this is an orphan 3DO (prop / feature / debug geometry)') +
      chip(m.has3DO, '3DO', m.has3DO ? 'unit geometry (3DO) found' : 'no 3DO — this unit cannot be opened in the 3D viewer') +
      chip(m.hasCOB, 'COB', m.hasCOB ? 'animation script (COB) found' : 'no COB — the unit will display statically with no animator')
    card.innerHTML = thumb +
      `<div class="title">${escapeHTML(title)}</div>` +
      `<div class="meta">${escapeHTML(meta)}</div>` +
      (sub ? `<div class="meta">${escapeHTML(sub)}</div>` : '') +
      `<div class="model-chips">${chips}</div>`
    card.addEventListener('click', () => {
      if (!m.has3DO) return  // can't open without geometry
      selectedModelName = m.name
      $$('.model-list-item').forEach((el) => el.classList.toggle('selected', el.dataset.name === m.name))
      $('#model-open-confirm').disabled = false
    })
    card.addEventListener('dblclick', () => { if (m.has3DO) openModelViewer(m.name) })
    frag.appendChild(card)
  }
  list.replaceChildren(frag)
}

async function openModelViewer(name) {
  $('#model-open-dialog').classList.add('hidden')
  // Push a new model tab into the unified tab array so the map
  // editor's tab bar (and the viewer's mirrored tab bar) both show
  // the new entry.  switchToTab routes by type so the dialog mounts
  // automatically.
  const meta = availableModels.find((m) => m.name === name)
  const activeTab = activeTabIndex >= 0 ? tabs[activeTabIndex] : null
  if (modelOpenIntent === 'replace' && activeTab?.type === 'model') {
    activeTab.name = name
    activeTab.meta = meta
  } else {
    tabs.push({ type: 'model', name, meta })
    activeTabIndex = tabs.length - 1
  }
  modelOpenIntent = 'add'
  // Force-switch so the dialog re-opens, the topbar/footer refresh,
  // and the viewer loads the new model even when the tab index
  // stayed put.
  switchToTab(activeTabIndex, { fresh: false, force: true })
}

function closeModelViewer() {
  // The viewer's "Close" button drops the currently-active model
  // tab — same gesture as the × on the tab itself.  If the user
  // had a map open too, switchToTab returns them to it; otherwise
  // the welcome dialog shows.
  if (activeTabIndex >= 0 && tabs[activeTabIndex]?.type === 'model') {
    closeTab(activeTabIndex)
  } else {
    $('#model-viewer-dialog').classList.add('hidden')
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function setStatus(msg) { $('#status').textContent = msg }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}
function sanitiseFilename(s) {
  return s.replace(/[^a-zA-Z0-9_ -]+/g, '').trim() || 'newmap'
}
