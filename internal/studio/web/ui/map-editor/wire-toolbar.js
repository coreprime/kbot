// wire-toolbar.js
//
// Legacy DOM toolbar wirer for the map editor.  Owns the imperative
// boot-time wiring for the ribbon-side static markup that the React
// MapRibbon doesn't (yet) replace, plus the small handful of
// drawer / placement / schema helpers that ride alongside:
//
//   - wireToolbar()              — every ribbon button + dropdown
//                                  (File, Edit, Actions, Advanced)
//                                  the legacy template still ships.
//                                  Click handlers reach Save / Open /
//                                  Resize / Scatter / Export / Quality
//                                  Check / Clipboard / OTA dialog, +
//                                  delegates the brush / heightmap /
//                                  voids / symmetry hover popups + the
//                                  Undo / Redo history flyouts to the
//                                  legacy-popups module.
//   - wireZoomButtons()          — the three Zoom ribbon buttons.
//   - wireTabs()                 — drawer tab strip (now React-managed
//                                  via configureSidebarBridge); kept
//                                  only to push the initial sidebar
//                                  signals on first paint.
//   - wireModeToolbar()          — Mode dropdown is React-managed;
//                                  publishes the initial mode state.
//   - wireViewMenu()             — View dropdown is React-managed;
//                                  publishes the initial view toggles
//                                  + makes the feature-info panel
//                                  draggable.
//   - switchTab(tab)             — drawer tab switcher (Sections vs
//                                  Features).  Routes the React
//                                  sidebar's tab clicks into the
//                                  shared state + republishes.
//   - placementAnchor(cx, cy, p) — rotation-aware top-left-anchor for
//                                  a section so the cursor lands at
//                                  the centre of the footprint.
//   - placeFeature(ax, ay)       — drops the active feature pick at
//                                  the supplied attribute cell (with
//                                  symmetry mates).
//   - activeSchema()             — returns the live OTA schema record
//                                  the user is editing, or null.
//
// Cross-module deps reached through hostCallbacks so this module
// doesn't import studio.js:
//   - publishMapRibbonState()      — pushes ribbon snapshot into React
//   - publishMapSidebarState()     — pushes sidebar snapshot into React
//   - refreshSchemaSelector()      — repopulates the legacy schema
//                                    dropdown after a schema change
//   - wireSchemaSelector()         — opens-on-hover + popup-anchor for
//                                    the legacy schema dropdown badge
//   - startNewMapFromEditor()      — File → New
//   - openExistingMapFromEditor()  — File → Open (in-editor)
//   - runQualityChecker()          — Advanced → Quality Check…
//   - buildSavePayload()           — payload the Quality Check posts

import { $, state, hostCallbacks } from '../host-context.js'
import { rotatedFootprint } from './rotation.js'
import { symmetryMatesAttr } from './symmetry.js'
import { bumpContentVersion } from './content-cache.js'
import { renderCanvas } from './canvas/render.js'
import { renderDrawer } from './drawer.js'
import { setZoom, fitZoom } from './zoom-pan.js'
import { undo, redo, updateUndoButtons } from './undo.js'
import {
  cutSelection,
  copyToClipboard,
  pasteFromClipboard,
  clearRegion,
  clearAllFeatures,
  clearFeaturesInSelection,
} from './clipboard.js'
import {
  exportHeightmap,
  exportMinimap,
  exportFullRender,
  exportMapImage,
  exportBuildmap,
  exportVoidmap,
  onImportHeightmapFile,
} from './exports.js'
import { save, saveLoose } from './save.js'
import { openResizeDialog, wireResizeDialog } from './dialogs/resize.js'
import { openOTADialog, wireOTADialog } from './dialogs/ota.js'
import { wireSchemaEditor } from './dialogs/schema-editor.js'
import {
  openScatterDialog,
  closeScatterDialog,
  applyScatter,
} from './dialogs/scatter.js'
import {
  closeAllRibbonDropdowns,
  positionRibbonPopup,
  wireHistoryFlyout,
  wireSymmetryGroup,
  wireVoidsBrushGroup,
  wireHeightmapBrushGroup,
  wireBrushSizeGroup,
} from './ribbon/legacy-popups.js'
import { makePanelDraggable } from '../common/panel-layout.js'
import { runQualityChecker } from './dialogs/quality-checker.js'
import { buildSavePayload } from './save-payload.js'

// switchTab is the drawer tab switcher (Sections vs Features) — NOT
// the registry's switchToTab (which takes a numeric index).  React's
// MapSidebar tab strip calls this through configureSidebarBridge.
export function switchTab(tab) {
  state.drawer = tab
  // React MapSidebar reads drawer / filter / checkbox visibility off
  // signals — publishMapSidebarState pushes the new tab + restored
  // per-tab filter into the React tree.  Sections-vs-Features-only
  // checkbox visibility is computed inside publishMapSidebarState
  // (showUsed / showWreckage flip off on Sections).
  hostCallbacks.publishMapSidebarState?.()
  // Placeholder text — the React input doesn't currently bind it, so
  // poke the DOM input directly when present.  Falls through cleanly
  // when the input hasn't mounted yet (early boot).
  const filterInput = document.getElementById('filter')
  if (filterInput) {
    filterInput.placeholder = tab === 'features'
      ? 'Filter features by name, world, category'
      : 'Filter sections by name, world, group'
  }
  renderDrawer()
}

