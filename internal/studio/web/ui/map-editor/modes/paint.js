// paint.js
//
// Paint-mode mouse dispatch + the stamp pipeline.  Three top-level
// entry points (onPaintMouseDown / Move / Up) cover the mode's
// branch in the central mouse router; everything else here is the
// internal mechanics they call into.
//
// Paint gesture taxonomy:
//
//   - No active placement, no shift, click on a tile →
//     beginTransaction + handlePaint → stamp under the cursor.
//     Each drag step stamps again; mouseup commits 'Paint' (or
//     aborts the empty transaction if no stamp landed).
//
//   - Shift held during paint → handlePaint dispatches to
//     eraseAt at the cursor cell, so shift-paint inside paint
//     mode acts as a quick-erase modifier.
//
//   - Active placement (state.placement) → handlePaintModeClick
//     drives a two-click anchored-preview flow:
//       click 1: anchor the preview at the click cell
//       drag inside the footprint: slide the preview
//       click 2 inside, no drag: confirm-here; commit + drop
//                                 selection + slip to Select Area
//       click 2 outside: commit + re-arm at the next click
//
//   - Drawer drop (drag-from-section) falls through to handlePaint
//     in the canvas drop handler — exported so studio.js's
//     drop-fallback can route through the same code path.
//
// Module-private state:
//   - _placementMoveAnchor — the in-flight anchored-preview drag.
//
// Cross-module deps via hostCallbacks (set in studio.js):
//   - renderCanvas, setMode, hidePlacementHint        (already wired)
//   - placeFeature                                    (R40c)
//   - tryAutoSwitchAt                                 (R40a)
//   - renderDrawer, clearStampSelection, placementAnchor
//                                                     (added R40d)
//
// Stamp helpers (stampSection, stampSectionWithRotation,
// copyTileHeights) live in this module because they only feed
// the paint-mode click path now; the drag-from-drawer path goes
// through handlePaint above them.

import { isTakMapActive, stampTakSection } from '../tak-edit.js'
import { state, setStatus, hostCallbacks } from '../../host-context.js'
import { pickCell, pickFeatureAttrCell } from '../mouse-coords.js'
import { rotatedFootprint, transformedSourceCell } from '../rotation.js'
import { tryAutoRotatePlacement } from '../canvas/placement.js'
import { symmetryMatesTile } from '../symmetry.js'
import { patchMinimapTile } from '../minimap.js'
import {
  beginTransaction, commitTransaction, abortTransaction,
} from '../undo.js'
import { paintState } from '../paint-state.js'
import { eraseAt } from './erase.js'

let _placementMoveAnchor = null

// resetPaintPlacement clears the in-flight anchored-preview drag
// so abortTransientGestureState + mode-swap paths don't leave us
// thinking a drag is mid-flight after the cursor left the canvas.
export function resetPaintPlacement() {
  _placementMoveAnchor = null
}

// onPaintMouseDown — paint-mode branch of the canvas mousedown
// dispatcher.  Anchored placement vs. fresh-stamp branch.
export function onPaintMouseDown(e) {
  if (state.placement) {
    _handlePaintModeClick(e)
    return
  }
  beginTransaction()
  handlePaint(e)
}

// onPaintMouseMove — paint-mode branch of the canvas mousemove
// dispatcher.  Three sub-paths:
//   - mid-drag on an anchored preview → translate it
//   - hover with a non-anchored placement → updatePlacementHover
//   - active paint stroke → keep stamping
function _updatePlacementHover(e) {
  const { tx: cx, ty: cy } = pickCell(e)
  const anchor = hostCallbacks.placementAnchor?.(cx, cy, state.placement)
  if (!anchor) return
  const { tx, ty } = anchor
  const moved = state.placement.tx !== tx || state.placement.ty !== ty
  const waking = !!state.placement.dormant
  if (moved) {
    state.placement.tx = tx
    state.placement.ty = ty
  }
  // Cursor entered the canvas → wake the preview so it starts
  // rendering under the cursor instead of (invisibly) at the
  // viewport centre we seeded it with.
  if (waking) state.placement.dormant = false
  // Auto-fit rotation while the cursor is dragging the preview around:
  // a new position can change which orientation is the only seam-clean
  // option.  Once Q/E sets userRotated, this becomes a no-op.
  if (moved) tryAutoRotatePlacement(state.placement)
  if (moved || waking) hostCallbacks.renderCanvas?.()
}

