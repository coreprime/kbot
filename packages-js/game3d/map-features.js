// map-features.js — 3D stand-ins for TA's 2D map features.
//
// TA authors map features (trees, rocks, metal deposits, kelp…) as GAF
// sprites drawn for one fixed camera; a free-orbit 3D battlefield needs
// geometry instead.  This module builds deterministic low-poly stand-ins
// per feature CATEGORY: shapes chosen to read correctly from TA's classic
// high angle AND survive rotation — a conifer is a trunk with stacked
// canopy cones, a broadleaf a trunk with a rounded crown, a rock an
// irregular seeded polyhedron.  Ground-set features (metal deposits, steam
// vents, scars, tracks) are FLAT terrain-conforming decals rather than
// lumps; vents also surface a live steam emitter for the world to drive.
// Features that ship a real 3DO (wrecks, dragon teeth, heaps) are NOT
// faked: they come back on the `models` list for the world to place as
// real model instances.
//
// Each vertex carries a small MATERIAL pair (metalness, emissive) beside
// its colour so the feature shader can give metal decals a bright
// specular sheen (they catch the sun and pulse lights like real plating
// instead of reading as flat grey cardboard) and give vent throats a
// faint ember glow — without any per-feature CPU work at draw time.
//
// Everything is a pure function of its inputs: each placement seeds its
// own PRNG from (name, cell), so the same map + catalogue always produces
// byte-identical geometry — the property the pack/replay pipeline keys on.
//
// Output geometry is baked into big interleaved batches (pos3 + normal3 +
// colour3 + material2 per vertex, world space) uploaded once by the
// renderer's setMapFeatures() — thousands of features cost a handful of
// static draw calls per frame, no per-feature CPU work.

/** World units per feature/attribute cell (16 px = 16 wu). */
const FEATURE_CELL_WU = 16

// Floats per baked vertex: pos3 + normal3 + colour3 + material2
// (metalness, emissive).  Kept as a named constant so the batch consumers
// (renderer stride, tests) stay in step.
export const FEATURE_VERTEX_FLOATS = 11

// Split batches so no single Float32Array grows unbounded on huge maps —
// ~40k triangles per batch keeps allocations and uploads pleasant.
const MAX_BATCH_VERTS = 120000

// ── Deterministic PRNG ───────────────────────────────────────────────────

// featureSeed hashes a feature placement into a 32-bit PRNG seed (FNV-1a
// over the name plus the cell coordinates).
export function featureSeed(name, ax, ay) {
  let h = 0x811c9dc5
  const s = String(name)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= ax + 0x9e3779b9
  h = Math.imul(h, 0x01000193)
  h ^= ay + 0x85ebca6b
  h = Math.imul(h, 0x01000193)
  return h >>> 0
}

// mulberry32 — tiny deterministic PRNG (float in [0,1)).
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Triangle sink ────────────────────────────────────────────────────────

// TriSink accumulates world-space triangles with per-vertex colour and a
// material pair (metalness, emissive); the normal is the face normal (flat
// shading — the low-poly read).  The active material is a sink property so
// a whole builder (e.g. buildMetalPatch) can stamp its family material once
// and every triangle it emits inherits it — no threading it through every
// primitive call.
class TriSink {
  constructor() {
    this.data = []
    this.verts = 0
    // Current material applied to emitted vertices: [metalness, emissive].
    this.metal = 0
    this.emissive = 0
  }

  // material sets the metalness/emissive stamped onto subsequent triangles.
  material(metal = 0, emissive = 0) {
    this.metal = metal
    this.emissive = emissive
  }

  // tri pushes one triangle. a/b/c are [x,y,z]; color is [r,g,b] applied
  // to all three vertices unless ca/cb/cc override per-vertex.
  //
  // upFace forces the emitted face normal to point +Y (up).  Ground decals
  // (metal plates, vent crusts, scars) are terrain-conforming quads/discs
  // whose winding order can produce a downward-facing geometric normal —
  // that made the sun-facing lighting term collapse to zero and the plate
  // read as near-black.  Forcing the normal up for those flat lie-on-the-
  // ground primitives makes the overhead sun light them correctly.
  tri(a, b, c, color, ca = null, cb = null, cc = null, upFace = false) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    // Flat ground decals must present an up-facing normal so the overhead
    // sun lights them; flip a downward-pointing face normal.
    if (upFace && ny < 0) { nx = -nx; ny = -ny; nz = -nz }
    const d = this.data
    const m = this.metal, e = this.emissive
    const push = (p, col) => {
      d.push(p[0], p[1], p[2], nx, ny, nz, col[0], col[1], col[2], m, e)
    }
    push(a, ca || color)
    push(b, cb || color)
    push(c, cc || color)
    this.verts += 3
  }
}

// ── Sprite-decal sink ────────────────────────────────────────────────────

// Floats per decal vertex: pos3 + normal3 + uv2.  A separate, thinner
// layout from the coloured stand-in vertex — decals are lit flat and read
// their colour from the sprite texture, so they carry UVs instead of an
// RGB + material pair.
export const DECAL_VERTEX_FLOATS = 8

// DecalSink accumulates a single sprite's terrain-conforming textured
// quads (pos3 + normal3 + uv2 per vertex, world space, +Y face normals).
// One sink per sprite id → the renderer draws one batch per texture.
class DecalSink {
  constructor() {
    this.data = []
    this.verts = 0
  }

