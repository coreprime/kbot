// terrain-sample.test.js — headless proofs for the battlefield surface
// sampler (terrain-sample.js): heightAt matches the renderer's mesh
// triangulation exactly, the display heightScale applies, edges clamp, and
// normals tilt toward downhill.  Pure math — runs under `node --test`.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createTerrainSampler } from '../terrain-sample.js'

const CELL = 16
const SCALE = 0.61

// A 3×3 height field with a single-cell hill in the middle column:
//   0 100   0
//   0 100   0
//   0 100   0
const field = () => createTerrainSampler({
  heights: [0, 100, 0, 0, 100, 0, 0, 100, 0],
  w: 3,
  h: 3,
  cellWU: CELL,
  heightScale: SCALE,
})

test('heightAt returns vertex heights × heightScale at cell corners', () => {
  const t = field()
  assert.equal(t.heightAt(0, 0), 0)
  assert.equal(t.heightAt(CELL, 0), 100 * SCALE)
  assert.equal(t.heightAt(2 * CELL, 2 * CELL), 0)
})

test('heightAt interpolates along the mesh triangulation between corners', () => {
  const t = field()
  // Halfway up the western slope of the ridge.
  assert.ok(Math.abs(t.heightAt(CELL / 2, 0) - 50 * SCALE) < 1e-9)
  // The quad diagonal split: at the exact cell centre both triangles of the
  // (0,0)..(1,1) cell agree on (y00 + y11)/2 + correction; sample a point in
  // each half and check monotonic rise toward the ridge.
  const low = t.heightAt(CELL * 0.25, CELL * 0.75)
  const high = t.heightAt(CELL * 0.75, CELL * 0.25)
  assert.ok(high > low, `ridge-side sample (${high}) should top valley-side (${low})`)
})

test('heightAt clamps outside the map instead of extrapolating', () => {
  const t = field()
  assert.equal(t.heightAt(-500, -500), t.heightAt(0, 0))
  assert.equal(t.heightAt(9999, 9999), t.heightAt(2 * CELL, 2 * CELL))
})

test('rawHeightAt reports source units (no display scale)', () => {
  const t = field()
  assert.equal(t.rawHeightAt(CELL, 0), 100)
})

test('normalAt tilts away from the ridge and is unit length', () => {
  const t = field()
  // West of the ridge the surface rises toward +X, so the normal leans -X.
  const n = t.normalAt(CELL * 0.5, CELL)
  assert.ok(n[0] < -0.01, `normal x = ${n[0]}, want < 0 on the west slope`)
  // The test ridge is a cliff (61 wu over one 16 wu cell), so up is small
  // but must stay positive.
  assert.ok(n[1] > 0.05, `normal up ${n[1]} must stay positive`)
  const len = Math.hypot(n[0], n[1], n[2])
  assert.ok(Math.abs(len - 1) < 1e-6, `normal length ${len}`)
  // Flat ground far from the hill: straight up.
  const flat = createTerrainSampler({ heights: new Array(9).fill(7), w: 3, h: 3, cellWU: CELL, heightScale: SCALE })
  const nf = flat.normalAt(CELL, CELL)
  assert.ok(Math.abs(nf[0]) < 1e-9 && Math.abs(nf[2]) < 1e-9 && Math.abs(nf[1] - 1) < 1e-9)
})

test('empty field degrades to a flat plane at 0', () => {
  const t = createTerrainSampler({ heights: null, w: 0, h: 0 })
  assert.equal(t.heightAt(10, 10), 0)
  assert.deepEqual(t.normalAt(10, 10), [0, 1, 0])
})
