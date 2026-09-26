// node --test coverage for picking a player's start from the sandbox-map JSON.

import test from 'node:test'
import assert from 'node:assert/strict'
import { playerStart } from './start-positions.js'

test('player 1 starts at slot 0, whatever order the specials list them in', () => {
  const info = {
    startPositions: [
      { number: 4, slot: 3, x: 400, z: 40 },
      { number: 2, slot: 1, x: 200, z: 20 },
      { number: 1, slot: 0, x: 100, z: 10 },
    ],
  }
  assert.deepEqual(playerStart(info, 0), { number: 1, slot: 0, x: 100, z: 10 })
  assert.deepEqual(playerStart(info), playerStart(info, 0))
  assert.equal(playerStart(info, 1).number, 2)
})

test('StartPos0 is slot 0 too; the first entry of a slot wins', () => {
  const info = {
    startPositions: [
      { number: 0, slot: 0, x: 5, z: 6 },
      { number: 1, slot: 0, x: 7, z: 8 },
    ],
  }
  assert.equal(playerStart(info, 0).x, 5)
})

test('no start is invented for a slot the schema does not fill', () => {
  assert.equal(playerStart({ startPositions: [{ number: 3, slot: 2, x: 1, z: 1 }] }, 0), null)
  assert.equal(playerStart({ startPositions: [] }, 0), null)
  assert.equal(playerStart({}, 0), null)
  assert.equal(playerStart(null, 0), null)
})
