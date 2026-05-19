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

const state = {
  tileW: 128,
  tileH: 128,
  name: 'newmap',
  planet: 'Green',
  tiles: [],     // length tileW*tileH; each entry null | { sectionPath, sx, sy, rotation }
  heights: [],   // length (tileW*2)*(tileH*2); per attribute cell (0..255)
  features: [],
  zoom: 1,
  drawer: 'sections',
  drawerFilters: { sections: '', features: '' },
  selected: null, // { type: 'section', path, tileW, tileH, image } | { type: 'feature', name }
  sectionsList: [],
  featuresList: [],
  sectionImages: new Map(),         // path → HTMLImageElement (raw, rotation=0)
  sectionImagesRotated: new Map(),  // `${path}|${rot}` → HTMLCanvasElement
  sectionHeights: new Map(),        // path → { w, h, heights[(w*2)*(h*2)] }
  featureImages: new Map(),         // lowercased name → HTMLImageElement (animated)
  dragging: null,
  dropPreview: null,
  collapsedGroups: new Set(),
  usedOnly: false,                // features tab: hide unused features when true
  includeWreckage: false,         // features tab: include corpses/wreckage when true
  highlightFeatureName: null,     // lowercased name; placements outlined in red while hovered

  // ── new ───────────────────────────────────────────────────────────────
  mode: 'select-terrain',        // 'paint' | 'select-terrain' | 'select-features' | 'view' | 'picker' | 'start-points' | 'erase'
  viewMode: 'map',               // 'map' | 'heightmap' | 'tiles'
  showGridlines: true,
  animateFeatures: true,
  showFeatures: true,
  placement: null,               // { sectionPath, tileW, tileH, rotation, tx, ty } while a section follows the cursor
  rectSelection: null,           // { x, y, w, h } during a Select-Terrain rectangle drag
  terrainClipboard: null,        // captured rectangle being moved/rotated; see captureTerrain()
  selectedFeature: -1,           // index into state.features when Select-Features picks one
  selectedFeatures: new Set(),   // multi-select indices (Picker mode)
  pickerRect: null,              // { x, y, w, h } during a Picker drag-select
  selectedStartPos: -1,          // index into active schema's startPositions
  ota: null,                     // see defaultOTAState
  activeSchema: 0,               // index into state.ota.schemas
  showMinimap: true,             // minimap panel visibility (toggleable from View)
  minimapPos: null,              // { top, left } in canvas-wrap coords once user drags
  eraseSize: 1,                  // erase brush size (N×N tiles)
  eraseScope: 'all',             // 'all' | 'terrain' | 'features'
  eraseCursor: null,             // last hovered tile while in Erase mode, for the brush outline
  hoveredFeatureName: null,      // drawer feature being hovered (forces animate)
}

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

// activeWorldFor maps a planet/tileset slug to the list of section worlds
// that should be considered "matching".  Plant-named worlds (greenworld,
// archipelago, etc.) are also matched by their planet aliases.
function activeWorldsFor(planet) {
  const p = (planet || '').toLowerCase()
  if (p === 'greenworld' || p === 'green') return ['greenworld']
  if (p === 'metal') return ['metal']
  if (p === 'mars' || p === 'desert') return ['mars']
  if (p === 'moon' || p === 'lunar') return ['moon']
  if (p === 'archipelago' || p === 'water') return ['archipelago']
  if (p === 'lava') return ['lava']
  return p ? [p] : []
}

// featureWorldMatches returns true when a feature's world string should
// count as part of the active tileset.  Feature TDFs use slightly different
// world names (e.g. "Green World", "All Worlds") than the section folder
// layout, so we normalise both sides before comparing.
function featureWorldMatches(featureWorld, activeWorlds) {
  if (!activeWorlds.length) return true
  const w = (featureWorld || '').toLowerCase().replace(/[\s_-]+/g, '')
  if (w.includes('allworlds')) return true
  for (const a of activeWorlds) {
    const norm = a.toLowerCase().replace(/[\s_-]+/g, '')
    if (w.includes(norm)) return true
    // "Green World" → "greenworld"; "mars" → "mars"
    if (norm === 'mars' && w.includes('desert')) return true
    if (norm === 'moon' && (w.includes('moon') || w.includes('lunar'))) return true
    if (norm === 'archipelago' && (w.includes('archipelago') || w.includes('water'))) return true
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
  // Start the server heartbeat as soon as the page is wired — works
  // even on the Welcome screen so the user finds out the server died
  // before they pick a map.
  startServerHeartbeat()
})

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
let selectedMapPath = null
let openMapSource = 'welcome' // 'welcome' or 'editor' — controls where Back returns to
let sizeDialogSource = 'welcome' // same idea for the New-map size dialog

async function openMapDialog(source = 'welcome') {
  openMapSource = source
  $('#welcome-dialog').classList.add('hidden')
  $('#open-dialog').classList.remove('hidden')
  $('#open-list').innerHTML = '<div class="loading">Loading maps…</div>'
  $('#open-confirm').disabled = true
  selectedMapPath = null
  try {
    const resp = await fetch('/api/studio/maps')
    const data = await resp.json()
    availableMaps = data.maps || []
  } catch (err) {
    availableMaps = []
    $('#open-list').innerHTML = `<div class="loading">Failed to load maps: ${escapeHTML(String(err))}</div>`
    return
  }
  renderOpenList()
}

