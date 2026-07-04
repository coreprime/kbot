// world-fx.test.js — headless proofs for the data-driven weapon + death
// presentation (world-fx.js): a pack laser def yields a palette-tinted beam
// of pulse particles along the firing line, a missile def flies its packed
// mesh with a smoke trail, the D-gun classifies onto its fireball particle,
// severity picks wreck vs debris, and damaged units smoke on the TA health
// ladder.  Everything runs against a bare ParticlePool — no WebGL, no DOM.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ParticlePool } from '../cob-particles.js'
import { TAPalette } from '../palette.js'
import {
  SFX_PROJECTILE_LASER,
  SFX_PROJECTILE_DGUN,
} from '../weapon-driver.js'
import {
  normalizePackWeaponDef,
  weaponVisualPlan,
  spawnWeaponVisual,
  resolveDeathPlan,
  unitRocksOnImpact,
  damageSmokeIntervalMs,
  debrisBurst,
  stepDebris,
  stepModelShots,
  modelShotPose,
  impactBurst,
} from '../world-fx.js'
import { ExplosionManager } from '../explosion-fx.js'
import { raycastTerrain } from '../terrain-los.js'
import { createTerrainSampler } from '../terrain-sample.js'
import { IMPULSE_KICK_SCALE } from '../create-world.js'

// A palette where index 232 (the ARM laser green) is pure green.
const palette = new TAPalette(Array.from({ length: 256 }, (_, i) => (i === 232 ? [0, 255, 0] : [128, 128, 128])))

const binding = () => ({ particles: new ParticlePool(2048) })

// Pack v4 weapons.json shapes (see internal/studio/pack_weapons.go).
const LASER_DEF = normalizePackWeaponDef('armcomlaser', {
  id: 'armcomlaser', renderType: 0, beamWeapon: true,
  colorIdx: 232, color2Idx: 234, durationSec: 0.03,
  velocityWU: 400, rangeWU: 200, areaOfEffectWU: 16,
})
const ROCKET_DEF = normalizePackWeaponDef('armrl_missile', {
  id: 'armrl_missile', renderType: 1, model: 'missile',
  smokeTrail: true, smokeDelaySec: 0.05, velocityWU: 250,
  rangeWU: 500, areaOfEffectWU: 48,
})
const DGUN_DEF = normalizePackWeaponDef('arm_disintegrator', {
  id: 'arm_disintegrator', renderType: 3, beamWeapon: true, commandFire: true,
  model: 'dgun', startSmoke: true, velocityWU: 200, rangeWU: 240, areaOfEffectWU: 48,
})

test('weaponVisualPlan classifies laser/missile/dgun correctly', () => {
  assert.equal(weaponVisualPlan(LASER_DEF), 'beam')
  assert.equal(weaponVisualPlan(ROCKET_DEF), 'model')
  assert.equal(weaponVisualPlan(DGUN_DEF), 'particle') // the fireball, not the mesh
})

test('a laser id yields a palette-green pulse-chain beam along the line', () => {
  const b = binding()
  const res = spawnWeaponVisual({
    weapon: LASER_DEF,
    from: [0, 10, 0],
    to: [120, 10, 0],
    binding: b,
    palette,
  })
  assert.equal(res.plan, 'beam')
  const pool = b.particles
  let beam = 0
  let minX = Infinity, maxX = -Infinity
  for (let i = 0; i < pool.count; i++) {
    if (pool.kind[i] !== SFX_PROJECTILE_LASER) continue
    beam++
    // Palette idx 232 is pure green — the beam tint must carry green and
    // essentially no red (brightness scaling keeps the hue).
    assert.ok(pool.g[i] > 0.5, `pulse ${i} green ${pool.g[i]}`)
    assert.ok(pool.r[i] < 0.05, `pulse ${i} red ${pool.r[i]}`)
    minX = Math.min(minX, pool.x[i])
    maxX = Math.max(maxX, pool.x[i])
  }
  assert.ok(beam >= 12, `beam pulse chain too sparse: ${beam}`)
  assert.ok(minX <= 1 && maxX >= 119, `beam does not span muzzle→target: [${minX}, ${maxX}]`)
})

