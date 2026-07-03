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
  damageSmokeIntervalMs,
  debrisBurst,
  stepDebris,
  stepModelShots,
  modelShotPose,
} from '../world-fx.js'

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
