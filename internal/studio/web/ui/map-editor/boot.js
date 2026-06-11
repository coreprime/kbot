// boot.js
//
// Map-editor lifecycle hub.  Owns the entry-point pair that mounts a
// map tab onto the editor surface (openLoadedMap + startEditor), the
// one-shot finishEditorBoot wire chain that runs the first time any
// map tab opens, the per-tileset catalog loaders that hydrate the
// drawer panels, the per-tab module-let snapshot/restore pair the
// multi-tab framework uses to swap MapDoc-scoped state in and out,
// and the abortTransientGestureState fallback that resets every
// mode's in-flight drag/paint state on a tab swap.
//
// Surface:
//
//   - openLoadedMap(data, card)        — primary map open path.  Builds
//                                        a fresh MapDoc, pushes it
//                                        through the registry with
//                                        deferred activation, hydrates
//                                        the tile / heights / voids /
//                                        features arrays from the
//                                        backend response, then calls
//                                        finishEditorBoot to mount the
//                                        canvas.
//   - startEditor()                    — size-dialog Confirm handler.
//                                        Same tab-push + finishEditorBoot
//                                        shape as openLoadedMap, but
//                                        seeds an empty MapDoc at the
//                                        user-picked dimensions and
//                                        builds one Network-N schema
//                                        per dice-picked player count.
//   - finishEditorBoot()               — the idempotent wire chain.
//                                        First call wires toolbar /
//                                        zoom / tabs / minimap / mode /
//                                        view-menu / keyboard / dev
//                                        panel; every call recreates
//                                        the canvas DOM, restores the
//                                        sidebar filter, awaits the
//                                        sections + features catalogs,
//                                        sizes + centres the viewport,
//                                        and paints the first frame.
//   - loadSections() / loadFeatures()  — catalog fetchers that
//                                        repopulate the active map's
//                                        sectionsList / featuresList +
//                                        re-render the drawer when the
//                                        active side matches.
//   - fetchFeatureOrigins()            — GAF hotspot fetcher.  Cached
//                                        across map switches; first
//                                        load applies + repaints, every
//                                        subsequent load reuses the
//                                        cache.
//   - applyFeatureOrigins(map)         — patches the drawer catalog +
//                                        every placed feature with the
//                                        hotspot origin offsets so the
//                                        canvas re-anchors them on the
//                                        right sub-tile.
//   - snapshotActiveTabModuleLets()    — copies module-level lets
//                                        (undo / redo stacks, pending
//                                        transaction, minimap base,
//                                        scroll position) off the
//                                        editor onto the outgoing tab's
//                                        MapDoc before a tab switch.
//   - restoreActiveTabModuleLets()     — reverse direction; populates
//                                        the module-level lets from the
//                                        incoming tab's MapDoc.  Scroll
//                                        position is restored later
//                                        (after the new canvas is
//                                        sized) by the tab descriptor.
//   - abortTransientGestureState()     — drops every in-flight per-mode
//                                        gesture (pan / paint stroke /
//                                        heightmap hold / paint
//                                        placement / each per-mode
//                                        drag) so a tab swap can't
//                                        leave a stuck cursor or
//                                        ongoing stroke behind.
//
// Cross-module deps reached through hostCallbacks so this module
// doesn't import studio.js:
//   - openTab(typeId, spec, opts)      — tab registry push; lives in
//                                        studio.js (orchestration).
//   - renderMapTabs()                  — pushes the tab list into the
//                                        React InterfaceTabStrip signal.
//   - updateTopbarDocInfo(tab)         — refreshes the shared topbar
//                                        from the active tab.
//   - wireDeveloperDialog()            — Settings / Help / Developer
//                                        dialog wiring; stays studio-
//                                        side because the Settings /
//                                        Help / Developer buttons need
//                                        to work even when no map tab
//                                        has ever been opened (e.g. a
//                                        unit-editor-only session).
//   - publishMapSidebarState()         — pushes the active map's
//                                        drawer filter into the React
//                                        MapSidebar signal so the
//                                        filter input flips on tab
//                                        switch.

import { $, state, tabs, tabState, hostCallbacks, MapDoc, setStatus, clamp } from '../host-context.js'
import { TAK_TERRAIN_KEY, TAK_TERRAIN_EDITOR_MAX } from './constants.js'
import { setCurrentTakMap } from './tak-edit.js'
import {
  undoStack,
  redoStack,
  getPendingTransaction,
  setPendingTransaction,
} from './undo.js'
import { resetPaintStroke } from './paint-state.js'
import { resetPaintPlacement } from './modes/paint.js'
import { resetHmHoldTimer } from './modes/heightmap.js'
import { resetTerrainDrag } from './modes/terrain-select.js'
import { resetFeatureDrag } from './modes/feature-select.js'
import { resetStartPosDrag } from './modes/start-points.js'
import { resetPickerDrag } from './modes/picker.js'
import { cancelPan } from './cursor.js'
import { bumpContentVersion } from './content-cache.js'
import { defaultOTAState } from './helpers.js'
import { pickedPlayerCounts } from './dialogs/dice-picker.js'
import {
  invalidateMinimapBase,
  wireMinimap,
  getMinimapBaseSnapshot,
  setMinimapBaseSnapshot,
} from './minimap.js'
import { renderCanvas } from './canvas/render.js'
import { renderDrawer } from './drawer.js'
import { resetGL } from './canvas/webgl.js'
import {
  recreateEditorView,
  prepareCanvasDimensions,
  centerViewOnMap,
} from './editor-view.js'
import {
  wireToolbar,
  wireZoomButtons,
  wireTabs,
  wireModeToolbar,
  wireViewMenu,
} from './wire-toolbar.js'
import { wireKeyboard } from './keyboard.js'
import { wireDeveloperPanel } from './dev-stats.js'
import { applyPanelLayout } from '../common/panel-layout.js'

