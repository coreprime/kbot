// debris-fragments.js — shatter a dying model into MANY small shard meshes.
//
// TA authors most units from a handful of large COB pieces (a tank ≈ body +
// turret; a kbot a few limbs).  Throwing one flying record PER PIECE means a
// death is one or two big chunks arcing while they spin — which reads as the
// whole body tumbling in a spiral, not an explosion.  This module fragments
// the model FINER than its piece tree: every triangle group is diced into
// many small clusters, each cluster becomes its own recentred shard mesh
// with its own pivot, and the caller (create-world) flies each shard as an
// independent debris fragment.  The result is a shower of small pieces
// bursting outward — a real shatter.
//
// The heavy geometry work is pure + deterministic (seeded rng, no GL): it
// returns interleaved shard floats + per-fragment descriptors, which the GL
// caller uploads into one shard VBO and wraps in a lightweight synthetic
// model whose `flat` list is the fragments.  world-fx's debrisBurst then
// flies that `flat` list exactly like a real piece tree — a fragment carries
// the same move/rotate channels a Piece does, plus a `centroid` the burst
// uses to bias each shard OUTWARD from the model centre (radial explosion).

// Interleaved model vertex layout (must match model-loader FLOATS_PER_VERTEX
// and the renderer's VERTEX_STRIDE): pos(3), normal(3), uv(2), ao(1).
const FLOATS_PER_VERTEX = 9

// Fragment-count tuning.  A death should throw enough shards to read as an
// explosion regardless of how few COB pieces the unit has, but stay bounded
// so a mass death (or a giant like the commander) can't blow the per-frame
// debris budget.  The target scales with the model's size (bounding radius)
// and the death severity; the global cap belongs to the caller's piece
// budget, but we clamp here too so one death is never pathological.
export const FRAG_MIN = 10           // even a peewee throws a handful+
export const FRAG_MAX = 64           // hard ceiling for one death
export const FRAG_PER_RADIUS = 1.1   // shards per world-unit of bounding radius
// Severity 100 (commander / self-destruct — the hero blast) gets the full
// budget; a light corpse-leaving kill sheds a thinner shower.
export const FRAG_SEVERITY_FLOOR = 0.45

// targetFragmentCount picks how many shards a model of `radius` world units
// should shatter into at `severity` (0..100).  Deterministic, no rng.
export function targetFragmentCount(radius, severity = 100) {
  const r = Math.max(1, +radius || 1)
  const sev = Math.max(0, Math.min(100, +severity || 0))
  const sevScale = FRAG_SEVERITY_FLOOR + (1 - FRAG_SEVERITY_FLOOR) * (sev / 100)
  const raw = Math.round(r * FRAG_PER_RADIUS * sevScale)
  return Math.max(FRAG_MIN, Math.min(FRAG_MAX, raw))
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

// collectTriangles walks a model's triangle draw groups and returns a flat
// list of source triangles, each { verts:Float32Array(27), centroid:[x,y,z],
// group } where `group` carries the texture/colour/material this triangle
// draws with.  Only groups that retained their CPU copy (`group.tris`, set
// by model-loader for TRIANGLES groups) contribute — lines/points don't
// shatter.  Positions are in the model's object frame.
export function collectTriangles(model) {
  const out = []
  if (!model || !Array.isArray(model.flat)) return out
  for (const piece of model.flat) {
    if (!piece || !Array.isArray(piece.drawGroups)) continue
    for (const group of piece.drawGroups) {
      const f = group.tris
      if (!f || !f.length) continue
      for (let o = 0; o + FLOATS_PER_VERTEX * 3 <= f.length; o += FLOATS_PER_VERTEX * 3) {
        const verts = f.subarray(o, o + FLOATS_PER_VERTEX * 3)
        out.push({ verts, centroid: _triCentroid(f, o), group })
      }
    }
  }
  return out
}

// _seedPoints scatters `k` seed points across the triangle set for spatial
// k-means-lite clustering — picks well-separated triangles (farthest-point
// sampling seeded by rng) so shards are compact spatial chunks, not random
// speckle.  Returns an array of seed centroids.
function _seedPoints(tris, k, rng) {
  const seeds = []
  if (!tris.length) return seeds
  // First seed: a deterministic rng pick.
  let idx = Math.floor(rng() * tris.length) % tris.length
  seeds.push(tris[idx].centroid.slice())
  // Remaining seeds: farthest-point from the chosen set (with a small rng
  // tie-break jitter so equidistant candidates don't always pick the same).
  const dist2 = (a, b) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
    return dx * dx + dy * dy + dz * dz
  }
  while (seeds.length < k) {
    let best = -1, bestD = -1
    for (let i = 0; i < tris.length; i++) {
      let nearest = Infinity
      for (const s of seeds) {
        const d = dist2(tris[i].centroid, s)
        if (d < nearest) nearest = d
      }
      const score = nearest * (0.85 + rng() * 0.3)
      if (score > bestD) { bestD = score; best = i }
    }
    if (best < 0) break
    seeds.push(tris[best].centroid.slice())
  }
  return seeds
}

