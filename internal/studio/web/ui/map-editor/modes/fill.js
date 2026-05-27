// fill.js
//
// Fill-mode mousedown handler — two related operations on the
// same gesture:
//
//   - Plain click   → 4-way connected flood from the clicked tile,
//                     replacing every cell whose section + sx/sy
//                     match the clicked tile with the active
//                     drawer-section's (0,0) cell (after the
//                     active rotation + flip).
//   - Shift+click   → global replace.  Walks every cell on the
//                     map; matches by the same key.  Handy when
//                     the user wants "swap palette A for B
//                     everywhere" without filling each island
//                     manually.
//
// Both paths produce a single undoable transaction.  Source +
// target identical → status note + no-op.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — single repaint after the fill commits.

import { state, setStatus, hostCallbacks } from '../../host-context.js'
import { pickCell } from '../mouse-coords.js'
import { transformedSourceCell } from '../rotation.js'
import { patchMinimapTile } from '../minimap.js'
import { beginTransaction, commitTransaction } from '../undo.js'

// onFillMouseDown floods the connected region of tiles matching the
// tile under the cursor with the active section's (0,0) source.  4-way
// connectivity; bounded by the map.
export function onFillMouseDown(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || ty < 0 || tx >= state.tileW || ty >= state.tileH) return
  const sel = state.selected
  if (!sel || sel.type !== 'section') {
    setStatus('Fill: pick a section from the drawer first.')
    return
  }
  const target = state.tiles[ty * state.tileW + tx]
  const targetKey = target ? `${target.sectionPath}|${target.sx}|${target.sy}` : 'null'
  // The section's (0,0) cell after rotation/flip gives the replacement tile.
  const src = transformedSourceCell(0, 0, sel.tileW, sel.tileH, sel.rotation || 0, !!sel.flipH, !!sel.flipV)
  const replacement = {
    sectionPath: sel.path,
    sx: src.sx, sy: src.sy,
    rotation: sel.rotation || 0,
    flipH: !!sel.flipH,
    flipV: !!sel.flipV,
  }
  const replacementKey = `${replacement.sectionPath}|${replacement.sx}|${replacement.sy}`
  if (replacementKey === targetKey) {
    setStatus('Fill: source and target are identical — nothing to do.')
    return
  }
  beginTransaction()
  const W = state.tileW
  const H = state.tileH
  let filled = 0
  // Shift+click = global replace.  Walks every cell instead of doing a
  // connected flood — handy when the user wants "swap palette A for B
  // everywhere" without manually filling each island.
  if (e.shiftKey) {
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const cell = state.tiles[cy * W + cx]
        const key = cell ? `${cell.sectionPath}|${cell.sx}|${cell.sy}` : 'null'
        if (key !== targetKey) continue
        state.tiles[cy * W + cx] = { ...replacement }
        patchMinimapTile(cx, cy)
        filled++
      }
    }
    commitTransaction(`Replace ${filled} tile${filled === 1 ? '' : 's'}`)
    hostCallbacks.renderCanvas?.()
    setStatus(`Replaced ${filled} tile${filled === 1 ? '' : 's'} globally with ${sel.name}.`)
    return
  }
  // Iterative scanline-ish flood — explicit stack to avoid blowing the
  // call frame on big maps.  Tracks visited cells via a Uint8Array.
  const visited = new Uint8Array(W * H)
  const stack = [[tx, ty]]
  visited[ty * W + tx] = 1
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()
    const cell = state.tiles[cy * W + cx]
    const key = cell ? `${cell.sectionPath}|${cell.sx}|${cell.sy}` : 'null'
    if (key !== targetKey) continue
    state.tiles[cy * W + cx] = { ...replacement }
    patchMinimapTile(cx, cy)
    filled++
    const neighbours = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
    for (const [nx, ny] of neighbours) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      if (visited[ny * W + nx]) continue
      visited[ny * W + nx] = 1
      stack.push([nx, ny])
    }
  }
  commitTransaction(`Fill ${filled} tile${filled === 1 ? '' : 's'}`)
  hostCallbacks.renderCanvas?.()
  setStatus(`Flood-filled ${filled} tile${filled === 1 ? '' : 's'} with ${sel.name}.  Shift-click to replace globally.`)
}
