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
function activeMap() { return activeTabIndex >= 0 ? tabs[activeTabIndex]?.map : null }

// Session-level state lives here.  These fields are shared across all
// tabs: drawer filters, view-menu toggles, panel layout, the section /
// feature catalogs and their image caches, and the user prefs the
// PrefsStore persists.  PER_MAP_FIELDS are NOT on this object — the
// Proxy below forwards them to activeMap().
const sessionState = {
  drawer: 'sections',
  drawerFilters: { sections: '', features: '' },
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
    $('#size-dialog').classList.remove('hidden')
  })
  $('#welcome-open').addEventListener('click', () => openMapDialog('welcome'))
  wireWelcomeDropZone()
  // Multi-tab management — the tab bar + "+" popout above the toolbar.
  wireMapTabBar()
  $('#size-cancel').addEventListener('click', closeSizeDialog)
  // Open-map dialog.
  $('#open-back').addEventListener('click', closeOpenDialog)
  $('#open-filter').addEventListener('input', () => renderOpenList())
  $('#open-confirm').addEventListener('click', confirmOpenMap)
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
  // Hydrate persisted UI prefs (drawer filters, toggle flags, view
  // mode, panel visibility) before any panel reads from state.
  loadPersistedPrefs()
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
  'showGridlines', 'showMinimap', 'showCameraInfo', 'showFeatures', 'showVoids', 'showContours', 'showStartPositions',
  'viewMode', 'drawerFilters', 'panelLayout']

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
    if (k === 'drawerFilters' && parsed[k] && typeof parsed[k] === 'object') {
      state.drawerFilters = { ...state.drawerFilters, ...parsed[k] }
    } else {
      state[k] = parsed[k]
    }
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
  if (!tab) return
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
  if (!tab) return
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

function closeTab(idx) {
  if (idx < 0 || idx >= tabs.length) return
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
  // Snapshot the outgoing tab.  Skip on fresh activation (the new
  // tab's MapDoc is the source of truth — we don't want to splat
  // module-let leftovers from the previously-active tab onto it).
  if (!fresh && activeTabIndex >= 0) snapshotActiveTabModuleLets()
  abortTransientGestureState()
  activeTabIndex = nextIdx
  restoreActiveTabModuleLets()
  renderMapTabs()
  // recreateEditorView() needs an active app surface to mount into.
  $('#app')?.classList.remove('hidden')
  recreateEditorView()
  // Sync drawer / view / mode UI to the new tab's state.
  if (typeof updateUndoButtons === 'function') updateUndoButtons()
  if (typeof bumpContentVersion === 'function') bumpContentVersion()
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

function renderMapTabs() {
  const list = document.querySelector('#map-tabs-list')
  if (!list) return
  list.replaceChildren()
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]
    const m = tab.map
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'map-tab' + (i === activeTabIndex ? ' active' : '')
    el.dataset.tabIndex = String(i)
    el.setAttribute('role', 'tab')
    el.title = `${m.name} (${m.tileW}×${m.tileH})`
    const lbl = document.createElement('span')
    lbl.className = 'map-tab-label'
    lbl.textContent = m.name || '(untitled)'
    el.appendChild(lbl)
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'map-tab-close'
    close.textContent = '×'
    close.title = 'Close this map'
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(i) })
    el.appendChild(close)
    el.addEventListener('click', () => switchToTab(i))
    list.appendChild(el)
  }
}

