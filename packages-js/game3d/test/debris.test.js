// debris.test.js — headless proofs for the death-debris physics: parabolic
// world-space flight, terrain bounces with energy loss, directional bias
// away from the killing impact, and determinism.
import test from 'node:test'
import assert from 'node:assert/strict'

import { debrisBurst, stepDebrisRecord, DEBRIS_MAX_BOUNCES } from '../world-fx.js'
import { mulberry32 } from '../map-features.js'

// A minimal one-piece "model": world-fx only touches piece.move/rotate.
const makeModel = (n = 1) => ({
  flat: Array.from({ length: n }, () => ({ move: [0, 0, 0], rotate: [0, 0, 0] })),
})

const makeRecord = (model, pieces, heading = 0) => ({
  x: 0, y: 50, z: 0, headingRad: heading, pieces, model,
})

test('a piece flies a parabola: vy linear in t, y quadratic between bounces', () => {
  const model = makeModel(1)
  const pieces = debrisBurst(model, { rng: mulberry32(7) })
  const rec = makeRecord(model, pieces)
  const d = pieces[0]
  const v0 = d.vy
  const g = 120
  const dtMs = 20
  const samples = []
  for (let i = 0; i < 10; i++) {
    stepDebrisRecord(rec, dtMs, { gravity: g })
    samples.push({ t: (i + 1) * dtMs / 1000, y: d.piece.move[1], vy: d.vy })
  }
  // vy decreases linearly by g each second.
  for (const s of samples) {
    assert.ok(Math.abs(s.vy - (v0 - g * s.t)) < 1e-6, 'vy = v0 - g·t')
  }
  // y follows the discrete integral of that (Euler): monotone rise while
  // vy > 0 and concave (second difference negative and constant).
  const dd = []
  for (let i = 2; i < samples.length; i++) {
    dd.push((samples[i].y - samples[i - 1].y) - (samples[i - 1].y - samples[i - 2].y))
  }
  for (const v of dd) {
    assert.ok(v < 0, 'trajectory is concave (gravity)')
    assert.ok(Math.abs(v - dd[0]) < 1e-6, 'constant curvature — a parabola')
  }
})

test('pieces bounce off the terrain, lose height each bounce, then settle', () => {
  const model = makeModel(1)
  const pieces = debrisBurst(model, { rng: mulberry32(3), speed: 20, lift: 80 })
  const rec = makeRecord(model, pieces)
  rec.y = 0 // launch at ground level so move[1] IS height above terrain
  const d = pieces[0]
  const peaks = []
  let prevY = 0
  let rising = false
  for (let i = 0; i < 4000 && !d.settled; i++) {
    stepDebrisRecord(rec, 10, { heightAt: () => 0, gravity: 120 })
    const y = d.piece.move[1]
    if (y > prevY) rising = true
    else if (rising) { peaks.push(prevY); rising = false }
    prevY = y
  }
  assert.ok(d.settled, 'piece settles')
  assert.ok(d.bounces >= 1 && d.bounces <= DEBRIS_MAX_BOUNCES + 1, `bounces=${d.bounces}`)
  assert.ok(peaks.length >= 2, `needs at least two flight arcs (got ${peaks.length})`)
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] < peaks[i - 1] * 0.6, `bounce ${i} peak ${peaks[i]} must lose height vs ${peaks[i - 1]}`)
  }
  assert.ok(Math.abs(d.piece.move[1]) < 1, 'settles on the ground')
})

test('impactDir biases the mean launch velocity away from the source', () => {
  const model = makeModel(24)
  // Impact arriving from the west → dir points east (+X).
  const pieces = debrisBurst(model, { rng: mulberry32(11), impactDir: [1, 0], impactMag: 3, headingRad: 0 })
  let mx = 0, mz = 0
  for (const d of pieces) { mx += d.vx; mz += d.vz }
  mx /= pieces.length; mz /= pieces.length
  assert.ok(mx > 20, `mean vx ${mx} must point away from the source`)
  assert.ok(Math.abs(mz) < mx, 'and dominates the cross axis')
  // Without a direction the burst is symmetric-ish.
  const sym = debrisBurst(makeModel(24), { rng: mulberry32(11) })
  let sx = 0
  for (const d of sym) sx += d.vx
  sx /= sym.length
  assert.ok(Math.abs(sx) < 15, `symmetric burst mean vx ${sx}`)
})

test('heading rotates the world-frame bias into the local frame', () => {
  const model = makeModel(24)
  // Unit yawed a half turn: a world +X push must become local −X so the
  // WORLD-frame scatter still points +X.  World vx = c·lx + s·lz (c=−1,s=0).
  const pieces = debrisBurst(model, { rng: mulberry32(5), impactDir: [1, 0], impactMag: 3, headingRad: Math.PI })
  let localMx = 0
  for (const d of pieces) localMx += d.vx
  localMx /= pieces.length
  assert.ok(localMx < -20, `local mean vx ${localMx} (world +X after the yaw)`)
})

test('deterministic: same seed → identical scatter, bounces and rest state', () => {
  const run = () => {
    const model = makeModel(6)
    const pieces = debrisBurst(model, { rng: mulberry32(42), impactDir: [0.6, -0.8], impactMag: 2 })
    const rec = makeRecord(model, pieces, 1.1)
    for (let i = 0; i < 200; i++) stepDebrisRecord(rec, 16, { heightAt: () => 40, gravity: 120 })
    return model.flat.map((p) => [...p.move, ...p.rotate].map((v) => +v.toFixed(9)))
  }
  assert.deepEqual(run(), run())
})