// snapshotActiveTabModuleLets captures every module-level let that
// belongs to the outgoing tab into its MapDoc so the next time the
// user switches back, restoreActiveTabModuleLets can put them right
// back.  Bails out for tab types without a .map (model / sandbox)
// so we don't throw assigning .undoStack onto a tab record that has
// no MapDoc.
export function snapshotActiveTabModuleLets() {
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

export function restoreActiveTabModuleLets() {
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

export function abortTransientGestureState() {
  cancelPan()
  resetPaintStroke()
  resetHmHoldTimer()
  resetPaintPlacement()
  resetTerrainDrag()
  resetFeatureDrag()
  resetStartPosDrag()
  resetPickerDrag()
}

export async function openLoadedMap(data, card) {
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
  hostCallbacks.openTab?.('map', { map: new MapDoc() }, { defer: true })
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

  // Preload the canvas backdrop.  TA maps: the tile-pool atlas (drawn per
  // stamp).  TA:Kingdoms maps are texture-mapped — there is no tile pool, so
  // preload the full terrain render and stash it under TAK_TERRAIN_KEY for the
  // backdrop pass.  The promise resolves on BOTH load and error so a missing
  // image (e.g. a TA:K map with no tile pool) can never hang the editor boot
  // and leave the default "newmap" showing.
  const img = new Image()
  const ready = new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true })
    img.addEventListener('error', resolve, { once: true })
  })
  // Track the active TA:K map so section drops route to the server-side
  // terrain-compositing path (tak-edit.js) instead of TA tile stamping.
  setCurrentTakMap(data.textureMapped ? data.path : null)
  if (data.textureMapped && data.terrainUrl) {
    // Two-stage backdrop: block boot only on a SMALL render (fast to
    // composite server-side and to decode), then swap in the near-native
    // render asynchronously once it lands. A cold full-res render of a big
    // TA:K map costs over a second before the first PNG byte plus a large
    // decode — awaiting it froze the editor on open.
    const sep = data.terrainUrl.includes('?') ? '&' : '?'
    img.src = `${data.terrainUrl}${sep}max=512`
    state.sectionImages.set(TAK_TERRAIN_KEY, img)
    const full = new Image()
    full.addEventListener('load', () => {
      // Only swap if this map is still the active backdrop.
      if (state.sectionImages.get(TAK_TERRAIN_KEY) === img) {
        state.sectionImages.set(TAK_TERRAIN_KEY, full)
        invalidateMinimapBase()
        hostCallbacks.renderCanvas?.()
      }
    }, { once: true })
    full.src = `${data.terrainUrl}${sep}max=${TAK_TERRAIN_EDITOR_MAX}`
  } else {
    img.src = data.tilePoolUrl
    state.sectionImages.set(data.tilePoolKey, img)
  }
  await ready

  $('#open-dialog').classList.add('hidden')
  $('#welcome-dialog').classList.add('hidden')
  // If the user came from a model tab, the 3DO viewer was the
  // surface in front — hide it so the map editor takes the screen.
  // Same for the Files overlay: this deferred open path mounts the
  // editor without routing through switchToTab, so the outgoing
  // Files tab's deactivate never fires — hide its overlay here or it
  // sits on top of the freshly-opened map.
  $('#model-viewer-dialog')?.classList.add('hidden')
  $('#files-dialog')?.classList.add('hidden')
  $('#app').classList.remove('hidden')
  hostCallbacks.renderMapTabs?.()
  // Refresh the shared topbar + footer hints from this new map tab,
  // otherwise they keep the previous (model) tab's strings.
  hostCallbacks.updateTopbarDocInfo?.(tabs[tabState.activeIndex])

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

export async function startEditor() {
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
  hostCallbacks.openTab?.('map', { map: new MapDoc() }, { defer: true })
  restoreActiveTabModuleLets()
  state.tileW = w
  state.tileH = h
  state.name = name
  state.planet = planet
  setCurrentTakMap(null) // a freshly-created map is TA tile-based, not TA:K terrain
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
  // Hide the model viewer + Files overlays — this deferred open path
  // bypasses switchToTab, so the outgoing tab's deactivate (which
  // would normally hide them) never runs.
  $('#model-viewer-dialog')?.classList.add('hidden')
  $('#files-dialog')?.classList.add('hidden')
  $('#app').classList.remove('hidden')
  hostCallbacks.renderMapTabs?.()
  hostCallbacks.updateTopbarDocInfo?.(tabs[tabState.activeIndex])

  await finishEditorBoot()
}

// finishEditorBoot wires the toolbar / canvas / drawer and loads the
// section + feature catalogs.  Called from both the New-map and
// Open-map paths once state has been seeded; subsequent calls are
// idempotent so File → New / File → Open mid-session re-renders
// without doubling up event listeners.
let editorWired = false
export async function finishEditorBoot() {
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
  hostCallbacks.publishMapSidebarState?.()
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

// loadSections / loadFeatures fetch the per-tileset catalog of
// stampable sections + the master feature list, then re-render the
// drawer if it's currently showing that side.  loadFeatures also
// awaits the GAF hotspot fetch so the very first render shows the
// correct sub-tile origins instead of the bottom-centred fallback.

export async function loadSections() {
  const resp = await fetch('/api/studio/sections')
  const data = await resp.json()
  state.sectionsList = data.sections || []
  if (state.drawer === 'sections') renderDrawer()
}

export async function loadFeatures() {
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

export async function fetchFeatureOrigins() {
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

export function applyFeatureOrigins(map) {
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
