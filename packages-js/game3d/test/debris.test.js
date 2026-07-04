// debris.test.js — headless proofs for the death-debris chunking: the model
// breaks into recognizable UNIT PIECE chunks (a moderate, piece-driven count,
// NOT 64-shard confetti), a one-piece unit still sheds several chunks by
// splitting its largest piece, a wide solid-angle burst with varied per-chunk
// spin, world-space parabolic flight, terrain bounces with energy loss,
// directional bias away from the killing impact, momentum inheritance (a
// moving unit throws its chunks along its travel direction), the chunk-count
// budget, and determinism.
import test from 'node:test'
import assert from 'node:assert/strict'

import { debrisBurst, stepDebrisRecord, DEBRIS_MAX_BOUNCES } from '../world-fx.js'
import {
  fragmentGeometry,
  targetFragmentCount,
  collectTriangles,
  FRAG_MIN,
  FRAG_MAX,
} from '../debris-fragments.js'
import { mulberry32 } from '../map-features.js'

// A minimal one-piece "model": world-fx only touches piece.move/rotate.
const makeModel = (n = 1) => ({
  flat: Array.from({ length: n }, () => ({ move: [0, 0, 0], rotate: [0, 0, 0] })),
})

const makeRecord = (model, pieces, heading = 0) => ({
  x: 0, y: 50, z: 0, headingRad: heading, pieces, model,
})

// shardFlatModel mirrors create-world's _buildShardModel: it wraps a
// fragmentGeometry result in a `flat` list of shard "pieces" (origin at the
// centroid, so they tumble in place; centroid carried so debrisBurst bursts
// them outward).  This is exactly what debrisBurst flies at runtime.
const shardFlatModel = (geo) => ({
  ...geo,
  flat: geo.fragments.map((f) => ({
    move: [0, 0, 0], rotate: [0, 0, 0],
    origin: [f.centroid[0], f.centroid[1], f.centroid[2]],
    centroid: f.centroid,
  })),
})

// One interleaved triangle: 3 verts × (pos3, normal3, uv2, ao1) = 27 floats.
const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => [
  ax, ay, az, 0, 1, 0, 0, 0, 1,
  bx, by, bz, 0, 1, 0, 1, 0, 1,
  cx, cy, cz, 0, 1, 0, 0, 1, 1,
]

// A synthetic "geometry model": one piece with one triangle draw group
// holding `nTris` triangles spread across a box of half-extent `ext`.  This
// is what fragmentGeometry reads (group.tris) — it stands in for a loaded
// unit whose model-loader retained the CPU triangle copy.
const makeGeoModel = (nTris = 60, ext = 20, seed = 1) => {
  const rng = mulberry32(seed)
  const floats = []
  for (let i = 0; i < nTris; i++) {
    const cx = (rng() * 2 - 1) * ext
    const cy = (rng() * 2 - 1) * ext
    const cz = (rng() * 2 - 1) * ext
    floats.push(...tri(cx, cy, cz, cx + 1, cy, cz, cx, cy + 1, cz))
  }
  const group = { mode: 'tris', textureName: 'unit_tex', color: null, tris: new Float32Array(floats) }
  return {
    name: 'GEOUNIT',
    boundsRadius: ext,
    bounds: { min: [-ext, -ext, -ext], max: [ext, ext, ext] },
    flat: [{ drawGroups: [group] }],
  }
}

