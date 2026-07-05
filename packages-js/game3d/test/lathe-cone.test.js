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
  nanoPieceNames,
  LATHE_CONE_PARTICLES,
  LATHE_CONE_HALF_ANGLE,
  LATHE_CONE_LIFE_MAX_MS,
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
  // A cone is several motes per tick (not one), streamed every ~26 ms so a
  // handful per tick accumulates into a dense stream — bigger/brighter motes
  // carry the read, so the per-tick count stays modest to keep the additive
  // load (and the luminance governor) sane when many builds run at once.
  assert.ok(LATHE_CONE_PARTICLES >= 3, 'a cone sprays several motes, not one')
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

test('motes are chunky enough to read + short-lived (visible cone, not blobs)', () => {
  const pool = new ParticlePool()
  const rng = mulberry32(99)
  latheConeSpray(pool, { from: FROM, to: TO, rng })
  for (let i = 0; i < pool.count; i++) {
    // Motes are sized to actually READ at gameplay distance — fine 1–2 px
    // points vanished into the terrain (the construction-spray-invisible
    // bug). Bounded so the cone is a spray, not a wall of big quads.
    assert.ok(pool.size[i] >= 2.0 && pool.size[i] <= 7.0,
      `mote ${i} is a readable spray mote (size ${pool.size[i]})`)
    // Life covers the whole crossing + slack so the mote reaches the build,
    // but is still bounded by the ceiling so a long span isn't a persistent
    // wall of motes.
    assert.ok(pool.life[i] > 0 && pool.life[i] <= LATHE_CONE_LIFE_MAX_MS,
      `mote ${i} lives within the ceiling (life ${pool.life[i]})`)
    // Motes FADE (no noFade) so the cone is a translucent stream.
    assert.equal(pool.noFade[i], 0, `mote ${i} fades over its life`)
  }
})

test('every mote lives long enough to REACH the build (stream reaches the target)', () => {
  // The stream must touch the structure, not stub out partway: a mote's life,
  // multiplied by its speed, has to cover the whole span at every build
  // distance (the old fixed speed + 520 ms clamp died at ~66 % of a typical
  // con→structure span, so the jet never reached the build).
  for (const to of [[40, 8, 10], TO, [260, 30, -80]]) {
    const pool = new ParticlePool()
    latheConeSpray(pool, { from: FROM, to, rng: mulberry32(11) })
    const span = Math.hypot(to[0] - FROM[0], to[1] - FROM[1], to[2] - FROM[2])
    for (let i = 0; i < pool.count; i++) {
      const sp = Math.hypot(pool.vx[i], pool.vy[i], pool.vz[i])
      const reach = sp * (pool.life[i] / 1000)
      assert.ok(reach >= span,
        `span ${span.toFixed(0)}: mote ${i} reaches ${reach.toFixed(0)} >= span`)
    }
  }
})

test('the spray is a BRIGHT green so it reads over the terrain', () => {
  // The construction cone was invisible partly because the motes were too
  // dim/small. The default colour must be a bright, green-dominant tint
  // (green channel clearly the strongest and well above 1 for the additive
  // glow) so a con→structure / factory build reads on screen.
  const pool = new ParticlePool()
  latheConeSpray(pool, { from: FROM, to: TO, rng: mulberry32(7) })
  assert.ok(pool.count > 0, 'the cone emitted motes')
  for (let i = 0; i < pool.count; i++) {
    assert.ok(pool.g[i] >= 1.0, `mote ${i} green is bright (g ${pool.g[i]})`)
    assert.ok(pool.g[i] > pool.r[i] && pool.g[i] > pool.b[i],
      `mote ${i} is green-dominant (r${pool.r[i]} g${pool.g[i]} b${pool.b[i]})`)
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

// ── nano-piece enumeration (the STREAM must flow from EVERY nozzle) ────────

test('enumerates ALL nano nozzles a builder model carries', () => {
  // A factory (ARMLAB-style) names two nozzles nano1/nano2; the stream must
  // flow from both, not one (the COB QueryNanoPiece alternates between them so
  // a single query captured only half the spray).
  assert.deepEqual(nanoPieceNames(['base', 'pad', 'beam1', 'beam2', 'nano1', 'nano2']),
    ['nano1', 'nano2'])
})

test('a single-nozzle con builder enumerates its one nano piece', () => {
  assert.deepEqual(nanoPieceNames(['body', 'nano']), ['nano'])
})

test('nano enumeration is case-insensitive, de-duped and index-ordered', () => {
  assert.deepEqual(nanoPieceNames(['nano2', 'NANO1', 'nano2', 'turret']), ['NANO1', 'nano2'])
})

test('a non-builder model yields no nano nozzles (stream falls back to hull)', () => {
  assert.deepEqual(nanoPieceNames(['body', 'turret', 'wheel1', 'wheel2']), [])
  assert.deepEqual(nanoPieceNames(null), [])
  assert.deepEqual(nanoPieceNames([null, undefined, '']), [])
})
