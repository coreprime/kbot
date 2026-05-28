// Piece — one node in the 3DO object hierarchy.
//
// A Piece holds:
//   • static data: name, origin offset from parent, child pieces, and
//     "draw groups" (one per texture/colour bucket), each carrying the
//     vertex buffer + element count needed to issue a single drawArrays.
//   • animated state: translation/rotation deltas, visibility, and
//     emitter-point marker.  COB's move-piece / turn-piece / spin-piece
//     / show-piece / hide-piece will mutate these fields directly when
//     the script driver lands; the renderer just reads them each frame.
//
// The piece is renderer-agnostic — it doesn't know about WebGL.  The
// ModelLoader fills in `drawGroups`; the ModelRenderer iterates them
// when traversing the hierarchy.

import { Mat4 } from './mat4.js'

export class Piece {
  constructor({ name, originX = 0, originY = 0, originZ = 0, selectionPrim = -1, isEmitterPoint = false } = {}) {
    this.name = name || ''
    // Static origin from the 3DO header — never mutated.  Animated
    // displacement lives in `move` / `rotate`, which COB scripting will
    // drive separately.
    this.origin = [originX, originY, originZ]
    this.selectionPrim = selectionPrim
    this.isEmitterPoint = isEmitterPoint

    // Animation channels.  Initial state is a no-op transform.
    // move: additive translation on top of origin (move-piece x to y).
    this.move = [0, 0, 0]
    // rotate: Euler angles in radians (turn-piece / spin-piece).
    this.rotate = [0, 0, 0]
    // visible: hide-piece sets this to false; show-piece restores it.
    this.visible = true
    // lodHide: set by the model loader from a name-pattern heuristic
    // (flares, muzzles, exhausts, smoke/aim anchors).  Renderer's
    // distance-LOD reads this flag when an entity drops to mid tier
    // and skips matching pieces' draw groups — cosmetic detail that
    // reads as sub-pixel anyway gets one fewer draw call per piece.
    // Static, shared across clones (set once at load).
    this.lodHide = false
    // userData is a free-form slot for the COB driver to stash speeds,
    // signal masks, etc. without polluting the geometry-only fields.
    this.userData = {}

    // Tree links.
    this.children = []
    this.parent = null

    // Rendering data — populated by ModelLoader during build.
    // drawGroups: [{ vbo, vertexCount, mode, textureName | null, color | null }]
    this.drawGroups = []
    // wireframe: { vbo, vertexCount } | null — packed pos-only buffer
    // of GL_LINES, one segment per source-primitive edge.  Used by
    // the renderer's "Wireframe" mode + "Wireframe overlay" toggle.
    this.wireframe = null

    // World matrix recomputed each frame by the renderer.  Kept as a
    // Float32Array(16) so the renderer can hand it straight to the
    // shader uniform.
    this.worldMatrix = Mat4.identity(Mat4.create())
  }

  addChild(child) {
    child.parent = this
    this.children.push(child)
  }

  // findByName traverses the subtree DFS, returning the first piece whose
  // name matches `target` (case-insensitive).  Useful when COB scripts
  // address pieces by name — we'll look them up via this rather than
  // walking the tree by hand.
  findByName(target) {
    const lower = (target || '').toLowerCase()
    if (this.name.toLowerCase() === lower) return this
    for (const c of this.children) {
      const hit = c.findByName(lower)
      if (hit) return hit
    }
    return null
  }

  // walk yields every piece in DFS order — root first, then children.
  *walk() {
    yield this
    for (const c of this.children) {
      yield* c.walk()
    }
  }

  // cloneForInstance returns a new Piece that mirrors this piece's
  // static shape but carries its own animated state.  GPU-backed
  // immutable data — drawGroups + wireframe + per-texture wireframe
  // variants — is shared by reference so spawning N units doesn't
  // re-upload geometry.  ONLY the per-instance fields (move, rotate,
  // visible, worldMatrix, userData) get fresh copies, so independent
  // CobBindings can write their own pose without colliding on a
  // shared tree.  Used by Model.cloneForInstance — see commentary
  // there for the multi-entity rationale.
  cloneForInstance() {
    const c = new Piece({
      name: this.name,
      originX: this.origin[0],
      originY: this.origin[1],
      originZ: this.origin[2],
      selectionPrim: this.selectionPrim,
      isEmitterPoint: this.isEmitterPoint,
    })
    // Static / immutable buffers — shared by reference.  These outer
    // arrays/objects are never mutated after the loader builds them,
    // so aliasing is safe and saves memory + GPU re-upload.
    c.drawGroups = this.drawGroups
    c.wireframe = this.wireframe
    if (this.wireframeByTex) c.wireframeByTex = this.wireframeByTex
    // lodHide is a load-time classification — propagate to clones so
    // every instance of a unit gets the same flare/muzzle skip set.
    c.lodHide = this.lodHide
    // Recurse on children, preserving parent linkage via addChild.
    for (const ch of this.children) {
      c.addChild(ch.cloneForInstance())
    }
    return c
  }

  // computeWorldMatrix multiplies parentWorld × local(origin + move +
  // rotate) into this.worldMatrix.  Called each frame by the renderer.
  computeWorldMatrix(parentWorld, scratch) {
    Mat4.identity(this.worldMatrix)
    Mat4.translate(this.worldMatrix, this.worldMatrix, this.origin[0] + this.move[0], this.origin[1] + this.move[1], this.origin[2] + this.move[2])
    if (this.rotate[1] !== 0) Mat4.rotateY(this.worldMatrix, this.worldMatrix, this.rotate[1])
    if (this.rotate[0] !== 0) Mat4.rotateX(this.worldMatrix, this.worldMatrix, this.rotate[0])
    if (this.rotate[2] !== 0) Mat4.rotateZ(this.worldMatrix, this.worldMatrix, this.rotate[2])
    if (parentWorld) {
      Mat4.multiply(scratch, parentWorld, this.worldMatrix)
      Mat4.copy(this.worldMatrix, scratch)
    }
  }
}
