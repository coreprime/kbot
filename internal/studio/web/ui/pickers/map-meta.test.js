// node --test coverage for the Open Map picker's meta line.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mapMetaLine } from './map-meta.js'

test('a TA map shows size, planet and players', () => {
  assert.equal(mapMetaLine({ tileW: 128, tileH: 96, planet: 'Green Planet', numPlayers: '2-4' }),
    '128×96 · Green Planet · 2-4 players')
})

test('a TA: Kingdoms map is labelled as such', () => {
  assert.equal(mapMetaLine({ tileW: 64, tileH: 64, format: 'kingdoms' }), '64×64 · TA: Kingdoms only')
})

test('a 0x1020 map is labelled as the old format', () => {
  assert.equal(mapMetaLine({ tileW: 32, tileH: 32, format: 'legacy' }), '32×32 · old TA format (0x1020)')
  assert.equal(mapMetaLine({ format: 'other' }), '')
})