// closeOpenDialog returns the user to whichever surface they came from —
// the Welcome modal on first boot, or back to the editor canvas when
// they hit File → Open mid-session.
function closeOpenDialog() {
  $('#open-dialog').classList.add('hidden')
  if (openMapSource === 'editor') {
    $('#app').classList.remove('hidden')
  } else {
    $('#welcome-dialog').classList.remove('hidden')
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
async function openLoadedMap(data, card) {
  // Clear in-flight selections / clipboards / undo history so the new
  // map starts cleanly — keeps the cached section/feature images
  // around since those are reusable.
  resetTransientEditorState()
  const w = data.tileW || 128
  const h = data.tileH || 128
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
  $('#info-name').textContent = state.name
  $('#info-size').textContent = `${w} × ${h}`

  // Wire up the canvas + drawer just like startEditor would have done
  // for a fresh map.
  await finishEditorBoot()
  setStatus(`Opened ${state.name} (${w}×${h}).`)
}

function confirmOnEnter(e) {
  if (e.key === 'Enter') startEditor()
}

async function startEditor() {
  // Mid-session New: wipe transient state so the new map doesn't
  // inherit the old undo history, placement preview, or selections.
  // First-boot call is a no-op (everything is already empty).
  resetTransientEditorState()
  const w = clamp(parseInt($('#size-w').value, 10) || 128, 16, 256)
  const h = clamp(parseInt($('#size-h').value, 10) || 128, 16, 256)
  const name = ($('#size-name').value || 'newmap').trim() || 'newmap'
  const planet = $('#size-planet').value
  // Pull the multi-selected player counts off the dice picker.  Falls
  // back to a single 4-player schema if the user somehow deselected
  // everything (the picker's clamp prevents this from the UI side).
  const counts = pickedPlayerCounts()
  state.tileW = w
  state.tileH = h
  state.name = name
  state.planet = planet
  state.tiles = new Array(w * h).fill(null)
  state.heights = new Array(w * 2 * h * 2).fill(80)
  state.features = []
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
  $('#app').classList.remove('hidden')
  $('#info-name').textContent = name
  $('#info-size').textContent = `${w} × ${h}`

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

// buildDicePips returns a domino-style pip layout for any count 1..10.
// Classic d6 faces (1..6) keep the canonical placements; 7..10 extend
// the pattern by adding pips along the centre row and edges.  Pips are
// laid out on a 4×4 grid: enough resolution to depict up to ten dots
// without crowding while still reading as a die face.
function buildDicePips(n) {
  const wrap = document.createElement('div')
  wrap.className = 'dice-pips'
  // 4x4 grid positions encoded as 16-bit bitmaps so the layout table
  // stays compact + the JS can iterate it linearly.  "1" places a pip.
  //  row 0: 0  1  2  3
  //  row 1: 4  5  6  7
  //  row 2: 8  9 10 11
  //  row 3:12 13 14 15
  const layouts = {
    1:  [0,0,0,0, 0,1,1,0, 0,1,1,0, 0,0,0,0],
    2:  [1,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1],
    3:  [1,0,0,0, 0,1,1,0, 0,1,1,0, 0,0,0,1],
    4:  [1,0,0,1, 0,0,0,0, 0,0,0,0, 1,0,0,1],
    5:  [1,0,0,1, 0,1,1,0, 0,1,1,0, 1,0,0,1],
    6:  [1,0,0,1, 1,0,0,1, 1,0,0,1, 0,0,0,0],
    7:  [1,0,0,1, 1,0,0,1, 1,0,0,1, 0,1,1,0],
    8:  [1,0,0,1, 1,0,0,1, 1,0,0,1, 1,0,0,1],
    9:  [1,0,0,1, 1,0,0,1, 1,1,1,1, 1,0,0,1],
    10: [1,1,1,1, 1,0,0,1, 1,0,0,1, 1,1,1,1],
  }
  const grid = layouts[n] || layouts[1]
  for (let i = 0; i < 16; i++) {
    const cell = document.createElement('span')
    if (!grid[i]) cell.style.visibility = 'hidden'
    wrap.appendChild(cell)
  }
  return wrap
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
    wireCanvas()
    wireTabs()
    wireMinimap()
    wireDeveloperPanel()
    wireDeveloperDialog()
    wireModeToolbar()
    wireViewMenu()
    wireKeyboard()
    editorWired = true
  } else {
    const cnv = $('#canvas')
    if (cnv) {
      cnv.width = state.tileW * TILE_PX
      cnv.height = state.tileH * TILE_PX
    }
  }

  await Promise.all([loadSections(), loadFeatures()])
  renderCanvas()
}

// resetTransientEditorState clears in-flight edits (placement,
// clipboards, selections, undo history) before swapping in a new map.
// State that survives a swap (sectionImages, sectionHeights,
// featureImages) is left alone — those are read-only caches.
function resetTransientEditorState() {
  state.placement = null
  state.terrainClipboard = null
  state.dragging = null
  state.dropPreview = null
  state.selected = null
  state.selectedFeature = -1
  state.selectedFeatures = new Set()
  state.selectedStartPos = -1
  state.rectSelection = null
  state.pickerRect = null
  state.eraseCursor = null
  state.undoStack = []
  state.redoStack = []
  state.collapsedGroups = new Set()
  hidePlacementHint()
  hideRotationBadge()
  updateUndoButtons?.()
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
  })
  $('#filter-used').addEventListener('change', (e) => {
    state.usedOnly = e.target.checked
    renderDrawer()
  })
  $('#filter-wreckage').addEventListener('change', (e) => {
    state.includeWreckage = e.target.checked
    renderDrawer()
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
    case 'picker': return 'Picker — click features to select, drag a rectangle for multi-select, Shift+click to toggle, Delete to remove.'
    case 'erase': return 'Erase — click or drag to remove tiles and features.  Switch to another mode when done.'
    case 'start-points': return 'Start Points — click empty space to drop the next available start position; click an existing one to drag/delete.'
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
  })
  animBtn.addEventListener('click', () => {
    state.animateFeatures = !state.animateFeatures
    animBtn.dataset.on = state.animateFeatures ? '1' : '0'
    renderDrawer()
    renderCanvas()
  })
  const miniBtn = $('#opt-minimap')
  if (miniBtn) {
    miniBtn.addEventListener('click', () => {
      setMinimapVisible(!state.showMinimap)
    })
  }
  $$('#display-mode-group .menu-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.viewMode = row.dataset.display
      $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r === row))
      const lbl = $('#view-current-lbl')
      if (lbl) lbl.textContent = row.querySelector('span:not(.ico)').textContent
      renderCanvas()
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
    else if (e.key === 'v' || e.key === 'V') setMode('view')
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
    else if (e.key === 'q' || e.key === 'Q') rotateActive(-1)
    else if (e.key === 'e' || e.key === 'E') rotateActive(1)
    else if (e.key === 'Escape') {
      // Clear whatever transient state is active first, then drop the
      // user back into Select mode — that's the "neutral" mode that
      // lets them re-orient before picking a new tool.
      if (state.placement) cancelPlacement()
      if (state.terrainClipboard) cancelTerrainClipboard()
      if (state.selectedFeatures.size > 0) state.selectedFeatures.clear()
      if (state.selectedFeature >= 0) state.selectedFeature = -1
      if (state.selected?.type === 'feature') clearStampSelection()
      if (state.mode !== 'select-terrain') setMode('select-terrain')
      else renderCanvas()
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
  // GAF hotspot offsets are loaded on a separate endpoint so the
  // (cheap) features list isn't blocked by parsing every GAF on the
  // server.  Fire-and-forget; drawing falls back to bottom-centred
  // anchoring until the origins arrive.
  fetchFeatureOrigins()
}

