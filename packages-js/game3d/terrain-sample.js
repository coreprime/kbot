// terrain-sample.js — CPU-side sampling of a battlefield height field.
//
// The renderer bakes a map's heights into a triangle mesh (see
// ModelRenderer.setMapTerrain); anything that wants to SIT on that mesh —
// grounded units, wreckage, selection rings, camera ground-picks — needs the
// same surface answered as a function.  createTerrainSampler wraps the raw
// pack height bytes in exactly the mesh's geometry:
//
//   * vertices at (cx*cellWU, heights[cz*w+cx]*heightScale, cz*cellWU),
//   * each cell quad split into the (00,10,11) / (00,11,01) triangle pair,
//
// so heightAt(x, z) returns the exact Y a full-resolution mesh renders at
// that point (large maps decimate their DRAWN mesh past ~90k quads; the
// sampler always answers at source resolution, which bounds the divergence
// to well under a height step).
//
// Why this matters for replays: recorded wire positions carry Y in TA world
// units, where the terrain surface sits at rawHeightByte × 1.0 wu.  The
// renderer deliberately flattens relief to heightScale (0.61) × rawHeight —
// a display-only choice — so a wire Y fed straight to the renderer floats
// units 0.39 × height above the drawn ground.  Clamping render Y through
// heightAt (the applyState `grounded` flag) pins units to the surface
// regardless of that scale; a driver placing airborne things converts
// altitude with the same heightScale instead.
//
// Pure module: no GL, no DOM — runs under plain Node for tests.

/**
 * @param {Object} t
 * @param {ArrayLike<number>} t.heights  Row-major raw height values (w×h).
 * @param {number} t.w  Heightmap width in cells.
 * @param {number} t.h  Heightmap height in cells.
 * @param {number} [t.cellWU=16]  World units per heightmap cell.
 * @param {number} [t.heightScale=1]  World-Y per raw height unit.
 * @param {number} [t.originX=0]  World X of cell (0, 0).
 * @param {number} [t.originZ=0]  World Z of cell (0, 0).
 * @returns {{
 *   heightAt: (x: number, z: number) => number,
 *   normalAt: (x: number, z: number) => [number, number, number],
 *   rawHeightAt: (x: number, z: number) => number,
 * }}
 */
export function createTerrainSampler({ heights, w, h, cellWU = 16, heightScale = 1, originX = 0, originZ = 0 }) {
  if (!heights || !(w > 0) || !(h > 0)) {
    const flat = () => 0
    return { heightAt: flat, rawHeightAt: flat, normalAt: () => [0, 1, 0] }
  }

  // Vertex height in RAW units, clamped to the grid (matches the mesh's
  // edge-snap: the final column/row reuses the last height sample).
  const raw = (cx, cz) => {
    if (cx < 0) cx = 0; else if (cx > w - 1) cx = w - 1
    if (cz < 0) cz = 0; else if (cz > h - 1) cz = h - 1
    return heights[cz * w + cx]
  }

  const rawHeightAt = (x, z) => {
    // Continuous position in cell space.
    let fx = (x - originX) / cellWU
    let fz = (z - originZ) / cellWU
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1
    if (fz < 0) fz = 0; else if (fz > h - 1) fz = h - 1
    const cx = Math.min(w - 2, Math.floor(fx))
    const cz = Math.min(h - 2, Math.floor(fz))
    const u = fx - cx
    const v = fz - cz
    const y00 = raw(cx, cz)
    const y10 = raw(cx + 1, cz)
    const y01 = raw(cx, cz + 1)
    const y11 = raw(cx + 1, cz + 1)
    // The mesh splits each quad along the (00 → 11) diagonal:
    //   u ≥ v  → triangle (00, 10, 11)
    //   u <  v → triangle (00, 11, 01)
    if (u >= v) return y00 + (y10 - y00) * u + (y11 - y10) * v
    return y00 + (y11 - y01) * u + (y01 - y00) * v
  }

  const heightAt = (x, z) => rawHeightAt(x, z) * heightScale

  // normalAt derives a SMOOTHED surface normal by central differences over
  // ~one cell — the right roughness for unit tilt (a tank spans several
  // texels; snapping to per-triangle facets reads as jitter while driving).
  const normalAt = (x, z) => {
    const d = cellWU * 0.75
    const dyDx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d)
    const dyDz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d)
    const inv = 1 / Math.hypot(dyDx, 1, dyDz)
    return [-dyDx * inv, inv, -dyDz * inv]
  }

  return { heightAt, rawHeightAt, normalAt }
}