export function onPaintMouseMove(e) {
  if (_placementMoveAnchor && state.placement) {
    const { tx, ty } = pickCell(e)
    const dx = tx - _placementMoveAnchor.cursorTX
    const dy = ty - _placementMoveAnchor.cursorTY
    const newTx = _placementMoveAnchor.anchoredTX + dx
    const newTy = _placementMoveAnchor.anchoredTY + dy
    if (dx !== 0 || dy !== 0) _placementMoveAnchor.moved = true
    if (state.placement.tx !== newTx || state.placement.ty !== newTy) {
      state.placement.tx = newTx
      state.placement.ty = newTy
      tryAutoRotatePlacement(state.placement)
      hostCallbacks.renderCanvas?.()
    }
  } else if (state.placement && !state.placement.anchored) {
    _updatePlacementHover(e)
  } else if (paintState.painting) {
    handlePaint(e)
  }
}

// onPaintMouseUp — paint-mode branch of the canvas mouseup
// dispatcher.  Resolves the three end-of-stroke shapes:
//   - end of an anchored-preview drag (no movement → confirm)
//   - end of a productive paint stroke → 'Paint' transaction
//   - end of an empty stroke → abort the transaction
export function onPaintMouseUp(_e) {
  if (_placementMoveAnchor) {
    // If the mousedown happened inside the anchored footprint and
    // the cursor didn't move, treat the mouseup as a "confirm here"
    // click; otherwise the drag has already updated tx/ty in place
    // and we just clear the anchor.
    if (!_placementMoveAnchor.moved) {
      // Mousedown-then-up inside the anchored footprint is a "confirm
      // here" gesture.  Commit, drop the drawer selection, and slip
      // into Select Area mode so the user can immediately move or
      // tweak what they just placed.
      commitAnchoredPlacement()
      state.selected = null
      hostCallbacks.hidePlacementHint?.()
      hostCallbacks.renderDrawer?.()
      hostCallbacks.setMode?.('select-terrain')
    }
    _placementMoveAnchor = null
    return
  }
  if (paintState.painting && paintState.paintedDuringStroke && !state.placement) {
    commitTransaction('Paint')
    if (state.selected?.type !== 'feature') hostCallbacks.clearStampSelection?.()
  } else if (paintState.painting && !paintState.paintedDuringStroke) {
    abortTransaction()
  }
}

// _handlePaintModeClick implements the two-click placement flow.
//
//   Click 1 — anchors the cursor-following preview at the click cell.
//             Tiles beneath are *not* modified yet.
//   Click 2 inside the anchored footprint (no drag) — confirms.
//   Click 2 outside the anchored footprint — confirms in place and
//             re-engages cursor-follow so the next click drops another
//             copy without re-picking from the drawer.
//   Mousedown + drag inside footprint — slides the preview to a new
//             position.
function _handlePaintModeClick(e) {
  const p = state.placement
  const { tx: cx, ty: cy } = pickCell(e)
  if (!p.anchored) {
    // First click — anchor at the click cell (centred via placementAnchor).
    const a = hostCallbacks.placementAnchor?.(cx, cy, p)
    if (!a) return
    p.tx = a.tx
    p.ty = a.ty
    p.anchored = true
    hostCallbacks.renderCanvas?.()
    setStatus('Section anchored — drag to reposition, Q / E to rotate, click again to confirm.')
    return
  }
  // Already anchored.  Mousedown inside the footprint kicks off a
  // drag-move; anywhere else commits and re-arms for the next stamp.
  const { w: fw, h: fh } = rotatedFootprint(p.origW, p.origH, p.rotation)
  const insideFootprint = cx >= p.tx && cx < p.tx + fw && cy >= p.ty && cy < p.ty + fh
  if (insideFootprint) {
    _placementMoveAnchor = {
      cursorTX: cx, cursorTY: cy,
      anchoredTX: p.tx, anchoredTY: p.ty,
      moved: false,
    }
    return
  }
  // Click outside the anchored footprint — commit, clear the drawer
  // selection, and switch to Select Area mode so the user is ready
  // to manipulate the just-placed section without re-mode-switching.
  commitAnchoredPlacement()
  state.selected = null
  hostCallbacks.hidePlacementHint?.()
  hostCallbacks.renderDrawer?.()
  hostCallbacks.setMode?.('select-terrain')
}

// commitAnchoredPlacement writes the current anchored placement to the
// map.  The drawer selection's rotation is updated so the next time we
// re-arm (multi-stamp) we keep the user's rotation choice.
export function commitAnchoredPlacement() {
  const p = state.placement
  if (!p) return
  // TA:K maps composite the section server-side (terrain + heights +
  // features) — there is no tile pool to stamp and no client-side undo
  // entry; the workspace's saved map is the authority.
  if (isTakMapActive()) {
    stampTakSection(p.sectionPath, p.tx, p.ty)
    state.placement = null
    hostCallbacks.hidePlacementHint?.()
    return
  }
  if (state.selected?.type === 'section') {
    state.selected.rotation = p.rotation
    state.selected.flipH = !!p.flipH
    state.selected.flipV = !!p.flipV
  }
  beginTransaction()
  stampSectionWithRotation(p.tx, p.ty, p.sectionPath, p.origW, p.origH, p.rotation, !!p.flipH, !!p.flipV)
  commitTransaction('Place section')
  state.placement = null
  hostCallbacks.hidePlacementHint?.()
}

