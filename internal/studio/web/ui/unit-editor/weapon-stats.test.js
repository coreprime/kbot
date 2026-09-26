// node --test coverage for the whole-tick weapon reload figures.

import test from 'node:test'
import assert from 'node:assert/strict'
import { reloadTicks, reloadSeconds, reloadMs, formatReload } from './weapon-stats.js'

test('reload is counted in whole ticks, reloadtime*30 truncated', () => {
  assert.equal(reloadTicks({ reloadSec: 0.35 }), 10)
  assert.equal(reloadTicks({ reloadSec: 3.6 }), 108)
  assert.equal(reloadTicks({ reloadSec: 0.39 }), 11, '11.7 ticks truncate to 11')
  assert.equal(reloadTicks({ reloadSec: 0.01 }), 0)
  assert.equal(reloadTicks({}), 0)
  assert.equal(reloadTicks(null), 0)
})

test('the server reloadTicks wins over reloadSec', () => {
  assert.equal(reloadTicks({ reloadSec: 0.35, reloadTicks: 10 }), 10)
  assert.equal(reloadTicks({ reloadSec: 1, reloadTicks: 29 }), 29)
})

test('seconds and milliseconds follow the whole ticks', () => {
  const w = { reloadSec: 0.35, reloadTicks: 10 }
  assert.ok(Math.abs(reloadSeconds(w) - 1 / 3) < 1e-12, '0.35 s reloads after 0.333 s')
  assert.ok(Math.abs(reloadMs(w) - 1000 / 3) < 1e-9)
})

test('formatReload shows the applied seconds and the tick count', () => {
  assert.equal(formatReload({ reloadSec: 0.35, reloadTicks: 10 }), '0.33 s (10 ticks)')
  assert.equal(formatReload({ reloadTicks: 1 }), '0.03 s (1 tick)')
  assert.equal(formatReload({ reloadTicks: 30 }), '1 s (30 ticks)')
  assert.equal(formatReload({}), '—')
})