// makeMultiPieceModel builds a model whose `flat` list has `nPieces` distinct
// COB pieces, each with its own triangle group at a distinct offset — stands
// in for a loaded unit's piece tree (turret / hull / barrel / legs).
const makeMultiPieceModel = (nPieces = 5, ext = 20, seed = 1) => {
  const rng = mulberry32(seed)
  const flat = []
  for (let p = 0; p < nPieces; p++) {
    const ox = (rng() * 2 - 1) * ext
    const oy = (rng() * 2 - 1) * ext
    const oz = (rng() * 2 - 1) * ext
    const floats = []
    // A handful of triangles per piece, clustered near the piece origin.
    for (let i = 0; i < 6; i++) {
      const jx = (rng() * 2 - 1) * 3, jy = (rng() * 2 - 1) * 3, jz = (rng() * 2 - 1) * 3
      floats.push(...tri(jx, jy, jz, jx + 1, jy, jz, jx, jy + 1, jz))
    }
    const group = { mode: 'tris', textureName: 'piece_tex' + p, color: null, tris: new Float32Array(floats) }
    flat.push({ origin: [ox, oy, oz], parent: null, drawGroups: [group] })
  }
  return { name: 'MULTIUNIT', boundsRadius: ext, bounds: { min: [-ext, -ext, -ext], max: [ext, ext, ext] }, flat }
}

// ── Piece-chunk breakup ────────────────────────────────────────────────

test('a one-piece unit still throws several chunks (largest piece is split)', () => {
  // One draw group (≈ one COB piece), but the largest piece splits so a
  // single-body tank still sheds several recognizable chunks — not one blob.
  const model = makeGeoModel(80, 20)
  const count = targetFragmentCount(model.boundsRadius, 100)
  const geo = fragmentGeometry(model, { count, rng: mulberry32(9) })
  assert.ok(geo, 'geometry model breaks up')
  assert.ok(geo.fragments.length >= FRAG_MIN, `>= ${FRAG_MIN} chunks (got ${geo.fragments.length})`)
  // More than the single source piece — the one body split into parts.
  assert.ok(geo.fragments.length > model.flat.length, 'splits the lone piece into chunks')
  // But MODERATE — not the old 64-shard confetti.
  assert.ok(geo.fragments.length <= FRAG_MAX, `chunky, not confetti (got ${geo.fragments.length})`)
})

test('a multi-piece unit throws its actual COB pieces as chunks', () => {
  // 6 distinct pieces at 6 distinct offsets: the chunks should land near
  // those piece offsets (recognizable turret/hull/barrel parts), one per
  // piece when the count target matches the piece count.
  const model = makeMultiPieceModel(6, 24, 3)
  const geo = fragmentGeometry(model, { count: 6, rng: mulberry32(3) })
  assert.equal(geo.fragments.length, 6, 'one chunk per COB piece')
  // Each chunk centroid is offset from the model centre (it will burst out).
  for (const f of geo.fragments) {
    assert.ok(Math.hypot(f.centroid[0], f.centroid[1], f.centroid[2]) > 1, 'chunk sits away from centre')
  }
})

test('too many pieces merge down to the moderate cap', () => {
  const model = makeMultiPieceModel(40, 30, 7)
  const geo = fragmentGeometry(model, { count: FRAG_MAX, rng: mulberry32(7) })
  assert.ok(geo.fragments.length <= FRAG_MAX, `capped at ${FRAG_MAX} (got ${geo.fragments.length})`)
  assert.ok(geo.fragments.length >= FRAG_MIN, 'still several chunks')
})

test('chunk count scales with model size and severity, within the moderate band', () => {
  const peewee = targetFragmentCount(6, 100)
  const commander = targetFragmentCount(120, 100)
  assert.ok(commander > peewee, 'bigger model → more chunks')
  assert.ok(peewee >= FRAG_MIN, 'a small unit still gets the floor')
  assert.ok(commander <= FRAG_MAX, 'capped for perf (moderate, not confetti)')
  // Severity scales it: a corpse-leaving kill (low severity) sheds fewer
  // than a catastrophic blast of the same unit (picked below the cap so the
  // difference isn't clipped away).
  assert.ok(targetFragmentCount(20, 30) < targetFragmentCount(20, 100), 'severity scales count')
})

