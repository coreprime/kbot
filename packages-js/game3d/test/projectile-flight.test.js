// projectile-flight.test.js — headless proofs for faithful weapon flight:
// ballistic arcs land ON the target, guided missiles steer at the TDF turn
// rate and detonate on proximity, torpedoes run below the waterline with a
// splash on impact.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizePackWeaponDef,
  spawnWeaponVisual,
  stepModelShots,
  TA_TURN_TO_RAD,
} from '../world-fx.js'

// Minimal binding: a particle pool that swallows emits, plus an explosion
// recorder so splash/fire dispatch is observable.
const makeBinding = () => {
  const spawns = []
  return {
    particles: { emit() {}, onExpire: null },
    explosions: { spawn(pos, opts) { spawns.push({ pos: pos.slice(), ...opts }) } },
    spawns,
  }
}

const stepUntilGone = (shots, binding, env, maxMs = 60000) => {
  let last = null
  let t = 0
  while (shots.length && t < maxMs) {
    // Record the live shot's position before the step that may expire it.
    last = { x: shots[0].x, y: shots[0].y, z: shots[0].z }
    stepModelShots(shots, 25, { env })
    t += 25
  }
  assert.ok(t < maxMs, 'shot must expire')
  return last
}

test('ballistic arc rises then lands at the target', () => {
  const def = normalizePackWeaponDef('cannon', {
    renderType: 1, model: 'shell', ballistic: 1, velocityWU: 150, rangeWU: 600, areaOfEffectWU: 24,
  })
  const binding = makeBinding()
  const shots = []
  const from = [0, 10, 0]
  const to = [300, 10, 100]
  const res = spawnWeaponVisual({ weapon: def, from, to, binding, modelShots: shots, gravity: 100 })
  assert.ok(res.modelShot, 'model plan expected')
  // The arc must actually rise above the straight chord.
  let peak = -Infinity
  const probe = [Object.assign({}, res.modelShot)]
  const mirror = probe[0]
  for (let i = 0; i < 200 && probe.length; i++) {
    peak = Math.max(peak, mirror.y)
    stepModelShots(probe, 25, {})
  }
  assert.ok(peak > 40, `arc peaks at ${peak}wu — must loft`)
  const last = stepUntilGone(shots, binding, {})
  const missXZ = Math.hypot(last.x - to[0], last.z - to[2])
  assert.ok(missXZ < 12, `ballistic shot lands ${missXZ}wu from the target`)
  assert.ok(Math.abs(last.y - to[1]) < 14, `lands near target height (y=${last.y})`)
})

test('guided missile steers onto a displaced target at its turn rate', () => {
  const def = normalizePackWeaponDef('missile', {
    renderType: 6, model: 'missile', guidance: 1, turnRate: 16384, velocityWU: 120,
    rangeWU: 900, areaOfEffectWU: 32,
  })
  assert.ok(def.turnRateRad > 1.5, 'turnrate 16384 ≈ π/2 rad/s')
  const binding = makeBinding()
  const shots = []
  spawnWeaponVisual({ weapon: def, from: [0, 20, 0], to: [400, 20, 0], binding, modelShots: shots })
  // The wire says the shot actually hit HERE — 90° off the launch bearing.
  const s = shots[0]
  s.tx = 0; s.ty = 20; s.tz = 250
  const last = stepUntilGone(shots, binding, {})
  const miss = Math.hypot(last.x - 0, last.z - 250)
  assert.ok(miss < 25, `guided shot detonates ${miss}wu from the steered target`)
})

test('guided turn rate limits the per-step bearing change', () => {
  const slow = normalizePackWeaponDef('m', { model: 'm', guidance: 1, turnRate: 2000, velocityWU: 100, rangeWU: 400 })
  const binding = makeBinding()
  const shots = []
  spawnWeaponVisual({ weapon: slow, from: [0, 0, 0], to: [200, 0, 0], binding, modelShots: shots })
  const s = shots[0]
  s.tx = 0; s.tz = 200 // 90° turn demanded
  const h0 = Math.atan2(s.vz, s.vx)
  stepModelShots(shots, 100, {}) // 0.1 s
  const h1 = Math.atan2(s.vz, s.vx)
  let turned = Math.abs(h1 - h0)
  if (turned > Math.PI) turned = 2 * Math.PI - turned
  const maxTurn = 2000 * TA_TURN_TO_RAD * 0.1
  assert.ok(turned <= maxTurn * 1.05, `turned ${turned} rad in 0.1s, cap ${maxTurn}`)
  assert.ok(turned > maxTurn * 0.5, 'and it does actually steer')
})

test('torpedo runs below the waterline and splashes on expiry', () => {
  const def = normalizePackWeaponDef('torp', {
    renderType: 6, model: 'torpedo', waterWeapon: 1, velocityWU: 100, rangeWU: 500, areaOfEffectWU: 40,
  })
  const binding = makeBinding()
  const shots = []
  const env = { waterY: 30 }
  spawnWeaponVisual({ weapon: def, from: [0, 28, 0], to: [300, 28, 0], binding, modelShots: shots, env })
  let minY = Infinity, maxY = -Infinity
  while (shots.length) {
    minY = Math.min(minY, shots[0].y)
    maxY = Math.max(maxY, shots[0].y)
    stepModelShots(shots, 25, { env })
  }
  assert.ok(maxY <= 30, `torpedo must stay at/below the waterline (maxY=${maxY})`)
  assert.ok(minY >= 30 - 6.5, `and hold running depth (minY=${minY})`)
  const splash = binding.spawns.find((sp) => sp.kind === 'splash')
  assert.ok(splash, 'underwater detonation splashes')
})

test('impacts at/below the waterline splash; above it they burn', () => {
  const def = normalizePackWeaponDef('gun', { model: 'shell', velocityWU: 200, rangeWU: 300, areaOfEffectWU: 20 })
  const wet = makeBinding()
  const wetShots = []
  spawnWeaponVisual({ weapon: def, from: [0, 40, 0], to: [100, 5, 0], binding: wet, modelShots: wetShots, env: { waterY: 10 } })
  while (wetShots.length) stepModelShots(wetShots, 25, { env: { waterY: 10 } })
  assert.ok(wet.spawns.some((sp) => sp.kind === 'splash'), 'below waterline → splash')

  const dry = makeBinding()
  const dryShots = []
  spawnWeaponVisual({ weapon: def, from: [0, 40, 0], to: [100, 35, 0], binding: dry, modelShots: dryShots, env: { waterY: 10 } })
  while (dryShots.length) stepModelShots(dryShots, 25, { env: { waterY: 10 } })
  assert.ok(dry.spawns.every((sp) => sp.kind !== 'splash'), 'above waterline → no splash')
})

test('terrain detonates a shot early', () => {
  const def = normalizePackWeaponDef('cannon', { model: 'shell', ballistic: 1, velocityWU: 120, rangeWU: 600, areaOfEffectWU: 24 })
  const binding = makeBinding()
  const shots = []
  spawnWeaponVisual({ weapon: def, from: [0, 10, 0], to: [300, 10, 0], binding, modelShots: shots, gravity: 100 })
  // A 60wu-tall ridge at x≥150 interrupts the flight.
  const env = { heightAt: (x) => (x >= 150 ? 60 : 0) }
  let last = null
  while (shots.length) {
    last = { x: shots[0].x, y: shots[0].y }
    stepModelShots(shots, 25, { env })
  }
  assert.ok(last.x < 300, `shot must stop at the ridge (x=${last.x})`)
})
