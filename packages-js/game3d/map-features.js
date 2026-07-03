// map-features.js — 3D stand-ins for TA's 2D map features.
//
// TA authors map features (trees, rocks, metal deposits, kelp…) as GAF
// sprites drawn for one fixed camera; a free-orbit 3D battlefield needs
// geometry instead.  This module builds deterministic low-poly stand-ins
// per feature CATEGORY: shapes chosen to read correctly from TA's classic
// high angle AND survive rotation — a tree is a trunk with stacked canopy
// cones, a rock an irregular seeded polyhedron.  Ground-set features
// (metal deposits, steam vents, scars) are FLAT terrain-conforming
// decals rather than lumps; vents also surface a live steam emitter for
// the world to drive.  Features that ship a real 3DO (wrecks, dragon
// teeth) are NOT faked: they come back on the `models` list for the
// world to place as real model instances.
//
// Everything is a pure function of its inputs: each placement seeds its
// own PRNG from (name, cell), so the same map + catalogue always produces
// byte-identical geometry — the property the pack/replay pipeline keys on.
//
// Output geometry is baked into big interleaved batches (pos3 + normal3 +
// colour3 per vertex, world space) uploaded once by the renderer's
// setMapFeatures() — thousands of features cost a handful of static draw
// calls per frame, no per-feature CPU work.

/** World units per feature/attribute cell (16 px = 16 wu). */
const FEATURE_CELL_WU = 16

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

// TriSink accumulates world-space triangles with per-vertex colour; the
// normal is the face normal (flat shading — the low-poly read).
class TriSink {
  constructor() {
    this.data = []
    this.verts = 0
  }

  // tri pushes one triangle. a/b/c are [x,y,z]; color is [r,g,b] applied
  // to all three vertices unless ca/cb/cc override per-vertex.
  tri(a, b, c, color, ca = null, cb = null, cc = null) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    const d = this.data
    const push = (p, col) => {
      d.push(p[0], p[1], p[2], nx, ny, nz, col[0], col[1], col[2])
    }
    push(a, ca || color)
    push(b, cb || color)
    push(c, cc || color)
    this.verts += 3
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
function box(sink, rng, { x = 0, y = 0, z = 0, w, h, d, yaw = 0, color }) {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const rot = (px, pz) => [x + px * c - pz * s, z + px * s + pz * c]
  const hw = w / 2, hd = d / 2
  const corners = []
  for (const [px, pz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    const [wx, wz] = rot(px, pz)
    corners.push([wx, wz])
  }
  const lo = y, hi = y + h
  const cTop = shade(color, 1.0)
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
  sink.tri(a, b, c, color, color, color, c2)
  sink.tri(a, c, d, color, color, c2, c2)
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
    sink.tri(ring[i], centre, ring[(i + 1) % n], color, edge, color, edge)
  }
}

// disc emits a flat n-gon lying on the ground — the crater/scar decal.
function disc(sink, rng, { x = 0, y = 0, z = 0, r, n = 8, color }) {
  const centre = [x, y, z]
  const phase = rng() * Math.PI * 2
  const ring = []
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2
    const rr = r * (0.8 + rng() * 0.4)
    ring.push([x + Math.cos(a) * rr, y, z + Math.sin(a) * rr])
  }
  const edge = shade(color, 1.35)
  for (let i = 0; i < n; i++) {
    sink.tri(ring[i], centre, ring[(i + 1) % n], color, edge, color, edge)
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

function buildTree(sink, rng, { x, y, z, r, h }) {
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

const ROCK_GREY = [0.42, 0.40, 0.37]

function buildRock(sink, rng, { x, y, z, r, h }) {
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
  blob(sink, rng, { x, y: y - 0.5, z, r: r * 0.8, h: h * 0.16, color: shade(ROCK_GREY, 0.8) })
}

const KELP_GREEN = [0.10, 0.34, 0.22]

function buildKelp(sink, rng, { x, y, z, r, h }) {
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

const BUSH_GREEN = [0.22, 0.40, 0.14]

function buildBush(sink, rng, { x, y, z, r, h }) {
  const col = jitterColor(rng, BUSH_GREEN, 0.2)
  blob(sink, rng, { x, y, z, r: r * 0.9, h: Math.max(2, h * 0.8), color: col, squash: 0.8 })
}

const PROP_STEEL = [0.45, 0.44, 0.48]

function buildProp(sink, rng, { x, y, z, r, h }) {
  const col = jitterColor(rng, PROP_STEEL, 0.15)
  const n = 1 + ((rng() * 2) | 0)
  for (let i = 0; i < n; i++) {
    box(sink, rng, {
      x: x + (rng() - 0.5) * r * 0.8, y, z: z + (rng() - 0.5) * r * 0.8,
      w: r * (0.6 + rng() * 0.6), h: h * (0.5 + rng() * 0.6), d: r * (0.6 + rng() * 0.6),
      yaw: rng() * Math.PI, color: col,
    })
  }
}

const SCAR_DARK = [0.09, 0.08, 0.07]

function buildScar(sink, rng, { x, y, z, r }) {
  disc(sink, rng, { x, y: y + 0.15, z, r, n: 8, color: SCAR_DARK })
}

// Metal deposits: TA draws them as dark metal plates set flush into the
// ground — a FLAT decal, not a lump.  A slightly-raised paneled plate:
// a seam-coloured base quad with a grid of shade-jittered panels inset
// over it, every vertex hugging the terrain.  Corner panels are clipped
// to an octagon so the patch reads as the classic rounded plate.
const METAL_PLATE = [0.15, 0.16, 0.185]
const METAL_SEAM = [0.055, 0.06, 0.075]

function buildMetalPatch(sink, rng, { x, y, z, r, heightAt = null }) {
  const hAt = typeof heightAt === 'function' ? heightAt : () => y
  const half = Math.max(6, r * 1.05)
  // Base plate: an octagonal seam-coloured underlay — the rounded plate
  // outline — that shows through the panel gaps and clipped corners.
  conformingDisc(sink, rng, hAt, {
    x, z, r: half * 1.15, n: 8, lift: 0.3, color: METAL_SEAM, wobble: 0.02,
  })
  const n = Math.max(2, Math.min(4, Math.round(half / 5)))
  const cell = (half * 2) / n
  const inset = cell * 0.05
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
      if (rng() < 0.12) k *= 1.35
      conformingQuad(sink, hAt, {
        x0: cx - cell / 2 + inset, z0: cz - cell / 2 + inset,
        x1: cx + cell / 2 - inset, z1: cz + cell / 2 - inset,
        lift: 0.45, color: shade(jitterColor(rng, METAL_PLATE, 0.08), k),
        shadeLow: shade(METAL_PLATE, k * 0.8),
      })
    }
  }
}

// Geothermal / steam vents: a FLAT rocky-crust decal with a scorched
// throat.  The live steam wisp is emitted by the world at the vent's
// mouth (buildFeatureField returns the emitter list; create-world drives
// it off the fx clock), so the baked geometry stays static.
const VENT_CRUST = [0.23, 0.19, 0.16]
const VENT_SCORCH = [0.08, 0.065, 0.055]
const VENT_THROAT = [0.03, 0.025, 0.02]

function buildVent(sink, rng, { x, y, z, r, heightAt = null }) {
  const hAt = typeof heightAt === 'function' ? heightAt : () => y
  // Outer crust ring (lighter mineral stain), scorch band, then the
  // near-black throat with a faint ember warmth at its centre.
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 1.05, n: 12, lift: 0.3,
    color: shade(jitterColor(rng, VENT_CRUST, 0.12), 1.15), edgeColor: shade(VENT_CRUST, 0.9),
  })
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 0.62, n: 10, lift: 0.42, color: VENT_SCORCH, wobble: 0.2,
  })
  conformingDisc(sink, rng, hAt, {
    x, z, r: r * 0.3, n: 8, lift: 0.55,
    color: [0.16, 0.07, 0.03], edgeColor: VENT_THROAT, wobble: 0.1,
  })
}

