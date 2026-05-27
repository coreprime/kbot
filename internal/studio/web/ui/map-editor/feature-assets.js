// feature-assets.js
//
// Feature sprite image loading + world-anchor projection helpers.
// Used by both the canvas renderer (drawFeatures path) and the
// minimap dot pass; pulled out of studio.js so neither needs the
// host file at import time.
//
// whenImageReady dedupes load-listener registration on a single
// Image element — the renderer used to add a fresh 'load' handler
// on every repaint that touched a not-yet-decoded section atlas,
// which made the decode race itself fire a thousand listeners.
//
// preloadFeatureImage attaches a static-frame PNG to
// state.featureImages so subsequent draws find it ready.  We never
// use the animated APNG canvas for placement — the animated frame
// canvas is padded to the bounding box of all frames, which
// shifts the in-image hotspot away from (OriginX, OriginY).
// Drawer thumbnails still animate via their own <img> tags.
//
// featureAnchorWorld returns the world-pixel position the feature
// is anchored at.  TA stores f.ax / f.ay as the *top-left*
// attribute cell of the feature's footprint, but the rendered
// anchor lives at the CENTRE of the footprint, shifted UP by
// Height/2 to account for the underlying terrain elevation.
// Without the Height/2 term, TA's default ground (height ≈ 64)
// made every feature render one tile too low.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — schedule a repaint when a freshly-loaded
//     feature image becomes available.

import { state, hostCallbacks } from '../host-context.js'
import { TILE_PX } from './constants.js'

const imageReadyCallbacks = new WeakMap()

export function whenImageReady(img, kind, cb) {
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

export function preloadFeatureImage(f) {
  if (!f.previewUrl) return
  const key = f.name.toLowerCase()
  if (state.featureImages.has(key)) return
  // Canvas placements always use the static first-frame PNG.  The
  // animated APNG canvas is padded to the bounding box of all
  // frames, which shifts the in-image hotspot away from (OriginX,
  // OriginY) and breaks placement on multi-frame features.
  // Drawer thumbnails still animate via their own <img> elements
  // (see renderFeatureGroup).
  const img = new Image()
  img.src = f.previewUrl + '?static=1'
  img.onload = () => hostCallbacks.renderCanvas?.()
  state.featureImages.set(key, img)
}

// featureAnchorOffset returns the (dx, dy) inside the sprite image
// that corresponds to the feature's world anchor point.  Uses the
// GAF hotspot when the backend supplied it, otherwise falls back
// to a bottom-centred anchor (matches the historical placement
// until the origin metadata arrives over the wire).
export function featureAnchorOffset(f, img) {
  if (typeof f.originX === 'number' && typeof f.originY === 'number' && (f.originX !== 0 || f.originY !== 0)) {
    return { dx: f.originX, dy: f.originY }
  }
  return { dx: img.naturalWidth / 2, dy: img.naturalHeight }
}

// featureRenderRect returns the on-canvas rectangle covered by a
// feature sprite drawn at world position (px, py).  When the
// sprite image is loaded and we know the GAF origin, we use the
// actual frame geometry; otherwise we fall back to a bottom-
// centred footprint box so the click target is still roughly
// right.
export function featureRenderRect(f, px, py) {
  const img = f.previewUrl ? state.featureImages.get((f.name || '').toLowerCase()) : null
  if (img && img.complete && img.naturalWidth > 0) {
    const { dx, dy } = featureAnchorOffset(f, img)
    return { x: px - dx, y: py - dy, w: img.naturalWidth, h: img.naturalHeight }
  }
  const fw = (f.footprintX || 1) * (TILE_PX / 2)
  const fh = (f.footprintZ || 1) * (TILE_PX / 2)
  return { x: px - fw / 2, y: py - fh, w: fw, h: fh }
}

export function featureAnchorWorld(f, heightOverride) {
  const fw = f.footprintX || 1
  const fh = f.footprintZ || 1
  const px = f.ax * (TILE_PX / 2) + fw * (TILE_PX / 4)
  const h = heightOverride != null ? heightOverride : featureGroundHeight(f)
  const py = f.ay * (TILE_PX / 2) + fh * (TILE_PX / 4) - (h >> 1)
  return { px, py }
}

// featureGroundHeight reads the height byte from the attribute
// grid at the feature's anchor cell.  Heights live one byte per
// 16-px attr cell in state.heights, sized state.tileW*2 ×
// state.tileH*2.  Out-of-range (e.g. orphaned features) returns 0
// so the feature falls back to its cell centre without any
// elevation kick.
export function featureGroundHeight(f) {
  if (!state.heights || !state.tileW) return 0
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  if (f.ax < 0 || f.ay < 0 || f.ax >= aw || f.ay >= ah) return 0
  const idx = f.ay * aw + f.ax
  return state.heights[idx] | 0
}
