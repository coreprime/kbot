// open-map.js
//
// Imperative wrapper around the React open-map picker (which
// lives in ./open-map-dialog.js).  Owns the catalogue polling
// state, the picker open/close orchestration, and the
// "where did the user come from" routing that decides what to
// pop back to on cancel.
//
// Flow
// ----
//   openMapDialog(source) — hide every competing surface
//     (welcome / 3DO viewer), start fetchMaps() polling, await
//     the React picker.  Resolves to either `confirmOpenMap()`
//     (the user picked a map) or `closeOpenDialog()` (cancel).
//   fetchMaps() — poll /api/studio/maps every 500ms while the
//     server is still indexing.  Each poll pushes fresh data
//     into the React picker via reactUi.updateMapDialog().
//   confirmOpenMap() — fetch /api/studio/load, then hand the
//     decoded payload off to the openLoadedMap host callback
//     which hydrates editor state.
//   closeOpenDialog() — restore whichever surface the user
//     came from.
//
// Cross-module dependencies (via hostCallbacks):
//   - configureReactUi() — boots the React UI bridge.
//   - openLoadedMap(data, card) — hydrates editor state from a
//     /api/studio/load response.

import {
  $,
  tabs,
  tabState,
  setStatus,
  hostCallbacks,
  getReactUi,
} from '../host-context.js'

// Module-level state for the open-map flow.  These are private
// to this module; nothing reaches in from outside.
let availableMaps = []
let mapsLoading = false
let mapsPollTimer = null
let selectedMapPath = null
let openMapSource = 'welcome' // 'welcome' or 'editor' — controls where Back returns to
// Surfaces that were visible at openMapDialog() entry; closeOpenDialog
// puts each one back when the user cancels.  Snapshotting (rather than
// switching on active tab type) means we restore correctly for sandbox
// tabs (which share #model-viewer-dialog with model tabs) AND any future
// tab type that hangs off one of these surfaces.
let openMapPriorSurfaces = null

export async function openMapDialog(source = 'welcome') {
  openMapSource = source
  // Snapshot every surface we're about to hide so the cancel handler
  // can flip the same ones back on.  Previously closeOpenDialog branched
  // on the active tab's `type` and only knew about 'model' / 'map' — a
  // sandbox tab fell through both branches and the screen went blank.
  openMapPriorSurfaces = {
    welcome:   !$('#welcome-dialog').classList.contains('hidden'),
    viewer:    !$('#model-viewer-dialog').classList.contains('hidden'),
    appEditor: !$('#app').classList.contains('hidden'),
  }
  // Hide every surface that might be in front of the picker —
  // the welcome screen on first boot, the 3DO viewer dialog when
  // the user clicks "Open Map" from a model tab.  Without this
  // the open list would render behind a higher-z-index dialog
  // and look like the click did nothing.
  $('#welcome-dialog').classList.add('hidden')
  $('#model-viewer-dialog').classList.add('hidden')
  selectedMapPath = null
  if (mapsPollTimer) { clearTimeout(mapsPollTimer); mapsPollTimer = null }
  if (availableMaps.length === 0) mapsLoading = true
  // React-managed dialog — see /ui/pickers/open-map-dialog.js.
  // We start polling fetchMaps() AND open the dialog in parallel
  // so the user sees skeleton tiles immediately while the
  // catalogue streams in.  Each poll cycle pushes fresh data via
  // updateMapDialog().  On resolve we either route into
  // confirmOpenMap (which loads + opens the map) or restore the
  // editor surface the user came from.
  ;(async () => {
    const ui = getReactUi() || await hostCallbacks.configureReactUi?.()
    if (!ui || typeof ui.openMapDialog !== 'function') return
    fetchMaps()
    const picked = await ui.openMapDialog({
      items: availableMaps,
      loading: mapsLoading,
      query: '',
      selectedPath: null,
    })
    if (!picked) {
      closeOpenDialog()
      return
    }
    selectedMapPath = picked.path
    confirmOpenMap()
  })()
}

export async function fetchMaps() {
  try {
    const resp = await fetch('/api/studio/maps')
    const data = await resp.json()
    availableMaps = data.maps || []
    mapsLoading = !!data.loading
  } catch {
    availableMaps = []
    mapsLoading = false
    const ui = getReactUi()
    if (ui && typeof ui.updateMapDialog === 'function') {
      ui.updateMapDialog({ items: [], loading: false })
    }
    return
  }
  // Push the fresh catalog into the React picker (no-op when
  // the picker isn't open).  The picker re-renders on its own
  // state signal so we don't need to touch any DOM here.
  const ui = getReactUi()
  if (ui && typeof ui.updateMapDialog === 'function') {
    ui.updateMapDialog({ items: availableMaps, loading: mapsLoading })
  }
  if (mapsLoading) {
    mapsPollTimer = setTimeout(fetchMaps, 500)
  }
}

// closeOpenDialog returns the user to whichever surface they
// came from.  Snapshot/restore via openMapPriorSurfaces — that catches
// every tab type that hangs off welcome / model-viewer-dialog / #app
// without having to enumerate them, so a sandbox tab (which shares
// model-viewer-dialog with model tabs) restores correctly.
export function closeOpenDialog() {
  const ui = getReactUi()
  if (ui && typeof ui.closeMapDialog === 'function') {
    ui.closeMapDialog()
  }
  if (mapsPollTimer) { clearTimeout(mapsPollTimer); mapsPollTimer = null }
  const prior = openMapPriorSurfaces
  openMapPriorSurfaces = null
  if (prior) {
    $('#welcome-dialog').classList.toggle('hidden', !prior.welcome)
    $('#model-viewer-dialog').classList.toggle('hidden', !prior.viewer)
    $('#app')?.classList.toggle('hidden', !prior.appEditor)
    return
  }
  // Fallback for the (now impossible) case where someone calls
  // closeOpenDialog without a matching openMapDialog().  Use the
  // legacy source-based restore so we don't leave the screen blank.
  if (openMapSource === 'welcome') {
    $('#welcome-dialog').classList.remove('hidden')
    return
  }
  const active = tabState.activeIndex >= 0 ? tabs[tabState.activeIndex] : null
  if (active?.type === 'model' || active?.type === 'sandbox') {
    $('#model-viewer-dialog').classList.remove('hidden')
  } else if (active?.type === 'map') {
    $('#app')?.classList.remove('hidden')
  }
}

async function confirmOpenMap() {
  if (!selectedMapPath) return
  // openLoadedMap below routes the screen onto the new map tab — the
  // restore snapshot from openMapDialog() is no longer relevant, drop
  // it so a subsequent close path can't accidentally fire a stale
  // restore against a moved-on UI state.
  openMapPriorSurfaces = null
  const card = availableMaps.find((x) => x.path === selectedMapPath)
  const confirmBtn = $('#open-confirm')
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Loading…' }
  try {
    const resp = await fetch('/api/studio/load?path=' + encodeURIComponent(selectedMapPath))
    if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`)
    const data = await resp.json()
    await hostCallbacks.openLoadedMap?.(data, card)
  } catch (err) {
    setStatus(`Failed to open ${card?.name || selectedMapPath}: ${err.message || err}`)
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Open' }
    return
  }
  if (confirmBtn) confirmBtn.textContent = 'Open'
}
