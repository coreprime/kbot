// debris-fragments.js — break a dying model into recognizable UNIT PIECES.
//
// TA authors a unit from a COB piece tree: hull, turret, barrel, legs, cab,
// etc.  A death should throw THOSE — you want to see the tank's turret and
// hull cartwheel away, not a puff of triangles.  So this module chunks the
// model along its OWN piece boundaries: every COB piece with geometry becomes
// one flying debris chunk carrying its real geometry + texture.  Units with
// very few pieces (a one-body tank) would throw too few chunks to read as an
// explosion, so the LARGEST chunks are split into 2–3 sub-chunks along their
// long axis — still chunky recognizable parts, never dust.
//
// The target is moderate and piece-count-driven (~4–16 typical), a world
// apart from the old fine k-means shatter (up to 64 tiny shards that read as
// abstract confetti).
//
// The heavy geometry work is pure + deterministic (seeded rng, no GL): it
// returns interleaved chunk floats + per-chunk descriptors, which the GL
// caller uploads into one chunk VBO and wraps in a lightweight synthetic
// model whose `flat` list is the chunks.  world-fx's debrisBurst then flies
// that `flat` list exactly like a real piece tree — a chunk carries the same
// move/rotate channels a Piece does, plus a `centroid` the burst uses to bias
// each chunk OUTWARD from the model centre (radial explosion), and now
// inherits the unit's velocity at death (momentum).

// Interleaved model vertex layout (must match model-loader FLOATS_PER_VERTEX
// and the renderer's VERTEX_STRIDE): pos(3), normal(3), uv(2), ao(1).
const FLOATS_PER_VERTEX = 9

// Chunk-count tuning.  A death should throw enough recognizable parts to read
// as an explosion, but stay a moderate, piece-driven count — NOT the old
// 64-shard dust cloud.  The floor guarantees even a one-piece tank sheds
// several chunks (its body split into sub-chunks); the ceiling bounds a mass
// death's per-frame budget.
export const FRAG_MIN = 4            // even a one-piece unit throws a few chunks
export const FRAG_MAX = 16           // moderate ceiling — chunky, not confetti
export const FRAG_PER_RADIUS = 0.32  // chunks per world-unit of bounding radius
// Severity 100 (commander / self-destruct — the hero blast) gets the full
// budget; a light corpse-leaving kill sheds a thinner shower.
export const FRAG_SEVERITY_FLOOR = 0.55

// targetFragmentCount picks how many chunks a model of `radius` world units
// should break into at `severity` (0..100).  Deterministic, no rng.  Moderate
// and piece-driven — the caller also never exceeds the model's own piece count
// past what sub-splitting fills in.
export function targetFragmentCount(radius, severity = 100) {
  const r = Math.max(1, +radius || 1)
  const sev = Math.max(0, Math.min(100, +severity || 0))
  const sevScale = FRAG_SEVERITY_FLOOR + (1 - FRAG_SEVERITY_FLOOR) * (sev / 100)
  const raw = Math.round(FRAG_MIN + r * FRAG_PER_RADIUS * sevScale)
  return Math.max(FRAG_MIN, Math.min(FRAG_MAX, raw))
}

// _accumulatedOrigin walks a piece's static origins up its parent chain to the
// root — the piece's rest offset within the MODEL frame.  Chunk geometry lives
// in the piece's own local frame (model-loader stores per-piece verts), so the
// accumulated origin is what places the turret above the hull, the barrel out
// front, etc.  Returns [x,y,z].
function _accumulatedOrigin(piece) {
  let x = 0, y = 0, z = 0
  let p = piece
  // Guard against cycles (shouldn't happen in a tree) with a bounded walk.
  for (let guard = 0; p && guard < 256; guard++) {
    const o = p.origin || [0, 0, 0]
    x += o[0]; y += o[1]; z += o[2]
    p = p.parent
  }
  return [x, y, z]
}

// _pieceChunks collects one raw chunk per COB piece that carries triangle
// geometry.  A chunk is { tris:[{verts,centroid,group}], offset:[x,y,z] }
// where `offset` is the piece's accumulated model-space origin and each
// triangle's verts stay in the piece-local frame (recentred later).  Pieces
// without retained triangle groups (lines/points, headless stubs) contribute
// nothing.
function _pieceChunks(model) {
  const chunks = []
  if (!model || !Array.isArray(model.flat)) return chunks
  for (const piece of model.flat) {
    if (!piece || !Array.isArray(piece.drawGroups)) continue
    const tris = []
    for (const group of piece.drawGroups) {
      const f = group.tris
      if (!f || !f.length) continue
      for (let o = 0; o + FLOATS_PER_VERTEX * 3 <= f.length; o += FLOATS_PER_VERTEX * 3) {
        tris.push({ verts: f.subarray(o, o + FLOATS_PER_VERTEX * 3), centroid: _triCentroid(f, o), group })
      }
    }
    if (tris.length) chunks.push({ tris, offset: _accumulatedOrigin(piece) })
  }
  return chunks
}

