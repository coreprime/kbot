// tiles.js
//
// 2D-canvas tile pass — the headline "show the map" loop.  For
// every tile inside the visible-bounds rect we look up the
// section atlas, hand the source rect to drawTransformedTile (the
// rotation + flip implementation lives in webgl.js's CPU
// fallback), and fall back to a placeholder swatch with a one-
// shot whenImageReady callback when the atlas is still decoding.
//
// drawRotatedTile is the simpler sibling — same idea, but
// rotation-only and no flip flags.  It's used by the terrain-
// clipboard preview which doesn't store its own flip state, so a
// lighter helper keeps the call sites obvious.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — register a one-shot redraw when a tile's
//     section atlas finishes decoding (whenImageReady's
//     callback target).

import { state, hostCallbacks } from '../../host-context.js'
import { TILE_PX, TAK_TERRAIN_KEY } from '../constants.js'
import { visibleTileBounds, visiblePixelBounds } from '../viewport.js'
import { whenImageReady } from '../feature-assets.js'
import { drawTransformedTile } from '../rotation.js'

// drawTakTerrain paints the TA:Kingdoms texture-mapped terrain render as a
// read-only backdrop (TA:K maps have no 32×32 tile pool). Returns true when it
// handled the draw so the caller skips the tile loop.
//
// Only the VISIBLE region is blitted each frame — the full backdrop maps onto a
// tileW*32-pixel canvas (up to ~7680px), and redrawing the whole thing on every
// pan/zoom was the source of the sluggish zoom. We map the visible canvas rect
// to the corresponding source-image rect and let the GPU scale just that slice.
function drawTakTerrain(ctx) {
  const img = state.sectionImages.get(TAK_TERRAIN_KEY)
  if (!img) return false
  // The backdrop is an <img> until the first stamp patch converts it to a
  // canvas (which has no complete/naturalWidth and is always drawable).
  const isCanvas = typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement
  if (!isCanvas && (!img.complete || img.naturalWidth === 0)) {
    whenImageReady(img, 'render', () => hostCallbacks.renderCanvas?.())
    return true
  }
  const iw = isCanvas ? img.width : img.naturalWidth
  const ih = isCanvas ? img.height : img.naturalHeight
  const canvasW = state.tileW * TILE_PX
  const canvasH = state.tileH * TILE_PX
  // Source→canvas scale (the served render may be smaller than the canvas).
  const sx = iw / canvasW
  const sy = ih / canvasH
  const pb = visiblePixelBounds()
  const dx = Math.max(0, pb.minX)
  const dy = Math.max(0, pb.minY)
  const dw = Math.min(canvasW, pb.maxX) - dx
  const dh = Math.min(canvasH, pb.maxY) - dy
  if (dw <= 0 || dh <= 0) return true
  ctx.drawImage(img, dx * sx, dy * sy, dw * sx, dh * sy, dx, dy, dw, dh)
  return true
}

export function drawTiles(ctx) {
  if (drawTakTerrain(ctx)) return
  const vb = visibleTileBounds()
  for (let ty = vb.minTY; ty <= vb.maxTY; ty++) {
    for (let tx = vb.minTX; tx <= vb.maxTX; tx++) {
      const stamp = state.tiles[ty * state.tileW + tx]
      if (!stamp) continue
      const img = state.sectionImages.get(stamp.sectionPath)
      if (!img || !img.complete || img.naturalWidth === 0) {
        ctx.fillStyle = '#3a4d61'
        ctx.fillRect(tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX)
        whenImageReady(img, 'render', () => hostCallbacks.renderCanvas?.())
        continue
      }
      drawTransformedTile(ctx, img, stamp.sx, stamp.sy, stamp.rotation || 0, !!stamp.flipH, !!stamp.flipV, tx * TILE_PX, ty * TILE_PX)
    }
  }
}

// drawRotatedTile copies one 32×32 source tile from a section
// image to the destination canvas, rotated by `rotation` quarter-
// turns clockwise.  Simpler than drawTransformedTile — no flip
// flags, no edge-flip math.  Used by the terrain-clipboard preview
// which only carries a rotation.
export function drawRotatedTile(ctx, img, sx, sy, rotation, dx, dy) {
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
