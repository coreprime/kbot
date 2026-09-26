// node --test coverage for the COB-assembly opcode colouring.

import test from 'node:test'
import assert from 'node:assert/strict'
import { cobaOpCategory } from './cob-highlight.js'

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