function wireMapTabBar() {
  const addBtn = document.querySelector('#map-tab-add')
  const popup = document.querySelector('#map-tab-add-popup')
  if (!addBtn || !popup) return
  // Position the popup just below the "+" button each time it opens.
  // Using position:fixed sidesteps the #map-tabs overflow-x clip that
  // was previously hiding the popup.
  const positionPopup = () => {
    const r = addBtn.getBoundingClientRect()
    popup.style.top = `${Math.round(r.bottom + 2)}px`
    popup.style.left = `${Math.round(r.left)}px`
  }
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const willShow = popup.classList.contains('hidden')
    if (willShow) positionPopup()
    popup.classList.toggle('hidden')
  })
  document.querySelector('#map-tab-add-new')?.addEventListener('click', () => {
    popup.classList.add('hidden')
    // Open the size dialog in "append a tab" mode.  When the user
    // confirms, startEditor() pushes a brand-new tab.
    sizeDialogSource = 'tabbar'
    document.querySelector('#size-dialog')?.classList.remove('hidden')
  })
  document.querySelector('#map-tab-add-open')?.addEventListener('click', () => {
    popup.classList.add('hidden')
    openMapDialog('tabbar')
  })
  document.addEventListener('click', (e) => {
    if (popup.classList.contains('hidden')) return
    if (e.target === addBtn || addBtn.contains(e.target)) return
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

const HEARTBEAT_INTERVAL_MS = 5000
const HEARTBEAT_TIMEOUT_MS = 4000
const DISCONNECT_THRESHOLD = 2 // consecutive failures before showing "disconnected"

let heartbeatState = 'connecting' // 'connecting' | 'connected' | 'disconnected'
let heartbeatFailures = 0
let heartbeatTimer = null

function startServerHeartbeat() {
  // The first ping fires immediately so we know about a dead server
  // before the user takes any action.
  pingHeartbeat()
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(pingHeartbeat, HEARTBEAT_INTERVAL_MS)
}

async function pingHeartbeat() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HEARTBEAT_TIMEOUT_MS)
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
      applyConnectionUI()
    }
  } else {
    heartbeatFailures++
    if (heartbeatFailures >= DISCONNECT_THRESHOLD && heartbeatState !== 'disconnected') {
      heartbeatState = 'disconnected'
      applyConnectionUI()
    }
  }
}

function applyConnectionUI() {
  const card = $('#connection-card')
  const overlay = $('#disconnect-overlay')
  if (!card || !overlay) return
  const offline = heartbeatState === 'disconnected'
  card.classList.toggle('hidden', !offline)
  overlay.classList.toggle('hidden', !offline)
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
  $('#welcome-dialog').classList.add('hidden')
  $('#open-dialog').classList.remove('hidden')
  $('#open-confirm').disabled = true
  selectedMapPath = null
  if (mapsPollTimer) { clearTimeout(mapsPollTimer); mapsPollTimer = null }
  // Show skeleton immediately so the dialog never appears empty, then
  // start fetching.  fetchMaps polls until the server marks the catalog
  // as fully loaded.
  if (availableMaps.length === 0) mapsLoading = true
  renderOpenList()
  fetchMaps()
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
// the Welcome modal on first boot, or back to the editor canvas when
// they hit File → Open mid-session.
function closeOpenDialog() {
  $('#open-dialog').classList.add('hidden')
  if (mapsPollTimer) { clearTimeout(mapsPollTimer); mapsPollTimer = null }
  if (openMapSource === 'welcome') {
    $('#welcome-dialog').classList.remove('hidden')
  } else {
    // 'editor' / 'tabbar' — the editor is already mounted; just dismiss
    // the picker without disturbing the active tab.
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

// openLoadedMap hydrates editor state from a /api/studio/load response
// and jumps straight into the editor (skipping the New-map size
// dialog).  The TNT's tile pool is fetched as a synthetic "section"
// keyed `tnt:<path>` — the rest of the render/save path treats it like
// any other section thanks to the `tnt:` prefix branch in builder.go.
// wireWelcomeDropZone binds dragover/drop on the welcome modal so the
// user can drop a .tnt (+ optional .ota sibling) from their desktop
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
  // Push a brand-new MapDoc as the active tab.  Subsequent state.X
  // writes land in this MapDoc — the previously-active tab keeps its
  // own state intact in tabs[], reachable by clicking back.
  tabs.push({ map: new MapDoc() })
  activeTabIndex = tabs.length - 1
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
  $('#app').classList.remove('hidden')
  renderMapTabs()

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
  // tabs[] and can be reached by clicking them.
  tabs.push({ map: new MapDoc() })
  activeTabIndex = tabs.length - 1
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
  $('#app').classList.remove('hidden')
  renderMapTabs()

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
    wireDeveloperDialog()
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
    // Don't intercept while the user is typing into a text input — but
    // checkbox / radio / file <input>s and <select> dropdowns shouldn't
    // swallow our shortcuts (the schema-select used to steal focus and
    // block Q/E rotation).
    const t = e.target
    if (t instanceof HTMLTextAreaElement) return
    if (t instanceof HTMLInputElement) {
      const typ = (t.type || '').toLowerCase()
      if (typ === '' || /^(text|search|number|password|email|url|tel)$/.test(typ)) return
    }
    // Escape closes any open Map-section dialog before falling through
    // to the Escape-clears-selection path below, so the user can dismiss
    // Properties / Resize / Developer with a single keystroke.
    if (e.key === 'Escape') {
      const ota = $('#ota-dialog')
      if (ota && !ota.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeOTADialog(); return }
      const resize = $('#resize-dialog')
      if (resize && !resize.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeResizeDialog(); return }
      const dev = $('#developer-dialog')
      if (dev && !dev.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeDeveloperDialog(); return }
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
    else if (e.key === 'q' || e.key === 'Q') rotateActive(-1)
    else if (e.key === 'e' || e.key === 'E') rotateActive(1)
    else if (e.key === 'ArrowLeft' && pageSectionSibling(-1)) { e.preventDefault() }
    else if (e.key === 'ArrowRight' && pageSectionSibling(1)) { e.preventDefault() }
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
  })
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
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.25))
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.25))
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
  }
}

