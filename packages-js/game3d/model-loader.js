// ModelLoader pulls model geometry from the configured AssetProvider
// (provider.model(name)), walks the JSON tree,
// triangulates each primitive, generates per-vertex UVs (3DO carries
// none — they're derived from primitive vertex order, see format docs),
// computes a face normal so the shader can flat-shade non-textured
// faces, and uploads the result to GPU buffers under each Piece.
//
// Per-vertex layout (9 floats):
//   [ x, y, z, nx, ny, nz, u, v, ao ]
//
// The trailing `ao` is a baked ambient-occlusion factor in [0, 1]:
// 1.0 = unoccluded, lower values darken the ambient term in concave
// regions.  It's computed from the spread of incident face normals at
// the vertex's position — flat plates score 1.0, vertices wedged
// inside a tight crease (many face normals pointing different ways)
// score lower.  See #smoothNormalsAcrossBuckets.
//
// We bake one vertex buffer per (texture | flat colour) bucket inside a
// piece so each draw call binds at most one texture.  This keeps the
// renderer's inner loop simple and gives the GPU a clean batch.

import { Piece } from './piece.js'
import { Model } from './model.js'
import { applyResolvedHints } from './hints-textures.js'
import { enhanceMeshEnabled } from './enhance-mesh.js'
import { requireAssetProvider } from './assets.js'

const FLOATS_PER_VERTEX = 9

// _lodHidePatterns — piece names matching any of these regexes get tagged
// with `lodHide = true` at load time so the renderer's distance-LOD
// (Phase 2) skips them on units rendering at mid tier. The patterns encode
// the game's modelling conventions for sub-pixel cosmetic detail, so the
// list is game configuration: the active game's adapter supplies it via
// setLodHidePatterns() at boot (empty until then — conservative, every
// piece draws at every tier). A future FBI-driven hint can extend or
// override this per-unit.
let _lodHidePatterns = []

// setLodHidePatterns installs the game's cosmetic-piece name heuristics.
export function setLodHidePatterns(patterns) {
  _lodHidePatterns = Array.isArray(patterns) ? patterns.slice() : []
}

export class ModelLoader {
  constructor({ gl, palette, textureCache }) {
    this.gl = gl
    this.palette = palette
    this.textureCache = textureCache
  }

