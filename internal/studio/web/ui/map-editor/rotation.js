// rotation.js
//
// Pure tile-rotation + flip helpers shared between the 2D canvas
// path, the WebGL renderer, and the section-stamp pipeline.  No
// DOM, no module state — every input is an explicit argument.
//
// rotation r ∈ {0,1,2,3}: count of 90° clockwise quarter-turns.
// For rotated cell (rx, ry) in a footprint that is (rotW, rotH)
// tiles (where rotW = origH and rotH = origW for r ∈ {1,3}), the
// original section cell is:
//   r=0: ox=rx, oy=ry                                 (footprint origW × origH)
//   r=1: ox=ry, oy=(origW-1)-rx                       (footprint origH × origW)
//   r=2: ox=(origW-1)-rx, oy=(origH-1)-ry             (footprint origW × origH)
//   r=3: ox=(origH-1)-ry, oy=rx                       (footprint origH × origW)

import { TILE_PX } from './constants.js'

export function rotatedFootprint(origW, origH, rotation) {
  return (rotation & 1) ? { w: origH, h: origW } : { w: origW, h: origH }
}

export function rotatedSourceCell(rx, ry, origW, origH, rotation) {
  switch (rotation & 3) {
    case 0: return { sx: rx, sy: ry }
    case 1: return { sx: ry, sy: (origW - 1) - rx }
    case 2: return { sx: (origW - 1) - rx, sy: (origH - 1) - ry }
    case 3: return { sx: (origH - 1) - ry, sy: rx }
  }
}

// transformedSourceCell extends rotatedSourceCell with optional H/V
// flips on top.  Flips are applied to the *post-rotation*
// destination grid: flipH mirrors across the vertical centre, flipV
// across the horizontal centre.  This keeps the user's mental
// model simple — Q/E rotate, then F/G mirror what they see.
export function transformedSourceCell(rx, ry, origW, origH, rotation, flipH, flipV) {
  const { w: fw, h: fh } = rotatedFootprint(origW, origH, rotation)
  const px = flipH ? (fw - 1 - rx) : rx
  const py = flipV ? (fh - 1 - ry) : ry
  return rotatedSourceCell(px, py, origW, origH, rotation)
}

// drawTransformedTile composes rotation + flip in canvas-space so a
// single tile pixel pattern is drawn rotated and/or mirrored.  The
// flip is applied *after* the rotation in pixel terms (matching
// what the user sees in the preview).
export function drawTransformedTile(ctx, img, sx, sy, rotation, flipH, flipV, dx, dy) {
  if ((rotation & 3) === 0 && !flipH && !flipV) {
    ctx.drawImage(img, sx * 32, sy * 32, 32, 32, dx, dy, TILE_PX, TILE_PX)
    return
  }
  ctx.save()
  ctx.translate(dx + TILE_PX / 2, dy + TILE_PX / 2)
  if (flipV) ctx.scale(1, -1)
  if (flipH) ctx.scale(-1, 1)
  if ((rotation & 3) !== 0) ctx.rotate((rotation & 3) * Math.PI / 2)
  ctx.drawImage(img, sx * 32, sy * 32, 32, 32, -TILE_PX / 2, -TILE_PX / 2, TILE_PX, TILE_PX)
  ctx.restore()
}
