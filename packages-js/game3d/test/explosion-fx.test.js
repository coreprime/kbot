// explosion-fx.test.js — headless proofs for the polygonal explosion
// system's size ladder AND its readability disciplines: coalescing,
// the global concurrency cap and the luminance soft-clip.  These caps are
// correctness requirements (the commander-death barrage must stay
// readable), so they are asserted, not eyeballed.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ExplosionManager,
  tierFor,
  MAX_CONCURRENT,
  MAX_PER_BUCKET,
  COALESCE_BUCKET_WU,
  BUDGET_FREE_COUNT,
} from '../explosion-fx.js'

test('size ladder: aoe + death severity pick sensible tiers', () => {
  assert.equal(tierFor({ aoe: 8 }), 'small')          // small-arms round
  assert.equal(tierFor({ aoe: 48 }), 'medium')        // cannon shell
  assert.equal(tierFor({ aoe: 128 }), 'large')        // heavy plasma
  assert.equal(tierFor({ aoe: 512 }), 'huge')         // nuke-class
  // Deaths climb a rung; catastrophic severity tops out.
  assert.equal(tierFor({ aoe: 8, kind: 'death' }), 'medium')
  assert.equal(tierFor({ aoe: 48, kind: 'death' }), 'large')
  assert.equal(tierFor({ aoe: 48, kind: 'death', severity: 120 }), 'huge')
  // Water impacts splash regardless of size.
  assert.equal(tierFor({ aoe: 48, kind: 'splash' }), 'splash')
})

test('a single small hit is brief and tight', () => {
  const m = new ExplosionManager()
  const rec = m.spawn([0, 0, 0], { aoe: 8 })
  assert.ok(rec.lifeMs <= 400, `small hit lasts ${rec.lifeMs}ms — must be brief`)
  assert.ok(rec.rMax <= 12, `small hit radius ${rec.rMax}wu — must stay tight`)
})

test('coalescing: hammering one spot never stacks past MAX_PER_BUCKET', () => {
  const m = new ExplosionManager()
  for (let i = 0; i < 20; i++) {
    m.spawn([10 + (i % 3), 0, 12], { aoe: 16 })
    m.step(10)
  }
  const inBucket = m._live.filter((r) => r.bucket === m._bucketKey(10, 12))
  assert.ok(inBucket.length <= MAX_PER_BUCKET,
    `bucket holds ${inBucket.length} live effects, cap is ${MAX_PER_BUCKET}`)
})

test('coalescing: a bigger detonation upgrades the bucket record in place', () => {
  const m = new ExplosionManager()
  m.spawn([0, 0, 0], { aoe: 8 })
  m.spawn([1, 0, 1], { aoe: 8 })
  const before = m.liveCount
  const rec = m.spawn([2, 0, 2], { aoe: 300, kind: 'death', severity: 120 })
  assert.equal(m.liveCount, before, 'no new record added')
  assert.equal(rec.tier, 'huge', 'strongest record upgraded')
})

test('global cap: a map-wide barrage never exceeds MAX_CONCURRENT', () => {
  const m = new ExplosionManager()
  for (let i = 0; i < 200; i++) {
    // Spread far apart so bucket coalescing can't absorb them.
    m.spawn([i * COALESCE_BUCKET_WU * 2, 0, (i % 7) * COALESCE_BUCKET_WU * 3], { aoe: 40 })
  }
  assert.ok(m.liveCount <= MAX_CONCURRENT,
    `live=${m.liveCount}, cap=${MAX_CONCURRENT}`)
})

test('luminance soft-clip: per-vertex alpha dims as the barrage grows', () => {
  const maxAlpha = (m) => {
    m.step(0)
    const d = m.tris()
    let a = 0
    for (let i = 6; i < m.vertCount() * 7; i += 7) a = Math.max(a, d[i])
    return a
  }
  const calm = new ExplosionManager()
  calm.spawn([0, 0, 0], { aoe: 40 })
  const calmA = maxAlpha(calm)

  const barrage = new ExplosionManager()
  for (let i = 0; i < MAX_CONCURRENT * 2; i++) {
    barrage.spawn([i * COALESCE_BUCKET_WU * 2, 0, i * COALESCE_BUCKET_WU], { aoe: 40 })
  }
  assert.ok(barrage.liveCount > BUDGET_FREE_COUNT)
  const stressA = maxAlpha(barrage)
  assert.ok(stressA < calmA,
    `under barrage max alpha ${stressA} must dim below calm ${calmA}`)
  // And the dim factor matches the documented sqrt law.
  const expected = Math.sqrt(BUDGET_FREE_COUNT / barrage.liveCount)
  assert.ok(Math.abs(stressA / calmA - expected) < 0.05)
})

test('scene lights are capped and budget-dimmed too', () => {
  const m = new ExplosionManager()
  for (let i = 0; i < 40; i++) {
    m.spawn([i * COALESCE_BUCKET_WU * 2, 0, 0], { aoe: 200 })
  }
  const lights = m.lights()
  assert.ok(lights.length <= 5, `lights=${lights.length}`)
  for (const l of lights) assert.ok(l.strength < 200, 'strength bounded')
})

test('splash tier: no fire light, geometry present', () => {
  const m = new ExplosionManager()
  m.spawn([0, 0, 0], { aoe: 40, kind: 'splash' })
  m.step(50)
  assert.ok(m.vertCount() > 0, 'splash renders geometry')
  assert.equal(m.lights().length, 0, 'splash casts no fire light')
})

test('deterministic: same spawn sequence + steps → identical buffers', () => {
  const run = () => {
    const m = new ExplosionManager()
    m.spawn([10, 0, 20], { aoe: 30 })
    m.step(40)
    m.spawn([60, 2, -10], { aoe: 90, kind: 'death', severity: 60 })
    m.step(40)
    m.step(40)
    return Array.from(m.tris().subarray(0, m.vertCount() * 7))
  }
  assert.deepEqual(run(), run())
})

test('records expire and the buffer drains', () => {
  const m = new ExplosionManager()
  m.spawn([0, 0, 0], { aoe: 16 })
  m.step(10)
  assert.ok(m.vertCount() > 0)
  m.step(5000)
  assert.equal(m.liveCount, 0)
  assert.equal(m.vertCount(), 0)
})