test('chunk verts are recentred about the chunk centroid (tumble in place)', () => {
  const model = makeGeoModel(60, 25)
  const geo = fragmentGeometry(model, { count: 24, rng: mulberry32(4) })
  const STRIDE = 9
  for (const f of geo.fragments) {
    let sx = 0, sy = 0, sz = 0, n = 0
    for (let v = 0; v < f.vertexCount; v++) {
      const o = (f.first + v) * STRIDE
      sx += geo.floats[o]; sy += geo.floats[o + 1]; sz += geo.floats[o + 2]; n++
    }
    // Mean shard-local position ≈ 0 — the geometry sits around its own pivot.
    assert.ok(Math.abs(sx / n) < 1e-3 && Math.abs(sy / n) < 1e-3 && Math.abs(sz / n) < 1e-3,
      'shard centred on its own pivot')
    // The centroid it reports is offset from the model centre (it will burst
    // outward along it).
    assert.equal(f.textureName, 'unit_tex', 'shard keeps the source texture')
  }
})

test('fragmentGeometry returns null for a model with no readable triangles', () => {
  assert.equal(collectTriangles(makeModel(3)).length, 0, 'stub pieces carry no tris')
  assert.equal(fragmentGeometry(makeModel(3), { count: 20, rng: mulberry32(1) }), null)
})

// ── Burst spread + spin ────────────────────────────────────────────────

test('shards burst across a WIDE solid angle, not along one axis', () => {
  const model = makeGeoModel(120, 22)
  const geo = fragmentGeometry(model, { count: FRAG_MAX, rng: mulberry32(2) })
  const pieces = debrisBurst(shardFlatModel(geo), { rng: mulberry32(2) })
  // Bin the horizontal launch bearing into octants; a real explosion fills
  // most of them, a one-axis scatter clusters into one or two.
  const octants = new Set()
  let upCount = 0
  for (const d of pieces) {
    const ang = Math.atan2(d.vz, d.vx)
    octants.add(Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 8) % 8)
    if (d.vy > 0) upCount++
  }
  assert.ok(octants.size >= 6, `burst spans the horizon (octants=${octants.size})`)
  assert.ok(upCount > pieces.length * 0.8, 'and is upward-biased')
})

test('angular velocities are varied per fragment and per axis (no unison spin)', () => {
  const model = makeGeoModel(80, 20)
  const geo = fragmentGeometry(model, { count: 40, rng: mulberry32(6) })
  const pieces = debrisBurst(shardFlatModel(geo), { rng: mulberry32(6) })
  const sxs = pieces.map((d) => d.sx)
  const sys = pieces.map((d) => d.sy)
  // Spins straddle zero (both signs present) on each axis and have real
  // spread — not a single shared rate.
  assert.ok(Math.min(...sxs) < -2 && Math.max(...sxs) > 2, 'sx spans both directions')
  assert.ok(Math.min(...sys) < -2 && Math.max(...sys) > 2, 'sy spans both directions')
  const uniqX = new Set(sxs.map((v) => v.toFixed(3)))
  assert.ok(uniqX.size > pieces.length * 0.8, 'distinct per-fragment spins')
})

// ── Physics (parabola, bounce, bias, determinism) ──────────────────────

