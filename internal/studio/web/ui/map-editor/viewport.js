// viewport.js
//
// Visible-area helpers for the map canvas — every per-cell render
// pass that wants to skip drawing tiles the user can't see calls
// one of these two functions.  On large maps the canvas is much
// larger than the viewport so the cull is a big win.
//
// visibleTileBounds returns an inclusive
// [minTX..maxTX, minTY..maxTY] tile rect padded by one tile so
// partially-visible edges aren't clipped.  visiblePixelBounds is
// the same rectangle in canvas pixels (game pixels at TILE_PX
// resolution) for callers that work in pixel space (features,
// hit-test outlines, etc.) and need to cull against the sprite's
// drawn box rather than tile cells.

import { state, $, clamp } from '../host-context.js'
import { TILE_PX } from './constants.js'
import { overscrollPadding } from './zoom-pan.js'

export function visibleTileBounds() {
  const wrap = $('#canvas-scroll')
  if (!wrap) return { minTX: 0, minTY: 0, maxTX: state.tileW - 1, maxTY: state.tileH - 1 }
  // The canvas sits at (overscrollPadding.x, overscrollPadding.y)
  // inside .canvas-stack, so subtract that offset before converting
  // scroll pixels to canvas pixels.  Negative values just mean
  // we're looking at the whitespace beyond a map edge — they clamp
  // away below.
  const z = state.zoom || 1
  const left = (wrap.scrollLeft - overscrollPadding.x) / z
  const top = (wrap.scrollTop - overscrollPadding.y) / z
  const right = (wrap.scrollLeft - overscrollPadding.x + wrap.clientWidth) / z
  const bottom = (wrap.scrollTop - overscrollPadding.y + wrap.clientHeight) / z
  const minTX = clamp(Math.floor(left / TILE_PX) - 1, 0, state.tileW - 1)
  const minTY = clamp(Math.floor(top / TILE_PX) - 1, 0, state.tileH - 1)
  const maxTX = clamp(Math.ceil(right / TILE_PX), 0, state.tileW - 1)
  const maxTY = clamp(Math.ceil(bottom / TILE_PX), 0, state.tileH - 1)
  return { minTX, minTY, maxTX, maxTY }
}

export function visiblePixelBounds() {
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
