// map-features.test.js — headless proofs for the feature stand-in field:
// deterministic geometry, category classification, catalogue-driven sizing
// and the 3DO-object split.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildFeatureField,
  categoryBuilder,
  featureSizeWU,
  featureSeed,
  mulberry32,
  isFlatGroundCategory,
  FEATURE_VERTEX_FLOATS,
  DECAL_VERTEX_FLOATS,
} from '../map-features.js'

// Floats per baked vertex — pos3 + normal3 + colour3 + material2.
const STRIDE = FEATURE_VERTEX_FLOATS
// Floats per decal vertex — pos3 + normal3 + uv2.
const DSTRIDE = DECAL_VERTEX_FLOATS

const DEFS = {
  tree1: { id: 'tree1', category: 'trees', footprintX: 2, footprintZ: 2, heightWU: 40, spriteW: 40, spriteH: 52 },
  rock4: { id: 'rock4', category: 'rocks', footprintX: 3, footprintZ: 2, heightWU: 20 },
  shale: { id: 'shale', category: 'metal', footprintX: 2, footprintZ: 2, heightWU: 14 },
  armpw_dead: { id: 'armpw_dead', category: 'arm_corpses', footprintX: 2, footprintZ: 2, object: 'armpw_dead' },
}

const FEATURES = [
  { name: 'Tree1', ax: 10, ay: 12 },
  { name: 'Rock4', ax: 30, ay: 8 },
  { name: 'Shale', ax: 5, ay: 40 },
  { name: 'ARMPW_DEAD', ax: 20, ay: 20 },
  { name: 'Tree1', ax: 11, ay: 12 },
]

test('buildFeatureField is deterministic — identical bytes across runs', () => {
  const a = buildFeatureField({ features: FEATURES, defs: DEFS })
  const b = buildFeatureField({ features: FEATURES, defs: DEFS })
  assert.equal(a.batches.length, b.batches.length)
  for (let i = 0; i < a.batches.length; i++) {
    assert.equal(a.batches[i].count, b.batches[i].count)
    assert.deepEqual(Array.from(a.batches[i].data), Array.from(b.batches[i].data))
  }
  assert.deepEqual(a.models, b.models)
})

test('neighbouring placements of the same feature differ (per-cell seeding)', () => {
  const one = buildFeatureField({ features: [FEATURES[0]], defs: DEFS })
  const two = buildFeatureField({ features: [FEATURES[4]], defs: DEFS })
  // Same tree type, adjacent cells: geometry must not be a pure translate —
  // compare Y coordinates (translation-invariant on this axis apart from
  // terrain, which is flat 0 here).
  const ys = (f) => Array.from(f.batches[0].data).filter((_, i) => i % STRIDE === 1).join(',')
  assert.notEqual(ys(one), ys(two))
})

test('object features route to the model list, sprites to geometry', () => {
  const field = buildFeatureField({ features: FEATURES, defs: DEFS })
  assert.equal(field.models.length, 1)
  assert.equal(field.models[0].name, 'armpw_dead')
  assert.equal(field.models[0].feature, 'armpw_dead')
  // The wreck placement contributes no stand-in triangles; the four sprite
  // features do.
  assert.ok(field.batches[0].count > 0)
  assert.equal(field.counts.placed, 5)
  assert.equal(field.counts.models, 1)
})

test('placements land at their cell centres on the terrain surface', () => {
  const heightAt = (x, z) => 7 + x * 0 + z * 0
  const field = buildFeatureField({ features: [{ name: 'Rock4', ax: 4, ay: 6 }], defs: DEFS, heightAt })
  const data = field.batches[0].data
  // Gather X/Z bounds of the emitted geometry — the blob must straddle the
  // cell centre (4.5*16, 6.5*16) and sit around y=7.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity
  for (let i = 0; i < data.length; i += STRIDE) {
    minX = Math.min(minX, data[i]); maxX = Math.max(maxX, data[i])
    minZ = Math.min(minZ, data[i + 2]); maxZ = Math.max(maxZ, data[i + 2])
    minY = Math.min(minY, data[i + 1])
  }
  assert.ok(minX < 4.5 * 16 && maxX > 4.5 * 16)
  assert.ok(minZ < 6.5 * 16 && maxZ > 6.5 * 16)
  assert.ok(minY > 0 && minY < 8, `geometry should sit near terrain y=7, minY=${minY}`)
})