  // quad emits a terrain-conforming textured quad.  corners is four
  // [x,y,z] world points in winding order (a,b,c,d); uv the matching
  // [u,v] pairs.  Two triangles, up-facing normal so the overhead sun
  // lights the decal (it never reads black).
  quad(a, b, c, d, ua, ub, uc, ud) {
    const push = (p, uv) => {
      this.data.push(p[0], p[1], p[2], 0, 1, 0, uv[0], uv[1])
    }
    push(a, ua); push(b, ub); push(c, uc)
    push(a, ua); push(c, uc); push(d, ud)
    this.verts += 6
  }
}

// shade scales a colour (baked AO / vertical gradient).
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k]

// jitterColor perturbs a base colour deterministically per instance.
const jitterColor = (rng, c, amt = 0.12) => {
  const k = 1 + (rng() * 2 - 1) * amt
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)]
}

// ── Shape builders ───────────────────────────────────────────────────────
// All builders emit at the origin with +Y up; place() moves them into
// world space.  Sizes are world units.

// cone emits an n-gon cone (apex up) — the canopy / crystal primitive.
function cone(sink, rng, { x = 0, y = 0, z = 0, r, h, n = 5, color, tipColor = null, baseShade = 0.72, wobble = 0.25 }) {
  const apex = [x, y + h, z]
  const ring = []
  const phase = rng() * Math.PI * 2
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    const rr = r * (1 + (rng() * 2 - 1) * wobble)
    ring.push([x + Math.cos(a) * rr, y + (rng() * 2 - 1) * h * 0.06, z + Math.sin(a) * rr])
  }
  const cBase = shade(color, baseShade)
  const cTip = tipColor || color
  for (let i = 0; i < n; i++) {
    const p0 = ring[i], p1 = ring[(i + 1) % n]
    sink.tri(p0, p1, apex, color, cBase, cBase, cTip)
    // Underside so the canopy survives low camera angles.
    sink.tri(p1, p0, [x, y, z], cBase)
  }
}

// dome emits a rounded n-gon-by-rings hemisphere — the broadleaf crown /
// leafy-bush primitive (reads full and organic from every angle, unlike a
// single spike cone).
function dome(sink, rng, { x = 0, y = 0, z = 0, r, h, n = 6, rings = 2, color, topColor = null, baseShade = 0.62, wobble = 0.22 }) {
  const phase = rng() * Math.PI * 2
  const apex = [x, y + h, z]
  const top = topColor || shade(color, 1.12)
  // Build stacked rings from base to just below apex.
  const rows = []
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / (rings + 1)
    const ry = y + h * (t * 0.9)
    const rr = r * Math.cos(t * Math.PI * 0.5) * (1 + (rng() * 2 - 1) * wobble * 0.5)
    const row = []
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2 + ri * 0.2
      const rj = rr * (1 + (rng() * 2 - 1) * wobble)
      row.push([x + Math.cos(a) * rj, ry, z + Math.sin(a) * rj])
    }
    rows.push(row)
  }
  const cBase = shade(color, baseShade)
  // Skirt + between-ring bands.
  for (let ri = 0; ri < rings; ri++) {
    const lo = rows[ri], hi = rows[ri + 1]
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const cLo = shade(color, baseShade + ri * 0.14)
      const cHi = shade(color, baseShade + (ri + 1) * 0.14)
      sink.tri(lo[i], lo[j], hi[j], color, cLo, cLo, cHi)
      sink.tri(lo[i], hi[j], hi[i], color, cLo, cHi, cHi)
    }
  }
  // Cap the crown to the apex.
  const capRing = rows[rings]
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    sink.tri(capRing[i], capRing[j], apex, color, color, color, top)
  }
  // Close the underside so low angles don't see through the crown.
  const base = rows[0]
  const centre = [x, y, z]
  for (let i = 0; i < n; i++) {
    sink.tri(base[(i + 1) % n], base[i], centre, cBase)
  }
}

// blob emits an irregular seeded polyhedron — the rock primitive.  A
// squashed octahedron whose six cardinal vertices get per-instance radius
// jitter; eight faces, flat-shaded.
function blob(sink, rng, { x = 0, y = 0, z = 0, r, h, color, squash = 1.0 }) {
  const j = () => 0.6 + rng() * 0.8
  const top = [x + (rng() - 0.5) * r * 0.5, y + h * j(), z + (rng() - 0.5) * r * 0.5]
  const bot = [x, y - r * 0.2, z]
  const phase = rng() * Math.PI * 2
  const ring = []
  for (let i = 0; i < 4; i++) {
    const a = phase + (i / 4) * Math.PI * 2
    const rr = r * j()
    ring.push([x + Math.cos(a) * rr, y + h * 0.28 * squash * (0.5 + rng() * 0.9), z + Math.sin(a) * rr])
  }
  for (let i = 0; i < 4; i++) {
    const p0 = ring[i], p1 = ring[(i + 1) % 4]
    const kTop = 0.9 + rng() * 0.15
    const kSide = 0.62 + rng() * 0.18
    sink.tri(p0, p1, top, shade(color, kTop))
    sink.tri(p1, p0, bot, shade(color, kSide))
  }
}

// box emits an axis-jittered box — the prop / building primitive.
function box(sink, rng, { x = 0, y = 0, z = 0, w, h, d, yaw = 0, color, roofColor = null }) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const rot = (px, pz) => [x + px * c - pz * s, z + px * s + pz * c]
  const hw = w / 2, hd = d / 2
  const corners = []
  for (const [px, pz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    const [wx, wz] = rot(px, pz)
    corners.push([wx, wz])
  }
  const lo = y, hi = y + h
  const cTop = roofColor || shade(color, 1.0)
  const cSide = shade(color, 0.7)
  const cSide2 = shade(color, 0.55)
  // top
  sink.tri([corners[0][0], hi, corners[0][1]], [corners[1][0], hi, corners[1][1]], [corners[2][0], hi, corners[2][1]], cTop)
  sink.tri([corners[0][0], hi, corners[0][1]], [corners[2][0], hi, corners[2][1]], [corners[3][0], hi, corners[3][1]], cTop)
  // sides
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4]
    const col = (i % 2) ? cSide : cSide2
    sink.tri([a[0], lo, a[1]], [b[0], lo, b[1]], [b[0], hi, b[1]], col)
    sink.tri([a[0], lo, a[1]], [b[0], hi, b[1]], [a[0], hi, a[1]], col)
  }
}