test('a model weapon flies its packed mesh with a smoke trail scheduled', () => {
  const b = binding()
  const shots = []
  const trails = { calls: [], schedule(...a) { this.calls.push(a) }, tick() {}, clear() {} }
  const res = spawnWeaponVisual({
    weapon: ROCKET_DEF,
    from: [0, 5, 0],
    to: [0, 5, 300],
    binding: b,
    palette,
    smokeTrails: trails,
    modelShots: shots,
  })
  assert.equal(res.plan, 'model')
  assert.equal(shots.length, 1)
  assert.equal(shots[0].modelName, 'missile')
  assert.equal(trails.calls.length, 1, 'smokeTrail=1 must schedule a wake')
  // TDF smokedelay carries through as the puff cadence.
  assert.ok(Math.abs(trails.calls[0][5] - 50) < 1e-9, `interval ${trails.calls[0][5]}`)
  // Flight: pose faces +Z (game heading π), pitch level.
  const pose = modelShotPose(shots[0])
  assert.ok(Math.abs(Math.abs(pose.heading) - Math.PI) < 1e-6)
  assert.ok(Math.abs(pose.pitch) < 1e-6)
  // Step to expiry: the shot advances toward the target then detonates
  // with an impact burst in the pool.
  const before = b.particles.count
  for (let i = 0; i < 100; i++) stepModelShots(shots, 40)
  assert.equal(shots.length, 0, 'shot should expire')
  assert.ok(b.particles.count > before, 'impact burst should emit particles')
})

test('the D-gun spawns its signature fireball particle', () => {
  const b = binding()
  const res = spawnWeaponVisual({
    weapon: DGUN_DEF,
    from: [0, 8, 0],
    to: [200, 8, 0],
    binding: b,
    palette,
  })
  assert.equal(res.plan, 'particle')
  assert.ok(res.isDgun, 'classifier must pick the D-gun kind')
  let dgun = 0
  for (let i = 0; i < b.particles.count; i++) {
    if (b.particles.kind[i] === SFX_PROJECTILE_DGUN) dgun++
  }
  assert.equal(dgun, 1)
})

test('resolveDeathPlan follows the corpsetype severity ladder', () => {
  assert.deepEqual(
    resolveDeathPlan({ severity: 10, corpse: 'armpw_dead', heapCorpse: '2x2f' }),
    { debris: false, corpse: 'armpw_dead' })
  assert.deepEqual(
    resolveDeathPlan({ severity: 60, corpse: 'armpw_dead', heapCorpse: '2x2f' }),
    { debris: true, corpse: '2x2f' })
  assert.deepEqual(
    resolveDeathPlan({ severity: 150, corpse: 'armpw_dead', heapCorpse: '2x2f' }),
    { debris: true, corpse: null })
  assert.deepEqual(resolveDeathPlan({}), { debris: false, corpse: null })
})

test('damage smoke starts below 2/3 health and quickens toward death', () => {
  assert.equal(damageSmokeIntervalMs(1), null)
  assert.equal(damageSmokeIntervalMs(0.7), null)
  const mid = damageSmokeIntervalMs(0.5)
  const low = damageSmokeIntervalMs(0.1)
  assert.ok(mid > low, `smoke cadence must quicken: ${mid} vs ${low}`)
  assert.ok(low >= 260, 'cadence floor keeps the pool sane')
})

test('debris pieces scatter outward and fall under gravity', () => {
  // A fake model: three pieces with live move/rotate channels.
  const mkPiece = () => ({ move: [0, 0, 0], rotate: [0, 0, 0] })
  const model = { flat: [mkPiece(), mkPiece(), mkPiece()] }
  // Seeded rng for a reproducible assertion.
  let s = 42
  const rng = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
  const pieces = debrisBurst(model, { rng })
  assert.equal(pieces.length, 3)
  for (let i = 0; i < 30; i++) stepDebris(pieces, 33)
  let displaced = 0
  let falling = 0
  for (const d of pieces) {
    const dist = Math.hypot(d.piece.move[0], d.piece.move[2])
    if (dist > 5) displaced++
    if (d.vy < 0) falling++
    assert.ok(
      Math.abs(d.piece.rotate[0]) + Math.abs(d.piece.rotate[1]) + Math.abs(d.piece.rotate[2]) > 0.1,
      'pieces must tumble')
  }
  assert.ok(displaced >= 2, `pieces should scatter outward (${displaced}/3)`)
  assert.equal(falling, 3, 'gravity must be pulling every piece down by 1s in')
})

