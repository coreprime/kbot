// node --test coverage for the TA fixed-point scale helpers.

import test from 'node:test'
import assert from 'node:assert/strict'
import * as scale from './ta-scale.js'

test('angles are 65536 units per turn', () => {
  assert.equal(scale.TA_TURNS_PER_CIRCLE, 65536)
  assert.ok(Math.abs(scale.angleToRadians(16384) - Math.PI / 2) < 1e-12)
  assert.ok(Math.abs(scale.angleToRadians(-32768) + Math.PI) < 1e-12)
})

test('distances are 65536 units per world unit', () => {
  assert.equal(scale.linearToWorld(65536 * 3), 3)
  assert.equal(scale.linearToWorld(-32768), -0.5)
})

test('the browser carries no COB opcode table', () => {
  // Opcode meanings come from kbot-io's disassembler; a local copy went
  // stale once (0x10037000 is XOR, not MOD), so none is kept here.
  const opcodeNames = Object.keys(scale).filter((k) => k.startsWith('OP_'))
  assert.deepEqual(opcodeNames, [])
})