// conformingQuad emits a flat ground quad whose four corners each sample
// the terrain height — the decal primitive.  Corners are (x0,z0)..(x1,z1)
// axis-aligned; `lift` floats the decal just above the surface so it
// draws over the map mesh without z-fighting.
function conformingQuad(sink, hAt, { x0, z0, x1, z1, lift, color, shadeLow = null }) {
  const p = (px, pz) => [px, hAt(px, pz) + lift, pz]
  const a = p(x0, z0), b = p(x1, z0), c = p(x1, z1), d = p(x0, z1)
  const c2 = shadeLow || color
  sink.tri(a, b, c, color, color, color, c2, true)
  sink.tri(a, c, d, color, color, c2, c2, true)
}

// conformingDisc emits a flat n-gon decal hugging the terrain — like
// disc(), but every ring vertex samples the surface height.
function conformingDisc(sink, rng, hAt, { x, z, r, n = 10, lift, color, edgeColor = null, wobble = 0.15 }) {
  const centre = [x, hAt(x, z) + lift, z]
  const phase = rng() * Math.PI * 2
  const ring = []
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    const rr = r * (1 - wobble + rng() * wobble * 2)
    const px = x + Math.cos(a) * rr
    const pz = z + Math.sin(a) * rr
    ring.push([px, hAt(px, pz) + lift, pz])
  }
  const edge = edgeColor || color
  for (let i = 0; i < n; i++) {
    sink.tri(ring[i], centre, ring[(i + 1) % n], color, edge, color, edge, true)
  }
}

// ── Category builders ────────────────────────────────────────────────────

const TREE_GREENS = [
  [0.16, 0.38, 0.13],
  [0.20, 0.44, 0.16],
  [0.13, 0.33, 0.15],
  [0.24, 0.42, 0.12],
]
const TRUNK_BROWN = [0.30, 0.20, 0.11]

// buildTree — a conifer: trunk + stacked shrinking canopy cones.
function buildTree(sink, rng, { x, y, z, r, h }) {
  sink.material(0, 0)
  const trunkH = h * (0.28 + rng() * 0.1)
  const trunkR = Math.max(0.8, r * 0.14)
  box(sink, rng, { x, y, z, w: trunkR * 2, h: trunkH, d: trunkR * 2, yaw: rng() * Math.PI, color: jitterColor(rng, TRUNK_BROWN) })
  // Two to three stacked canopy cones, shrinking upward — reads as a
  // conifer from the side and a full crown from TA's high angle.
  const green = jitterColor(rng, TREE_GREENS[(rng() * TREE_GREENS.length) | 0])
  const layers = 2 + ((rng() * 2) | 0)
  let ly = y + trunkH * 0.75
  let lr = r
  const layerH = (y + h - ly) / layers * 1.25
  for (let i = 0; i < layers; i++) {
    cone(sink, rng, {
      x: x + (rng() - 0.5) * r * 0.2, y: ly, z: z + (rng() - 0.5) * r * 0.2,
      r: lr, h: layerH, n: 5, color: shade(green, 1 - i * 0.08), wobble: 0.3,
    })
    ly += layerH * 0.55
    lr *= 0.68
  }
}

// buildBroadleaf — a deciduous tree: trunk + a rounded leafy crown.
function buildBroadleaf(sink, rng, { x, y, z, r, h }) {
  sink.material(0, 0)
  const trunkH = h * (0.30 + rng() * 0.12)
  const trunkR = Math.max(0.9, r * 0.16)
  box(sink, rng, { x, y, z, w: trunkR * 2, h: trunkH, d: trunkR * 2, yaw: rng() * Math.PI, color: jitterColor(rng, TRUNK_BROWN) })
  const green = jitterColor(rng, TREE_GREENS[(rng() * TREE_GREENS.length) | 0], 0.16)
  const crownH = (h - trunkH) * (0.9 + rng() * 0.3)
  // One or two overlapping crown domes for a fuller, lumpier read.
  const lobes = 1 + ((rng() * 2) | 0)
  for (let i = 0; i < lobes; i++) {
    const off = i === 0 ? 0 : r * 0.4
    const a = rng() * Math.PI * 2
    dome(sink, rng, {
      x: x + Math.cos(a) * off, y: y + trunkH * 0.8, z: z + Math.sin(a) * off,
      r: r * (0.9 - i * 0.15), h: crownH * (0.9 - i * 0.1), n: 6, rings: 2,
      color: shade(green, 1 - i * 0.06),
    })
  }
}

const ROCK_GREY = [0.42, 0.40, 0.37]

function buildRock(sink, rng, { x, y, z, r, h }) {
  sink.material(0, 0)
  const col = jitterColor(rng, ROCK_GREY, 0.18)
  blob(sink, rng, { x, y, z, r, h: Math.max(h, r * 0.7), color: col })
  // A satellite pebble or two sells the "scatter" read.
  const n = (rng() * 2) | 0
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2
    blob(sink, rng, {
      x: x + Math.cos(a) * r * 1.1, y, z: z + Math.sin(a) * r * 1.1,
      r: r * (0.25 + rng() * 0.2), h: h * 0.3, color: shade(col, 0.9),
    })
  }
}