test('each fragment travels monotonically OUTWARD from the spawn centre (no orbit)', () => {
  // Shatter a real geometry model so shards carry true centroids, then fly
  // them.  A fragment must move steadily AWAY from the unit centre on the XZ
  // plane — its distance from spawn strictly grows while airborne, and its
  // world bearing barely drifts.  A vortex/orbit shows up as either a
  // non-increasing radius (it circles at fixed range) or a large bearing
  // swing (the path curls around the unit).
  const model = makeGeoModel(160, 26, 5)
  const geo = fragmentGeometry(model, { count: FRAG_MAX, rng: mulberry32(5) })
  const fm = shardFlatModel(geo)
  const pieces = debrisBurst(fm, { rng: mulberry32(5) })
  const heading = 0.6
  const rec = makeRecord(fm, pieces, heading)
  rec.y = 200 // high spawn: a long airborne flight before any bounce
  const c = Math.cos(heading), sn = Math.sin(heading)
  // World XZ offset of a shard from the spawn centre (record heading applied,
  // exactly as create-world renders and stepDebrisRecord bounces it).
  const offset = (d) => {
    const org = d.piece.origin || [0, 0, 0]
    const lx = org[0] + d.piece.move[0], lz = org[2] + d.piece.move[2]
    return [c * lx + sn * lz, -sn * lx + c * lz]
  }
  const start = pieces.map(offset)
  const startR = start.map(([x, z]) => Math.hypot(x, z))
  // Only assert on shards that actually have an outward radial to grow along
  // (a shard sitting almost exactly on the centre has no defined bearing).
  const tracked = pieces.map((_, i) => startR[i] > 2)
  let prev = pieces.map(offset)
  let regressions = 0
  const NSTEP = 24
  for (let s = 0; s < NSTEP; s++) {
    // Airborne window only — freeze the check once a shard first touches down.
    stepDebrisRecord(rec, 33, { heightAt: () => 0, gravity: 120 })
    pieces.forEach((d, i) => {
      if (!tracked[i] || d.bounces > 0) return
      const [x, z] = offset(d)
      const [px, pz] = prev[i]
      // Radius must not shrink step-to-step while flying outward.
      if (Math.hypot(x, z) < Math.hypot(px, pz) - 1e-6) regressions++
    })
    prev = pieces.map(offset)
  }
  assert.equal(regressions, 0, 'no fragment loses ground on its outward radius mid-flight')
  // And the net bearing swing over the flight is small — paths are radial
  // arcs, not curls around the unit.
  let worst = 0
  pieces.forEach((d, i) => {
    if (!tracked[i]) return
    const [ex, ez] = offset(d)
    const [sx, sz] = start[i]
    let dd = Math.atan2(ez, ex) - Math.atan2(sz, sx)
    while (dd > Math.PI) dd -= Math.PI * 2
    while (dd < -Math.PI) dd += Math.PI * 2
    worst = Math.max(worst, Math.abs(dd))
  })
  assert.ok(worst < 0.30, `bearing swing ${(worst * 180 / Math.PI).toFixed(1)}° must stay radial, not orbit`)
  // Net outward displacement dominates: every tracked shard ends FURTHER from
  // the centre than it began.
  pieces.forEach((d, i) => {
    if (!tracked[i]) return
    const [ex, ez] = offset(d)
    assert.ok(Math.hypot(ex, ez) > startR[i], 'shard ends outside where it began')
  })
})

test('spin contributes ZERO net translation (pure in-place tumble)', () => {
  // Two identical fragments, same launch, one spinning fast and one not:
  // their flight paths must be bit-identical.  stepDebrisRecord advances
  // move/ from vx,vy,vz only — rotate/ never feeds back into move/ — so spin
  // is a purely visual tumble and cannot orbit the shard around the unit.
  const mk = (spin) => ({
    move: [0, 0, 0], rotate: [0, 0, 0], origin: [12, 4, -8], centroid: [12, 4, -8], _spin: spin,
  })
  const spun = mk(true)
  const still = mk(false)
  const seedVel = { vx: 40, vy: 50, vz: -30 }
  const arm = (p, spin) => ({
    piece: p, ...seedVel,
    sx: spin ? 30 : 0, sy: spin ? -25 : 0, sz: spin ? 18 : 0,
    bounces: 0, settled: false,
  })
  const recSpun = makeRecord({ flat: [spun] }, [arm(spun, true)], 0.4)
  const recStill = makeRecord({ flat: [still] }, [arm(still, false)], 0.4)
  recSpun.y = recStill.y = 120
  for (let i = 0; i < 40; i++) {
    stepDebrisRecord(recSpun, 25, { heightAt: () => 0, gravity: 120 })
    stepDebrisRecord(recStill, 25, { heightAt: () => 0, gravity: 120 })
  }
  // Identical translation despite wildly different spin.
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(spun.move[k] - still.move[k]) < 1e-9,
      `spin must not perturb move[${k}] (${spun.move[k]} vs ${still.move[k]})`)
  }
  // The spun shard DID accumulate rotation (it visibly tumbles).
  assert.ok(Math.abs(spun.rotate[0]) > 1 || Math.abs(spun.rotate[1]) > 1,
    'spun fragment actually tumbles')
  assert.deepEqual(still.rotate, [0, 0, 0], 'the still fragment never rotates')
})