function onCanvasMouseMove(e) {
  if (panState) { updatePan(e); return }
  updateHoverLabel(e)
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
  $('#btn-import-heightmap')?.addEventListener('click', () => $('#import-heightmap-file').click())
  $('#import-heightmap-file')?.addEventListener('change', onImportHeightmapFile)
  $('#btn-undo').addEventListener('click', undo)
  $('#btn-redo').addEventListener('click', redo)
  wireHistoryFlyout($('#btn-undo'), $('#undo-history-popup'))
  wireHistoryFlyout($('#btn-redo'), $('#redo-history-popup'))
  $('#btn-new').addEventListener('click', startNewMapFromEditor)
  $('#btn-open').addEventListener('click', openExistingMapFromEditor)
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
  // own tab.
  sizeDialogSource = 'tabbar'
  const wIn = $('#size-w'); if (wIn) wIn.value = String(state.tileW || 128)
  const hIn = $('#size-h'); if (hIn) hIn.value = String(state.tileH || 128)
  const nIn = $('#size-name'); if (nIn) nIn.value = state.name || 'newmap'
  $('#size-dialog').classList.remove('hidden')
}

// closeSizeDialog returns the user to the surface they came from when
// they cancel the size picker.  Resetting transient state is deferred
// to the actual swap inside startEditor (or openLoadedMap) so a
// cancelled New leaves the existing editor untouched.
function closeSizeDialog() {
  $('#size-dialog').classList.add('hidden')
  if (sizeDialogSource === 'welcome') {
    $('#welcome-dialog').classList.remove('hidden')
  }
  // 'editor' / 'tabbar' — editor stays visible behind the dismissed dialog.
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

async function saveLoose() {
  setStatus('Building TNT + OTA…')
  if (state.terrainClipboard) dropTerrainClipboard()
  cancelPlacement()
  const payload = {
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
  }
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
      return
    }
  }
  setStatus('Saved loose .tnt + .ota.')
}

async function save() {
  setStatus('Building HPI archive…')
  // Drop in-flight selections so they don't leak into the saved map.
  if (state.terrainClipboard) dropTerrainClipboard()
  cancelPlacement()
  const payload = {
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
  }
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
  } catch (err) {
    setStatus(`Save failed: ${err.message}`)
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
