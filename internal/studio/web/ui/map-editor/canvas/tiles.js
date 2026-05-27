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
import { TILE_PX } from '../constants.js'
import { visibleTileBounds } from '../viewport.js'
import { whenImageReady } from '../feature-assets.js'
import { drawTransformedTile } from '../rotation.js'

export function drawTiles(ctx) {
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