const CRYSTAL_TEAL = [0.30, 0.78, 0.72]

function buildCrystals(sink, rng, { x, y, z, r, h }) {
  // Crystals catch a little specular so they read glassy, not chalky.
  sink.material(0.35, 0.06)
  const col = jitterColor(rng, CRYSTAL_TEAL, 0.15)
  const n = 3 + ((rng() * 3) | 0)
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2
    const d = rng() * r * 0.8
    const ch = h * (0.5 + rng() * 0.8)
    cone(sink, rng, {
      x: x + Math.cos(a) * d, y, z: z + Math.sin(a) * d,
      r: Math.max(1.2, r * (0.16 + rng() * 0.14)), h: ch, n: 4,
      color: col, tipColor: shade(col, 1.4), baseShade: 0.5, wobble: 0.1,
    })
  }
  // A low rock base grounds the cluster.
  sink.material(0, 0)
  blob(sink, rng, { x, y: y - 0.5, z, r: r * 0.8, h: h * 0.16, color: shade(ROCK_GREY, 0.8) })
}

const KELP_GREEN = [0.10, 0.34, 0.22]

function buildKelp(sink, rng, { x, y, z, r, h }) {
  sink.material(0, 0)
  const col = jitterColor(rng, KELP_GREEN, 0.2)
  const n = 2 + ((rng() * 3) | 0)
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2
    const d = rng() * r * 0.7
    cone(sink, rng, {
      x: x + Math.cos(a) * d, y, z: z + Math.sin(a) * d,
      r: Math.max(0.8, r * 0.12), h: h * (0.6 + rng() * 0.7), n: 3,
      color: col, tipColor: shade(col, 1.25), baseShade: 0.6, wobble: 0.15,
    })
  }
}

const CORAL_HUES = [
  [0.72, 0.34, 0.40], // pink
  [0.78, 0.52, 0.26], // amber
  [0.40, 0.60, 0.72], // blue
  [0.66, 0.40, 0.66], // violet
]

// buildCoral — a branching reef clump: several thin cones fanning outward
// and up from a common base, tipped a brighter hue.  Reads as a coral/
// anemone rather than the generic green kelp fronds.
function buildCoral(sink, rng, { x, y, z, r, h }) {
  sink.material(0.08, 0.04)
  const base = CORAL_HUES[(rng() * CORAL_HUES.length) | 0]
  const col = jitterColor(rng, base, 0.14)
  const tip = shade(col, 1.5)
  const n = 4 + ((rng() * 4) | 0)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.6
    const d = r * (0.15 + rng() * 0.5)
    const ch = h * (0.5 + rng() * 0.7)
    // Lean each branch outward for the splayed reef silhouette.
    const bx = x + Math.cos(a) * d
    const bz = z + Math.sin(a) * d
    cone(sink, rng, {
      x: bx, y, z: bz,
      r: Math.max(0.7, r * (0.10 + rng() * 0.08)), h: ch, n: 4,
      color: col, tipColor: tip, baseShade: 0.55, wobble: 0.2,
    })
  }
  // A squat lumpy foot so the clump doesn't float.
  blob(sink, rng, { x, y, z, r: r * 0.55, h: h * 0.18, color: shade(col, 0.7), squash: 0.7 })
}

const BUSH_GREEN = [0.22, 0.40, 0.14]

// buildBush — a low leafy shrub: a cluster of small overlapping domes so
// it reads as foliage from any angle rather than a single boulder shape.
function buildBush(sink, rng, { x, y, z, r, h }) {
  sink.material(0, 0)
  const col = jitterColor(rng, BUSH_GREEN, 0.2)
  const bh = Math.max(2.5, h * 0.85)
  const clumps = 2 + ((rng() * 3) | 0)
  for (let i = 0; i < clumps; i++) {
    const a = rng() * Math.PI * 2
    const d = i === 0 ? 0 : r * (0.3 + rng() * 0.4)
    dome(sink, rng, {
      x: x + Math.cos(a) * d, y, z: z + Math.sin(a) * d,
      r: r * (0.55 + rng() * 0.3), h: bh * (0.7 + rng() * 0.5), n: 5, rings: 1,
      color: shade(col, 0.85 + rng() * 0.3), wobble: 0.28,
    })
  }
}

const PROP_STEEL = [0.45, 0.44, 0.48]

// buildProp — a small cluster of boxes for machines/cars/pipes: a bit of
// metallic sheen so wreck-yard scatter catches the light.
function buildProp(sink, rng, { x, y, z, r, h }) {
  sink.material(0.4, 0)
  const col = jitterColor(rng, PROP_STEEL, 0.15)
  const n = 1 + ((rng() * 2) | 0)
  for (let i = 0; i < n; i++) {
    box(sink, rng, {
      x: x + (rng() - 0.5) * r * 0.8, y, z: z + (rng() - 0.5) * r * 0.8,
      w: r * (0.6 + rng() * 0.6), h: h * (0.5 + rng() * 0.6), d: r * (0.6 + rng() * 0.6),
      yaw: rng() * Math.PI, color: col,
    })
  }
  sink.material(0, 0)
}

const BUILDING_CONCRETE = [0.52, 0.50, 0.46]
const BUILDING_ROOF = [0.34, 0.30, 0.28]
const RUIN_STONE = [0.40, 0.38, 0.34]