// collectTriangles — legacy accessor kept for the tests / callers that want a
// flat triangle list.  Returns every geometry triangle across all pieces,
// each { verts, centroid, group }, positions in the piece-local frame.
export function collectTriangles(model) {
  const out = []
  for (const chunk of _pieceChunks(model)) {
    for (const t of chunk.tris) out.push(t)
  }
  return out
}

// _triCentroid returns the centroid [x,y,z] of triangle t (3 verts of
// FLOATS_PER_VERTEX floats each) inside interleaved buffer `f` at float
// offset `o`.
function _triCentroid(f, o) {
  const a = o, b = o + FLOATS_PER_VERTEX, c = o + FLOATS_PER_VERTEX * 2
  return [
    (f[a] + f[b] + f[c]) / 3,
    (f[a + 1] + f[b + 1] + f[c + 1]) / 3,
    (f[a + 2] + f[b + 2] + f[c + 2]) / 3,
  ]
}

// _chunkExtent returns the bounding half-extent [ex,ey,ez] and centre of a
// chunk's triangles in the piece-local frame — used to pick the split axis
// and rank chunks by size.
function _chunkBounds(tris) {
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  for (const t of tris) {
    const c = t.centroid
    for (let k = 0; k < 3; k++) {
      if (c[k] < mn[k]) mn[k] = c[k]
      if (c[k] > mx[k]) mx[k] = c[k]
    }
  }
  return { mn, mx, size: Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) }
}

// _splitChunk cuts a chunk's triangles into `parts` sub-chunks along its
// longest axis (a chunky split — halves/thirds of a hull, not dust).  Each
// sub-chunk inherits the parent's model-space offset.  Deterministic.
function _splitChunk(chunk, parts) {
  const b = _chunkBounds(chunk.tris)
  // Longest local axis.
  const ext = [b.mx[0] - b.mn[0], b.mx[1] - b.mn[1], b.mx[2] - b.mn[2]]
  let axis = 0
  if (ext[1] > ext[axis]) axis = 1
  if (ext[2] > ext[axis]) axis = 2
  const lo = b.mn[axis], hi = b.mx[axis]
  const span = hi - lo || 1
  const buckets = Array.from({ length: parts }, () => [])
  for (const t of chunk.tris) {
    let idx = Math.floor(((t.centroid[axis] - lo) / span) * parts)
    if (idx < 0) idx = 0
    if (idx >= parts) idx = parts - 1
    buckets[idx].push(t)
  }
  return buckets.filter((tr) => tr.length).map((tr) => ({ tris: tr, offset: chunk.offset }))
}

// _growToCount splits the largest chunks until there are at least `target`
// chunks (or every chunk is a single triangle).  Each pass splits the biggest
// remaining chunk in two/three — so a one-body tank becomes several chunky
// halves, a multi-piece kbot mostly keeps its native pieces.  Deterministic.
function _growToCount(chunks, target) {
  const out = chunks.slice()
  // Bounded: each pass adds ≥1 chunk, and we never split a single triangle.
  let guard = 0
  while (out.length < target && guard++ < 128) {
    // Pick the largest splittable chunk.
    let bi = -1, bestSize = -1
    for (let i = 0; i < out.length; i++) {
      if (out[i].tris.length < 2) continue
      const s = _chunkBounds(out[i].tris).size
      if (s > bestSize) { bestSize = s; bi = i }
    }
    if (bi < 0) break
    const need = target - out.length
    const parts = need >= 2 && out[bi].tris.length >= 3 ? 3 : 2
    const sub = _splitChunk(out[bi], parts)
    if (sub.length < 2) break // couldn't actually split — stop
    out.splice(bi, 1, ...sub)
  }
  return out
}

// _capToCount merges the smallest chunks into their neighbours until there are
// at most `cap` — a huge multi-piece unit (dozens of COB pieces) shouldn't
// blow the moderate budget.  Merges by appending the smallest chunk's tris to
// the next-smallest so the result stays a whole part.  Deterministic.
function _capToCount(chunks, cap) {
  const out = chunks.slice()
  let guard = 0
  while (out.length > cap && guard++ < 512) {
    // Merge the two smallest chunks.
    out.sort((a, b) => _chunkBounds(a.tris).size - _chunkBounds(b.tris).size)
    const a = out.shift()
    const b = out.shift()
    out.push({ tris: a.tris.concat(b.tris), offset: b.offset })
  }
  return out
}