  async load(modelName) {
    const data = await requireAssetProvider().model(modelName, { enhanceMesh: enhanceMeshEnabled() })
    if (!data) throw new Error(`asset provider returned no geometry for model ${modelName}`)
    // decalSet flags textures with alpha-keyed pixels — the loader
    // emits their draw groups AFTER the opaque ones in every piece so
    // the GPU draws coplanar logos/glass/rotors on top of their base
    // surface rather than punching the base out via alpha-test.
    this._decalSet = new Set((data.decals || []).map((n) => n.toLowerCase()))
    // TA:K models carry a per-side texture query ("side=ara") so same-named
    // team/logo textures resolve against the unit's own side GAF. The query
    // is baked into every texture key this load produces.
    this._texQuery = data.textureQuery || ''
    const root = this.#buildPiece(data.root)
    // X-flip the bounds to match the per-piece flip applied above,
    // otherwise camera framing centres on the un-flipped X midpoint.
    const flippedBounds = data.bounds ? {
      min: [-data.bounds.max[0], data.bounds.min[1], data.bounds.min[2]],
      max: [-data.bounds.min[0], data.bounds.max[1], data.bounds.max[2]],
    } : data.bounds
    const model = new Model({ name: data.name, root, bounds: flippedBounds })
    // Phase 2 LOD — tag cosmetic-only pieces so the renderer's mid
    // tier (units small on screen) can skip their draw groups.
    // Heuristic: names match the TA convention for sub-pixel detail
    // (flares, muzzles, exhausts, smoke / aim anchors).  Conservative
    // — anything not on the list still draws at every tier.  A future
    // FBI-driven hint can supersede this and tag additional pieces
    // per-unit-type without changing the renderer.
    for (const p of model.flat) {
      if (_lodHidePatterns.some((re) => re.test(p.name))) {
        p.lodHide = true
      }
    }
    // Sprite detection: a piece whose own geometry is one big quad authored
    // for the game's fixed camera (TA:K lodestones, banner-style props)
    // gets billboarded so it stays readable from any angle in the free
    // camera. Two signatures qualify:
    //   upright — height the dominant extent (a sprite on a stick);
    //   tilted  — the quad's plane leans between flat and vertical (the
    //             lodestone glyph is 54wu wide but only 29 tall, leaned
    //             ~30° toward TA:K's camera, so height-dominance alone
    //             misses it).
    // Flat ground plates (normal straight up), true architecture walls
    // (normal horizontal, not height-dominant), sub-sprite-scale quads and
    // cosmetic anchors all stay put.
    for (const p of model.flat) {
      if (p.lodHide || !p.sourceVertices || p.sourceVertices.length !== 12) continue
      const vs = p.sourceVertices
      const xs = [vs[0], vs[3], vs[6], vs[9]]
      const ys = [vs[1], vs[4], vs[7], vs[10]]
      const zs = [vs[2], vs[5], vs[8], vs[11]]
      const ext = (a) => Math.max(...a) - Math.min(...a)
      const h = ext(ys)
      if (h < 24) continue
      const upright = h >= ext(xs) * 0.8 || h >= ext(zs) * 0.8
      // Quad plane normal from the first two edges; |ny|/|n| is 1 for a
      // flat plate, 0 for a vertical wall, in between for a leaned sprite.
      const e1x = vs[3] - vs[0], e1y = vs[4] - vs[1], e1z = vs[5] - vs[2]
      const e2x = vs[6] - vs[0], e2y = vs[7] - vs[1], e2z = vs[8] - vs[2]
      const ny = e1z * e2x - e1x * e2z
      const nl = Math.hypot(e1y * e2z - e1z * e2y, ny, e1x * e2y - e1y * e2x) || 1
      const tilt = Math.abs(ny) / nl
      if (!upright && !(tilt > 0.25 && tilt < 0.95)) continue
      p.billboard = true
    }
    // Pass through the server's textureSources map (texture name →
    // GAF basename) so the studio's Textures tab can group rows by
    // parent atlas.  Empty when the server didn't resolve a GAF
    // (e.g. a stub texture name the engine would substitute with a
    // fallback) — the client renders those under "(unknown)".
    model.textureSources = data.textureSources || {}
    if (data.textures && data.textures.length) {
      // Fire-and-forget — the renderer is happy to draw fallbacks
      // until the real PNGs land.  ensure() resolves once they have.
      const q = this._texQuery
      this.textureCache.ensure(q ? data.textures.map((n) => `${n}?${q}`) : data.textures)
    }
    return model
  }