// stampSectionWithRotation writes per-cell {sectionPath, sx, sy, rotation,
// flipH, flipV} records into state.tiles and copies the section's height
// samples (with the same transform) into state.heights at 16-px
// resolution.  flipH/flipV are optional and default to false.
function stampSectionWithRotation(tx, ty, sectionPath, origW, origH, rotation, flipH = false, flipV = false) {
  const { w: fw, h: fh } = rotatedFootprint(origW, origH, rotation)
  const sec = state.sectionHeights.get(sectionPath) // may be undefined
  for (let dy = 0; dy < fh; dy++) {
    for (let dx = 0; dx < fw; dx++) {
      const mx = tx + dx
      const my = ty + dy
      if (mx < 0 || my < 0 || mx >= state.tileW || my >= state.tileH) continue
      const src = transformedSourceCell(dx, dy, origW, origH, rotation, flipH, flipV)
      state.tiles[my * state.tileW + mx] = { sectionPath, sx: src.sx, sy: src.sy, rotation, flipH, flipV }
      patchMinimapTile(mx, my)
      if (sec) _copyTileHeights(sec, src.sx, src.sy, mx, my, rotation, origW, origH, flipH, flipV)
    }
  }
  paintState.paintedDuringStroke = true
  hostCallbacks.renderCanvas?.()
}

// _copyTileHeights — each tile cell maps to a 2×2 block in the 16-px
// attribute grid; copy the 4 height samples from the section into
// state.heights, applying the inverse rotation so a rotated section's
// elevations end up where the rotated tile graphic visually points.
function _copyTileHeights(sec, ssx, ssy, mtx, mty, rotation, origW, _origH, flipH = false, flipV = false) {
  const secAttrW = origW * 2
  const mapAttrW = state.tileW * 2
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      // The flip mirrors the visible 2×2 attribute slots inside the tile
      // before we map back through the rotation — same composition as
      // drawTransformedTile so seams stay coherent.
      const fqx = flipH ? 1 - qx : qx
      const fqy = flipV ? 1 - qy : qy
      let sqx = fqx
      let sqy = fqy
      switch (rotation & 3) {
        case 1: sqx = fqy; sqy = 1 - fqx; break
        case 2: sqx = 1 - fqx; sqy = 1 - fqy; break
        case 3: sqx = 1 - fqy; sqy = fqx; break
      }
      const srcAX = ssx * 2 + sqx
      const srcAY = ssy * 2 + sqy
      const dstAX = mtx * 2 + qx
      const dstAY = mty * 2 + qy
      if (srcAY >= 0 && srcAX >= 0 && srcAY * secAttrW + srcAX < sec.heights.length) {
        state.heights[dstAY * mapAttrW + dstAX] = sec.heights[srcAY * secAttrW + srcAX]
      }
    }
  }
}

// handlePaint dispatches a per-tile stamp at the cursor cell — the
// per-mousemove step of a paint stroke.  Exported so the drawer's
// drag-drop fallback (studio.js) can route plain drops through the
// same code path without duplicating the section / feature switch.
export function handlePaint(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) return

  // Shift held in Paint mode still acts as a quick-erase modifier.
  if (e.shiftKey) {
    eraseAt(tx, ty)
    paintState.paintedDuringStroke = true
    return
  }
  if (!state.selected) return
  if (state.selected.type === 'section' && state.mode === 'paint') {
    _stampSection(tx, ty)
    paintState.paintedDuringStroke = true
  } else if (state.selected.type === 'feature') {
    const { ax, ay } = pickFeatureAttrCell(e, state.selected)
    hostCallbacks.placeFeature?.(ax, ay)
    paintState.paintedDuringStroke = true
  }
}

// _stampSection writes a single section instance (with symmetry mates)
// at (tx, ty).  The mate's flip flags XOR with the user's flip so the
// mirrored copy lands as the mirrored picture.
function _stampSection(tx, ty) {
  const sel = state.selected
  const rotation = sel.rotation || 0
  const { w: fw, h: fh } = rotatedFootprint(sel.tileW, sel.tileH, rotation)
  stampSectionWithRotation(tx, ty, sel.path, sel.tileW, sel.tileH, rotation, !!sel.flipH, !!sel.flipV)
  for (const m of symmetryMatesTile(tx, ty, fw, fh)) {
    stampSectionWithRotation(m.tx, m.ty, sel.path, sel.tileW, sel.tileH, rotation,
      !!sel.flipH !== m.fx, !!sel.flipV !== m.fy)
  }
}