// buildStructure — a blocky building/monument/ruin: a main mass plus one
// or two smaller adjoining volumes so it reads as architecture, not a
// single crate.  Taller footprints get a stepped silhouette.
function buildStructure(sink, rng, { x, y, z, r, h }, { stone = false, jagged = false } = {}) {
  sink.material(stone ? 0.05 : 0.12, 0)
  const base = jitterColor(rng, stone ? RUIN_STONE : BUILDING_CONCRETE, 0.12)
  const roof = stone ? shade(base, 0.7) : jitterColor(rng, BUILDING_ROOF, 0.1)
  const yaw = rng() * Math.PI
  const mainH = h * (jagged ? (0.5 + rng() * 0.35) : (0.75 + rng() * 0.35))
  box(sink, rng, { x, y, z, w: r * 1.7, h: mainH, d: r * 1.7, yaw, color: base, roofColor: roof })
  // A secondary wing / tower offset to a corner.
  const wings = 1 + ((rng() * 2) | 0)
  for (let i = 0; i < wings; i++) {
    const a = yaw + (i * Math.PI * 0.5) + rng() * 0.4
    const d = r * (0.7 + rng() * 0.4)
    const wh = mainH * (jagged ? (0.35 + rng() * 0.4) : (0.5 + rng() * 0.6))
    box(sink, rng, {
      x: x + Math.cos(a) * d, y, z: z + Math.sin(a) * d,
      w: r * (0.6 + rng() * 0.5), h: wh, d: r * (0.6 + rng() * 0.5),
      yaw: yaw + rng() * 0.3, color: shade(base, 0.85 + rng() * 0.2), roofColor: roof,
    })
  }
  sink.material(0, 0)
}

function buildBuilding(sink, rng, dims) {
  buildStructure(sink, rng, dims, { stone: false, jagged: false })
}

function buildRuin(sink, rng, dims) {
  buildStructure(sink, rng, dims, { stone: true, jagged: true })
}

const SPIRE_STONE = [0.46, 0.43, 0.40]

// buildSpire — a tall tapering monolith (TA/TAK spires + monuments): a
// stack of shrinking boxes rising to a point.  Reads as a distinct
// vertical landmark from any angle.
function buildSpire(sink, rng, { x, y, z, r, h }) {
  sink.material(0.1, 0)
  const col = jitterColor(rng, SPIRE_STONE, 0.12)
  const yaw = rng() * Math.PI * 0.25
  const segs = 3 + ((rng() * 2) | 0)
  let ly = y
  let lr = r * 0.8
  const segH = h / segs
  for (let i = 0; i < segs; i++) {
    box(sink, rng, {
      x, y: ly, z, w: lr * 2, h: segH * 1.05, d: lr * 2,
      yaw: yaw + i * 0.15, color: shade(col, 1 - i * 0.05),
    })
    ly += segH
    lr *= 0.7
  }
  // A pointed cap crowns the spire.
  cone(sink, rng, { x, y: ly, z, r: lr * 1.3, h: segH * 0.8, n: 4, color: shade(col, 0.85), wobble: 0.05 })
  sink.material(0, 0)
}

const DEBRIS_BROWN = [0.30, 0.26, 0.21]

// buildDebris — a low rubble mound (corpses/heaps that ship no 3DO): a
// squashed rock plus a few chips, kept close to the ground.
function buildDebris(sink, rng, { x, y, z, r, h }) {
  sink.material(0.1, 0)
  const col = jitterColor(rng, DEBRIS_BROWN, 0.16)
  blob(sink, rng, { x, y, z, r: r * 1.1, h: Math.max(1.5, h * 0.35), color: col, squash: 0.4 })
  const n = 1 + ((rng() * 3) | 0)
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2
    blob(sink, rng, {
      x: x + Math.cos(a) * r * 0.8, y, z: z + Math.sin(a) * r * 0.8,
      r: r * (0.2 + rng() * 0.25), h: h * 0.25, color: shade(col, 0.85 + rng() * 0.2), squash: 0.5,
    })
  }
  sink.material(0, 0)
}

const SCAR_DARK = [0.09, 0.08, 0.07]

// buildScar — a flat scorch/track/crater decal hugging the terrain.
function buildScar(sink, rng, { x, y, z, r, heightAt = null }) {
  sink.material(0, 0)
  const hAt = typeof heightAt === 'function' ? heightAt : () => y
  conformingDisc(sink, rng, hAt, {
    x, z, r, n: 9, lift: 0.2, color: SCAR_DARK, edgeColor: shade(SCAR_DARK, 1.6), wobble: 0.25,
  })
}

// Metal deposits: TA draws them as dark metal plates set flush into the
// ground — a FLAT decal, not a lump.  The plate is genuine steel: a dark
// steel base with a grid of shade-jittered rivet-cornered panels, every
// vertex hugging the terrain and every vertex flagged HIGHLY METALLIC so
// the feature shader gives it a bright blinn specular highlight (it catches
// the sun and any weapon-pulse light like real plating).  Corner panels
// are clipped to an octagon so the patch reads as the classic rounded plate.
const METAL_PLATE = [0.30, 0.32, 0.37]
const METAL_SEAM = [0.07, 0.08, 0.10]
const METAL_RIVET = [0.52, 0.55, 0.60]