export function wireTabs() {
  // Sidebar tabs + filter row are React-managed now (see
  // /ui/map-editor/tabs/sidebar.js).  Click / input handlers route
  // through configureSidebarBridge, which the React tree installs.
  // Nothing left to wire here, but the publishMapSidebarState call
  // ensures the React signals reflect the live state every time we
  // re-enter the editor (File → New / Open / etc.).
  hostCallbacks.publishMapSidebarState?.()
}

export function wireModeToolbar() {
  // The Mode dropdown is React-managed (see
  // /ui/map-editor/ribbon/map-ribbon.js).  Mode picks fire through
  // the map-ribbon bridge's setMode action; the React tree reads the
  // active mode off ribbonState.mode each publish.  Nothing to wire
  // here, but publishing the initial mode keeps the dropdown badge in
  // lockstep on first paint.
  hostCallbacks.publishMapRibbonState?.()
}

export function wireViewMenu() {
  // The View dropdown + every toggle row + the display-mode picker
  // are React-managed now (see /ui/map-editor/ribbon/map-ribbon.js).
  // The host bridge installed in configureReactUi routes the clicks
  // through to setMinimapVisible / setVoidsVisible / setFeaturesVisible
  // / etc.  Only the feature-info-panel's draggable wiring stays
  // here — it's the one floating panel we didn't migrate this round.
  makePanelDraggable($('#feature-info-panel'), $('#feature-info-header'))
  // Push the initial View toggles into the React store so the menu's
  // check-glyphs reflect persisted state on first paint.
  hostCallbacks.publishMapRibbonState?.()
}

// wireZoomButtons binds the three Zoom ribbon buttons.  Lives outside
// EditorView because the buttons sit in the toolbar (which is mounted
// once for the session) rather than the canvas stack.
export function wireZoomButtons() {
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom * (state.settings?.zoomStep || 1.25)))
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom / (state.settings?.zoomStep || 1.25)))
  $('#zoom-fit').addEventListener('click', fitZoom)
}

// placementAnchor returns the top-left tile coordinate where the section
// should land so that the cursor cell ends up at the centre of the
// section's footprint.  For a W×H section, the cursor at (cx, cy) maps
// to a top-left at (cx - floor(W/2), cy - floor(H/2)).
export function placementAnchor(cursorTX, cursorTY, p) {
  const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, p.rotation)
  return { tx: cursorTX - Math.floor(fw / 2), ty: cursorTY - Math.floor(fh / 2) }
}

// activeSchema returns the OTA schema the user is currently editing,
// or null when no map is loaded.  Used by the start-position delete
// path (mode.js) and by any cursor / picker code that needs the live
// schema's start markers.
export function activeSchema() {
  if (!state.ota || !state.ota.schemas[state.activeSchema]) return null
  return state.ota.schemas[state.activeSchema]
}

// placeFeature drops the active feature pick at the supplied attribute
// cell, mirroring the placement onto every symmetry mate the user has
// configured.  Existing features at the same anchor are replaced (so a
// double-click swaps without stacking).
export function placeFeature(ax, ay) {
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

// wireToolbar binds every ribbon-side button + dropdown the legacy
// template still ships.  Most of the dropdowns are React-managed now
// — the optional-chaining guards below short-circuit when the static
// element is absent so the wiring is harmless when present.  The
// ribbon popups (File / Edit / Actions / Advanced) still drop down
// from their legacy buttons because the React migration covers only
// the toolbar surface above the popups.
export function wireToolbar() {
  $('#btn-save')?.addEventListener('click', save)
  $('#btn-save-loose')?.addEventListener('click', saveLoose)
  $('#btn-resize')?.addEventListener('click', openResizeDialog)
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
  $('#btn-import-heightmap')?.addEventListener('click', () => $('#import-heightmap-file')?.click())
  // The import-heightmap-file <input> stays as a real DOM element
  // (kept outside the ribbon template precisely because the React
  // ribbon's importHeightmap bridge action synthesises a click on it).
  $('#import-heightmap-file')?.addEventListener('change', onImportHeightmapFile)
  $('#btn-undo')?.addEventListener('click', undo)
  $('#btn-redo')?.addEventListener('click', redo)
  wireHistoryFlyout($('#btn-undo'), $('#undo-history-popup'))
  wireHistoryFlyout($('#btn-redo'), $('#redo-history-popup'))
  $('#btn-new')?.addEventListener('click', () => hostCallbacks.startNewMapFromEditor?.())
  $('#btn-open')?.addEventListener('click', () => hostCallbacks.openExistingMapFromEditor?.())
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
  $('#btn-ota')?.addEventListener('click', openOTADialog)

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
  hostCallbacks.wireSchemaSelector?.()
  wireOTADialog()
  wireSchemaEditor()
  wireBrushSizeGroup()
  wireHeightmapBrushGroup()
  wireVoidsBrushGroup()
  wireSymmetryGroup()
  hostCallbacks.refreshSchemaSelector?.()
  updateUndoButtons()
}
