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

  // dispose releases every piece's GPU buffers — must be called when the
  // user closes the viewer so the WebGL context can be reused for the
  // next model without leaks.
  dispose(gl) {
    for (const p of this.flat) {
      for (const g of p.drawGroups) {
        if (g.vbo) gl.deleteBuffer(g.vbo)
      }
      p.drawGroups = []
      if (p.wireframe?.vbo) {
        gl.deleteBuffer(p.wireframe.vbo)
        p.wireframe = null
      }
    }
  }
}