test('unitRocksOnImpact keeps structures planted and hulls rocking', () => {
  // Explicit flag wins in both directions.
  assert.equal(unitRocksOnImpact({ mobile: false, grounded: true }), false)
  assert.equal(unitRocksOnImpact({ mobile: false, grounded: false }), false)
  assert.equal(unitRocksOnImpact({ mobile: true, grounded: true, _moved: false }), true)
  // Inference: a grounded unit that has never moved reads as a structure…
  assert.equal(unitRocksOnImpact({ grounded: true }), false)
  assert.equal(unitRocksOnImpact({ grounded: true, _moved: false }), false)
  // …but the motion latch flips it to a mobile hull for good.
  assert.equal(unitRocksOnImpact({ grounded: true, _moved: true }), true)
  // Non-grounded records (air, hover over water, ships) always rock.
  assert.equal(unitRocksOnImpact({ grounded: false }), true)
  assert.equal(unitRocksOnImpact({ air: true }), true)
  // No record → no rock.
  assert.equal(unitRocksOnImpact(null), false)
})

test('a terrain-blocked shot bursts AT the ridge hit point, not as a faint puff', () => {
  // Build the ridge from terrain-los.test.js: a shot from low ground at a
  // low-ground target behind a tall ridge is blocked ON the ridge face.
  const w = 21, h = 5
  const heights = new Array(w * h).fill(0)
  for (let cz = 0; cz < h; cz++) for (const cx of [9, 10, 11]) heights[cz * w + cx] = 120
  const { heightAt } = createTerrainSampler({ heights, w, h, cellWU: 16, heightScale: 1 })
  const from = [8, 30, 32], to = [312, 30, 32]
  const hit = raycastTerrain(from, to, heightAt)
  assert.ok(hit, 'the ridge blocks the shot')

  // The impact fires at the raycast hit point (the ridge), scaled to the
  // weapon, as a REAL burst: particles emitted + a polygonal explosion-manager
  // detonation at the hit point — not the old lone faint puff.
  const b = { particles: new ParticlePool(2048), explosions: new ExplosionManager() }
  impactBurst(b, hit.point, { aoe: 48, terrain: true })

  // A visible burst emits multiple particles (flash + dirt + several sparks),
  // clearly more than the old 1-puff-plus-2-sparks floor.
  assert.ok(b.particles.count >= 6, `terrain block should be a real burst, got ${b.particles.count} particles`)

  // The explosion manager detonated exactly at the raycast hit point (the
  // ridge), NOT at the untouched target far away.
  assert.equal(b.explosions.liveCount, 1, 'a polygonal burst fires at the block')
  const rec = b.explosions._live[0]
  assert.ok(Math.abs(rec.x - hit.point[0]) < 1e-6 && Math.abs(rec.z - hit.point[2]) < 1e-6,
    `burst sits on the ridge hit (${rec.x.toFixed(0)},${rec.z.toFixed(0)}) not the target (312)`)
  assert.ok(rec.x < 200, 'the burst is on the ridge, well short of the shielded target')

  // Every emitted particle sits at the ridge, not downrange at the target.
  for (let i = 0; i < b.particles.count; i++) {
    assert.ok(b.particles.x[i] < 200, `particle ${i} at x=${b.particles.x[i]} should be on the ridge`)
  }
})

test('hit-rock amplitude is scaled to 0.6× (40% gentler lean)', () => {
  // The kick velocity is linear in the resulting lean, so the amplitude scale
  // is exactly IMPULSE_KICK_SCALE. It must be 0.6 × the previous 0.55 = 0.33.
  const PREVIOUS_KICK = 0.55
  assert.ok(Math.abs(IMPULSE_KICK_SCALE - PREVIOUS_KICK * 0.6) < 1e-9,
    `kick scale ${IMPULSE_KICK_SCALE} must be 0.6 × ${PREVIOUS_KICK}`)
})
