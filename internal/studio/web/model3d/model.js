// Model wraps the root Piece plus the flat list of every piece in the
// hierarchy.  The renderer iterates over `flat` for draw calls; COB and
// UI code (piece tree sidebar) walks the tree starting from `root`.
//
// Bounds are pre-computed by the server in world space so the camera
// framing code doesn't have to walk the whole hierarchy on every load.

export class Model {
  constructor({ name, root, bounds }) {
    this.name = name
    this.root = root
    this.bounds = bounds || { min: [0, 0, 0], max: [0, 0, 0] }
    // boundsRadius — conservative bounding-sphere radius in object
    // space, computed once at load.  Half-diagonal of the AABB; over-
    // approximates a true minimal sphere but never under-approximates,
    // so the frustum culler's per-frame sphere-vs-plane test stays
    // safe (a false-positive "in frustum" is fine; a false-negative
    // would pop the unit visibly out of view).  Reused by the LOD
    // tier classifier (Phase 2) for projected-pixel size.
    const dx = this.bounds.max[0] - this.bounds.min[0]
    const dy = this.bounds.max[1] - this.bounds.min[1]
    const dz = this.bounds.max[2] - this.bounds.min[2]
    this.boundsRadius = 0.5 * Math.hypot(dx, dy, dz)
    // boundsCentre — object-space midpoint of the AABB.  Caching here
    // avoids three adds + three multiplies per entity per frame in
    // the cull / LOD math.
    this.boundsCentre = [
      0.5 * (this.bounds.min[0] + this.bounds.max[0]),
      0.5 * (this.bounds.min[1] + this.bounds.max[1]),
      0.5 * (this.bounds.min[2] + this.bounds.max[2]),
    ]
    this.flat = []
    if (root) {
      for (const p of root.walk()) this.flat.push(p)
    }
  }

  // findPiece returns the piece with a matching name (case-insensitive),
  // or null.  Surfaces COB-style lookups: `find-piece "turret"` →
  // model.findPiece('turret').
  findPiece(name) {
    return this.root ? this.root.findByName(name) : null
  }

  // cloneForInstance returns a new Model wrapping a freshly-cloned
  // piece tree (every Piece duplicated via Piece.cloneForInstance) so
  // the caller can spawn N unit instances of the same type without
  // them stomping each other's animated pose.  All GPU-backed
  // immutable buffers (drawGroups + wireframe) stay shared by
  // reference; the clone is marked isInstance so dispose() skips GPU
  // teardown (releasing those shared VBOs would invalidate the source
  // model's draws).  Bounds are shared by reference — they're a plain
  // {min, max} that the renderer + camera read but never mutate.
  cloneForInstance() {
    const cloneRoot = this.root ? this.root.cloneForInstance() : null
    const m = new Model({ name: this.name, root: cloneRoot, bounds: this.bounds })
    m.isInstance = true
    // The constructor already recomputed boundsRadius + boundsCentre
    // from the same `bounds` reference, so the clone shares the
    // canonical values without extra work.
    return m
  }

  // dispose releases every piece's GPU buffers — must be called when the
  // host closes so the WebGL context can be reused for the next model
  // without leaks.
  dispose(gl) {
    // Instance clones share the source model's VBOs — deleting them
    // here would break every other live unit sharing the geometry.
    // Only the canonical loader-cached model owns the buffers.
    if (this.isInstance) return
    for (const p of this.flat) {
      for (const g of p.drawGroups) {
        if (g.vbo) gl.deleteBuffer(g.vbo)
      }
      p.drawGroups = []
      if (p.wireframe?.vbo) {
        gl.deleteBuffer(p.wireframe.vbo)
        p.wireframe = null
      }
      if (p.wireframeByTex) {
        for (const w of p.wireframeByTex.values()) {
          if (w.vbo) gl.deleteBuffer(w.vbo)
        }
        p.wireframeByTex = null
      }
    }
  }
}
