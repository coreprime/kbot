// node --test coverage for the AI profile viewer's labels.

import test from 'node:test'
import assert from 'node:assert/strict'
import { limitLabel, limitDisabled, weightLabel, weightBarPercent, kindLabel, writtenNote } from './ai-format.js'

test('-1 is unlimited and any other negative limit is disabled', () => {
  assert.equal(limitLabel({ maximum: -1 }), '∞ Unlimited')
  assert.equal(limitLabel({ maximum: 0 }), 'Disabled')
  assert.equal(limitLabel({ maximum: -2 }), 'Disabled')
  assert.equal(limitLabel({ maximum: -100 }), 'Disabled')
  assert.equal(limitLabel({ maximum: 6 }), 'Max: 6')
  assert.equal(limitDisabled({ maximum: -2 }), true)
  assert.equal(limitDisabled({ maximum: -1 }), false)
})

test('effective settings use the same labels', () => {
  assert.equal(limitLabel({ limit: -1 }), '∞ Unlimited')
  assert.equal(limitLabel({ limit: 0, forbidden: true }), 'Disabled')
  assert.equal(limitLabel({ limit: 12 }), 'Max: 12')
})

test('weights are multipliers clamped to 100%', () => {
  assert.equal(weightLabel(0.2), '×0.2')
  assert.equal(weightBarPercent(0.2), 20)
  assert.equal(weightBarPercent(4), 100)
  assert.equal(weightBarPercent(0), 0)
  assert.equal(weightBarPercent(-1), 0)
})

test('targets are labelled unit, category or all', () => {
  assert.equal(kindLabel('unit'), 'unit')
  assert.equal(kindLabel('category'), 'category')
  assert.equal(kindLabel('all'), 'all units')
  assert.equal(kindLabel('none'), 'no target')
  assert.equal(kindLabel(''), '')
})

test('values the game reads as a prefix are explained', () => {
  assert.equal(writtenNote('O', 0), 'written “O”')
  assert.equal(writtenNote('DECOM', 0), 'written “DECOM”')
  assert.equal(writtenNote('0.20', 0.2), '')
  assert.equal(writtenNote('4', 4), '')
  assert.equal(writtenNote('12abc', 12), 'written “12abc”')
  assert.equal(writtenNote('', 0), 'no value: reads as 0')
})
