// node --test coverage for reading a download's file name.

import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadName } from './download-name.js'

test('quoted Content-Disposition file names', () => {
  assert.equal(downloadName('attachment; filename="Metal Heck.ufo"', 'x.hpi'), 'Metal Heck.ufo')
  assert.equal(downloadName('attachment; filename="a \\"b\\".hpi"', 'x'), 'a "b".hpi')
})

test('bare file names and fallbacks', () => {
  assert.equal(downloadName('attachment; filename=map.ufo; size=3', 'x'), 'map.ufo')
  assert.equal(downloadName('', 'fallback.ufo'), 'fallback.ufo')
  assert.equal(downloadName(null, 'fallback.hpi'), 'fallback.hpi')
  assert.equal(downloadName('attachment', 'f.ufo'), 'f.ufo')
})