function buildMetalPatch(sink, rng, { x, y, z, r, heightAt = null }) {
  const hAt = typeof heightAt === 'function' ? heightAt : () => y
  const half = Math.max(6, r * 1.05)
  // Base plate: an octagonal dark-steel underlay — the rounded plate
  // outline — that shows through the panel gaps and clipped corners.
  // Fully metallic so the seams also glint.
  sink.material(0.85, 0)
  conformingDisc(sink, rng, hAt, {
    x, z, r: half * 1.15, n: 8, lift: 0.3, color: METAL_SEAM, wobble: 0.02,
  })
  const n = Math.max(2, Math.min(4, Math.round(half / 5)))
  const cell = (half * 2) / n
  const inset = cell * 0.06
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const cx = x - half + (gx + 0.5) * cell
      const cz = z - half + (gz + 0.5) * cell
      // Octagon clip: skip panels whose centre falls outside the plate's
      // rounded outline (corner panels on 3x3+ grids).
      if (Math.abs(cx - x) + Math.abs(cz - z) > half * 1.3) continue
      // Panel shade: dark steel with deterministic wear jitter; the odd
      // panel reads lighter (scuffed) for the plated-yard look.
      let k = 0.85 + rng() * 0.3
      if (rng() < 0.12) k *= 1.4
      // Metalness varies slightly per panel so the sheen isn't uniform —
      // scuffed panels read a touch more matte, polished ones mirror-bright.
      sink.material(0.72 + rng() * 0.25, 0)
      conformingQuad(sink, hAt, {
        x0: cx - cell / 2 + inset, z0: cz - cell / 2 + inset,
        x1: cx + cell / 2 - inset, z1: cz + cell / 2 - inset,
        lift: 0.45, color: shade(jitterColor(rng, METAL_PLATE, 0.08), k),
        shadeLow: shade(METAL_PLATE, k * 0.75),
      })
      // Four corner rivets: tiny bright metallic dots that pin the plate
      // and give it hardware detail under the specular highlight.
      const rv = cell * 0.10
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const rx = cx + sx * (cell / 2 - inset - rv * 1.4)
        const rz = cz + sz * (cell / 2 - inset - rv * 1.4)
        if (Math.abs(rx - x) + Math.abs(rz - z) > half * 1.3) continue
        sink.material(0.95, 0.02)
        conformingQuad(sink, hAt, {
          x0: rx - rv, z0: rz - rv, x1: rx + rv, z1: rz + rv,
          lift: 0.55, color: METAL_RIVET, shadeLow: shade(METAL_RIVET, 0.75),
        })
      }
    }
  }
  sink.material(0, 0)
}

// Geothermal / steam vents: a FLAT rocky-crust decal with a scorched
// throat.  The throat carries EMISSIVE warmth so it reads genuinely hot
// (a faint ember glow that survives shadow/night), the crust like scorched
// rock.  The live steam wisp is emitted by the world at the vent's mouth
// (buildFeatureField returns the emitter list; create-world drives it off
// the fx clock), so the baked geometry stays static.
const VENT_CRUST = [0.24, 0.20, 0.17]
const VENT_SCORCH = [0.08, 0.065, 0.055]
const VENT_THROAT = [0.05, 0.03, 0.02]
const VENT_EMBER = [0.55, 0.18, 0.05]

function buildVent(sink, rng, { x, y, z, r, heightAt = null }) {
  const hAt = typeof heightAt === 'function' ? heightAt : () => y
  // Outer crust ring (lighter mineral stain), scorch band, then the
  // near-black throat with a hot ember centre.
  sink.material(0, 0)
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 1.05, n: 12, lift: 0.3,
    color: shade(jitterColor(rng, VENT_CRUST, 0.12), 1.15), edgeColor: shade(VENT_CRUST, 0.9),
  })
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 0.62, n: 10, lift: 0.42, color: VENT_SCORCH, wobble: 0.2,
  })
  // Throat: scorched rim fading to a glowing ember core.  Emissive rises
  // toward the centre so it looks lit from within.
  sink.material(0, 0.25)
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 0.34, n: 10, lift: 0.55,
    color: shade(VENT_EMBER, 0.5), edgeColor: VENT_THROAT, wobble: 0.12,
  })
  sink.material(0, 0.7)
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 0.16, n: 8, lift: 0.62, color: VENT_EMBER, edgeColor: shade(VENT_EMBER, 0.7), wobble: 0.1,
  })
  sink.material(0, 0)
}

// ── Flat ground sprite decals ────────────────────────────────────────────
//
// TA draws metal deposits, steam vents, scars, tracks, craters and holes as
// flat art laid into the ground.  A pack (format v6+) ships each such
// feature's real first-frame GAF sprite (with alpha) at featuresprites/
// <id>.png; the renderer paints that authored art onto the terrain as a
// texture-conforming, edge-alpha decal — far truer than any procedural
// octagon.  buildSpriteDecal emits the decal geometry (terrain-hugging
// quad, subdivided so it conforms to slopes) with UVs into a per-sprite
// DecalSink; the procedural buildMetalPatch / buildVent / buildScar remain
// as the FALLBACK when a pack predates v6 (or the sprite failed to pack).

// FLAT_GROUND_CATEGORIES — kept in step with the pack's
// flatGroundFeatureCategories (pack_features.go): these feature families
// render as real-sprite decals when their sprite art is packed.
const FLAT_GROUND_CATEGORIES = new Set([
  'metal', 'steamvents', 'scars', 'smudges', 'tracks', 'craters', 'holes',
])

// isFlatGroundCategory reports whether a category is drawn as a flat ground
// decal (matches the pack extraction set, plus the vent/scar name-hint
// families so pre-catalogue packs still route sensibly).
export function isFlatGroundCategory(category, nameHint = '') {
  const c = String(category || '').toLowerCase()
  if (FLAT_GROUND_CATEGORIES.has(c)) return true
  const n = String(nameHint || '').toLowerCase()
  return /steamvent|geyser|fumarole|vent|scar|smudge|track|crater|\bhole|\bmetal/.test(c + ' ' + n)
}