test('a fragment flies a parabola: vy linear in t, y quadratic between bounces', () => {
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
  for (const s of samples) {
    assert.ok(Math.abs(s.vy - (v0 - g * s.t)) < 1e-6, 'vy = v0 - g·t')
  }
  const dd = []
  for (let i = 2; i < samples.length; i++) {
    dd.push((samples[i].y - samples[i - 1].y) - (samples[i - 1].y - samples[i - 2].y))
  }
  for (const v of dd) {
    assert.ok(v < 0, 'trajectory is concave (gravity)')
    assert.ok(Math.abs(v - dd[0]) < 1e-6, 'constant curvature — a parabola')
  }
})

test('fragments bounce off the terrain, lose height each bounce, then settle', () => {
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
  assert.ok(d.settled, 'fragment settles')
  assert.ok(d.bounces >= 1 && d.bounces <= DEBRIS_MAX_BOUNCES + 1, `bounces=${d.bounces}`)
  assert.ok(peaks.length >= 2, `needs at least two flight arcs (got ${peaks.length})`)
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] < peaks[i - 1] * 0.6, `bounce ${i} peak ${peaks[i]} must lose height vs ${peaks[i - 1]}`)
  }
  assert.ok(Math.abs(d.piece.move[1]) < 1, 'settles on the ground')
})

test('a shard settles at its centroid height (origin-aware ground contact)', () => {
  // A shard whose rest centroid sits 30 above the record origin must settle
  // with move[1] ≈ -(origin.y) so its world height lands on the ground.
  const shard = { move: [0, 0, 0], rotate: [0, 0, 0], origin: [0, 30, 0] }
  const model = { flat: [shard] }
  const pieces = debrisBurst(model, { rng: mulberry32(8), speed: 10, lift: 40 })
  const rec = makeRecord(model, pieces)
  rec.y = 0
  for (let i = 0; i < 4000 && !pieces[0].settled; i++) {
    stepDebrisRecord(rec, 10, { heightAt: () => 0, gravity: 120 })
  }
  assert.ok(pieces[0].settled, 'shard settles')
  // World height = rec.y + origin.y + move.y ≈ 0.
  assert.ok(Math.abs(rec.y + shard.origin[1] + shard.move[1]) < 1, 'lands on the ground, not floating')
})

test('impactDir biases the mean launch velocity away from the source', () => {
  const model = makeModel(48)
  // Impact arriving from the west → dir points east (+X).
  const pieces = debrisBurst(model, { rng: mulberry32(11), impactDir: [1, 0], impactMag: 3, headingRad: 0 })
  let mx = 0, mz = 0
  for (const d of pieces) { mx += d.vx; mz += d.vz }
  mx /= pieces.length; mz /= pieces.length
  assert.ok(mx > 20, `mean vx ${mx} must point away from the source`)
  assert.ok(Math.abs(mz) < mx, 'and dominates the cross axis')
  // Without a direction the burst has no net horizontal bias — the biased
  // mean must dominate the unbiased one at the same sample size.
  const sym = debrisBurst(makeModel(48), { rng: mulberry32(11) })
  let sx = 0
  for (const d of sym) sx += d.vx
  sx /= sym.length
  assert.ok(Math.abs(sx) < mx * 0.6, `symmetric burst mean vx ${sx} << biased ${mx}`)
})

