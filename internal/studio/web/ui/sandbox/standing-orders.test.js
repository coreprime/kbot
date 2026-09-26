// node --test coverage for the spawn-time Stance order of Hold units.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnStance } from './standing-orders.js'

test('a commander (StandingMoveOrder=0) is put on Hold Position at spawn', () => {
  assert.deepEqual(spawnStance({ standingMoveOrder: 0, standingFireOrder: 2 }), { move: 0, fire: 2 })
})

test('a Hold Fire unit (StandingFireOrder=0) keeps its resolved move order', () => {
  assert.deepEqual(spawnStance({ standingMoveOrder: 2, standingFireOrder: 0 }), { move: 2, fire: 0 })
  assert.deepEqual(spawnStance({ standingMoveOrder: 1, standingFireOrder: 0 }), { move: 1, fire: 0 })
})

test('no Stance order when the spawn already applies the resolved orders', () => {
  assert.equal(spawnStance({ standingMoveOrder: 2, standingFireOrder: 2 }), null, 'the game default, Roam / Fire at Will')
  assert.equal(spawnStance({ standingMoveOrder: 1, standingFireOrder: 1 }), null)
  assert.equal(spawnStance({}), null, 'a bare meta (no FBI) keeps the sim defaults')
  assert.equal(spawnStance(null), null)
})

test('a TA: Kingdoms meta (orders left out unless non-zero) gets no Stance order', () => {
  assert.equal(spawnStance({ name: 'araarch' }), null, 'no keys: the sim defaults')
  assert.equal(spawnStance({ standingMoveOrder: 2 }), null, 'lifcow: standingmoveorder = 2 only')
})

test('an order outside 0..2 next to a Hold falls back to the spawn default', () => {
  assert.deepEqual(spawnStance({ standingMoveOrder: 0, standingFireOrder: 3 }), { move: 0, fire: 2 })
  assert.deepEqual(spawnStance({ standingMoveOrder: 3, standingFireOrder: 0 }), { move: 1, fire: 0 })
})