// _chunkFragment turns one chunk into a fragment descriptor: its triangles
// recentred about the chunk centroid (model-space centroid = mean triangle
// centroid + the piece offset), plus per-material sub-groups so a multi-texture
// piece still draws all its faces.  Appends verts to `floats`; returns the
// fragment or null when empty.
function _chunkFragment(chunk, floats) {
  const tris = chunk.tris
  if (!tris.length) return null
  // Model-space centroid: local mean + the piece's accumulated origin.
  let lx = 0, ly = 0, lz = 0
  for (const t of tris) { lx += t.centroid[0]; ly += t.centroid[1]; lz += t.centroid[2] }
  lx /= tris.length; ly /= tris.length; lz /= tris.length
  const cx = lx + chunk.offset[0], cy = ly + chunk.offset[1], cz = lz + chunk.offset[2]
  // Group this chunk's triangles by draw material so a multi-texture piece
  // renders every face (one sub-group per group), all sharing the chunk VBO.
  const byGroup = new Map()
  for (const t of tris) {
    let arr = byGroup.get(t.group)
    if (!arr) { arr = []; byGroup.set(t.group, arr) }
    arr.push(t)
  }
  const subGroups = []
  for (const [g, arr] of byGroup) {
    const first = (floats.length / FLOATS_PER_VERTEX) | 0
    for (const t of arr) {
      const v = t.verts
      for (let k = 0; k < 3; k++) {
        const o = k * FLOATS_PER_VERTEX
        // pos recentred to the chunk pivot (local vert - local mean); normal/
        // uv/ao copied verbatim so the chunk keeps its texture + shading.
        floats.push(v[o] - lx, v[o + 1] - ly, v[o + 2] - lz)
        floats.push(v[o + 3], v[o + 4], v[o + 5])
        floats.push(v[o + 6], v[o + 7])
        floats.push(v[o + 8])
      }
    }
    subGroups.push({
      first,
      vertexCount: arr.length * 3,
      textureName: g.textureName || null,
      color: g.color || null,
      depthTier: g.depthTier || 0,
      isDecal: !!g.isDecal,
      synthetic: !!g.synthetic,
      specScale: g.specScale,
      runningLights: g.runningLights,
      bump: g.bump,
    })
  }
  // The fragment's headline material is its first (largest-appended) group.
  const head = subGroups[0]
  return {
    first: head.first,
    vertexCount: subGroups.reduce((n, sg) => n + sg.vertexCount, 0),
    centroid: [cx, cy, cz],
    groups: subGroups,
    // Back-compat single-material fields (callers/tests that read a flat
    // fragment): mirror the headline group.
    textureName: head.textureName,
    color: head.color,
    depthTier: head.depthTier,
    isDecal: head.isDecal,
    synthetic: head.synthetic,
    specScale: head.specScale,
    runningLights: head.runningLights,
    bump: head.bump,
  }
}

// fragmentGeometry breaks `model` into up to `count` recognizable piece chunks.
// Pure + deterministic (all randomness from `rng`), no GL: it returns the data
// a GL caller uploads into one chunk VBO plus one flying record per chunk.
//
//   {
//     floats: Float32Array,   // all chunks' interleaved verts, concatenated
//     fragments: [{
//       first, vertexCount,   //   this chunk's slice in `floats` (headline)
//       centroid:[x,y,z],     //   chunk centre in MODEL space (its pivot AND
//                             //   the outward-burst direction seed)
//       groups:[{first,vertexCount,textureName,color,...}],  // per-material
//       textureName, color, depthTier, isDecal, synthetic, ...  // headline
//     }],
//     bounds: {min,max},      // object-space AABB (culling + framing)
//   }
//
// Chunk verts are recentred so each chunk's centroid sits at the origin — the
// renderer spins the chunk about its own centre (fragment origin = centroid) so
// it TUMBLES IN PLACE.  `rng` is accepted for signature/determinism parity with
// the old shatter but the piece-chunking itself is deterministic without it.
// Returns null when the model has no readable triangle geometry (headless test
// stubs) so the caller can fall back to the legacy per-piece burst.
export function fragmentGeometry(model, { count = 8, rng = Math.random } = {}) {
  void rng
  let chunks = _pieceChunks(model)
  if (!chunks.length) return null
  const target = Math.max(FRAG_MIN, Math.min(FRAG_MAX, count | 0 || FRAG_MIN))
  // Too many native pieces → merge down to the moderate cap; too few → split
  // the biggest chunks up to the target so even a one-piece unit sheds parts.
  if (chunks.length > target) chunks = _capToCount(chunks, target)
  else if (chunks.length < target) chunks = _growToCount(chunks, target)

  const floats = []
  const fragments = []
  const bmin = [Infinity, Infinity, Infinity]
  const bmax = [-Infinity, -Infinity, -Infinity]
  for (const chunk of chunks) {
    const frag = _chunkFragment(chunk, floats)
    if (!frag) continue
    fragments.push(frag)
    const [cx, cy, cz] = frag.centroid
    if (cx < bmin[0]) bmin[0] = cx; if (cy < bmin[1]) bmin[1] = cy; if (cz < bmin[2]) bmin[2] = cz
    if (cx > bmax[0]) bmax[0] = cx; if (cy > bmax[1]) bmax[1] = cy; if (cz > bmax[2]) bmax[2] = cz
  }
  if (!fragments.length) return null
  return {
    floats: new Float32Array(floats),
    fragments,
    bounds: { min: bmin, max: bmax },
  }
}