async function fetchFeatureOrigins() {
  try {
    const resp = await fetch('/api/studio/feature-origins')
    if (!resp.ok) return
    const data = await resp.json()
    const map = new Map()
    for (const o of (data.origins || [])) map.set((o.name || '').toLowerCase(), o)
    // Patch the existing entries in place so any drawer items already
    // rendered pick up the right anchor on the next redraw.
    for (const f of state.featuresList) {
      const o = map.get((f.name || '').toLowerCase())
      if (o) { f.originX = o.originX; f.originY = o.originY }
    }
    // Same patch on placed features so the canvas re-anchors them.
    for (const f of state.features || []) {
      const o = map.get((f.name || '').toLowerCase())
      if (o) { f.originX = o.originX; f.originY = o.originY }
    }
    renderCanvas()
  } catch { /* ignore — drawing falls back to bottom-centre */ }
}

function renderDrawer() {
  const drawer = $('#drawer')
  const q = (state.drawerFilters[state.drawer] || '').trim().toLowerCase()
  if (state.drawer === 'sections') renderSectionsDrawer(drawer, q)
  else renderFeaturesDrawer(drawer, q)
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
  title.innerHTML = `<span class="chev">▾</span><span>${escapeHTML(worldName)}</span><span class="drawer-group-count">${totalItems}</span>`
  title.addEventListener('click', () => toggleGroup(key, defaultCollapsed))
  groupEl.appendChild(title)
  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  groupEl.appendChild(body)
  return groupEl
}

// renderSectionGroup builds the DOM for one collapsible group of sections.
// `key` is the persistent identifier used for the collapse-state set;
// `defaultCollapsed` is the starting state when the key is unknown.
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

  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  for (const s of items) {
    const item = document.createElement('div')
    item.className = 'drawer-item'
    item.draggable = true
    item.dataset.path = s.path
    if (state.selected?.type === 'section' && state.selected.path === s.path) {
      item.classList.add('selected')
    }
    item.innerHTML = `
      <img class="drawer-thumb" src="/api/studio/section-preview/${encodeURI(s.path)}" alt="" draggable="false" />
      <div class="drawer-meta">
        <div class="drawer-name">${escapeHTML(s.name)}</div>
        <div class="drawer-sub">${s.tileW || '?'}×${s.tileH || '?'} tiles · ${escapeHTML(s.group || '')}</div>
      </div>
    `
    item.addEventListener('click', () => selectSection(s))
    item.addEventListener('dragstart', (e) => beginSectionDrag(e, s))
    body.appendChild(item)
  }
  groupEl.appendChild(body)
  return groupEl
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

  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  for (const f of items) {
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
    // Hover-to-animate and hover-highlight: while the cursor is over this
    // row, force the thumb to animate (even with global animation off)
    // and outline every placement of that feature in red on the canvas.
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
    body.appendChild(item)
  }
  groupEl.appendChild(body)
  return groupEl
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
  const placement = { sectionPath: s.path, origW: s.tileW, origH: s.tileH, rotation: 0, tx: 0, ty: 0, anchored: false, userRotated: false }
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
  const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / state.zoom
  const cy = (wrap.scrollTop + wrap.clientHeight / 2) / state.zoom
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
  state.features = snap.features.map((f) => ({ ...f }))
  if (snap.tileW !== state.tileW || snap.tileH !== state.tileH) {
    state.tileW = snap.tileW
    state.tileH = snap.tileH
    const lbl = $('#info-size')
    if (lbl) lbl.textContent = `${state.tileW} × ${state.tileH}`
    const cnv = $('#canvas')
    if (cnv) {
      cnv.width = state.tileW * TILE_PX
      cnv.height = state.tileH * TILE_PX
    }
  }
  if (snap.ota) {
    state.ota = cloneOTA(snap.ota)
    state.activeSchema = clamp(snap.activeSchema || 0, 0, state.ota.schemas.length - 1)
    refreshSchemaSelector()
  }
  if (typeof snap.name === 'string') {
    state.name = snap.name
    const nm = $('#info-name')
    if (nm) nm.textContent = snap.name
  }
  if (typeof snap.planet === 'string') state.planet = snap.planet
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
}

