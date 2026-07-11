// node --test coverage for the map-feature → sim addFeature transform.

import test from 'node:test'
import assert from 'node:assert/strict'
import { simFeatureSpecs } from './map-features-sim.js'

// A representative slice of the /api/studio/feature-defs catalogue, matching
// real TA feature-def shapes: a genuine deposit is INDESTRUCTIBLE and metal-
// bearing. Most (rockmetal1-4) carry a metal-named id under category=rocks;
// the green-planet ones (greenaquaore1-3) carry an aquaore-named id. A
// geothermal steam vent; a plain tree; an ORDINARY reclaim rock (destructible,
// no metal in the name); and MetalTower01 — a metal-NAMED but destructible
// decorative building that must NOT be mistaken for a mex site.
const defs = {
  rockmetal1: { category: 'rocks', metal: 127, footprintX: 3, footprintZ: 3, reclaimable: true, indestructible: true },
  greenaquaore1: { category: 'rocks', metal: 116, footprintX: 3, footprintZ: 3, indestructible: true },
  metalvent01: { category: 'steamvents', geothermal: true, footprintX: 3, footprintZ: 3, indestructible: true },
  greentree1: { category: 'trees', footprintX: 1, footprintZ: 1, blocking: true, reclaimable: true },
  rock1a: { category: 'rocks', metal: 100, footprintX: 2, footprintZ: 2, reclaimable: true },
  metaltower01: { category: 'building', metal: 150, footprintX: 2, footprintZ: 2, reclaimable: true },
  // TA:Kingdoms mana features: a sacred stone (sacredsite multiplier, the mana
  // resource site) and an upright henge standing-stone (category=mana but no
  // multiplier — decorative, blocking, must NOT be pushed as a resource site).
  aramana02: { category: 'mana', sacredSite: 1.5, footprintX: 2, footprintZ: 2, indestructible: true },
  arahenge01: { category: 'mana', footprintX: 4, footprintZ: 3, heightWU: 74, blocking: true, indestructible: true },
}

test('metal deposit becomes a non-blocking metal patch that stamps metal', () => {
  const specs = simFeatureSpecs([{ name: 'RockMetal1', ax: 20, ay: 30 }], defs, 16)
  assert.equal(specs.length, 1)
  const s = specs[0]
  assert.equal(s.kind, 1, 'metal patch kind')
  assert.equal(s.metal, 127, 'metal value carried through for the cell stamp')
  assert.equal(s.blocking, false, 'a deposit is passable so the extractor can be founded on it')
  assert.equal(s.indestructible, false)
  // Cell centre: (20 + 0.5) * 16, (30 + 0.5) * 16.
  assert.equal(s.x, 328)
  assert.equal(s.z, 488)
  assert.equal(s.footprintX, 3)
  assert.equal(s.footprintZ, 3)
})

test('geothermal vent becomes a geothermal-flagged blocking site', () => {
  const specs = simFeatureSpecs([{ name: 'MetalVent01', ax: 10, ay: 10 }], defs, 16)
  assert.equal(specs.length, 1)
  const s = specs[0]
  assert.equal(s.kind, 0, 'a vent is a prop-kind feature, not a metal patch')
  assert.equal(s.geothermal, true, 'geothermal flag threaded so the plant site is recognised')
  assert.equal(s.indestructible, true, 'the vent stays a solid obstacle for ordinary buildings')
  assert.equal(s.x, 168)
  assert.equal(s.z, 168)
})

test('an aquaore-named deposit under category=rocks is still a metal patch', () => {
  const specs = simFeatureSpecs([{ name: 'GreenAquaore1', ax: 20, ay: 30 }], defs, 16)
  assert.equal(specs.length, 1)
  const s = specs[0]
  assert.equal(s.kind, 1, 'metal patch kind')
  assert.equal(s.metal, 116, 'aquaore deposit metal carried through for the cell stamp')
  assert.equal(s.blocking, false)
})

test('a reclaimable tree becomes a blocking, reclaimable scenery prop', () => {
  const specs = simFeatureSpecs([{ name: 'GreenTree1', ax: 5, ay: 5 }], defs, 16)
  assert.equal(specs.length, 1)
  const s = specs[0]
  assert.equal(s.kind, 0, 'a tree is a scenery prop, not a metal patch')
  assert.equal(s.reclaimable, true, 'reclaimable flag threaded so a builder can salvage it')
  assert.equal(s.blocking, true, 'a tree occupies its plot per the FBI blocking flag')
  assert.equal(s.indestructible, false)
  assert.equal(s.metal, 0)
  assert.equal(s.energy, 0)
  assert.equal(s.footprintX, 1)
})

test('reclaim rocks and destructible reclaimable scenery are pushed as reclaimable props, not mex sites', () => {
  const specs = simFeatureSpecs([
    { name: 'Rock1a', ax: 6, ay: 6 },
    // MetalTower is metal-named but destructible — reclaimable scenery, not a mex site.
    { name: 'MetalTower01', ax: 7, ay: 7 },
  ], defs, 16)
  assert.equal(specs.length, 2)
  // Neither is a metal patch (kind 1); both are reclaimable scenery props (kind 0).
  for (const s of specs) {
    assert.equal(s.kind, 0, 'destructible reclaimable scenery is a prop, never a mex site')
    assert.equal(s.reclaimable, true)
    assert.equal(s.indestructible, false)
  }
})

test('a TA:K sacred stone becomes a non-blocking sacred site carrying its multiplier', () => {
  const specs = simFeatureSpecs([{ name: 'AraMana02', ax: 8, ay: 8 }], defs, 16)
  assert.equal(specs.length, 1)
  const s = specs[0]
  assert.equal(s.kind, 3, 'sacred site kind')
  assert.equal(s.sacredSite, 1.5, 'sacredsite multiplier carried through for the producer income')
  assert.equal(s.blocking, false, 'the stone is passable so the lodestone founds on top of it')
  assert.equal(s.indestructible, false)
  assert.equal(s.footprintX, 2)
  assert.equal(s.footprintZ, 2)
})

test('an upright henge standing-stone shares category=mana but is not a resource site', () => {
  const specs = simFeatureSpecs([{ name: 'AraHenge01', ax: 3, ay: 3 }], defs, 16)
  assert.equal(specs.length, 0, 'a henge carries no sacredsite multiplier and stays decorative scenery')
})

test('features with no catalogue entry, and non-feature junk, are skipped', () => {
  const specs = simFeatureSpecs([
    { name: 'UnknownThing', ax: 1, ay: 1 },
    { ax: 2, ay: 2 },
    null,
  ], defs, 16)
  assert.equal(specs.length, 0)
})

test('a mixed field yields the tree prop, the metal patch and the vent', () => {
  const specs = simFeatureSpecs([
    { name: 'GreenTree1', ax: 0, ay: 0 },
    { name: 'RockMetal1', ax: 4, ay: 8 },
    { name: 'MetalVent01', ax: 12, ay: 3 },
  ], defs, 16)
  assert.equal(specs.length, 3)
  // Two prop-kind features (the reclaimable tree and the geothermal vent) plus
  // the one metal patch.
  assert.deepEqual(specs.map((s) => s.kind).sort(), [0, 0, 1])
})
