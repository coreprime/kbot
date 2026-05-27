// feature-info.js
//
// Floating "Feature Info" callout that appears while a single
// feature is selected.  Shows the data you'd want to round-trip
// through the TNT file — map tile, attribute sub-cell, world
// pixel, terrain height byte, footprint, category.  Hidden on
// no-selection or multi-select (Picker mode).
//
// Pure DOM updater — reads state, writes textContent into the
// #feature-info-panel pill.  Called from renderCanvas after every
// frame.

import { state, $ } from '../host-context.js'
import { featureAnchorWorld, featureGroundHeight } from './feature-assets.js'

export function updateFeatureInfoPanel() {
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
  // Tile = which 32-px tile the anchor falls in.  Sub-tile is
  // the 0/1 attribute offset inside that tile (TA's 2×2
  // attribute grid per tile).
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
