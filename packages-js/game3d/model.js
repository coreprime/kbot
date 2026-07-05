// Model wraps the root Piece plus the flat list of every piece in the
// hierarchy.  The renderer iterates over `flat` for draw calls; COB and
// UI code (piece tree sidebar) walks the tree starting from `root`.
//
// Bounds are pre-computed by the server in world space so the camera
// framing code doesn't have to walk the whole hierarchy on every load.

import { Mat4 } from './mat4.js'

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

  // resolvePieceWorld returns the WORLD position [x, y, z] of `piece`
  // when this model is placed at (x, y, z) world units with body yaw
  // `headingRad` (and optional pitch / roll / uniform scale).  It walks
  // the whole tree recomputing every piece's worldMatrix against a root
  // of translate(x,y,z) · rotateY(heading) · rotateX(pitch) ·
  // rotateZ(roll) · scale — exactly the chain the renderer builds for an
  // entity — but does so headlessly (no GL context).
  //
  // Why this is needed: the sim engine animates a per-instance model
  // CLONE that it never draws itself (in the sandbox each pane's
  // renderer draws its own pose-copy; the engine's clone is the
  // animation source).  Nothing ever calls computeWorldMatrix on that
  // clone, so its pieces keep the identity worldMatrix they were built
  // with — which would anchor muzzle-exit positions at the world origin
  // instead of tracking the unit wherever it has moved.  Recomputing
  // here against the unit's live transform makes a fired projectile
  // emit from the firing piece at the unit's current location.
  //
  // Returns null when there's no root or the piece carries no matrix.
  resolvePieceWorld(piece, x, y, z, headingRad, pitchRad = 0, rollRad = 0, scale = 1) {
    const wm = this.#resolvePieceMatrix(piece, x, y, z, headingRad, pitchRad, rollRad, scale)
    if (!wm) return null
    return [wm[12], wm[13], wm[14]]
  }

  // resolvePieceWorldPose returns the piece's WORLD position AND its world Y
  // yaw (heading), through the same transform chain as resolvePieceWorld.  The
  // yaw carries the piece's LIVE COB rotation (e.g. a factory `pad` piece the
  // engine's StartBuilding spins about Y) composed with the entity heading —
  // exactly what a nascent unit seated on that pad must inherit so it turns
  // WITH the pad instead of sitting at a frozen heading.  yaw follows the
  // renderer's convention (heading 0 faces -Z; increasing yaw turns toward +X).
  // Returns null when the piece can't be resolved.
  resolvePieceWorldPose(piece, x, y, z, headingRad, pitchRad = 0, rollRad = 0, scale = 1) {
    const wm = this.#resolvePieceMatrix(piece, x, y, z, headingRad, pitchRad, rollRad, scale)
    if (!wm) return null
    // Y yaw from the upper-left basis of a column-major matrix: a rotateY(θ)
    // leaves m[0]=cosθ, m[2]=-sinθ, so θ = atan2(-m[2], m[0]).
    const yaw = Math.atan2(-wm[2], wm[0])
    return { pos: [wm[12], wm[13], wm[14]], yaw }
  }

  // #resolvePieceMatrix walks the tree against the entity's live transform and
  // returns the target piece's world matrix (or null).  Shared by
  // resolvePieceWorld / resolvePieceWorldPose.
  #resolvePieceMatrix(piece, x, y, z, headingRad, pitchRad = 0, rollRad = 0, scale = 1) {
    if (!piece || !this.root) return null
    const root = Mat4.identity(Mat4.create())
    Mat4.translate(root, root, x || 0, y || 0, z || 0)
    if (headingRad) Mat4.rotateY(root, root, headingRad)
    if (pitchRad) Mat4.rotateX(root, root, pitchRad)
    if (rollRad) Mat4.rotateZ(root, root, rollRad)
    if (scale != null && scale !== 1 && scale > 0) Mat4.scale(root, root, scale)
    const scratch = Mat4.create()
    const walk = (p, parent) => {
      p.computeWorldMatrix(parent, scratch)
      for (const c of p.children) walk(c, p.worldMatrix)
    }
    walk(this.root, root)
    return piece.worldMatrix || null
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
    // Draw-group geometry lives in ONE shared VBO per model; delete it
    // once (per-group vbo fields all alias it).
    if (this.sharedVbo) {
      gl.deleteBuffer(this.sharedVbo)
      this.sharedVbo = null
    }
    for (const p of this.flat) {
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
