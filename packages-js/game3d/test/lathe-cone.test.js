// lathe-cone.test.js — headless proofs for the build nanolathe cone spray
// (world-fx.js latheConeSpray).  The construction lathe must read as a dense
// CONE of fine bright-green motes streaming from the builder's nano nozzle
// and CONVERGING on the build target — not a sparse train of discrete blobs.
// Everything runs against a bare ParticlePool: no WebGL, no DOM.

import test from 'node:test'
import assert from 'node:assert/strict'

import { ParticlePool, SFX_NANO_PARTICLES } from '../cob-particles.js'
import { mulberry32 } from '../map-features.js'
import {
  latheConeSpray,
  LATHE_CONE_PARTICLES,
  LATHE_CONE_HALF_ANGLE,
} from '../world-fx.js'

const FROM = [0, 10, 0]
const TO = [100, 10, 0]

// angleOffAxis returns the angle (radians) between a velocity and the
// nozzle→target axis.
function angleOffAxis(vel, from, to) {
  const ax = to[0] - from[0], ay = to[1] - from[1], az = to[2] - from[2]
  const al = Math.hypot(ax, ay, az) || 1
  const vl = Math.hypot(vel[0], vel[1], vel[2]) || 1
  const dot = (vel[0] * ax + vel[1] * ay + vel[2] * az) / (al * vl)
  return Math.acos(Math.max(-1, Math.min(1, dot)))
}

test('emits a burst of motes per tick (a cone, not one blob)', () => {
  const pool = new ParticlePool()
  const rng = mulberry32(1)
  const res = latheConeSpray(pool, { from: FROM, to: TO, rng })
  assert.equal(res.emitted, LATHE_CONE_PARTICLES)
  assert.ok(LATHE_CONE_PARTICLES >= 5, 'a cone sprays many motes, not one')
  assert.equal(pool.count, LATHE_CONE_PARTICLES)
  // Every mote is a nano particle.
  for (let i = 0; i < pool.count; i++) {
    assert.equal(pool.kind[i], SFX_NANO_PARTICLES)
  }
})

test('every mote stays within the cone half-angle and points at the target', () => {
  const pool = new ParticlePool()
  const rng = mulberry32(42)
  const res = latheConeSpray(pool, { from: FROM, to: TO, rng })
  // The reported widest deflection never exceeds the cone half-angle.
  assert.ok(res.maxAngleRad <= LATHE_CONE_HALF_ANGLE + 1e-6,
    `maxAngle ${res.maxAngleRad} <= half-angle ${LATHE_CONE_HALF_ANGLE}`)
  // Independently confirm from each live particle's velocity.
  for (let i = 0; i < pool.count; i++) {
    const ang = angleOffAxis([pool.vx[i], pool.vy[i], pool.vz[i]], FROM, TO)
    assert.ok(ang <= LATHE_CONE_HALF_ANGLE + 1e-6,
      `mote ${i} deflection ${ang} within cone`)
    // All motes travel toward the target (positive along-axis component).
    assert.ok(pool.vx[i] > 0, 'mote travels toward the +X target')
  }
  // A genuine SPREAD exists — not every mote is perfectly on-axis.
  assert.ok(res.maxAngleRad > 0.01, 'the cone actually spreads off-axis')
})

test('the cone originates at the nozzle and converges toward the target', () => {
  const pool = new ParticlePool()
  const rng = mulberry32(7)
  const res = latheConeSpray(pool, { from: FROM, to: TO, rng })
  assert.equal(res.converges, true, 'aim points lie within the target-jitter disc')
  // Motes spawn AT the nozzle (from), not scattered along the span.
  for (let i = 0; i < pool.count; i++) {
    assert.equal(pool.x[i], FROM[0])
    assert.equal(pool.y[i], FROM[1])
    assert.equal(pool.z[i], FROM[2])
  }
  // Convergence: every mote's aim point lands within a tight disc around
  // `to` (radius = span * target-jitter), so the fan narrows ONTO the
  // target rather than splaying past it.  Confirm each mote's line, extended
  // to the target's along-axis distance, lands inside that disc.
  // FROM=[0,10,0], TO=[100,10,0]: the axis is +X, so a mote's line reaches
  // the target plane at t = dist / (vx/|v|).  Its miss off `to` in the YZ
  // plane must lie within the convergence disc.
  const targetRadius = res.dist * 0.06 + 1e-3 // LATHE_CONE_TARGET_JITTER
  for (let i = 0; i < pool.count; i++) {
    const vl = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i]) || 1
    const t = res.dist / (pool.vx[i] / vl)
    const hitY = FROM[1] + (pool.vy[i] / vl) * t
    const hitZ = FROM[2] + (pool.vz[i] / vl) * t
    const miss = Math.hypot(hitY - TO[1], hitZ - TO[2])
    assert.ok(miss <= targetRadius,
      `mote ${i} converges onto the target (miss ${miss} <= ${targetRadius})`)
  }
})

test('motes are fine and short-lived (soft haze, not hard blobs)', () => {
  const pool = new ParticlePool()
  const rng = mulberry32(99)
  latheConeSpray(pool, { from: FROM, to: TO, rng })
  for (let i = 0; i < pool.count; i++) {
    assert.ok(pool.size[i] <= 3.0, `mote ${i} is fine (size ${pool.size[i]})`)
    assert.ok(pool.life[i] > 0 && pool.life[i] <= 520,
      `mote ${i} is short-lived (life ${pool.life[i]})`)
    // Motes FADE (no noFade) so the cone is a translucent haze.
    assert.equal(pool.noFade[i], 0, `mote ${i} fades over its life`)
  }
})

test('deterministic under a seeded rng — same seed sprays identically', () => {
  const a = new ParticlePool()
  const b = new ParticlePool()
  latheConeSpray(a, { from: FROM, to: TO, rng: mulberry32(123) })
  latheConeSpray(b, { from: FROM, to: TO, rng: mulberry32(123) })
  assert.equal(a.count, b.count)
  for (let i = 0; i < a.count; i++) {
    assert.equal(a.vx[i], b.vx[i], `mote ${i} vx deterministic`)
    assert.equal(a.vy[i], b.vy[i], `mote ${i} vy deterministic`)
    assert.equal(a.vz[i], b.vz[i], `mote ${i} vz deterministic`)
    assert.equal(a.size[i], b.size[i], `mote ${i} size deterministic`)
    assert.equal(a.life[i], b.life[i], `mote ${i} life deterministic`)
  }
  // A different seed must produce a different spray (no accidental constant).
  const c = new ParticlePool()
  latheConeSpray(c, { from: FROM, to: TO, rng: mulberry32(999) })
  let differs = false
  for (let i = 0; i < Math.min(a.count, c.count); i++) {
    if (a.vx[i] !== c.vx[i] || a.vy[i] !== c.vy[i] || a.vz[i] !== c.vz[i]) {
      differs = true
      break
    }
  }
  assert.ok(differs, 'a different seed yields a different cone')
})

test('no crash and no emission on degenerate endpoints', () => {
  const pool = new ParticlePool()
  const res = latheConeSpray(pool, { from: null, to: TO, rng: mulberry32(1) })
  assert.equal(res.emitted, 0)
  assert.equal(pool.count, 0)
})
