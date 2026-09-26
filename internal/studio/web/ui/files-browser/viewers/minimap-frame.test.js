// node --test coverage for the TNT viewer's minimap region mapping.

import test from 'node:test'
import assert from 'node:assert/strict'
import { frameFromDescribe, mapToMinimap, minimapToMap } from './minimap-frame.js'

// A 64×32-tile map: 2048×1024 px, visible 2016×896, region 252×112.
const describe = {
  pixelW: 2048, pixelH: 1024, minimapW: 252, minimapH: 252,
  minimapFrame: { contentW: 252, contentH: 112, visibleW: 2016, visibleH: 896 },
}

test('the visible map fills the minimap region only', () => {
  const f = frameFromDescribe(describe)
  const far = mapToMinimap(2016 / 2048, 896 / 1024, f)
  assert.ok(Math.abs(far.x - 1) < 1e-9)
  assert.ok(Math.abs(far.y - 112 / 252) < 1e-9)
  const origin = mapToMinimap(0, 0, f)
  assert.deepEqual(origin, { x: 0, y: 0 })
})

test('minimap clicks map back to the same map point', () => {
  const f = frameFromDescribe(describe)
  const p = mapToMinimap(0.3, 0.6, f)
  const back = minimapToMap(p.x, p.y, f)
  assert.ok(Math.abs(back.u - 0.3) < 1e-9)
  assert.ok(Math.abs(back.v - 0.6) < 1e-9)
})

test('without a region the minimap maps to the whole map', () => {
  const f = frameFromDescribe({ pixelW: 100, pixelH: 100 })
  assert.deepEqual(f, { fx: 1, fy: 1, vx: 1, vy: 1 })
  assert.deepEqual(mapToMinimap(0.25, 0.5, f), { x: 0.25, y: 0.5 })
})
