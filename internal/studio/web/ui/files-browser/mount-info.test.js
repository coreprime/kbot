// node --test coverage for the mount-order wording shown on the Files tab.

import test from 'node:test'
import assert from 'node:assert/strict'
import { discoveryText, layerPlacement, mountRows, skippedRows } from './mount-info.js'

test('discovery modes are explained', () => {
  assert.match(discoveryText('game-order'), /rev31\.gp3.*\*\.ccx.*\*\.ufo.*first ten \*\.hpi/)
  assert.match(discoveryText('all-archives'), /later archive overrides/)
  assert.match(discoveryText('game-order,all-archives'), /Mixed discovery/)
  assert.equal(discoveryText(''), '')
})

test('layer placement names the mount position', () => {
  assert.equal(layerPlacement({ Source: 'btdata.ccx', Kind: 'archive', Mount: 2 }), 'mount #2')
  assert.equal(
    layerPlacement({ Source: 'totala4.hpi', Kind: 'archive', Mount: 27, Note: 'past the ten-*.hpi limit' }),
    'mount #27 · past the ten-*.hpi limit')
  assert.match(layerPlacement({ Source: 'Physical Filesystem', Kind: 'loose' }), /loose file/)
  assert.match(layerPlacement({ Source: 'Workspace', Kind: 'workspace' }), /workspace edit/)
  assert.equal(layerPlacement({ Source: 'x' }), '')
})

test('mount and skipped rows come from the stats document', () => {
  const stats = {
    mountOrder: [
      { position: 1, name: 'rev31.gp3', version: 'v1' },
      { position: 2, name: 'data.hpi', version: 'v2', note: '' },
      { position: 3, name: 'totala4.hpi', version: 'v1', note: 'past the ten-*.hpi limit' },
    ],
    skippedArchives: [{ name: 'old.hpi', reason: 'no-trailer', detail: 'missing the Cavedog copyright trailer' }],
  }
  assert.deepEqual(mountRows(stats), [
    { position: 1, name: 'rev31.gp3', tag: '', note: '' },
    { position: 2, name: 'data.hpi', tag: 'v2', note: '' },
    { position: 3, name: 'totala4.hpi', tag: '', note: 'past the ten-*.hpi limit' },
  ])
  assert.deepEqual(skippedRows(stats), [{ name: 'old.hpi', reason: 'missing the Cavedog copyright trailer' }])
  assert.deepEqual(mountRows({}), [])
  assert.deepEqual(skippedRows(null), [])
})
