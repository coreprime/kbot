// symmetry.js
//
// Symmetry helpers for the paint / erase / heightmap / voids
// tools.  When the user picks Vertical / Horizontal / Both from
// the toolbar dropdown, every stroke applies to the original
// cell AND to its mirror(s) so a map's two halves stay
// pixel-identical.  Pure read-only over state.tileW / state.tileH
// / state.symmetry — no DOM, no side effects.
//
// The matching DOM wiring (wireSymmetryGroup / refreshSymmetryRow)
// stays in studio.js for now because it shares the
// positionSubmenuRight helper with the other mode-toolbar
// dropdowns.  SYMMETRY_LABELS comes along here so the host can
// reuse the same label table for the toolbar tick rows.

import { state } from '../host-context.js'

export const SYMMETRY_LABELS = { off: 'Off', x: 'Vertical', y: 'Horizontal', xy: 'Both' }

// symmetryMatesTile returns the tile coords each stroke should
// also touch when symmetry is on.  The original (tx, ty) is
// implicit and not included.  Each mate carries its own (fx, fy)
// flip flags so callers can apply matching tile rotations.
export function symmetryMatesTile(tx, ty, footW = 1, footH = 1) {
  if (state.symmetry === 'off') return []
  const W = state.tileW
  const H = state.tileH
  // The mirrored top-left for a footprint is the reflection of
  // the *far* edge so the footprint's body lands inside the
  // canvas.
  const mx = W - tx - footW
  const my = H - ty - footH
  const mates = []
  if (state.symmetry === 'x' || state.symmetry === 'xy') mates.push({ tx: mx, ty, fx: true, fy: false })
  if (state.symmetry === 'y' || state.symmetry === 'xy') mates.push({ tx, ty: my, fx: false, fy: true })
  if (state.symmetry === 'xy') mates.push({ tx: mx, ty: my, fx: true, fy: true })
  return mates
}

// symmetryMatesAttr is the attribute-grid analogue of
// symmetryMatesTile.  Used by the heightmap and voids brushes
// which paint at 16-px attribute resolution instead of 32-px
// tile resolution.
export function symmetryMatesAttr(ax, ay) {
  if (state.symmetry === 'off') return []
  const aw = state.tileW * 2
  const ah = state.tileH * 2
  const mx = aw - 1 - ax
  const my = ah - 1 - ay
  const mates = []
  if (state.symmetry === 'x' || state.symmetry === 'xy') mates.push({ ax: mx, ay })
  if (state.symmetry === 'y' || state.symmetry === 'xy') mates.push({ ax, ay: my })
  if (state.symmetry === 'xy') mates.push({ ax: mx, ay: my })
  return mates
}
