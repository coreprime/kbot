// mode.js
//
// Map-editor mode dispatch + the cluster of helpers that change as
// the active mode flips.  Owns:
//
//   - setMode(mode)              — the single seam every consumer
//                                   uses to switch tools.  Tears down
//                                   in-flight state that doesn't
//                                   belong to the incoming mode,
//                                   auto-enables the View toggle the
//                                   mode needs, swaps the canvas
//                                   cursor, repaints, and republishes
//                                   the React ribbon state.
//   - modeHint(mode)             — the status-bar one-liner shown
//                                   underneath the canvas after a
//                                   mode swap.
//   - syncDrawerToMode(mode)     — flips the left-sidebar drawer to
//                                   Sections or Features when the new
//                                   mode implies one or the other.
//   - rotateActive(dir)          — Q / E dispatch.  Rotates whichever
//                                   subject is currently in play —
//                                   the placement preview, the
//                                   floating terrain clipboard, or
//                                   the pre-selected drawer section.
//   - flipActive(axis)           — F / G dispatch.  Same shape as
//                                   rotateActive but only acts on
//                                   sections (clipboard flip isn't
//                                   implemented yet).
//   - handleDeleteKey()          — Delete / Backspace resolution.
//                                   Picker multi-select wins first,
//                                   then single feature select, then
//                                   a floating terrain clipboard,
//                                   then a selected start position.
//   - selectAllContent()         — Ctrl/Cmd-A.  Captures the bounding
//                                   box of every tile + feature into
//                                   a Select Area clipboard.
//   - cancelPlacement()          — drops the section placement ghost.
//   - showPlacementHint(label,k) — pops the floating "Placing X" pill
//                                   over the cursor; hides the Q/E
//                                   row for features (no rotation).
//   - hidePlacementHint()        — hides the pill.
//   - clearStampSelection()      — deselects the active drawer
//                                   section / feature so subsequent
//                                   clicks no longer stamp.
//
// Cross-module deps that come back through hostCallbacks rather than
// direct imports — these still live in studio.js this round:
//   - publishMapRibbonState()    — push fresh ribbon state into React
//                                  after mode + view flips
//   - switchDrawerTab(tab)       — syncDrawerToMode reaches the host
//                                  switchTab so the drawer flips when
//                                  the new mode implies a side
//   - activeSchema()             — handleDeleteKey looks up the
//                                  active OTA schema to remove a
//                                  start position
//   - renderDrawer()             — clearStampSelection repaints the
//                                  drawer row after deselecting

import { isTakMapActive } from './tak-edit.js'
import { $, $$, state, hostCallbacks, setStatus, activeMap } from '../host-context.js'
import {
  beginTransaction,
  commitTransaction,
} from './undo.js'
import {
  shrinkRectToContent,
  captureTerrain,
  dropTerrainClipboard,
  rotateTerrainClipboard,
} from './clipboard.js'
import {
  setVoidsVisible,
  setFeaturesVisible,
  setStartPositionsVisible,
} from './view-toggles.js'
import { refreshModeDropdown } from './ribbon/legacy-popups.js'
import { resetVoidsDrag } from './modes/voids.js'
import { renderCanvas } from './canvas/render.js'
import { renderDrawer } from './drawer.js'

// Switch the drawer to match the active editing mode — Place Tiles
// implies the user wants sections, Place Features implies features.
export function syncDrawerToMode(mode) {
  if (mode === 'paint' && state.drawer !== 'sections') {
    hostCallbacks.switchDrawerTab?.('sections')
  } else if (mode === 'select-features' && state.drawer !== 'features') {
    hostCallbacks.switchDrawerTab?.('features')
  }
}

export function setMode(mode) {
  // No-op when no map tab is the active context — every state.X read
  // below routes through the host-context Proxy to activeMap(), which
  // returns null when the user is on the welcome screen or a unit /
  // sandbox tab.  Hotkeys (P/T/F/G/K/S/X/D/H/B/R) bubble to the
  // document keyboard listener regardless of which tab owns focus, so
  // bail here rather than gating at every call site.
  if (!activeMap()) return
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
  hostCallbacks.publishMapRibbonState?.()
}

export function modeHint(mode) {
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

// rotateActive rotates whichever interactive subject is in play.  Q/E
// dispatches to the placement preview, the floating terrain clipboard,
// or the currently-selected drawer section (so the user can pre-rotate
// before placement starts).
export function rotateActive(dir) {
  // dir: +1 = clockwise, -1 = counter-clockwise.
  if (state.placement) {
    // TA:K terrain cells carry no orientation bits, so a rotated section
    // stamp cannot be represented — hold at 0 and tell the user why.
    if (isTakMapActive()) {
      setStatus('TA:K sections cannot rotate — the format stores terrain as (texture, U, V) with no orientation.')
      return
    }
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
export function flipActive(axis) {
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

// handleDeleteKey resolves the Delete keystroke against whatever the
// user has currently picked.  Picker multi-selection wins first, then
// the single Place-Features pick, then a captured terrain rectangle
// (which gets *thrown away* rather than dropped back onto the map).
export function handleDeleteKey() {
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
    const schema = hostCallbacks.activeSchema?.()
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

// selectAllContent captures the bounding box of every tile + feature
// on the map into a Select Area clipboard.  Bound to Ctrl/Cmd-A so
// the user can grab the whole work-in-progress in one keystroke.
export function selectAllContent() {
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

export function cancelPlacement() {
  if (!state.placement) return
  state.placement = null
  hidePlacementHint()
  renderCanvas()
}

export function showPlacementHint(label, kind) {
  const hint = $('#placement-hint')
  const lbl = $('#placement-hint-label')
  const rotateRow = $('#placement-hint-rotate')
  if (hint) hint.classList.remove('hidden')
  if (lbl) lbl.textContent = label
  // Features don't rotate — hide the Q/E line so the pill is less noisy
  // when the user is dragging features.
  if (rotateRow) rotateRow.classList.toggle('hidden', kind === 'feature')
}

export function hidePlacementHint() {
  const hint = $('#placement-hint')
  if (hint) hint.classList.add('hidden')
}

// clearStampSelection deselects the active section/feature so subsequent
// clicks no longer stamp.  We keep the erase tool intact since it's a
// distinct mode the user toggles explicitly.
export function clearStampSelection() {
  if (!state.selected) return
  state.selected = null
  hidePlacementHint()
  renderDrawer()
  setStatus('Stamp placed.  Pick another section/feature on the left to keep building.')
}
