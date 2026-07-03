// lerp-pieces.test.js — headless proofs for lerpPackedPieces (cob-pose.js):
// linear offsets, shortest-arc rotations across the TA-angle wrap seam,
// hard-switch visibility, and the mismatched-buffer fallback.

import test from 'node:test'
import assert from 'node:assert/strict'

import { lerpPackedPieces, TA_FULL_CIRCLE } from '../cob-pose.js'

// pack builds a stride-7 Float32 buffer from per-piece 7-tuples.
const pack = (...pieces) => {
  const out = new Float32Array(pieces.length * 7)
  pieces.forEach((p, i) => out.set(p, i * 7))
  return out
}

test('offsets lerp linearly, rotations arc, visibility switches hard', () => {
  const prev = pack([0, 0, 0, 1000, 0, 0, 1])
  const next = pack([10, -4, 2, 3000, 0, 0, 0])
  const mid = lerpPackedPieces(prev, next, 0.5)
  assert.ok(Math.abs(mid[0] - 5) < 1e-6)
  assert.ok(Math.abs(mid[1] + 2) < 1e-6)
  assert.ok(Math.abs(mid[2] - 1) < 1e-6)
  assert.ok(Math.abs(mid[3] - 2000) < 1e-3)
  assert.equal(mid[6], 0, 'visibility comes from next, no fade')
})

test('rotation takes the shortest arc across the 65536 wrap seam', () => {
  // 65000 → 500 is an 1036-unit step forward THROUGH the seam, not a
  // 64500-unit rewind.
  const prev = pack([0, 0, 0, 65000, 0, 0, 1])
  const next = pack([0, 0, 0, 500, 0, 0, 1])
  const mid = lerpPackedPieces(prev, next, 0.5)
  const expected = 65000 + (500 + TA_FULL_CIRCLE - 65000) / 2 // 65518
  assert.ok(Math.abs(mid[3] - expected) < 1e-3, `arc mid ${mid[3]}, want ${expected}`)
  // And the reverse direction wraps backwards.
  const back = lerpPackedPieces(next, prev, 0.5)
  assert.ok(Math.abs(back[3] - (500 - 1036 / 2)) < 1e-3, `reverse arc mid ${back[3]}`)
})

test('alpha clamps to [0,1] and endpoints reproduce inputs', () => {
  const prev = pack([1, 2, 3, 100, 200, 300, 1])
  const next = pack([4, 5, 6, 400, 500, 600, 1])
  assert.deepEqual(Array.from(lerpPackedPieces(prev, next, -3)).slice(0, 6), [1, 2, 3, 100, 200, 300])
  assert.deepEqual(Array.from(lerpPackedPieces(prev, next, 9)).slice(0, 6), [4, 5, 6, 400, 500, 600])
})

test('length mismatch or missing prev falls back to next verbatim', () => {
  const next = pack([7, 8, 9, 10, 11, 12, 1])
  assert.deepEqual(Array.from(lerpPackedPieces(null, next, 0.5)), Array.from(next))
  const shortPrev = new Float32Array(7 * 2)
  assert.deepEqual(Array.from(lerpPackedPieces(shortPrev, next, 0.5)), Array.from(next))
  assert.equal(lerpPackedPieces(null, null, 0.5), null)
})

test('accepts Uint8Array views (the wasm boundary form)', () => {
  const prev = pack([0, 0, 0, 0, 0, 0, 1])
  const next = pack([2, 0, 0, 200, 0, 0, 1])
  const mid = lerpPackedPieces(
    new Uint8Array(prev.buffer),
    new Uint8Array(next.buffer),
    0.25,
  )
  assert.ok(Math.abs(mid[0] - 0.5) < 1e-6)
  assert.ok(Math.abs(mid[3] - 50) < 1e-3)
})