// spriteDecalSize derives the decal's world footprint + terrain-hugging
// subdivision from the catalogue sprite dims (1 px ≈ 1 wu at TA scale).
// Falls back to the footprint radius when the def carries no sprite dims.
function spriteDecalSize(def, r) {
  let w = def && def.spriteW > 0 ? def.spriteW : r * 2
  let h = def && def.spriteH > 0 ? def.spriteH : r * 2
  // Clamp against dirty mod data (a 4096px sprite shouldn't tile a map).
  w = Math.max(6, Math.min(320, w))
  h = Math.max(6, Math.min(320, h))
  return { w, h }
}

// buildSpriteDecal bakes a feature's real GAF sprite as a terrain-
// conforming textured quad into `decalSink`.  The quad is subdivided into
// an NxN grid so every interior vertex samples the terrain and the decal
// drapes over slopes instead of clipping through them; UVs span the full
// sprite (0..1) so the sprite's own alpha feathers the edges.  A tiny
// deterministic yaw per placement keeps repeated deposits from tiling
// unnaturally.
function buildSpriteDecal(decalSink, rng, { x, z, def, r, heightAt }) {
  const hAt = typeof heightAt === 'function' ? heightAt : () => 0
  const { w, h } = spriteDecalSize(def, r)
  const hw = w / 2, hh = h / 2
  const lift = 0.35
  // Deterministic quarter-turn-ish yaw so identical sprites don't all face
  // the same way (metal fields, scar scatter).
  const yaw = (rng() - 0.5) * 0.6
  const cs = Math.cos(yaw), sn = Math.sin(yaw)
  // Subdivision: enough to follow terrain without exploding vertex counts.
  const seg = Math.max(1, Math.min(6, Math.round(Math.max(w, h) / 24)))
  const at = (gx, gz) => {
    // Grid coord in [-hw,hw] × [-hh,hh] before rotation.
    const lx = -hw + (gx / seg) * w
    const lz = -hh + (gz / seg) * h
    const wx = x + lx * cs - lz * sn
    const wz = z + lx * sn + lz * cs
    return [wx, hAt(wx, wz) + lift, wz]
  }
  const uvAt = (gx, gz) => [gx / seg, gz / seg]
  for (let gz = 0; gz < seg; gz++) {
    for (let gx = 0; gx < seg; gx++) {
      const a = at(gx, gz), b = at(gx + 1, gz), c = at(gx + 1, gz + 1), d = at(gx, gz + 1)
      const ua = uvAt(gx, gz), ub = uvAt(gx + 1, gz), uc = uvAt(gx + 1, gz + 1), ud = uvAt(gx, gz + 1)
      decalSink.quad(a, b, c, d, ua, ub, uc, ud)
    }
  }
}

// categoryBuilder maps a features.json category onto a shape family.  The
// category survey of the TA install groups into visual families; any
// unknown category falls back to the rock read (safe from every angle).
// Metal deposits and steam vents are FLAT terrain decals (the classic
// ground-plate / vent-mouth look), not 3D clusters; vents additionally
// get a live steam emitter from buildFeatureField.  Ground scars (scars,
// smudges, tracks, craters, holes) are also flat decals — never blobs.
//
// `nameHint` is the feature's own id (e.g. "btreea_01").  Packs built
// before the catalogue carried categories leave `category` blank, which
// used to collapse every tagless feature — trees included — to the rock
// read (they "vanished" as far as the user's eye was concerned, since a
// forest map looked like a boulder field).  When the category is empty or
// unrecognised we fall back to classifying by the id so a feature literally
// named "tree"/"bush"/"metal"/… still routes to the right family.
export function categoryBuilder(category, nameHint = '') {
  const pick = (c) => {
    // Trees first: conifers vs broadleaf/deciduous.
    if (/tree|conifer|pine|fir|spruce/.test(c)) {
      if (/broadleaf|oak|palm|leaf|deciduous|birch/.test(c)) return buildBroadleaf
      return buildTree
    }
    // Reef life: corals + anemones get the branching-clump read; kelp/
    // seaweed keep the frond read.
    if (/coral|anemone|reef|sponge/.test(c)) return buildCoral
    if (/kelp|seaweed|aqua|plant.*water/.test(c)) return buildKelp
    // Low leafy vegetation.
    if (/foliage|shrub|bush|gasplant|\bplant/.test(c)) return buildBush
    // Ground-set decals (do these BEFORE any 3D fallback).
    if (/steamvent|geyser|fumarole|vent/.test(c)) return buildVent
    if (/metal/.test(c)) return buildMetalPatch
    if (/crater|scar|smudge|track|hole|burn/.test(c)) return buildScar
    // Vertical landmarks.
    if (/spire|monument|obelisk|pillar|statue/.test(c)) return buildSpire
    if (/crystal|glyph/.test(c)) return buildCrystals
    // Architecture.
    if (/ruin|rubble/.test(c)) return buildRuin
    if (/building|barrier|wall|tower/.test(c)) return buildBuilding
    // Debris mounds (corpses/heaps that ship no 3DO).
    if (/corpse|wreck|heap|debris/.test(c)) return buildDebris
    // Steel scatter.
    if (/machine|pipe|car|truck|node/.test(c)) return buildProp
    // Rock scatter (last real family).
    if (/rock|boulder|stone|dragonteeth/.test(c)) return buildRock
    return null
  }
  const byCat = pick(String(category || '').toLowerCase())
  if (byCat) return byCat
  // Category was blank or unrecognised — try the feature's own name.
  const byName = pick(String(nameHint || '').toLowerCase())
  if (byName) return byName
  return buildRock
}