test('featureSizeWU derives from footprint + height with sane clamps', () => {
  const tree = featureSizeWU(DEFS.tree1)
  assert.ok(tree.h >= 40, 'TDF height wins')
  assert.ok(tree.r > 4 && tree.r < 20)
  const dflt = featureSizeWU(null)
  assert.ok(dflt.r >= 2 && dflt.h >= 3)
  const bogus = featureSizeWU({ footprintX: 99, footprintZ: 99, heightWU: 9999 })
  assert.ok(bogus.h <= 120 && bogus.r <= 48, 'dirty mod data clamps')
})

test('categoryBuilder classifies the full TA/TAK pack category survey', () => {
  const names = (fn) => fn.name
  // Every category present in a real pack's features.json maps to a fitting
  // surrogate family.  (Object-bearing categories — corpses, heaps,
  // dragonteeth — route to real 3DO models in buildFeatureField and never
  // reach categoryBuilder; the mappings below are the sprite fallbacks.)
  const expect = {
    // Vegetation.
    trees: 'buildTree',
    foliage: 'buildBush',
    plants: 'buildBush',
    shrubs: 'buildBush',
    gasplants: 'buildBush',
    // Reef life.
    anemones: 'buildCoral',
    aquacorals: 'buildCoral',
    corals: 'buildCoral',
    kelp: 'buildKelp',
    // Ground-set FLAT decals — never 3D blobs.
    metal: 'buildMetalPatch',
    nodes: 'buildProp',
    steamvents: 'buildVent',
    scars: 'buildScar',
    smudges: 'buildScar',
    tracks: 'buildScar',
    craters: 'buildScar',
    holes: 'buildScar',
    // Vertical landmarks.
    spires: 'buildSpire',
    monuments: 'buildSpire',
    glyph: 'buildCrystals',
    // Architecture.
    buildings: 'buildBuilding',
    building: 'buildBuilding',
    barriers: 'buildBuilding',
    ruin: 'buildRuin',
    // Debris + scatter.
    heaps: 'buildDebris',
    machines: 'buildProp',
    pipes: 'buildProp',
    cars: 'buildProp',
    trucks: 'buildProp',
    rocks: 'buildRock',
    dragonteeth: 'buildRock',
    // Unknown → safe rock read.
    'anything-weird': 'buildRock',
  }
  for (const [cat, fn] of Object.entries(expect)) {
    assert.equal(names(categoryBuilder(cat)), fn, `category ${cat}`)
  }
})

test('categoryBuilder falls back to the feature name when category is blank', () => {
  const names = (fn) => fn.name
  // Pre-catalogue packs leave the category empty; classify by id so trees /
  // bushes / metal features still route correctly instead of all becoming rocks.
  assert.equal(names(categoryBuilder('', 'btreea_01')), 'buildTree')
  assert.equal(names(categoryBuilder('', 'GreenBush3')), 'buildBush')
  assert.equal(names(categoryBuilder('', 'SmallMetal')), 'buildMetalPatch')
  assert.equal(names(categoryBuilder('', 'steamvent2')), 'buildVent')
  // A real category still wins over the name hint.
  assert.equal(names(categoryBuilder('metal', 'tree_looking_name')), 'buildMetalPatch')
  // No category AND no useful name → safe rock fallback.
  assert.equal(names(categoryBuilder('', 'xyzzy')), 'buildRock')
})

