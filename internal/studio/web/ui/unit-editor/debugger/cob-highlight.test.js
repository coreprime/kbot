// node --test coverage for the COB-assembly opcode colouring.

import test from 'node:test'
import assert from 'node:assert/strict'
import { baseOpName, cobaOpCategory, computeJumps, formatCobOperands } from './cob-highlight.js'

test('the game names of the bitwise words are arithmetic', () => {
  for (const op of ['XOR', 'NOT', 'XOR_ALT', 'BITWISE_AND', 'TAK_MATH_0A']) {
    assert.equal(cobaOpCategory(op), 'coba-op-arith', op)
  }
})

test('names older listings used still colour as arithmetic', () => {
  for (const op of ['MOD', 'BITWISE_XOR', 'BITWISE_NOT', 'LOGICAL_XOR']) {
    assert.equal(cobaOpCategory(op), 'coba-op-arith', op)
  }
})

test('a low-bit variant colours as its base instruction', () => {
  assert.equal(cobaOpCategory('JUMP@0x10064001'), 'coba-op-flow')
  assert.equal(cobaOpCategory('DISCARD_CALL'), 'coba-op-flow')
  assert.equal(cobaOpCategory('PUSH_CONST'), 'coba-op-stack')
})

test('baseOpName strips the stored word', () => {
  assert.equal(baseOpName('JUMP@0x10064001'), 'JUMP')
  assert.equal(baseOpName('JUMP'), 'JUMP')
  assert.equal(baseOpName(undefined), '')
})

// A low-bit JUMP (0x10064001) runs as JUMP, so it gets a lane and a
// target like any other jump.
test('computeJumps draws a lane for a low-bit jump', () => {
  const instructions = [
    { offset: 0, name: 'PUSH_CONST', p1: 1 },
    { offset: 8, name: 'JUMP_IF_FALSE@0x10066002', p1: 24 },
    { offset: 16, name: 'JUMP@0x10064001', p1: 0 },
    { offset: 24, name: 'RETURN' },
  ]
  const { jumps, maxLane } = computeJumps(instructions)
  assert.equal(jumps.length, 2)
  assert.ok(maxLane >= 0)
  const back = jumps.find((j) => j.fromIdx === 2)
  assert.ok(back, 'no lane for JUMP@0x10064001')
  assert.equal(back.toIdx, 0)
  assert.equal(back.isLoop, true)
  const fwd = jumps.find((j) => j.fromIdx === 1)
  assert.ok(fwd, 'no lane for JUMP_IF_FALSE@0x10066002')
  assert.equal(fwd.toIdx, 3)
})

test('operands of a low-bit variant are formatted as its base instruction', () => {
  const pieces = ['base', 'turret']
  assert.equal(formatCobOperands({ name: 'JUMP@0x10064001', p1: 0x40 }, pieces), '→ 0x40')
  assert.equal(formatCobOperands({ name: 'TURN@0x10002001', p1: 1, p2: 1 }, pieces), 'turret, y-axis')
  assert.equal(formatCobOperands({ name: 'PUSH_LOCAL', p1: 3 }, pieces), 'L3')
  assert.equal(formatCobOperands({ name: 'RETURN' }, pieces), '')
})
