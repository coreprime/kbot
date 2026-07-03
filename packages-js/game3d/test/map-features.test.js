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
} from '../map-features.js'

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
  const ys = (f) => Array.from(f.batches[0].data).filter((_, i) => i % 9 === 1).join(',')
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
  for (let i = 0; i < data.length; i += 9) {
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

test('categoryBuilder classifies the TA category survey', () => {
  const names = (fn) => fn.name
  assert.equal(names(categoryBuilder('trees')), 'buildTree')
  assert.equal(names(categoryBuilder('rocks')), 'buildRock')
  assert.equal(names(categoryBuilder('metal')), 'buildCrystals')
  assert.equal(names(categoryBuilder('kelp')), 'buildKelp')
  assert.equal(names(categoryBuilder('foliage')), 'buildBush')
  assert.equal(names(categoryBuilder('craters')), 'buildScar')
  assert.equal(names(categoryBuilder('machines')), 'buildProp')
  assert.equal(names(categoryBuilder('anything-weird')), 'buildRock')
})

test('mulberry32 + featureSeed are stable', () => {
  const s = featureSeed('tree1', 10, 12)
  assert.equal(s, featureSeed('tree1', 10, 12))
  assert.notEqual(s, featureSeed('tree1', 11, 12))
  const r1 = mulberry32(s), r2 = mulberry32(s)
  for (let i = 0; i < 8; i++) assert.equal(r1(), r2())
})