test('a tree feature produces visible above-ground canopy geometry', () => {
  // Regression guard for "trees not showing": buildTree must emit a canopy
  // that stands well above the terrain (not a flat/zero-height decal).
  const defs = { pinetree: { id: 'pinetree', category: 'trees', footprintX: 2, footprintZ: 2, heightWU: 40 } }
  const field = buildFeatureField({ features: [{ name: 'PineTree', ax: 6, ay: 6 }], defs, heightAt: () => 5 })
  assert.ok(field.batches.length > 0 && field.batches[0].count > 0, 'tree emits geometry')
  let maxY = -Infinity
  for (const b of field.batches) {
    for (let i = 0; i < b.data.length; i += STRIDE) maxY = Math.max(maxY, b.data[i + 1])
  }
  assert.ok(maxY > 20, `tree canopy rises above terrain, maxY=${maxY}`)
})

// Y-range helper over a field's baked vertices.
const yRange = (field) => {
  let minY = Infinity, maxY = -Infinity
  for (const b of field.batches) {
    for (let i = 0; i < b.data.length; i += STRIDE) {
      minY = Math.min(minY, b.data[i + 1])
      maxY = Math.max(maxY, b.data[i + 1])
    }
  }
  return { minY, maxY }
}

test('metal + vent decals lie FLAT on the terrain; crystals stay 3D', () => {
  const defs = {
    shale: { id: 'shale', category: 'metal', footprintX: 2, footprintZ: 2, heightWU: 14 },
    vent1: { id: 'vent1', category: 'steamvents', footprintX: 2, footprintZ: 2, heightWU: 30 },
    glyph1: { id: 'glyph1', category: 'glyph', footprintX: 2, footprintZ: 2, heightWU: 14 },
  }
  const one = (name) => yRange(buildFeatureField({
    features: [{ name, ax: 4, ay: 6 }], defs, heightAt: () => 7,
  }))
  const metal = one('shale')
  assert.ok(metal.minY > 7 && metal.maxY < 8,
    `metal decal must hug y=7: [${metal.minY}, ${metal.maxY}]`)
  const vent = one('vent1')
  assert.ok(vent.minY > 7 && vent.maxY < 8,
    `vent decal must hug y=7: [${vent.minY}, ${vent.maxY}]`)
  const crystals = one('glyph1')
  assert.ok(crystals.maxY > 10, 'crystal stand-ins stay 3D')
})

test('decals conform to sloped terrain per-vertex', () => {
  const defs = { shale: { id: 'shale', category: 'metal', footprintX: 3, footprintZ: 3, heightWU: 14 } }
  const heightAt = (x, z) => 3 + x * 0.15 + z * 0.05
  const field = buildFeatureField({ features: [{ name: 'Shale', ax: 8, ay: 8 }], defs, heightAt })
  for (const b of field.batches) {
    for (let i = 0; i < b.data.length; i += STRIDE) {
      const lift = b.data[i + 1] - heightAt(b.data[i], b.data[i + 2])
      assert.ok(lift > 0.1 && lift < 1.0,
        `every vertex floats just above its own terrain sample, lift=${lift}`)
    }
  }
})

test('steam vents surface a deterministic live emitter; metal does not', () => {
  const defs = {
    vent1: { id: 'vent1', category: 'steamvents', footprintX: 2, footprintZ: 2 },
    shale: { id: 'shale', category: 'metal', footprintX: 2, footprintZ: 2 },
  }
  const features = [
    { name: 'Vent1', ax: 3, ay: 5 },
    { name: 'Shale', ax: 9, ay: 9 },
    { name: 'Vent1', ax: 12, ay: 2 },
  ]
  const a = buildFeatureField({ features, defs, heightAt: () => 4 })
  const b = buildFeatureField({ features, defs, heightAt: () => 4 })
  assert.equal(a.emitters.length, 2, 'one emitter per vent, none for metal')
  assert.deepEqual(a.emitters, b.emitters, 'emitters must be deterministic')
  for (const em of a.emitters) {
    assert.equal(em.kind, 'steam')
    assert.ok(em.y > 4 && em.y < 5, 'emitter sits at the vent mouth')
    assert.ok(Number.isFinite(em.seed))
  }
})

