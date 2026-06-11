// node --test unit coverage for the TA:K rotation-by-substitution mapping.

import test from 'node:test'
import assert from 'node:assert/strict'
import { rotatedTakSectionName, findRotatedTakSection } from './tak-rotate.js'

test('edge, outer-corner, and inner-corner cycles', () => {
  // edges clockwise
  assert.equal(rotatedTakSectionName('n01', +1), 'e01')
  assert.equal(rotatedTakSectionName('e02', +1), 's02')
  assert.equal(rotatedTakSectionName('w03', +1), 'n03')
  // counter-clockwise inverts
  assert.equal(rotatedTakSectionName('e01', -1), 'n01')
  // outer corners
  assert.equal(rotatedTakSectionName('ne01', +1), 'se01')
  assert.equal(rotatedTakSectionName('nw02', +1), 'ne02')
  // inner corners normalize to the n/s-first spelling
  assert.equal(rotatedTakSectionName('n_e01', +1), 's_e01')
  assert.equal(rotatedTakSectionName('s_w02', +1), 'n_w02')
  assert.equal(rotatedTakSectionName('n_e01', -1), 'n_w01')
  // four clockwise steps come home
  let n = 'n_e07'
  for (let i = 0; i < 4; i++) n = rotatedTakSectionName(n, +1)
  assert.equal(n, 'n_e07')
})

test('non-directional names are left alone', () => {
  assert.equal(rotatedTakSectionName('accoast01a_200', +1), null)
  assert.equal(rotatedTakSectionName('', +1), null)
})

test('catalogue lookup stays within world + group', () => {
  const list = [
    { path: 'sections/veruna/coast cliffs/e01.tnt', name: 'e01', world: 'veruna', group: 'coast cliffs', tileW: 16, tileH: 16 },
    { path: 'sections/veruna/coast cliffs/s01.tnt', name: 's01', world: 'veruna', group: 'coast cliffs', tileW: 16, tileH: 16 },
    { path: 'sections/aramon/coast cliffs/s01.tnt', name: 's01', world: 'aramon', group: 'coast cliffs', tileW: 16, tileH: 16 },
  ]
  const hit = findRotatedTakSection(list, 'sections/veruna/coast cliffs/e01.tnt', +1)
  assert.ok(hit && hit.path === 'sections/veruna/coast cliffs/s01.tnt', 'rotates within veruna, not aramon')
  // missing variant → null
  assert.equal(findRotatedTakSection(list, 'sections/veruna/coast cliffs/s01.tnt', +1), null)
})
