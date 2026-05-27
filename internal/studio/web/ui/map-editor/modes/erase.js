// erase.js
//
// Erase-mode brush stamps.  `eraseAt` is the symmetry-aware entry
// point — it stamps once at the requested tile and again at every
// symmetry-mate tile.  `eraseAtSingle` does the actual work for
// one stamp position: clear tiles + drop features inside the
// brush footprint.
//
// The brush is centred (or near-centred for even sizes) on the
// cursor tile.  state.eraseSize is the side length in tiles;
// state.eraseScope ('all' | 'terrain' | 'features') gates which
// surface gets cleared:
//   - scope='all'       → both tiles + features
//   - scope='features'  → features only, tiles untouched
//   - scope='terrain'   → tiles only, features survive
//
// Cross-module deps: the host's renderCanvas() is called once at
// the end of a stamp if anything changed, so the caller can fire
// many `eraseAt` calls in a drag without each one repainting.

import { state, hostCallbacks } from '../../host-context.js'
import { symmetryMatesTile } from '../symmetry.js'
import { patchMinimapTile } from '../minimap.js'
import { bumpContentVersion } from '../content-cache.js'

export function eraseAt(tx, ty) {
  eraseAtSingle(tx, ty)
  for (const m of symmetryMatesTile(tx, ty, 1, 1)) eraseAtSingle(m.tx, m.ty)
}

export function eraseAtSingle(tx, ty) {
  const size = Math.max(1, state.eraseSize || 1)
  const scope = state.eraseScope || 'all'
  // Brush is centred (or near-centred for even sizes) on the cursor tile.
  const off = Math.floor(size / 2)
  const x0 = tx - off
  const y0 = ty - off
  const x1 = x0 + size
  const y1 = y0 + size
  let dirty = false
  if (scope !== 'features') {
    for (let ty2 = y0; ty2 < y1; ty2++) {
      if (ty2 < 0 || ty2 >= state.tileH) continue
      for (let tx2 = x0; tx2 < x1; tx2++) {
        if (tx2 < 0 || tx2 >= state.tileW) continue
        const i = ty2 * state.tileW + tx2
        if (state.tiles[i]) {
          state.tiles[i] = null
          patchMinimapTile(tx2, ty2)
          dirty = true
        }
      }
    }
  }
  if (scope !== 'terrain') {
    // Drop features whose anchor falls inside the brush.
    const minAX = x0 * 2, maxAX = x1 * 2
    const minAY = y0 * 2, maxAY = y1 * 2
    const before = state.features.length
    state.features = state.features.filter((f) => {
      return !(f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY)
    })
    if (state.features.length !== before) {
      bumpContentVersion()
      dirty = true
    }
  }
  if (dirty) hostCallbacks.renderCanvas?.()
}