test('ground decals (metal / vent / scar) present up-facing normals', () => {
  // Root cause of the black-metal-patch defect: the terrain-conforming quad
  // and disc builders emitted downward face normals, so the overhead sun's
  // diffuse term collapsed to zero. Every flat decal vertex must now carry a
  // normal whose Y is >= 0 (up-facing), so it lights instead of reading black.
  const defs = {
    shale: { id: 'shale', category: 'metal', footprintX: 3, footprintZ: 3, heightWU: 14 },
    vent1: { id: 'vent1', category: 'steamvents', footprintX: 2, footprintZ: 2 },
    scar1: { id: 'scar1', category: 'crater', footprintX: 2, footprintZ: 2 },
  }
  for (const name of ['Shale', 'Vent1', 'Scar1']) {
    const field = buildFeatureField({
      features: [{ name, ax: 8, ay: 8 }], defs, heightAt: (x, z) => 3 + x * 0.15 + z * 0.05,
    })
    let allUp = true
    for (const b of field.batches) {
      for (let i = 0; i < b.data.length; i += STRIDE) {
        if (b.data[i + 4] < -1e-6) { allUp = false }
      }
    }
    assert.ok(allUp, `${name} decal must have up-facing (ny >= 0) normals`)
  }
})

test('mulberry32 + featureSeed are stable', () => {
  const s = featureSeed('tree1', 10, 12)
  assert.equal(s, featureSeed('tree1', 10, 12))
  assert.notEqual(s, featureSeed('tree1', 11, 12))
  const r1 = mulberry32(s), r2 = mulberry32(s)
  for (let i = 0; i < 8; i++) assert.equal(r1(), r2())
})

// ── Material channel (metalness + emissive) ──────────────────────────────

// Baked vertices carry pos3 + normal3 + colour3 + material2; the material
// pair is the last two floats of every 11-float vertex.
const METAL_IDX = 9    // metalness
const EMISS_IDX = 10   // emissive

// matStats scans a field's vertices for the max metalness / emissive seen.
const matStats = (field) => {
  let maxMetal = 0, maxEmiss = 0
  for (const b of field.batches) {
    for (let i = 0; i < b.data.length; i += STRIDE) {
      maxMetal = Math.max(maxMetal, b.data[i + METAL_IDX])
      maxEmiss = Math.max(maxEmiss, b.data[i + EMISS_IDX])
    }
  }
  return { maxMetal, maxEmiss }
}

test('vertex layout carries an 11-float stride (pos3+nrm3+col3+mat2)', () => {
  assert.equal(FEATURE_VERTEX_FLOATS, 11)
  const field = buildFeatureField({ features: FEATURES, defs: DEFS })
  for (const b of field.batches) {
    assert.equal(b.data.length % STRIDE, 0, 'batch data is a whole number of vertices')
    assert.equal(b.data.length / STRIDE, b.count, 'count matches vertex total')
  }
})

test('metal plates are flagged strongly metallic; trees stay matte', () => {
  const defs = {
    shale: { id: 'shale', category: 'metal', footprintX: 3, footprintZ: 3, heightWU: 14 },
    tree1: { id: 'tree1', category: 'trees', footprintX: 2, footprintZ: 2, heightWU: 40 },
  }
  const metal = matStats(buildFeatureField({
    features: [{ name: 'Shale', ax: 4, ay: 6 }], defs, heightAt: () => 7,
  }))
  assert.ok(metal.maxMetal > 0.7, `metal patch reads metallic, maxMetal=${metal.maxMetal}`)
  const tree = matStats(buildFeatureField({
    features: [{ name: 'Tree1', ax: 4, ay: 6 }], defs, heightAt: () => 7,
  }))
  assert.equal(tree.maxMetal, 0, 'tree canopy is matte (no metalness)')
  assert.equal(tree.maxEmiss, 0, 'tree canopy has no emissive')
})

test('vent throats carry emissive warmth so they read hot', () => {
  const defs = { vent1: { id: 'vent1', category: 'steamvents', footprintX: 2, footprintZ: 2, heightWU: 30 } }
  const vent = matStats(buildFeatureField({
    features: [{ name: 'Vent1', ax: 3, ay: 5 }], defs, heightAt: () => 4,
  }))
  assert.ok(vent.maxEmiss > 0.3, `vent throat glows, maxEmiss=${vent.maxEmiss}`)
})