// categoryBuilder maps a features.json category onto a shape family.  The
// category survey of the TA install groups into visual families; any
// unknown category falls back to the rock read (safe from every angle).
// Metal deposits and steam vents are FLAT terrain decals (the classic
// ground-plate / vent-mouth look), not 3D clusters; vents additionally
// get a live steam emitter from buildFeatureField.
export function categoryBuilder(category) {
  const c = String(category || '').toLowerCase()
  if (/tree/.test(c)) return buildTree
  if (/kelp|coral|anemone|aqua|seaweed|plant.*water/.test(c)) return buildKelp
  if (/foliage|shrub|plant|gasplant|bush/.test(c)) return buildBush
  if (/steamvent|geyser|fumarole|vent/.test(c)) return buildVent
  if (/metal|node/.test(c)) return buildMetalPatch
  if (/crystal|spire|glyph/.test(c)) return buildCrystals
  if (/crater|scar|smudge|track|hole/.test(c)) return buildScar
  if (/machine|pipe|car|truck|building|barrier|monument|ruin/.test(c)) return buildProp
  if (/rock|heap|dragonteeth/.test(c)) return buildRock
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
 *            models: Array<{name: string, x: number, y: number, z: number, heading: number, feature: string}>,
 *            emitters: Array<{kind: string, x: number, y: number, z: number, r: number, seed: number}>,
 *            counts: {placed: number, models: number, skipped: number} }}
 */

// Live-effect emitter budget: a pathological mod map carpeted in vents
// shouldn't turn the particle pool into a fog machine.
const MAX_FIELD_EMITTERS = 128

export function buildFeatureField({ features, defs = {}, heightAt = null, cellWU = FEATURE_CELL_WU } = {}) {
  const batches = []
  const models = []
  const emitters = []
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
    const build = categoryBuilder(def ? def.category : '')
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
  return { batches, models, emitters, counts: { placed, models: models.length, skipped } }
}
