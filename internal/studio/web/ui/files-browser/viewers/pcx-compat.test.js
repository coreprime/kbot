// node --test unit coverage for the PCX game-compatibility badge.

import test from 'node:test'
import assert from 'node:assert/strict'
import { pcxCompatBadge } from './pcx-compat.js'

test('no report, no badge', () => {
  assert.equal(pcxCompatBadge(null), null)
  assert.equal(pcxCompatBadge({ format: 'PCX' }), null)
})

test('a clean file gets an ok badge', () => {
  const b = pcxCompatBadge({ gameCompat: { loads: true, ok: true, issues: [] } })
  assert.equal(b.level, 'ok')
})

test('warnings: the game loads the file but draws it differently', () => {
  const b = pcxCompatBadge({
    gameCompat: {
      loads: true,
      ok: false,
      issues: [{ code: 'bytes-per-line', severity: 'warning', message: 'BytesPerLine is 4 but the width is 3' }],
    },
  })
  assert.equal(b.level, 'warn')
  assert.match(b.label, /1 issue\)/)
  assert.match(b.title, /^warning: BytesPerLine/)
})

test('errors: the game refuses the file', () => {
  const b = pcxCompatBadge({
    gameCompat: {
      loads: false,
      ok: false,
      issues: [
        { code: 'version', severity: 'error', message: 'version 3' },
        { code: 'palette-marker', severity: 'warning', message: 'no marker' },
      ],
    },
  })
  assert.equal(b.level, 'error')
  assert.equal(b.title.split('\n').length, 2)
})