test('flat-decal categories produce near-zero-height geometry', () => {
  // Metal / vent / scar / track / smudge / crater / hole all hug the
  // terrain: their whole vertical extent stays inside a ~1wu decal band.
  const flatCats = ['metal', 'steamvents', 'scars', 'smudges', 'tracks', 'craters', 'holes']
  for (const category of flatCats) {
    const defs = { f: { id: 'f', category, footprintX: 3, footprintZ: 3, heightWU: 40, spriteH: 60 } }
    const { minY, maxY } = yRange(buildFeatureField({
      features: [{ name: 'F', ax: 4, ay: 6 }], defs, heightAt: () => 7,
    }))
    assert.ok(maxY - minY < 1.0, `${category} decal is flat: extent=${maxY - minY}`)
    assert.ok(minY >= 7, `${category} decal sits on terrain y=7: minY=${minY}`)
  }
})

test('3D surrogate categories rise above the terrain', () => {
  const cats3d = ['trees', 'foliage', 'anemones', 'corals', 'spires', 'monuments', 'buildings', 'ruin', 'heaps', 'machines', 'glyph', 'rocks']
  for (const category of cats3d) {
    const defs = { f: { id: 'f', category, footprintX: 3, footprintZ: 3, heightWU: 40 } }
    const { maxY } = yRange(buildFeatureField({
      features: [{ name: 'F', ax: 4, ay: 6 }], defs, heightAt: () => 7,
    }))
    assert.ok(maxY > 9, `${category} surrogate stands above terrain: maxY=${maxY}`)
  }
})

// ── Real-sprite ground decals (format v6 packs) ──────────────────────────

// Y-range over a decal batch's vertices (pos.y is index 1 of each vertex).
const decalYRange = (field) => {
  let minY = Infinity, maxY = -Infinity
  for (const d of field.decals || []) {
    for (let i = 0; i < d.data.length; i += DSTRIDE) {
      minY = Math.min(minY, d.data[i + 1])
      maxY = Math.max(maxY, d.data[i + 1])
    }
  }
  return { minY, maxY }
}

test('isFlatGroundCategory matches the pack extraction set', () => {
  for (const c of ['metal', 'steamvents', 'scars', 'smudges', 'tracks', 'craters', 'holes']) {
    assert.ok(isFlatGroundCategory(c), `${c} is flat ground`)
  }
  for (const c of ['trees', 'rocks', 'foliage', 'buildings', 'spires', 'corals']) {
    assert.ok(!isFlatGroundCategory(c), `${c} is upright, not flat ground`)
  }
})

test('flat features WITH a packed sprite become textured decals, not geometry', () => {
  const defs = {
    ore: { id: 'ore', category: 'metal', footprintX: 3, footprintZ: 3, spriteW: 66, spriteH: 55, sprite: 'featuresprites/ore.png' },
    vent: { id: 'vent', category: 'steamvents', footprintX: 1, footprintZ: 1, spriteW: 99, spriteH: 94, sprite: 'featuresprites/vent.png' },
  }
  const field = buildFeatureField({
    features: [{ name: 'Ore', ax: 4, ay: 6 }, { name: 'Vent', ax: 9, ay: 9 }],
    defs, heightAt: () => 7,
  })
  // No procedural stand-in geometry: both flat features went to decals.
  const standInVerts = field.batches.reduce((s, b) => s + b.count, 0)
  assert.equal(standInVerts, 0, 'flat sprite features emit no stand-in triangles')
  // Two distinct sprites → two decal batches, each carrying UV geometry.
  assert.equal(field.decals.length, 2, 'one decal batch per distinct sprite')
  assert.equal(field.counts.decals, 2)
  for (const d of field.decals) {
    assert.ok(d.sprite && d.sprite.startsWith('featuresprites/'), 'decal names its sprite')
    assert.ok(d.count > 0 && d.data.length === d.count * DSTRIDE, 'decal geometry is well-formed')
  }
  // Vent decals still surface a live steam emitter.
  assert.equal(field.emitters.length, 1, 'the vent decal keeps its steam wisp')
})

