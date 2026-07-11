// node --test coverage for the map-feature → sim addFeature transform.

import test from 'node:test'
import assert from 'node:assert/strict'
import { simFeatureSpecs } from './map-features-sim.js'

// A representative slice of the /api/studio/feature-defs catalogue, matching
// real TA feature-def shapes: metal deposits are category=rocks with a metal
// yield AND a metal-bearing name (RockMetal1-4, WaterMetal…); a geothermal steam
// vent; a plain tree; and an ORDINARY reclaim rock (name carries no "metal", so
// it must NOT be treated as a build site even though it reclaims to metal).
const defs = {
  rockmetal1: { category: 'rocks', metal: 127, footprintX: 3, footprintZ: 3, reclaimable: true },
  metalvent01: { category: 'steamvents', geothermal: true, footprintX: 3, footprintZ: 3, indestructible: true },
  greentree1: { category: 'trees', footprintX: 1, footprintZ: 1, blocking: true, reclaimable: true },
  rock1a: { category: 'rocks', metal: 100, footprintX: 2, footprintZ: 2, reclaimable: true },
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

test('trees and ordinary reclaim rocks are not pushed into the sim', () => {
  const specs = simFeatureSpecs([
    { name: 'GreenTree1', ax: 5, ay: 5 },
    { name: 'Rock1a', ax: 6, ay: 6 },
  ], defs, 16)
  assert.equal(specs.length, 0, 'non-metal scenery carries no build gate and must stay decorative')
})

test('features with no catalogue entry, and non-feature junk, are skipped', () => {
  const specs = simFeatureSpecs([
    { name: 'UnknownThing', ax: 1, ay: 1 },
    { ax: 2, ay: 2 },
    null,
  ], defs, 16)
  assert.equal(specs.length, 0)
})

test('a mixed field yields only the metal + vent, positioned at their cells', () => {
  const specs = simFeatureSpecs([
    { name: 'GreenTree1', ax: 0, ay: 0 },
    { name: 'RockMetal1', ax: 4, ay: 8 },
    { name: 'MetalVent01', ax: 12, ay: 3 },
  ], defs, 16)
  assert.equal(specs.length, 2)
  assert.deepEqual(specs.map((s) => s.kind).sort(), [0, 1])
})