// clusterTriangles partitions `tris` into `k` spatial clusters (compact
// shard chunks) by nearest-seed assignment.  Empty clusters are dropped, so
// the returned count may be < k for tiny models.  Deterministic under `rng`.
export function clusterTriangles(tris, k, rng = Math.random) {
  if (!tris.length) return []
  const kk = Math.max(1, Math.min(k, tris.length))
  const seeds = _seedPoints(tris, kk, rng)
  const buckets = seeds.map(() => [])
  for (const t of tris) {
    let best = 0, bestD = Infinity
    for (let s = 0; s < seeds.length; s++) {
      const dx = t.centroid[0] - seeds[s][0]
      const dy = t.centroid[1] - seeds[s][1]
      const dz = t.centroid[2] - seeds[s][2]
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; best = s }
    }
    buckets[best].push(t)
  }
  return buckets.filter((b) => b.length)
}

// fragmentGeometry shatters `model` into up to `count` recentred shard
// meshes.  Pure + deterministic (all randomness from `rng`), no GL: it
// returns the data a GL caller uploads into one shard VBO plus one flying
// record per shard.
//
//   {
//     floats: Float32Array,   // all shards' interleaved verts, concatenated
//     fragments: [{
//       first,                //   vertex offset of this shard in `floats`
//       vertexCount,          //   verts in this shard (multiple of 3)
//       centroid:[x,y,z],     //   shard centre in object space (its pivot,
//                             //   AND the outward-burst direction seed)
//       textureName, color,   //   draw material (from the source group)
//       depthTier, isDecal, synthetic, specScale, runningLights, bump,
//     }],
//     bounds: {min,max},      // object-space AABB (culling + framing)
//   }
//
// Shard verts are recentred so each shard's centroid sits at the origin —
// that lets the renderer spin the shard about its own centre (fragment
// origin = centroid) so it TUMBLES IN PLACE instead of swinging around the
// model origin.  Returns null when the model has no readable triangle
// geometry (headless test stubs) so the caller can fall back to the legacy
// per-piece burst.
export function fragmentGeometry(model, { count = 24, rng = Math.random } = {}) {
  const tris = collectTriangles(model)
  if (!tris.length) return null
  const clusters = clusterTriangles(tris, count, rng)
  if (!clusters.length) return null

  const floats = []
  const fragments = []
  const bmin = [Infinity, Infinity, Infinity]
  const bmax = [-Infinity, -Infinity, -Infinity]
  for (const cluster of clusters) {
    // Shard centroid = mean of its triangle centroids.
    let cx = 0, cy = 0, cz = 0
    for (const t of cluster) { cx += t.centroid[0]; cy += t.centroid[1]; cz += t.centroid[2] }
    cx /= cluster.length; cy /= cluster.length; cz /= cluster.length
    const first = (floats.length / FLOATS_PER_VERTEX) | 0
    for (const t of cluster) {
      const v = t.verts
      for (let k = 0; k < 3; k++) {
        const o = k * FLOATS_PER_VERTEX
        // pos recentred to the shard pivot; normal/uv/ao copied verbatim so
        // the shard keeps the unit's texture + shading.
        floats.push(v[o] - cx, v[o + 1] - cy, v[o + 2] - cz)
        floats.push(v[o + 3], v[o + 4], v[o + 5])
        floats.push(v[o + 6], v[o + 7])
        floats.push(v[o + 8])
      }
    }
    const g = cluster[0].group
    fragments.push({
      first,
      vertexCount: cluster.length * 3,
      centroid: [cx, cy, cz],
      textureName: g.textureName || null,
      color: g.color || null,
      depthTier: g.depthTier || 0,
      isDecal: !!g.isDecal,
      synthetic: !!g.synthetic,
      specScale: g.specScale,
      runningLights: g.runningLights,
      bump: g.bump,
    })
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