test('sprite decals lie flat on and hug the terrain surface', () => {
  const defs = { ore: { id: 'ore', category: 'metal', footprintX: 3, footprintZ: 3, spriteW: 66, spriteH: 55, sprite: 'featuresprites/ore.png' } }
  // Sloped terrain: every decal vertex must float just above its own
  // terrain sample (the conforming grid drapes over the slope).
  const heightAt = (x, z) => 3 + x * 0.12 + z * 0.06
  const field = buildFeatureField({ features: [{ name: 'Ore', ax: 8, ay: 8 }], defs, heightAt })
  assert.ok(field.decals.length === 1)
  for (const d of field.decals) {
    for (let i = 0; i < d.data.length; i += DSTRIDE) {
      const lift = d.data[i + 1] - heightAt(d.data[i], d.data[i + 2])
      assert.ok(lift > 0.1 && lift < 1.0, `decal vertex hugs terrain, lift=${lift}`)
      // Normal faces up so the sun lights it (never black).
      assert.ok(d.data[i + 4] > 0.9, 'decal normal points up')
    }
  }
  // The decal's vertical span comes only from draping the terrain slope,
  // not from standing up: it must stay within the terrain height range the
  // decal footprint spans (plus the small conforming lift), never more.
  const { minY, maxY } = decalYRange(field)
  let tMin = Infinity, tMax = -Infinity
  const d0 = field.decals[0]
  for (let i = 0; i < d0.data.length; i += DSTRIDE) {
    const t = heightAt(d0.data[i], d0.data[i + 2])
    tMin = Math.min(tMin, t); tMax = Math.max(tMax, t)
  }
  assert.ok(maxY - minY <= (tMax - tMin) + 1.0,
    `decal span (${(maxY - minY).toFixed(2)}) follows terrain span (${(tMax - tMin).toFixed(2)})`)
})

test('flat features WITHOUT a sprite fall back to procedural flat geometry', () => {
  // A v5 pack (no sprite field) still renders metal/vents as the improved
  // procedural decals — flat, in the stand-in batches, no textured decals.
  const defs = { ore: { id: 'ore', category: 'metal', footprintX: 3, footprintZ: 3, heightWU: 14 } }
  const field = buildFeatureField({ features: [{ name: 'Ore', ax: 4, ay: 6 }], defs, heightAt: () => 7 })
  assert.equal((field.decals || []).length, 0, 'no textured decals without packed sprite art')
  assert.ok(field.batches.reduce((s, b) => s + b.count, 0) > 0, 'procedural fallback geometry present')
})

test('decal batches are deterministic across runs', () => {
  const defs = { ore: { id: 'ore', category: 'metal', footprintX: 3, footprintZ: 3, spriteW: 66, spriteH: 55, sprite: 'featuresprites/ore.png' } }
  const feats = [{ name: 'Ore', ax: 4, ay: 6 }, { name: 'Ore', ax: 12, ay: 3 }]
  const a = buildFeatureField({ features: feats, defs, heightAt: () => 5 })
  const b = buildFeatureField({ features: feats, defs, heightAt: () => 5 })
  assert.equal(a.decals.length, b.decals.length)
  for (let i = 0; i < a.decals.length; i++) {
    assert.equal(a.decals[i].sprite, b.decals[i].sprite)
    assert.deepEqual(Array.from(a.decals[i].data), Array.from(b.decals[i].data))
  }
})

test('material channel is deterministic across runs', () => {
  const defs = {
    shale: { id: 'shale', category: 'metal', footprintX: 3, footprintZ: 3, heightWU: 14 },
    vent1: { id: 'vent1', category: 'steamvents', footprintX: 2, footprintZ: 2 },
  }
  const feats = [{ name: 'Shale', ax: 4, ay: 6 }, { name: 'Vent1', ax: 9, ay: 9 }]
  const a = buildFeatureField({ features: feats, defs, heightAt: () => 5 })
  const b = buildFeatureField({ features: feats, defs, heightAt: () => 5 })
  for (let i = 0; i < a.batches.length; i++) {
    assert.deepEqual(Array.from(a.batches[i].data), Array.from(b.batches[i].data))
  }
})
