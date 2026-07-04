// terrain-los.test.js — headless proofs for the shot-vs-terrain raycast:
// a shot fired over flat ground reaches its target, a shot fired at a unit
// behind a ridge terminates ON the ridge (not the endpoint), and the impact
// point lands on the rise's near face.
import test from 'node:test'
import assert from 'node:assert/strict'

import { raycastTerrain, LOS_END_SKIN_WU } from '../terrain-los.js'
import { createTerrainSampler } from '../terrain-sample.js'

// A flat sampler: ground at y=0 everywhere — nothing ever blocks.
const FLAT = () => 0

test('a shot over flat ground is never blocked', () => {
  const hit = raycastTerrain([0, 20, 0], [200, 20, 0], FLAT)
  assert.equal(hit, null, 'clear line of fire')
})

test('a shot at a unit behind a ridge terminates ON the ridge, not the target', () => {
  // Build a heightfield with a wall of raised cells in the middle: a ridge
  // running across the X span between shooter (x≈0) and target (x≈320).
  // Cells are 16wu; a 21-wide field spans 0..320wu.  Columns 9..11 (x≈144..176)
  // rise to a tall ridge; everything else is flat ground.
  const w = 21, h = 5
  const heights = new Array(w * h).fill(0)
  for (let cz = 0; cz < h; cz++) {
    for (const cx of [9, 10, 11]) heights[cz * w + cx] = 120
  }
  const { heightAt } = createTerrainSampler({ heights, w, h, cellWU: 16, heightScale: 1 })

  // Shooter fires from low ground at a target on the far low ground, at a
  // height (30) well BELOW the 120 ridge — the ridge blocks the line.
  const from = [8, 30, 32]
  const to = [312, 30, 32]
  const hit = raycastTerrain(from, to, heightAt)
  assert.ok(hit, 'the ridge blocks the shot')
  // The impact lands on the ridge (x ≈ 144..176), well short of the target.
  assert.ok(hit.point[0] > 120 && hit.point[0] < 200,
    `impact at x=${hit.point[0].toFixed(0)} sits on the ridge, not the target (x=312)`)
  assert.ok(hit.dist < Math.hypot(to[0] - from[0], to[2] - from[2]) - 100,
    'impact is far short of the target')
  // The impact point sits on (not below) the terrain surface it struck.
  assert.ok(Math.abs(hit.point[1] - heightAt(hit.point[0], hit.point[2])) < 5,
    'impact lands on the slope face')
})

test('a shot that clears the ridge (fired high) reaches the target', () => {
  const w = 21, h = 5
  const heights = new Array(w * h).fill(0)
  for (let cz = 0; cz < h; cz++) {
    for (const cx of [9, 10, 11]) heights[cz * w + cx] = 120
  }
  const { heightAt } = createTerrainSampler({ heights, w, h, cellWU: 16, heightScale: 1 })
  // Both ends high above the ridge crest — a lobbed/high shot clears it.
  const hit = raycastTerrain([8, 200, 32], [312, 200, 32], heightAt)
  assert.equal(hit, null, 'a shot above the crest is not blocked')
})

test('endpoint skin: a shot grazing its own target hilltop is not misfired', () => {
  // Target sits ON a hill; the muzzle is level with it and close.  The dip at
  // the very ends (within LOS_END_SKIN_WU) must not count as a block.
  const w = 5, h = 5
  const heights = new Array(w * h).fill(50)
  const { heightAt } = createTerrainSampler({ heights, w, h, cellWU: 16, heightScale: 1 })
  // Both endpoints sit a hair above the flat 50-high plateau.
  const hit = raycastTerrain([16, 52, 16], [48, 52, 16], heightAt)
  assert.equal(hit, null, 'grazing the shared surface at the ends does not block')
  void LOS_END_SKIN_WU
})
