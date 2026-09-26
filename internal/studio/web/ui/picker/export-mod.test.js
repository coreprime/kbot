// node --test coverage for the Export mod dialog's helpers.

import test from 'node:test'
import assert from 'node:assert/strict'
import { exportFormats, exportURL, preflightLines, shadowedRows, slugify } from './export-mod.js'

test('Total Annihilation offers .ufo first, TA: Kingdoms only .hpi', () => {
  assert.deepEqual(exportFormats('totala').map((f) => f.value), ['ufo', 'ccx', 'hpi'])
  assert.deepEqual(exportFormats('custom').map((f) => f.value), ['ufo', 'ccx', 'hpi'])
  assert.deepEqual(exportFormats('takingdoms').map((f) => f.value), ['hpi'])
})

test('export URLs carry the folder, extension, name and preflight flag', () => {
  assert.equal(exportURL('/w/my mod', { ext: 'ufo', name: 'my-mod', preflight: true }),
    '/api/hub/export?dir=%2Fw%2Fmy%20mod&ext=ufo&name=my-mod&preflight=1')
  assert.equal(exportURL('/w'), '/api/hub/export?dir=%2Fw')
  assert.equal(slugify('My Arm Overhaul!'), 'my-arm-overhaul')
  assert.equal(slugify('***'), 'ws')
})

test('preflight wording', () => {
  const ok = preflightLines({
    archive: 'mymod.ufo', checked: true, mounted: true, position: 4, of: 30,
    outrankedBy: ['rev31.gp3', 'btdata.ccx', 'AFark.ufo'],
    notes: ['2 of the 5 exported files are also provided by sources the game reads first'],
  })
  assert.equal(ok[0].tone, 'ok')
  assert.match(ok[0].text, /position 4 of 30\. 3 archives rank above it: rev31\.gp3, btdata\.ccx, AFark\.ufo\./)
  assert.equal(ok[1].tone, 'warn')

  const top = preflightLines({ archive: 'a.ccx', checked: true, mounted: true, position: 1, of: 2, outrankedBy: [], notes: [] })
  assert.match(top[0].text, /outranks every other archive/)

  const lost = preflightLines({ archive: 'zz.hpi', checked: true, mounted: false, notes: ['never mount it'] })
  assert.deepEqual(lost.map((l) => l.tone), ['error', 'warn'])

  const tak = preflightLines({ archive: 'x.hpi', checked: false, notes: ['not checked'] })
  assert.deepEqual(tak, [{ tone: 'info', text: 'not checked' }])
  assert.deepEqual(preflightLines(null), [])
})

test('shadowed rows are capped', () => {
  const check = { shadowed: [1, 2, 3].map((i) => ({ path: `units/u${i}.fbi`, by: ['rev31.gp3', 'loose file'] })) }
  assert.deepEqual(shadowedRows(check, 2), {
    rows: [{ path: 'units/u1.fbi', by: 'rev31.gp3, loose file' }, { path: 'units/u2.fbi', by: 'rev31.gp3, loose file' }],
    more: 1,
  })
  assert.deepEqual(shadowedRows({}), { rows: [], more: 0 })
})
