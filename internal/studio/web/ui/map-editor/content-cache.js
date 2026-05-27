// content-cache.js
//
// Content-version-keyed caches over state.features.  Everything that
// would otherwise walk the whole features array on every mouse-move
// (hit picking, hover outlines, minimap dots) reaches the index here
// and only rebuilds when contentVersion has actually ticked.
//
// contentVersion is bumped on every feature edit (placement, drag,
// scatter, paste, undo, redo, resize, load).  The two indices below
// invalidate on the same tick so they always agree:
//   - featureSpatial — tile-keyed bucket of feature indices for
//     featuresNear() (O(radius²) instead of O(N) per mouse-move).
//   - featureNameIndex — name → indices array for getFeaturesByName()
//     (hover outline + minimap dots).
//
// Tile-only edits route through invalidateMinimapBase + patchMinimap
// directly and don't need to invalidate the feature indices, so the
// minimap pipeline calls bumpContentVersion() only after FEATURE
// edits, not stamp/erase.

import { state } from '../host-context.js'

let contentVersion = 0
let featureSpatial = null
let spatialVersion = -1
let featureNameIndex = null
let nameIndexVersion = -1

export function getContentVersion() { return contentVersion }

// bumpContentVersion is called any time state.features changes.
// Feature indices recompute lazily when their cached version falls
// behind.
export function bumpContentVersion() {
  contentVersion++
  featureSpatial = null
  featureNameIndex = null
}

function rebuildFeatureSpatial() {
  featureSpatial = new Map()
  const tw = state.tileW
  for (let i = 0; i < state.features.length; i++) {
    const f = state.features[i]
    const tx = Math.floor(f.ax / 2)
    const ty = Math.floor(f.ay / 2)
    const key = ty * tw + tx
    let arr = featureSpatial.get(key)
    if (!arr) { arr = []; featureSpatial.set(key, arr) }
    arr.push(i)
  }
  spatialVersion = contentVersion
}

// featuresNear returns every feature whose ANCHOR tile is within a
// radius of (tx, ty).  Sprites can extend off their anchor so
// callers should still test the final draw rect, but the candidate
// set is now O(radius²) instead of O(N).
export function featuresNear(tx, ty, radius) {
  if (!featureSpatial || spatialVersion !== contentVersion) rebuildFeatureSpatial()
  const tw = state.tileW, th = state.tileH
  const lo = { x: Math.max(0, tx - radius), y: Math.max(0, ty - radius) }
  const hi = { x: Math.min(tw - 1, tx + radius), y: Math.min(th - 1, ty + radius) }
  const out = []
  for (let cy = lo.y; cy <= hi.y; cy++) {
    for (let cx = lo.x; cx <= hi.x; cx++) {
      const arr = featureSpatial.get(cy * tw + cx)
      if (arr) for (const i of arr) out.push(i)
    }
  }
  return out
}

// getFeaturesByName returns the indices of every feature whose
// (lowercased) name matches.  Backs the hover outline pass + the
// minimap dot loop, which previously walked all features looking
// for matches on every render.
export function getFeaturesByName(name) {
  if (!featureNameIndex || nameIndexVersion !== contentVersion) {
    featureNameIndex = new Map()
    for (let i = 0; i < state.features.length; i++) {
      const n = (state.features[i].name || '').toLowerCase()
      let arr = featureNameIndex.get(n)
      if (!arr) { arr = []; featureNameIndex.set(n, arr) }
      arr.push(i)
    }
    nameIndexVersion = contentVersion
  }
  return featureNameIndex.get(name) || []
}
