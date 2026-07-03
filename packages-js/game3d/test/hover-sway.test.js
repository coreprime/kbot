// hover-sway.test.js — headless proofs for the world-frame hovercraft
// sway (hover-sway.js): the cushion's lean is generated about WORLD axes
// and only then composed with the unit's heading, so the lean direction
// stays put in the world as the craft yaws.  The key property: sway
// sampled at heading θ and θ+π yields MIRRORED local pitch/roll (and the
// identical world-space lean), which is exactly what a half-turn inside
// the rock window must look like.

import test from 'node:test'
import assert from 'node:assert/strict'

import { hoverSway, hoverSwayWorldLean, worldLeanToLocal } from '../hover-sway.js'
import { HOVERCRAFT_WOBBLE_SCALE } from '../performance.js'

const close = (a, b, eps = 1e-12) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`)

// Recover the world-frame lean implied by a local pitch/roll at a heading
// (the inverse of worldLeanToLocal): llx = -roll, llz = pitch, rotated
// back by +heading.
const localToWorldLean = (pitch, roll, headingRad) => {
  const c = Math.cos(headingRad)
  const s = Math.sin(headingRad)
  const llx = -roll
  const llz = pitch
  return { lx: c * llx + s * llz, lz: -s * llx + c * llz }
}

test('world lean is heading-independent and deterministic', () => {
  const a = hoverSwayWorldLean(3.7, { motion: 0.5, phase: 1.1 })
  const b = hoverSwayWorldLean(3.7, { motion: 0.5, phase: 1.1 })
  assert.deepEqual(a, b)
  // Non-degenerate sample: the cushion is actually leaning.
  assert.ok(Math.abs(a.lx) > 1e-4 && Math.abs(a.lz) > 1e-4)
})

test('a half-turn mirrors the local pitch/roll exactly', () => {
  for (const t of [0.4, 2.9, 7.13, 40.5]) {
    for (const th of [0, 0.7, Math.PI / 2, 2.4]) {
      const fwd = hoverSway(t, th, { motion: 0.6 })
      const rev = hoverSway(t, th + Math.PI, { motion: 0.6 })
      close(rev.pitch, -fwd.pitch)
      close(rev.roll, -fwd.roll)
      close(rev.heave, fwd.heave) // heave is vertical — yaw-invariant
    }
  }
})

test('every heading expresses the SAME world-space lean', () => {
  const t = 5.21
  const world = hoverSwayWorldLean(t, { motion: 0.3 })
  for (const th of [0, 0.9, Math.PI / 2, Math.PI, 4.4, 2 * Math.PI]) {
    const { pitch, roll } = hoverSway(t, th, { motion: 0.3 })
    const back = localToWorldLean(pitch, roll, th)
    close(back.lx, world.lx, 1e-9)
    close(back.lz, world.lz, 1e-9)
  }
})

test('worldLeanToLocal matches the slope-tilt convention + round-trips', () => {
  // heading 0: pitch carries the world-Z lean, roll the (negated) world-X.
  const at0 = worldLeanToLocal(0.02, 0.05, 0)
  close(at0.pitch, 0.05)
  close(at0.roll, -0.02)
  // Quarter turn: the axes swap.
  const at90 = worldLeanToLocal(0.02, 0.05, Math.PI / 2)
  close(at90.pitch, 0.02)
  close(at90.roll, 0.05)
})

test('sway amplitude stays inside the toned-down envelope', () => {
  // Each world axis peaks at amp; a local channel sees the rotated lean
  // vector, so its bound is the vector magnitude — amp·√2.
  const maxLean = (0.027 + 0.075) * HOVERCRAFT_WOBBLE_SCALE * Math.SQRT2
  for (let t = 0; t < 40; t += 0.13) {
    const { pitch, roll } = hoverSway(t, t * 0.31, { motion: 1 })
    assert.ok(Math.abs(pitch) <= maxLean + 1e-9, `pitch ${pitch} out of envelope`)
    assert.ok(Math.abs(roll) <= maxLean + 1e-9, `roll ${roll} out of envelope`)
  }
  // The intensity pass: the global scale is calmed to 1 (was 3).
  assert.ok(HOVERCRAFT_WOBBLE_SCALE <= 1, 'hover wobble must stay toned down')
})
