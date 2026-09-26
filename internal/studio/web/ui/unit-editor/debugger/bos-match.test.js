// node --test coverage for the BOS-line to assembly matcher.

import test from 'node:test'
import assert from 'node:assert/strict'
import { bosStatementMatch } from './bos-match.js'

const pieces = ['base', 'turret']

test('a BOS turn line maps to its pushes and TURN', () => {
  const ins = [
    { offset: 0, name: 'PUSH_CONST', p1: 100 },
    { offset: 8, name: 'PUSH_CONST', p1: 5 },
    { offset: 16, name: 'TURN', p1: 1, p2: 1 },
  ]
  assert.deepEqual(bosStatementMatch('turn turret to y-axis <10> speed <5>;', ins, 0, pieces), { startIdx: 0, endIdx: 2 })
})

// Words with stray low bits are named NAME@0x…; the game runs them as NAME.
test('low-bit variants match as their base instruction', () => {
  const ins = [
    { offset: 0, name: 'PUSH_CONST@0x10021005', p1: 100 },
    { offset: 8, name: 'PUSH_CONST', p1: 5 },
    { offset: 16, name: 'TURN@0x10002001', p1: 1, p2: 1 },
    { offset: 28, name: 'JUMP@0x10064001', p1: 0 },
    { offset: 36, name: 'RETURN@0x10065001' },
  ]
  assert.deepEqual(bosStatementMatch('turn turret to y-axis <10> speed <5>;', ins, 0, pieces), { startIdx: 0, endIdx: 2 })
  assert.deepEqual(bosStatementMatch('else', ins, 0, pieces), { startIdx: 3, endIdx: 3 })
  assert.deepEqual(bosStatementMatch('return (0);', ins, 4, pieces), { startIdx: 4, endIdx: 4 })
})

test('comments and braces map to nothing', () => {
  assert.equal(bosStatementMatch('// hi', [], 0, pieces), null)
  assert.equal(bosStatementMatch('{', [], 0, pieces), null)
})