function wireCanvas() {
  const canvas = $('#canvas')
  canvas.width = state.tileW * TILE_PX
  canvas.height = state.tileH * TILE_PX
  canvas.style.width = canvas.width * state.zoom + 'px'
  canvas.style.height = canvas.height * state.zoom + 'px'

  canvas.addEventListener('mousedown', (e) => onCanvasMouseDown(e))
  window.addEventListener('mouseup', (e) => onCanvasMouseUp(e))
  canvas.addEventListener('mousemove', (e) => onCanvasMouseMove(e))
  canvas.addEventListener('mouseleave', () => {
    $('#hover-cell').textContent = '—'
    if (state.eraseCursor) { state.eraseCursor = null; renderCanvas() }
  })

  // Wheel/trackpad routing:
  //   - Ctrl/Cmd + wheel → zoom (covers Mac pinch — Safari sends pinch
  //     as wheel-with-ctrlKey).
  //   - Any horizontal delta (deltaX) → pan horizontally.
  //   - Shift + wheel → pan vertically.
  //   - Otherwise → zoom anchored to the cursor.
  const wrap = $('#canvas-scroll')
  wrap.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      zoomAtPointer(e.clientX, e.clientY, e.deltaY)
      return
    }
    if (e.deltaX !== 0) {
      e.preventDefault()
      wrap.scrollLeft += e.deltaX
      if (e.deltaY !== 0) wrap.scrollTop += e.deltaY
      return
    }
    if (e.shiftKey) {
      e.preventDefault()
      wrap.scrollTop += e.deltaY
      return
    }
    e.preventDefault()
    zoomAtPointer(e.clientX, e.clientY, e.deltaY)
  }, { passive: false })

  // Drag-and-drop from the sidebar drawer.  `dragover` only updates the
  // hover highlight; the actual stamp is committed once on `drop`.  This
  // avoids smearing the drag path across every cell the cursor passed.
  canvas.addEventListener('dragenter', (e) => { e.preventDefault() })
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
  })
  canvas.addEventListener('dragleave', () => {
    state.dropPreview = null
    renderCanvas()
  })
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
      const { tx, ty } = pickCell(e)
      if (tx >= 0 && tx < state.tileW && ty >= 0 && ty < state.tileH) {
        beginTransaction()
        placeFeature(tx, ty)
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
  })

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