// featureSizeWU derives a stand-in's radius + height from the catalogue
// entry: footprint cells → radius, TDF height / GAF sprite height → visual
// height (1 px ≈ 1 wu), with sane per-family defaults when both are absent.
export function featureSizeWU(def) {
  const fx = Math.max(1, (def && def.footprintX) | 0)
  const fz = Math.max(1, (def && def.footprintZ) | 0)
  const r = Math.min(fx, fz) * FEATURE_CELL_WU * 0.42
  let h = 0
  if (def && def.heightWU > 0) h = def.heightWU
  if (def && def.spriteH > 0) h = Math.max(h, def.spriteH * 0.8)
  if (!(h > 0)) h = r * 1.6
  // Clamp: TA sprite heights already sit in world scale, but dirty mod
  // data (height=255 markers) shouldn't produce sequoias.
  h = Math.max(3, Math.min(120, h))
  return { r: Math.max(2, Math.min(48, r)), h }
}

/**
 * buildFeatureField bakes a map's feature placements into renderer-ready
 * batches plus a list of real-model features.
 *
 * @param {Object} opts
 * @param {Array}  opts.features   Map placements: [{ name, ax, ay }] (the
 *   packed map JSON's features array — attribute cells).
 * @param {Object} opts.defs       features.json catalogue keyed by
 *   lower-case id ({} → every placement falls back to category defaults).
 * @param {Function} [opts.heightAt] (x, z) → terrain Y; defaults to 0.
 * @param {number} [opts.cellWU=16] World units per attribute cell.
 * @returns {{ batches: Array<{data: Float32Array, count: number}>,
 *            decals: Array<{sprite: string, feature: string, data: Float32Array, count: number}>,
 *            models: Array<{name: string, x: number, y: number, z: number, heading: number, feature: string}>,
 *            emitters: Array<{kind: string, x: number, y: number, z: number, r: number, seed: number}>,
 *            counts: {placed: number, decals: number, models: number, skipped: number} }}
 *
 * Flat ground features (metal deposits, steam vents, scars, tracks,
 * craters, holes) whose catalogue entry carries a packed `sprite` are
 * emitted as textured terrain decals (grouped per sprite in `decals`) that
 * paint the feature's real GAF art onto the ground; without a sprite they
 * fall back to the procedural decal geometry in `batches`.  Upright
 * features (trees, rocks, buildings…) always use the 3D stand-in geometry.
 */

// Live-effect emitter budget: a pathological mod map carpeted in vents
// shouldn't turn the particle pool into a fog machine.
const MAX_FIELD_EMITTERS = 128

export function buildFeatureField({ features, defs = {}, heightAt = null, cellWU = FEATURE_CELL_WU } = {}) {
  const batches = []
  const models = []
  const emitters = []
  // Sprite decals grouped by sprite path so each distinct feature art is
  // one textured draw — keyed by the sprite path, insertion order stable.
  const decalSinks = new Map()
  let sink = new TriSink()
  let placed = 0
  let skipped = 0
  const hAt = typeof heightAt === 'function' ? heightAt : () => 0

  const flush = () => {
    if (sink.verts > 0) {
      batches.push({ data: new Float32Array(sink.data), count: sink.verts })
      sink = new TriSink()
    }
  }

  for (const f of features || []) {
    if (!f || !f.name) { skipped++; continue }
    const key = String(f.name).toLowerCase()
    const def = defs[key] || null
    const x = (f.ax + 0.5) * cellWU
    const z = (f.ay + 0.5) * cellWU
    const y = hAt(x, z)
    const rng = mulberry32(featureSeed(key, f.ax | 0, f.ay | 0))
    if (def && def.object) {
      // Real 3DO — the world places the actual model.
      models.push({ name: def.object, x, y, z, heading: Math.PI + ((rng() * 4) | 0) * (Math.PI / 2), feature: key })
      placed++
      continue
    }
    const { r, h } = featureSizeWU(def)
    // Flat ground feature WITH packed real sprite art → paint it as a
    // texture-conforming decal instead of faking it with geometry.
    if (def && def.sprite && isFlatGroundCategory(def.category, key)) {
      let ds = decalSinks.get(def.sprite)
      if (!ds) {
        ds = { sprite: def.sprite, feature: key, sink: new DecalSink() }
        decalSinks.set(def.sprite, ds)
      }
      buildSpriteDecal(ds.sink, rng, { x, z, def, r, heightAt: hAt })
      // Steam-vent decals still surface a live steam wisp.
      if ((def.category || '').toLowerCase() === 'steamvents' && emitters.length < MAX_FIELD_EMITTERS) {
        emitters.push({ kind: 'steam', x, y: hAt(x, z) + 0.6, z, r, seed: featureSeed(key, f.ax | 0, f.ay | 0) })
      }
      placed++
      continue
    }
    const build = categoryBuilder(def ? def.category : '', key)
    build(sink, rng, { x, y, z, r, h, heightAt: hAt })
    // Steam vents carry a live wisp emitter on top of their baked decal —
    // the world drives it off the fx clock (deterministic per placement).
    if (build === buildVent && emitters.length < MAX_FIELD_EMITTERS) {
      emitters.push({ kind: 'steam', x, y: hAt(x, z) + 0.6, z, r, seed: featureSeed(key, f.ax | 0, f.ay | 0) })
    }
    placed++
    if (sink.verts >= MAX_BATCH_VERTS) flush()
  }
  flush()
  const decals = []
  for (const ds of decalSinks.values()) {
    if (ds.sink.verts > 0) {
      decals.push({ sprite: ds.sprite, feature: ds.feature, data: new Float32Array(ds.sink.data), count: ds.sink.verts })
    }
  }
  return { batches, decals, models, emitters, counts: { placed, decals: decals.length, models: models.length, skipped } }
}