test('momentum: a moving unit throws its chunks along its travel direction', () => {
  const model = makeModel(48)
  // Unit travelling east at 60 WU/s (world +X), no yaw.  Every chunk's launch
  // gains that bulk velocity, so the mean launch velocity points +X strongly.
  const pieces = debrisBurst(model, { rng: mulberry32(21), velocity: [60, 0, 0], headingRad: 0 })
  let mx = 0, mz = 0
  for (const d of pieces) { mx += d.vx; mz += d.vz }
  mx /= pieces.length; mz /= pieces.length
  assert.ok(mx > 40, `mean vx ${mx.toFixed(1)} carries the unit's eastward momentum`)
  assert.ok(Math.abs(mz) < mx, 'and dominates the cross axis')
  // A stationary unit's symmetric burst has near-zero net horizontal drift —
  // the momentum bias must dominate it.
  const still = debrisBurst(makeModel(48), { rng: mulberry32(21) })
  let sx = 0
  for (const d of still) sx += d.vx
  sx /= still.length
  assert.ok(Math.abs(sx) < mx * 0.5, `stationary mean vx ${sx.toFixed(1)} << moving ${mx.toFixed(1)}`)
})

test('momentum: vertical velocity is inherited too (a climbing/diving unit)', () => {
  const model = makeModel(48)
  // A unit diving (world −Y) at death — every chunk's vy is pulled down by
  // the inherited momentum relative to a level unit's burst.
  const diving = debrisBurst(model, { rng: mulberry32(22), velocity: [0, -50, 0] })
  const level = debrisBurst(makeModel(48), { rng: mulberry32(22) })
  let dv = 0, lv = 0
  for (const d of diving) dv += d.vy
  for (const d of level) lv += d.vy
  dv /= diving.length; lv /= level.length
  assert.ok(dv < lv - 40, `diving mean vy ${dv.toFixed(1)} sits ~50 below level ${lv.toFixed(1)}`)
})

test('momentum: world velocity is rotated into the local frame by heading', () => {
  const model = makeModel(48)
  // Unit yawed a half turn moving WORLD +X: local frame sees −X, so the
  // WORLD-frame scatter still carries east.  Local vx = c·wx (c=−1) ⇒ negative.
  const pieces = debrisBurst(model, { rng: mulberry32(23), velocity: [60, 0, 0], headingRad: Math.PI })
  let mx = 0
  for (const d of pieces) mx += d.vx
  mx /= pieces.length
  assert.ok(mx < -40, `local mean vx ${mx.toFixed(1)} (world +X after the yaw)`)
})

test('heading rotates the world-frame bias into the local frame', () => {
  const model = makeModel(48)
  // Unit yawed a half turn: a world +X push must become local −X so the
  // WORLD-frame scatter still points +X.  World vx = c·lx + s·lz (c=−1,s=0).
  const pieces = debrisBurst(model, { rng: mulberry32(5), impactDir: [1, 0], impactMag: 3, headingRad: Math.PI })
  let localMx = 0
  for (const d of pieces) localMx += d.vx
  localMx /= pieces.length
  assert.ok(localMx < -20, `local mean vx ${localMx} (world +X after the yaw)`)
})

test('deterministic: same seed → identical shatter, scatter, bounces and rest state', () => {
  const run = () => {
    const model = makeGeoModel(70, 22, 3)
    const geo = fragmentGeometry(model, { count: 30, rng: mulberry32(42) })
    const fm = shardFlatModel(geo)
    const pieces = debrisBurst(fm, { rng: mulberry32(42), impactDir: [0.6, -0.8], impactMag: 2 })
    const rec = makeRecord(fm, pieces, 1.1)
    for (let i = 0; i < 200; i++) stepDebrisRecord(rec, 16, { heightAt: () => 40, gravity: 120 })
    return {
      floats: Array.from(geo.floats).map((v) => +v.toFixed(6)),
      pose: fm.flat.map((p) => [...p.move, ...p.rotate].map((v) => +v.toFixed(9))),
    }
  }
  assert.deepEqual(run(), run())
})