function updateHoverLabel(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) {
    $('#hover-cell').textContent = '—'
    setCanvasHoverFeature(null)
    return
  }
  $('#hover-cell').textContent = `(${tx}, ${ty})`
  // Highlight the feature under the cursor (if any) so the minimap can
  // narrow its dot view to that type — see renderMinimap.
  const hit = findFeatureAt(tx, ty)
  const name = hit >= 0 ? (state.features[hit]?.name || '').toLowerCase() : null
  setCanvasHoverFeature(name)
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
  // win ties (overlapping click).
  const schema = activeSchema()
  if (schema && state.mode !== 'start-points') {
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
  // the tile they sit on.
  if (state.mode !== 'select-features') {
    const { tx, ty } = pickCell(e)
    if (tx >= 0 && tx < state.tileW && ty >= 0 && ty < state.tileH) {
      const fhit = findFeatureAt(tx, ty)
      if (fhit >= 0) {
        setMode('select-features')
        state.selectedFeature = fhit
        featureDragging = true
        beginTransaction()
        const f = state.features[fhit]
        featureDragOffset = { ax: f.ax - tx * 2, ay: f.ay - ty * 2 }
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
    const { tx, ty } = pickCell(e)
    if (findFeatureAt(tx, ty) < 0 && state.selected?.type !== 'feature') return true
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
  if (moved) {
    state.placement.tx = tx
    state.placement.ty = ty
  }
  // Auto-fit rotation while the cursor is dragging the preview around:
  // a new position can change which orientation is the only seam-clean
  // option.  Once Q/E sets userRotated, this becomes a no-op.
  if (moved) tryAutoRotatePlacement(state.placement)
  if (moved) renderCanvas()
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

      if (sec) copyTileHeights(sec, src.sx, src.sy, mx, my, rotation, origW, origH, flipH, flipV)
    }
  }
  paintedDuringStroke = true
  invalidateMinimapBase()
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
  const { tx, ty } = pickCell(e)
  // Hit-test by attribute cell: a feature occupies (ax/2, ay/2) on the tile grid.
  const hit = findFeatureAt(tx, ty)
  if (hit >= 0) {
    state.selectedFeature = hit
    featureDragging = true
    beginTransaction()
    const f = state.features[hit]
    featureDragOffset = { ax: f.ax - tx * 2, ay: f.ay - ty * 2 }
    renderCanvas()
    return
  }
  // Empty space + a feature in the drawer → drop a copy here.  This is
  // how the user places multiple features without leaving the mode.
  if (state.selected?.type === 'feature') {
    beginTransaction()
    placeFeature(tx, ty)
    commitTransaction('Place feature')
    return
  }
  // Empty space + nothing armed → deselect any prior pick.
  state.selectedFeature = -1
  renderCanvas()
}

function onFeatureMouseMove(e) {
  if (!featureDragging || state.selectedFeature < 0) return
  const { tx, ty } = pickCell(e)
  const f = state.features[state.selectedFeature]
  f.ax = clamp(tx * 2 + (featureDragOffset?.ax || 1), 0, state.tileW * 2 - 1)
  f.ay = clamp(ty * 2 + (featureDragOffset?.ay || 1), 0, state.tileH * 2 - 1)
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
function findFeatureAt(tx, ty) {
  const cpx = tx * TILE_PX + TILE_PX / 2
  const cpy = ty * TILE_PX + TILE_PX / 2
  for (let i = state.features.length - 1; i >= 0; i--) {
    const f = state.features[i]
    const px = (f.ax / 2) * TILE_PX
    const py = (f.ay / 2) * TILE_PX
    const r = featureRenderRect(f, px, py)
    if (cpx >= r.x && cpx <= r.x + r.w && cpy >= r.y && cpy <= r.y + r.h) return i
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
    state.selectedStartPos = hit
    const sp = schema.startPositions[hit]
    const { px, py } = gameToCanvas(sp.x, sp.z)
    startPosDragOffset = { dx: px - cx, dy: py - cy }
    startPosDragging = true
    beginTransaction()
    renderCanvas()
    return
  }
  // Empty space — place the next available start position.  The cap
  // comes from the schema's player count (Network N), not a fixed 10,
  // so a 4-player schema only allows StartPos1..4.  Gap-fill: if
  // {1, 3} are already placed, the next click drops a StartPos2
  // before adding any higher number.
  const cap = Math.max(1, Math.min(10, schemaPlayerCount(schema) || 10))
  const used = new Set(schema.startPositions.map((sp) => sp.number))
  let nextNum = 1
  while (used.has(nextNum) && nextNum <= cap) nextNum++
  if (nextNum > cap) {
    setStatus(`This schema is full — all ${cap} start position${cap === 1 ? '' : 's'} are placed.  Drag a marker or Delete one to free a slot.`)
    return
  }
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

function drawStartPositions(ctx) {
  if (!state.ota) return
  const fontFamily = getComputedStyle(document.body).fontFamily

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
        ctx.arc(px, py, 8, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  const schema = activeSchema()
  if (!schema) return
  ctx.save()
  ctx.font = `18px ${fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < schema.startPositions.length; i++) {
    const sp = schema.startPositions[i]
    const { px, py } = gameToCanvas(sp.x, sp.z)
    // Outer ring — accent when selected, gold otherwise.
    const selected = state.mode === 'start-points' && state.selectedStartPos === i
    ctx.fillStyle = selected ? 'rgba(139, 92, 246, 0.92)' : 'rgba(255, 200, 0, 0.92)'
    ctx.strokeStyle = selected ? '#fff' : 'rgba(0, 0, 0, 0.6)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(px, py, 16, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    // Robot glyph.
    ctx.fillStyle = '#000'
    ctx.font = `18px ${fontFamily}`
    ctx.fillText('🤖', px, py + 1)
    // Number badge — small pill below/right of the marker.
    const label = String(sp.number)
    ctx.font = `bold 11px ${fontFamily}`
    const w = ctx.measureText(label).width + 8
    const bx = px + 12
    const by = py + 6
    ctx.fillStyle = 'rgba(20, 24, 32, 0.95)'
    ctx.strokeStyle = selected ? '#fff' : 'rgba(139, 92, 246, 0.9)'
    ctx.lineWidth = 1.5
    roundRect(ctx, bx, by, w, 15, 4)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.fillText(label, bx + w / 2, by + 7)
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
  const hit = findFeatureAt(tx, ty)
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
    placeFeature(tx, ty)
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
        if (state.tiles[i]) { state.tiles[i] = null; dirty = true }
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
    if (state.features.length !== before) dirty = true
  }
  if (dirty) {
    invalidateMinimapBase()
    renderCanvas()
  }
}

function stampSection(tx, ty) {
  const sel = state.selected
  const rotation = sel.rotation || 0
  stampSectionWithRotation(tx, ty, sel.path, sel.tileW, sel.tileH, rotation, !!sel.flipH, !!sel.flipV)
}

function placeFeature(tx, ty) {
  const sel = state.selected
  // Features sit on the 16px attribute grid — anchor to the centre of the
  // clicked tile so they snap cleanly.
  const ax = tx * 2 + 1
  const ay = ty * 2 + 1
  // Replace any existing feature in this attr cell.
  state.features = state.features.filter((f) => !(f.ax === ax && f.ay === ay))
  state.features.push({
    name: sel.name,
    ax,
    ay,
    footprintX: sel.footprintX || 1,
    footprintZ: sel.footprintZ || 1,
    previewUrl: sel.previewUrl || null,
    originX: sel.originX || 0,
    originY: sel.originY || 0,
  })
  renderCanvas()
}

function renderCanvas() {
  const canvas = $('#canvas')
  canvas.width = state.tileW * TILE_PX
  canvas.height = state.tileH * TILE_PX
  canvas.style.width = canvas.width * state.zoom + 'px'
  canvas.style.height = canvas.height * state.zoom + 'px'
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false

  // Background fill.
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  if (state.viewMode === 'heightmap') {
    drawHeightmap(ctx)
  } else {
    drawTiles(ctx)
    if (state.viewMode === 'blended') drawHeightmapOverlay(ctx)
  }

  // Grid overlay (every 8 tiles) — only when the option is enabled.
  if (state.showGridlines) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let x = 0; x <= state.tileW; x += 8) {
      ctx.beginPath()
      ctx.moveTo(x * TILE_PX + 0.5, 0)
      ctx.lineTo(x * TILE_PX + 0.5, canvas.height)
      ctx.stroke()
    }
    for (let y = 0; y <= state.tileH; y += 8) {
      ctx.beginPath()
      ctx.moveTo(0, y * TILE_PX + 0.5)
      ctx.lineTo(canvas.width, y * TILE_PX + 0.5)
      ctx.stroke()
    }
  }

  // Features — drawn on top of tiles.  Hidden in tiles-only / heightmap.
  if (state.showFeatures && state.viewMode !== 'tiles' && state.viewMode !== 'heightmap') {
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

  // Rotation badge is an HTML overlay — hide it when there's nothing
  // to rotate.  The drawPlacementPreview / drawTerrainClipboard
  // functions re-show + reposition it via updateRotationBadge.
  if (!state.placement && !state.terrainClipboard) hideRotationBadge()

  // Mirror the main canvas into the floating minimap.
  scheduleMinimapRender()
  // Refresh the developer stats panel on the next frame too — keeps
  // the counts in sync with whatever the user just stamped.
  scheduleDevStatsRefresh()
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
        if (img) img.addEventListener('load', () => renderCanvas(), { once: true })
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
  // The canvas's CSS size is scaled by state.zoom; convert scroll
  // pixels back to canvas pixels by dividing.
  const z = state.zoom || 1
  const left = wrap.scrollLeft / z
  const top = wrap.scrollTop / z
  const right = (wrap.scrollLeft + wrap.clientWidth) / z
  const bottom = (wrap.scrollTop + wrap.clientHeight) / z
  // One-tile padding so a feature whose anchor lands just outside the
  // viewport still gets its (taller) sprite drawn correctly.
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
    const px = (f.ax / 2) * TILE_PX
    const py = (f.ay / 2) * TILE_PX
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
    for (const f of c.features) {
      const px = (c.tx + f.ax / 2) * TILE_PX
      const py = (c.ty + f.ay / 2) * TILE_PX
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

function drawSelectedFeatureOutline(ctx) {
  // Single-pick (Place Features) — yellow ring at the anchor.
  if (state.selectedFeature >= 0 && state.selectedFeature < state.features.length) {
    const f = state.features[state.selectedFeature]
    const px = (f.ax / 2) * TILE_PX
    const py = (f.ay / 2) * TILE_PX
    ctx.strokeStyle = '#ffcc00'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(px, py, 12, 0, Math.PI * 2)
    ctx.stroke()
  }
  // Multi-select (Picker mode) — accent-coloured ring around every
  // selected placement, plus the in-flight rectangle while sweeping.
  if (state.selectedFeatures.size > 0) {
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.95)'
    ctx.lineWidth = 2
    for (const i of state.selectedFeatures) {
      if (i < 0 || i >= state.features.length) continue
      const f = state.features[i]
      const px = (f.ax / 2) * TILE_PX
      const py = (f.ay / 2) * TILE_PX
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

// drawHighlightedFeatureOutlines draws a red rectangle around every
// placement of the currently-hovered drawer feature.  The rectangle
// follows the feature's footprint so the user can see *exactly* which
// cells are occupied.
function drawHighlightedFeatureOutlines(ctx) {
  if (!state.highlightFeatureName) return
  const target = state.highlightFeatureName
  ctx.strokeStyle = '#f85149'
  ctx.lineWidth = 2
  ctx.setLineDash([4, 3])
  for (const f of state.features) {
    if ((f.name || '').toLowerCase() !== target) continue
    const px = (f.ax / 2) * TILE_PX
    const py = (f.ay / 2) * TILE_PX
    const r = featureRenderRect(f, px, py)
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

// minimapBase holds the cached map render.  Sized to the same aspect
// ratio as the displayed minimap but drawn at the main canvas's full
// resolution so the base stays sharp at any zoom level.
let minimapBase = null
let minimapBaseStale = true
function invalidateMinimapBase() {
  minimapBaseStale = true
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
  const W = state.tileW * TILE_PX
  const H = state.tileH * TILE_PX
  if (minimapBase.width !== W || minimapBase.height !== H) {
    minimapBase.width = W
    minimapBase.height = H
  }
  const ctx = minimapBase.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = VOID_COLOR
  ctx.fillRect(0, 0, W, H)
  // Draw every tile — no viewport culling, this is the always-full
  // source for the minimap.  Same per-tile cost as the main canvas
  // but only paid when content actually changes.
  for (let ty = 0; ty < state.tileH; ty++) {
    for (let tx = 0; tx < state.tileW; tx++) {
      const stamp = state.tiles[ty * state.tileW + tx]
      if (!stamp) continue
      const img = state.sectionImages.get(stamp.sectionPath)
      if (!img || !img.complete || img.naturalWidth === 0) {
        if (img) img.addEventListener('load', () => invalidateMinimapBase(), { once: true })
        continue
      }
      drawTransformedTile(ctx, img, stamp.sx, stamp.sy, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV, tx * TILE_PX, ty * TILE_PX)
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
  if (target) {
    let matches = 0
    for (const f of state.features) {
      if ((f.name || '').toLowerCase() === target && ++matches > MINIMAP_HOVER_DOT_LIMIT) break
    }
    if (matches > 0 && matches <= MINIMAP_HOVER_DOT_LIMIT) {
      ctx.fillStyle = '#f85149'
      for (const f of state.features) {
        if ((f.name || '').toLowerCase() !== target) continue
        const px = ox + (f.ax / 2 / state.tileW) * dw
        const py = oy + (f.ay / 2 / state.tileH) * dh
        ctx.beginPath()
        ctx.arc(px, py, 2.8, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  updateMinimapViewport(ox, oy, dw, dh)
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
  const fracL = wrap.scrollLeft / fullW
  const fracT = wrap.scrollTop / fullH
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
    wrap.scrollLeft = cx * fullW - wrap.clientWidth / 2
    wrap.scrollTop = cy * fullH - wrap.clientHeight / 2
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
  for (const stamp of state.tiles || []) {
    const k = distinctTileKey(stamp)
    if (!k) continue
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
  return {
    distinctTiles: tileKeys.size,
    distinctFeatures: featureNames.size,
    totalFeatures: (state.features || []).length,
    sectionsUsed: sectionPaths.size,
    tileEntries: tileKeys, // for the dialog grid
  }
}

let devStatsRefreshQueued = false
function scheduleDevStatsRefresh() {
  if (devStatsRefreshQueued) return
  devStatsRefreshQueued = true
  // Use rAF so a burst of edits collapses to one refresh.
  requestAnimationFrame(() => {
    devStatsRefreshQueued = false
    refreshDevStats()
  })
}

function refreshDevStats() {
  const stats = computeDevStats()
  const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = String(v) }
  set('dev-stats-distinct-tiles', stats.distinctTiles)
  set('dev-stats-distinct-features', stats.distinctFeatures)
  set('dev-stats-total-features', stats.totalFeatures)
  // If the developer dialog is open, keep its summary + grid live too.
  const dlg = $('#developer-dialog')
  if (dlg && !dlg.classList.contains('hidden')) {
    set('dev-dlg-distinct-tiles', stats.distinctTiles)
    set('dev-dlg-sections-used', stats.sectionsUsed)
    renderDevTilesGrid(stats.tileEntries)
  }
}

function wireDeveloperPanel() {
  const panel = $('#dev-stats-panel')
  const toggle = $('#dev-stats-toggle')
  const header = $('#dev-stats-header')
  if (!panel || !toggle || !header) return
  toggle.addEventListener('click', () => {
    panel.classList.toggle('collapsed')
    toggle.textContent = panel.classList.contains('collapsed') ? '+' : '−'
  })
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
  })
  window.addEventListener('mouseup', () => {
    if (dragOffset) {
      dragOffset = null
      header.classList.remove('dragging')
    }
  })
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
      if (img) img.addEventListener('load', () => refreshDevStats(), { once: true })
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

function setZoom(z) {
  state.zoom = clamp(z, 0.25, 4)
  const canvas = $('#canvas')
  canvas.style.width = canvas.width * state.zoom + 'px'
  canvas.style.height = canvas.height * state.zoom + 'px'
  scheduleMinimapRender()
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
  const newZoom = clamp(state.zoom * step, 0.25, 4)
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
  wrap.scrollLeft = mapX * newZoom - (clientX - wrapRect.left)
  wrap.scrollTop = mapY * newZoom - (clientY - wrapRect.top)
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
  $('#btn-resize').addEventListener('click', openResizeDialog)
  $('#btn-undo').addEventListener('click', undo)
  $('#btn-redo').addEventListener('click', redo)
  $('#btn-new').addEventListener('click', startNewMapFromEditor)
  $('#btn-open').addEventListener('click', openExistingMapFromEditor)
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
  refreshSchemaSelector()
  updateUndoButtons()
}

function wireBrushSizeGroup() {
  const eraseRow = $('#mode-row-erase')
  const popup = $('#brush-dropdown-popup')
  if (!eraseRow || !popup) return
  // The brush picker hangs off the Erase row of the Mode menu — hovering
  // the row pops the size choices out to the side; mouseleave closes
  // after a short grace period so the cursor can travel onto the popup.
  let closeTimer = null
  const positionSubmenu = () => {
    const rect = eraseRow.getBoundingClientRect()
    popup.classList.remove('hidden') // need real dimensions
    const popW = popup.offsetWidth
    const popH = popup.offsetHeight
    const vpW = window.innerWidth
    const vpH = window.innerHeight
    // Drop directly under the Erase row by default; flip above when
    // there isn't vertical room, and nudge left if the popup runs
    // off the right edge.
    let left = rect.left
    let top = rect.bottom + 4
    if (left + popW > vpW - 8) left = Math.max(8, vpW - popW - 8)
    if (top + popH > vpH - 8) top = Math.max(8, rect.top - popH - 4)
    popup.style.left = left + 'px'
    popup.style.top = top + 'px'
  }
  const open = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
    positionSubmenu()
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
  // Prefer the explicit Type=Network N suffix; fall back to the
  // start-position count for legacy / loaded data without a clear type.
  const m = /network\s*(\d+)/i.exec(schema.type || '')
  if (m) return parseInt(m[1], 10)
  return (schema.startPositions || []).length || 2
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
    const count = schemaPlayerCount(active)
    lbl.textContent = count ? playerCountLabel(count) : 'Schema'
  }
  const list = $('#schema-row-list')
  if (list && state.ota) {
    const frag = document.createDocumentFragment()
    state.ota.schemas.forEach((s, i) => {
      const row = document.createElement('div')
      row.className = 'schema-row' + (i === state.activeSchema ? ' active' : '')
      const name = document.createElement('span')
      name.className = 'schema-row-name'
      name.textContent = s.name || s.type || `Schema ${i + 1}`
      const count = document.createElement('span')
      count.className = 'schema-row-count'
      count.textContent = playerCountLabel(schemaPlayerCount(s))
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
      row.appendChild(count)
      row.appendChild(gear)
      row.appendChild(del)
      frag.appendChild(row)
    })
    list.replaceChildren(frag)
  }
  const addGrid = $('#schema-add-grid')
  if (addGrid && state.ota) {
    const used = new Set(state.ota.schemas.map((s) => schemaPlayerCount(s)))
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
        chip.textContent = playerCountLabel(n)
        chip.title = `Add a Network ${n} schema with ${n} default start positions`
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
// via Start Points mode, which gap-fills 1..N as they click.
function addSchemaWithPlayers(playerCount) {
  if (!state.ota) return
  const proto = state.ota.schemas[state.activeSchema] || state.ota.schemas[0]
  beginTransaction()
  const newSchema = {
    ...proto,
    name: `Network ${playerCount}`,
    type: `Network ${playerCount}`,
    startPositions: [],
  }
  state.ota.schemas.push(newSchema)
  state.activeSchema = state.ota.schemas.length - 1
  state.selectedStartPos = -1
  commitTransaction(`Add ${playerCount}-player schema`)
  refreshSchemaSelector()
  renderCanvas()
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
  commitTransaction('Edit map properties')
  // Reflect any name change in the top-bar info pill.
  $('#info-name').textContent = state.ota.missionName
  state.name = state.ota.missionName
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
  commitTransaction(`Edit schema: ${s.name}`)
  refreshSchemaSelector()
  closeSchemaEditor()
}

// startNewMapFromEditor is the toolbar New button — confirms first
// because it nukes the current canvas, undo history, OTA, everything.
async function startNewMapFromEditor() {
  const ok = await confirmDialog({
    title: 'Start a new map?',
    message: 'This discards the current map. Unsaved changes will be lost.',
    okLabel: 'Discard and start new',
    okDanger: true,
  })
  if (!ok) return
  sizeDialogSource = 'editor'
  $('#app').classList.add('hidden')
  // Seed the dialog with whatever the user already has, so a "New"
  // that's really a "reset" doesn't punish them with a re-entry of
  // dimensions / planet.
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
  if (sizeDialogSource === 'editor') {
    $('#app').classList.remove('hidden')
  } else {
    $('#welcome-dialog').classList.remove('hidden')
  }
}

// openExistingMapFromEditor confirms then reuses the same picker the
// Welcome modal shows on first boot — the load flow then replaces the
// editor's state in place via openLoadedMap → finishEditorBoot.
async function openExistingMapFromEditor() {
  const ok = await confirmDialog({
    title: 'Open another map?',
    message: 'This discards the current map. Unsaved changes will be lost.',
    okLabel: 'Discard and open…',
    okDanger: true,
  })
  if (!ok) return
  $('#app').classList.add('hidden')
  openMapDialog('editor')
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
  const { offsetX, offsetY } = anchorOffsets(state.tileW, state.tileH, newW, newH)
  const dW = newW - state.tileW
  const dH = newH - state.tileH
  const desc = `${state.tileW}×${state.tileH} → ${newW}×${newH}` +
    `  (Δ ${dW >= 0 ? '+' : ''}${dW}, ${dH >= 0 ? '+' : ''}${dH})` +
    `  · existing content placed at (${offsetX}, ${offsetY})`
  $('#resize-preview').textContent = desc
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
  for (let ny = 0; ny < newAttrH; ny++) {
    for (let nx = 0; nx < newAttrW; nx++) {
      const ox = nx - offAX
      const oy = ny - offAY
      if (ox < 0 || oy < 0 || ox >= oldAttrW || oy >= oldH * 2) continue
      newHeights[ny * newAttrW + nx] = state.heights[oy * oldAttrW + ox]
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
  state.features = newFeatures
  $('#info-size').textContent = `${newW} × ${newH}`
  commitTransaction('Resize map')

  closeResizeDialog()
  const cnv = $('#canvas')
  cnv.width = newW * TILE_PX
  cnv.height = newH * TILE_PX
  renderCanvas()
  setStatus(`Resized to ${newW}×${newH}.  Existing content anchored to (${offsetX}, ${offsetY}).`)
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
    features: state.features.map((f) => ({ name: f.name, ax: f.ax, ay: f.ay })),
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