  #buildPiece(node) {
    // X-flip: TA's 3DO authoring tooling uses a left-handed
    // coordinate system; OpenGL is right-handed, so without a flip
    // every asymmetric unit ends up mirrored — e.g. ARMBATS'
    // command tower lands on starboard when in-game it's port.
    // Negate X at the piece-origin AND every vertex so the geometry
    // matches what TA itself draws.
    const piece = new Piece({
      name: node.name,
      originX: -node.origin[0],
      originY: node.origin[1],
      originZ: node.origin[2],
      selectionPrim: node.selectionPrim,
      isEmitterPoint: !!node.isEmitterPoint,
    })
    const raw = node.vertices || []
    const verts = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i += 3) {
      verts[i] = -raw[i]
      verts[i + 1] = raw[i + 1]
      verts[i + 2] = raw[i + 2]
    }
    // Keep the raw verts for tiny pieces — the single-quad billboard
    // detector reads them after the tree is built. Capped to one quad's
    // worth so normal meshes don't double their vertex memory.
    if (verts.length <= 12) piece.sourceVertices = verts
    if (node.primitives && node.primitives.length) {
      this.#buildDrawGroups(piece, verts, node.primitives, node.selectionPrim)
    }
    for (const c of node.children || []) {
      piece.addChild(this.#buildPiece(c))
    }
    return piece
  }

  // Decide whether a primitive is one of TA's flat ground plates —
  // the selection footprint and/or the projected drop shadow — which
  // the engine paints onto the terrain rather than drawing as model
  // geometry.  Three signals, any of which qualifies:
  //   1. The object header's OffsetToSelectionPrimitive INDEX names it
  //      directly (the authoritative selection plate).
  //   2. Untextured + palette-0 (TA's transparency / shadow key).
  //   3. Untextured + flat-horizontal quad painted PURE BLACK — a
  //      separate drop-shadow plate some units carry alongside the
  //      selection one (e.g. the ARM Swatter / ARMAH, whose "GP" root
  //      holds a colour-0 selection quad AND a colour-245 black quad).
  // Without skipping all three, the stray plate renders as an opaque
  // square sitting on the ground under the unit.
  #isGroundPlate(prim, verts, primIdx, shadowPlateIdx) {
    if (primIdx === shadowPlateIdx) return true
    if (prim.texture) return false
    if (!prim.isColored) return false
    if (prim.colorIndex === 0) return true
    const indices = prim.indices || []
    if (indices.length < 3) return false
    const y0 = verts[indices[0] * 3 + 1]
    for (let k = 1; k < indices.length; k++) {
      if (Math.abs(verts[indices[k] * 3 + 1] - y0) > 1e-4) return false
    }
    const c = prim.colorRGB
      ? [prim.colorRGB[0] / 255, prim.colorRGB[1] / 255, prim.colorRGB[2] / 255, 1]
      : this.palette.colorFor(prim.colorIndex)
    return c[0] === 0 && c[1] === 0 && c[2] === 0
  }

  #buildDrawGroups(piece, verts, primitives, selectionPrim = -1) {
    const shadowPlateIdx =
      typeof selectionPrim === 'number' && selectionPrim >= 0
        ? selectionPrim
        : -1
    // Bucket primitives by (texture | flat colour) so each becomes one
    // batched draw call.  Keying on lowercased texture name keeps the
    // case-insensitive matching the GAF lookup uses.
    const triBuckets = new Map() // key → { interleaved: number[], texture, color }
    const lineBuckets = new Map()
    const pointBuckets = new Map()
    // Wireframe edge data: one VBO per piece containing line segments
    // for each primitive's outline (the *original* polygon edges, not
    // the triangulated diagonals).  Built in parallel with the
    // triangle buckets so the renderer can swap modes without
    // re-uploading geometry.
    const wireframeVerts = []
    // Per-texture wireframe — keyed by lowercased texture name so
    // the Textures-tab hover-highlight can paint ONLY the edges
    // belonging to primitives that use a given atlas (the combined
    // wireframe above paints every edge in the piece, which makes
    // a one-face logo look like the whole hull is using it).
    // Built alongside the combined wireframe and uploaded in
    // finalizeWireframes() below.
    const wireframeByTex = new Map() // texKey (lower) → number[] (xyz pairs)

    // Coplanar-primitive detection by POSITION (not index) — TA
    // artists sometimes emit a base and a decal on the same face
    // using SEPARATE vertex entries that just happen to share
    // coordinates.  We quantise positions to 1/100 of a world unit
    // and signature each primitive by sorted (x,y,z) triples so
    // those overlapping-but-distinct vertex sets still register as
    // coplanar.  The signature is used downstream to decide whether
    // a lonely decal needs a synthetic dark base (it doesn't if some
    // other primitive sits at the same face already).
    const decals = this._decalSet || new Set()
    const positionSig = (indices) => {
      const triples = []
      for (const i of indices) {
        const x = Math.round((verts[i * 3] || 0) * 100) / 100
        const y = Math.round((verts[i * 3 + 1] || 0) * 100) / 100
        const z = Math.round((verts[i * 3 + 2] || 0) * 100) / 100
        triples.push(`${x},${y},${z}`)
      }
      triples.sort()
      return triples.join('|')
    }
    const faceCount = new Map()
    for (let primIdx = 0; primIdx < primitives.length; primIdx++) {
      const prim = primitives[primIdx]
      if ((prim.indices || []).length < 3) continue
      // Ignore ground / shadow plates — they don't render and
      // shouldn't be considered "a base" for someone else.
      if (this.#isGroundPlate(prim, verts, primIdx, shadowPlateIdx)) continue
      const sig = positionSig(prim.indices)
      faceCount.set(sig, (faceCount.get(sig) || 0) + 1)
    }
    // Faces whose lonely decal needs a synthetic dark backing.
    // Limited to decals on side / down-facing surfaces — UP-facing
    // decals (like aircraft-plant grated platforms) want their
    // alpha-keyed pixels to keep revealing the ground, so we never
    // fill those.
    const lonelyFaces = []
    // depthTierAtSig tracks how many primitives we've already emitted
    // at a given face position.  TA models routinely stack two or
    // three OPAQUE primitives at the same face (panel + chevron
    // overlay + accent) — without a per-tier polygon offset the GPU
    // z-fights between them because triangulation order differs
    // even when the world-space vertices coincide.  Each primitive
    // bumps this counter; the renderer reads back tier > 0 to apply
    // a glPolygonOffset that pulls the layer slightly toward the
    // camera so it wins the depth test cleanly.
    const depthTierAtSig = new Map()

    for (let primIdx = 0; primIdx < primitives.length; primIdx++) {
      const prim = primitives[primIdx]
      const indices = prim.indices || []
      const count = indices.length
      if (count === 0) continue
      // Ground / shadow plates (selection footprint, palette-0 key, or a
      // flat black drop-shadow quad) are projected onto the terrain
      // in-game, never drawn as model geometry — skip them so they don't
      // render as a solid square slab under the unit.
      if (this.#isGroundPlate(prim, verts, primIdx, shadowPlateIdx)) continue
      const plainTex = (prim.texture || '').toLowerCase()
      const texKey = plainTex && this._texQuery ? `${plainTex}?${this._texQuery}` : plainTex
      // Prefer the server-resolved face colour (TA:K side palettes differ
      // per unit); fall back to the global palette for older payloads.
      const color = (!texKey && prim.isColored)
        ? (prim.colorRGB
            ? [prim.colorRGB[0] / 255, prim.colorRGB[1] / 255, prim.colorRGB[2] / 255, 1]
            : this.palette.colorFor(prim.colorIndex))
        : null
      // Look up depth tier for this primitive's face: 0 for the
      // first primitive at this position, 1 for the second, etc.
      // Bucket key gets the tier baked in so primitives at different
      // tiers never get batched together (which would defeat the
      // per-bucket polygon offset).
      let tier = 0
      if (count >= 3) {
        const ps = positionSig(indices)
        tier = depthTierAtSig.get(ps) || 0
        depthTierAtSig.set(ps, tier + 1)
      }
      const baseBucketKey = texKey || (color ? `#${prim.colorIndex}` : '__notex__')
      let bucketKey = tier === 0 ? baseBucketKey : `${baseBucketKey}#t${tier}`
      // FillModel's reconstructed faces (open box bottoms, hollow-shell
      // backsides) routinely land coplanar with original art — e.g. the
      // ARM Swatter's nose cap shares the deck plane with the team-colour
      // top.  They must never win a depth tie against the artist's real
      // face, so keep them in their own bucket and mark it so the renderer
      // can push them away from the camera.
      if (prim.synthetic) bucketKey += '#syn'

      // Lonely-decal check: a decal primitive whose face position
      // doesn't appear in any other (non-shadow) primitive within
      // this piece.  We back it with a synthetic dark base — but
      // only if the face is roughly vertical or downward-facing.
      // Upward-facing decals (baseplates with grate cutouts) need
      // to keep their see-through pixels so the ground shows.
      if (count >= 3 && texKey && decals.has(plainTex)) {
        const sig = positionSig(indices)
        if (faceCount.get(sig) === 1) {
          const positions = []
          for (let i = 0; i < count; i++) {
            const v = indices[i]
            positions.push([
              verts[v * 3] || 0,
              verts[v * 3 + 1] || 0,
              verts[v * 3 + 2] || 0,
            ])
          }
          const n = this.#faceNormal(positions)
          // |n.y| < 0.7 means the face is closer to vertical than to
          // horizontal — those are the panels / side faces that suffer
          // from sky bleed-through.  Horizontal faces (|n.y| ≥ 0.7)
          // are baseplate-style cutouts; leave their alpha alone.
          if (Math.abs(n[1]) < 0.7) {
            lonelyFaces.push(indices.slice())
          }
        }
      }

      if (count === 1) {
        // Emit points — used as smoke/explosion anchors.  Rendered as
        // GL_POINTS so users can see piece anchors in the viewer.
        const bucket = this.#getOrCreate(pointBuckets, bucketKey, prim.texture, color)
        const v = indices[0]
        const x = verts[v * 3] || 0, y = verts[v * 3 + 1] || 0, z = verts[v * 3 + 2] || 0
        bucket.interleaved.push(x, y, z, 0, 1, 0, 0.5, 0.5, 1)
        continue
      }
      if (count === 2) {
        const bucket = this.#getOrCreate(lineBuckets, bucketKey, prim.texture, color)
        for (let i = 0; i < 2; i++) {
          const v = indices[i]
          const x = verts[v * 3] || 0, y = verts[v * 3 + 1] || 0, z = verts[v * 3 + 2] || 0
          bucket.interleaved.push(x, y, z, 0, 1, 0, i, 0, 1)
        }
        continue
      }
      // 3+ vertices — triangulate as a fan rooted at vertex 0.  UVs
      // assume the source polygon was authored as a quad in convex
      // CW order; we lay UVs on a unit square (0,0)-(1,1) and let the
      // first three vertices keep their natural UVs for triangles.
      const uvs = this.#computeUVs(count)
      const positions = []
      for (let i = 0; i < count; i++) {
        const v = indices[i]
        positions.push([
          verts[v * 3] || 0,
          verts[v * 3 + 1] || 0,
          verts[v * 3 + 2] || 0,
        ])
      }
      const normal = this.#faceNormal(positions)
      const bucket = this.#getOrCreate(triBuckets, bucketKey, prim.texture, color)
      // Stash the tier on the bucket so the renderer can apply a
      // depth offset to higher-tier coplanar layers.
      bucket.depthTier = Math.max(bucket.depthTier || 0, tier)
      if (prim.synthetic) bucket.synthetic = true
      // Triangle fan: (0, i, i+1) for i = 1..count-2.  AO seeds at
      // 1.0 (no occlusion); the smoothing pass replaces it with a
      // baked value derived from local face-normal divergence.
      for (let i = 1; i < count - 1; i++) {
        const tri = [0, i, i + 1]
        for (const k of tri) {
          const p = positions[k]
          const uv = uvs[k]
          bucket.interleaved.push(p[0], p[1], p[2], normal[0], normal[1], normal[2], uv[0], uv[1], 1)
        }
        // Also stash the triangle's three vertex positions on the
        // piece for CPU-side surface sampling — e.g. the build-time
        // transporter sparkle effect that needs to emit particles ON
        // the polygons (not in the bounding sphere around them).  The
        // VBO can't be read back cheaply from the GPU, so we keep a
        // parallel CPU copy here.  Memory cost is ~36 bytes per
        // triangle; a 20-piece × 100-tri unit costs ~72 KB which is
        // negligible at studio scale.
        if (!piece._tris) piece._tris = []
        piece._tris.push(
          positions[0][0], positions[0][1], positions[0][2],
          positions[i][0], positions[i][1], positions[i][2],
          positions[i + 1][0], positions[i + 1][1], positions[i + 1][2],
        )
      }
      // Wireframe edges follow the original polygon outline so quads
      // stay quads — the diagonals introduced by triangulation never
      // become visible wireframe lines.  Push to BOTH the combined
      // piece wireframe AND the per-texture bucket so the renderer
      // can paint the whole piece OR just the matching faces.
      // `texKey` (the bucket key) is already declared higher up;
      // this uses the same value as the bucket key for the tris.
      let perTexEdges = null
      if (texKey) {
        perTexEdges = wireframeByTex.get(texKey)
        if (!perTexEdges) { perTexEdges = []; wireframeByTex.set(texKey, perTexEdges) }
      }
      for (let i = 0; i < count; i++) {
        const a = positions[i]
        const b = positions[(i + 1) % count]
        wireframeVerts.push(a[0], a[1], a[2], b[0], b[1], b[2])
        if (perTexEdges) perTexEdges.push(a[0], a[1], a[2], b[0], b[1], b[2])
      }
    }

    // Synthesise a dark backing primitive for each lonely decal.  The
    // base bucket gets a sentinel `__decal_base__` key so it's
    // collected with the opaque pass (drawn first), and uses the same
    // vertices + computed normal as the decal so the geometry lines
    // up at the identical depth value.  When the decal draws on top
    // with LEQUAL depth + alpha discards, the discarded pixels reveal
    // the dark base instead of the sky.
    for (const lonely of lonelyFaces) {
      const count = lonely.length
      const uvs = this.#computeUVs(count)
      const positions = []
      for (let i = 0; i < count; i++) {
        const v = lonely[i]
        positions.push([
          verts[v * 3] || 0,
          verts[v * 3 + 1] || 0,
          verts[v * 3 + 2] || 0,
        ])
      }
      const normal = this.#faceNormal(positions)
      const bucket = this.#getOrCreateColored(triBuckets, '__decal_base__', [0.06, 0.07, 0.09, 1])
      for (let i = 1; i < count - 1; i++) {
        const tri = [0, i, i + 1]
        for (const k of tri) {
          const p = positions[k]
          const uv = uvs[k]
          bucket.interleaved.push(p[0], p[1], p[2], normal[0], normal[1], normal[2], uv[0], uv[1], 1)
        }
      }
    }

    // Smooth normals across shared vertex positions where adjacent
    // faces aren't too sharp.  3DO only carries per-face normals
    // (the loader computes them above) so the unit reads as a
    // chunky faceted block; this averaging pass softens the
    // panels back into curved-feeling surfaces while keeping
    // genuine hard corners (dot < 0.7 between face normals) sharp.
    this.#smoothNormalsAcrossBuckets(triBuckets)

    const gl = this.gl
    const finalize = (map, mode) => {
      // Partition into opaque-first / decal-last so draw order
      // matches TA's convention: base texture, then any alpha-keyed
      // overlays.  Within the opaque list we also sort by depthTier
      // so coplanar layers (panel → chevron → accent) march from
      // base toward camera in a stable order — the renderer applies
      // a polygon offset proportional to the tier so the layers
      // don't z-fight.
      const opaque = []
      const decal = []
      for (const bucket of map.values()) {
        // Material-hint fields (specular / running-lights / bump) are
        // copied on by applyResolvedHints below — the single shared mapper
        // also used by the renderer's live re-apply, so the two never drift.
        const group = {
          vbo: null,
          mode,
          vertexCount: 0,
          textureName: bucket.texture || null,
          color: bucket.color,
          isDecal: !!(bucket.texture && decals.has(bucket.texture.toLowerCase())),
          depthTier: bucket.depthTier || 0,
          synthetic: !!bucket.synthetic,
        }
        applyResolvedHints(group, bucket.texture)
        const arr = new Float32Array(bucket.interleaved)
        group.vbo = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, group.vbo)
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW)
        group.vertexCount = arr.length / FLOATS_PER_VERTEX
        if (group.isDecal) decal.push(group)
        else opaque.push(group)
      }
      opaque.sort((a, b) => a.depthTier - b.depthTier)
      for (const g of opaque) piece.drawGroups.push(g)
      for (const g of decal) piece.drawGroups.push(g)
    }
    finalize(triBuckets, gl.TRIANGLES)
    finalize(lineBuckets, gl.LINES)
    finalize(pointBuckets, gl.POINTS)

    // Upload the wireframe edge buffer if any primitives contributed.
    if (wireframeVerts.length) {
      const arr = new Float32Array(wireframeVerts)
      const vbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW)
      piece.wireframe = { vbo, vertexCount: arr.length / 3 }
    }
    // Per-texture wireframe — one buffer per atlas referenced on this
    // piece.  Texture-hover in the Textures tab draws only these
    // buffers for the hovered atlas so a single-face logo doesn't
    // light up the whole hull.  Stored as a Map (lower-cased
    // texture name → {vbo, vertexCount}).
    if (wireframeByTex.size) {
      piece.wireframeByTex = new Map()
      for (const [texKey, verts2] of wireframeByTex) {
        if (!verts2.length) continue
        const arr2 = new Float32Array(verts2)
        const vbo2 = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo2)
        gl.bufferData(gl.ARRAY_BUFFER, arr2, gl.STATIC_DRAW)
        piece.wireframeByTex.set(texKey, { vbo: vbo2, vertexCount: arr2.length / 3 })
      }
    }
  }

  #getOrCreateColored(map, key, color) {
    let bucket = map.get(key)
    if (!bucket) {
      bucket = { interleaved: [], texture: '', color }
      map.set(key, bucket)
    }
    return bucket
  }

  #getOrCreate(map, key, texture, color) {
    let bucket = map.get(key)
    if (!bucket) {
      bucket = { interleaved: [], texture: texture || '', color }
      map.set(key, bucket)
    }
    return bucket
  }

  // computeUVs lays unit-square UVs over the polygon vertices in source
  // order.  Quads cover (0,0) → (1,1); triangles get the top-left half;
  // higher-order polygons (rare in TA models) get a polar UV around the
  // primitive's centroid so the texture at least appears smooth.
  #computeUVs(count) {
    if (count === 3) return [[0, 1], [1, 1], [1, 0]]
    if (count === 4) return [[0, 1], [1, 1], [1, 0], [0, 0]]
    const out = []
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      out.push([0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)])
    }
    return out
  }

  // faceNormal returns the unit normal of the polygon defined by the
  // first three vertices.  TA primitives can be CW or CCW depending on
  // the artist's tooling; the renderer disables face culling and uses
  // |dot(N, L)| for lighting, so the sign doesn't matter — only the
  // axis.
  #faceNormal(positions) {
    const [a, b, c] = positions
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2]
    const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) { nx /= len; ny /= len; nz /= len }
    else { nx = 0; ny = 1; nz = 0 }
    return [nx, ny, nz]
  }

  // smoothNormalsAcrossBuckets averages each vertex's normal with the
  // normals of every face that touches the same world-space position,
  // provided the face normals are within ~45° of each other.  Faces
  // sharing an edge that bends sharper than that (e.g. a panel meeting
  // a hard corner) keep their original face normal so the silhouette
  // and the hard creases stay crisp.  We quantise position to 1/100 wu
  // so floating-point jitter between primitives doesn't break the
  // shared-vertex grouping.
  //
  // The pass also bakes a per-vertex AO factor into the 9th float of
  // every triangle vertex.  AO = |Σ face_normals| / count over all
  // incident faces — a flat plate scores 1.0 (all normals aligned)
  // while a tight crease scores lower (incident normals cancel out).
  // The fragment shader multiplies the ambient term by this AO so
  // crevices darken without paying for a screen-space pass.
  #smoothNormalsAcrossBuckets(buckets) {
    if (!buckets.size) return
    const COS_THRESHOLD = 0.7 // ≈ 45° between adjacent face normals
    // Pass 1: gather all face normals incident on each unique position.
    const incident = new Map()
    for (const bucket of buckets.values()) {
      const arr = bucket.interleaved
      for (let i = 0; i < arr.length; i += FLOATS_PER_VERTEX) {
        const kx = Math.round(arr[i] * 100) / 100
        const ky = Math.round(arr[i + 1] * 100) / 100
        const kz = Math.round(arr[i + 2] * 100) / 100
        const key = `${kx},${ky},${kz}`
        let entry = incident.get(key)
        if (!entry) { entry = []; incident.set(key, entry) }
        entry.push(arr[i + 3], arr[i + 4], arr[i + 5])
      }
    }
    // Pre-compute per-position AO once so we don't re-scan the
    // incident list inside the per-vertex loop.  Map a position key
    // to the normalised divergence factor — close to 1 for flat
    // regions, closer to 0 for crevices.
    const aoByPos = new Map()
    for (const [key, list] of incident) {
      const n = list.length / 3
      let sx = 0, sy = 0, sz = 0
      for (let j = 0; j < list.length; j += 3) {
        sx += list[j]; sy += list[j + 1]; sz += list[j + 2]
      }
      const mag = Math.hypot(sx, sy, sz)
      // Bias so single-face vertices stay at 1.0 and only true
      // crevices (mag/n significantly less than 1) get darkened.
      // Lift the floor to 0.55 — full black ambient looks like a
      // missing texture, not a soft AO.
      const raw = n > 0 ? mag / n : 1
      const ao = 0.55 + 0.45 * raw
      aoByPos.set(key, Math.min(1, ao))
    }
    // Pass 2: rewrite each vertex's normal to the unit average of all
    // incident face normals whose dot with the current vertex normal
    // exceeds the threshold.  When the seed normal is the only one
    // aligned (hard edge), the result equals the original.
    for (const bucket of buckets.values()) {
      const arr = bucket.interleaved
      for (let i = 0; i < arr.length; i += FLOATS_PER_VERTEX) {
        const kx = Math.round(arr[i] * 100) / 100
        const ky = Math.round(arr[i + 1] * 100) / 100
        const kz = Math.round(arr[i + 2] * 100) / 100
        const key = `${kx},${ky},${kz}`
        const list = incident.get(key)
        if (!list) continue
        const nx = arr[i + 3], ny = arr[i + 4], nz = arr[i + 5]
        let sx = 0, sy = 0, sz = 0
        for (let j = 0; j < list.length; j += 3) {
          const mx = list[j], my = list[j + 1], mz = list[j + 2]
          if (nx * mx + ny * my + nz * mz >= COS_THRESHOLD) {
            sx += mx; sy += my; sz += mz
          }
        }
        const len = Math.hypot(sx, sy, sz)
        if (len > 1e-6) {
          arr[i + 3] = sx / len
          arr[i + 4] = sy / len
          arr[i + 5] = sz / len
        }
        const ao = aoByPos.get(key)
        if (ao !== undefined) arr[i + 8] = ao
      }
    }
  }
}
