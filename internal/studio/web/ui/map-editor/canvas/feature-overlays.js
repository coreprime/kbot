// feature-overlays.js
//
// Selection + hover overlays drawn on top of the feature pass:
//
//   - drawSelectedFeatureOutline   Dashed white box around the
//                                  feature the user has selected
//                                  via Place Features; if multiple
//                                  are selected via Picker mode,
//                                  a purple ring around each plus
//                                  the in-flight sweep rectangle.
//   - drawHighlightedFeatureOutlines
//                                  Red dashed boxes around every
//                                  placement matching the
//                                  currently-hovered drawer entry,
//                                  gated on FEATURE_HIGHLIGHT_LIMIT
//                                  so dense maps stay responsive.
//
// Both overlays use featureRenderRect to bound the rectangle to
// the sprite's actual frame geometry when the sprite image has
// loaded, falling back to a footprint-sized box otherwise.

import { state } from '../../host-context.js'
import { TILE_PX, FEATURE_HIGHLIGHT_LIMIT } from '../constants.js'
import { getFeaturesByName } from '../content-cache.js'
import { featureRenderRect, featureAnchorWorld, featureGroundHeight } from '../feature-assets.js'
import { visiblePixelBounds } from '../viewport.js'
import { normalizedRect } from '../helpers.js'

export function drawSelectedFeatureOutline(ctx) {
  // Single-pick (Place Features) — dashed white box around the
  // feature's footprint cells, so the user sees the area the
  // feature actually occupies on the attribute grid rather than
  // just an anchor circle.  Lifted by Height/2 to mirror the same
  // terrain-elevation offset featureAnchorWorld applies, so the
  // box hugs the rendered sprite instead of floating one-to-two
  // tiles below it.
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
  // selected placement, plus the in-flight rectangle while
  // sweeping.
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

// drawHighlightedFeatureOutlines draws a red rectangle around
// every placement of the currently-hovered drawer feature.  The
// rectangle follows the feature's footprint so the user can see
// *exactly* which cells are occupied.  Skipped entirely once
// state.features grows past FEATURE_HIGHLIGHT_LIMIT — for huge
// maps the highlight makes every hover feel sluggish and the user
// can still pick out the hovered type via the drawer thumbnail.
export function drawHighlightedFeatureOutlines(ctx) {
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
