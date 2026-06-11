// contract.test.js
//
// The game-adapter contract: every surface the studio's shared UI reads off
// a game adapter, asserted for both shipped packages. This is the spec a
// custom game package must satisfy too — if a field or call shape changes
// here, every consumer in /ui/common and the sandbox changes with it.
//
// Runs under node's built-in runner: `node --test packages-js/`.

import test from 'node:test'
import assert from 'node:assert/strict'

import { game as totala } from '@kbot/game-totala'
import { game as takingdoms } from './index.js'

const GAMES = [totala, takingdoms]

test('identity and branding', () => {
  assert.equal(totala.id, 'totala')
  assert.equal(takingdoms.id, 'takingdoms')
  for (const g of GAMES) {
    assert.ok(g.label && typeof g.label === 'string', `${g.id}: label`)
    assert.ok(g.branding && typeof g.branding.headerLogo === 'string', `${g.id}: branding.headerLogo`)
    assert.match(g.branding.headerLogo, /^\/branding\//, `${g.id}: logo served from /branding/`)
    assert.ok(g.branding.chip && g.branding.chip.short && g.branding.chip.color, `${g.id}: chip metadata`)
    assert.match(g.branding.icon || '', /^data:image\/png;base64,/, `${g.id}: application icon data URI`)
  }
})

test('welcome fx theme shape', () => {
  assert.equal(totala.welcomeFx.style, 'beam')
  assert.equal(takingdoms.welcomeFx.style, 'smoke')
  // Each style's renderer reads specific colour callbacks.
  assert.equal(typeof totala.welcomeFx.hot, 'function')
  assert.equal(typeof totala.welcomeFx.spark, 'function')
  assert.equal(typeof takingdoms.welcomeFx.smoke, 'function')
})

test('weapon conventions', () => {
  for (const g of GAMES) {
    const w = g.weapons
    assert.ok(Array.isArray(w.slots) && w.slots.length === 3, `${g.id}: 3 weapon slots`)
    for (let i = 0; i < 3; i++) {
      const names = w.slotScripts(i)
      assert.ok(names.length >= 3, `${g.id}: slot ${i} probe names`)
      assert.ok(names.includes(w.slots[i].aim), `${g.id}: slot ${i} includes its aim script`)
    }
    assert.deepEqual(w.slotScripts(99), [], `${g.id}: out-of-range slot is empty`)
    assert.equal(typeof w.isAimScript, 'function')
    assert.equal(typeof w.entryArgs, 'function')
  }

  // TA: per-slot scripts, (heading, pitch) stacks, no shared set.
  assert.equal(totala.weapons.shared, null)
  assert.ok(totala.weapons.isAimScript('AimPrimary'))
  assert.ok(!totala.weapons.isAimScript('AimWeapon'))
  assert.deepEqual(totala.weapons.entryArgs('AimPrimary', { heading: 5, pitch: -3 }), [5, -3])
  assert.equal(totala.weapons.entryArgs('FirePrimary', {}), null)

  // TA:K: shared parameterized set; AimWeapon takes the weapon index and
  // FireWeapon dispatches on it.
  assert.deepEqual(takingdoms.weapons.shared, { aim: 'AimWeapon', fire: 'FireWeapon', query: 'QueryWeapon' })
  assert.ok(takingdoms.weapons.isAimScript('AimWeapon'))
  assert.ok(takingdoms.weapons.isAimScript('AimPrimary'), 'converted COBs keep TA names')
  assert.deepEqual(takingdoms.weapons.entryArgs('AimWeapon', { heading: 5, pitch: -3, weapon: 0 }), [5, -3, 0])
  assert.deepEqual(takingdoms.weapons.entryArgs('FireWeapon', { weapon: 0 }), [0])
  for (let i = 0; i < 3; i++) {
    assert.ok(takingdoms.weapons.slotScripts(i).includes('AimWeapon'), `TA:K slot ${i} probes the shared set`)
  }
})

test('cob quick-action catalogue', () => {
  for (const g of GAMES) {
    assert.ok(Array.isArray(g.cobEntries) && g.cobEntries.length >= 3, `${g.id}: sections`)
    for (const sec of g.cobEntries) {
      assert.ok(sec.section, `${g.id}: section label`)
      for (const row of sec.rows) {
        assert.ok(row.name && row.icon && row.title, `${g.id}/${sec.section}: row shape`)
      }
    }
  }
  const names = (g) => g.cobEntries.flatMap((s) => s.rows.map((r) => r.name))
  assert.ok(!names(totala).includes('Dying'), 'TA has no Dying row')
  assert.ok(names(takingdoms).includes('Dying'))
  assert.ok(names(takingdoms).includes('AimWeapon'))
})

test('scene environments', () => {
  for (const g of GAMES) {
    assert.ok(Array.isArray(g.environments) && g.environments.length >= 6, `${g.id}: catalogue size`)
    for (const e of g.environments) {
      assert.ok(e.env && e.icon && e.label && e.title, `${g.id}: env row shape`)
    }
  }
  // TA:K relabels the shared world manifests with kingdom names and must
  // not describe anything as the "TA default".
  const tak = takingdoms.environments
  assert.ok(tak.some((e) => e.label === 'Aramon'))
  assert.ok(tak.every((e) => !/TA default/i.test(e.title)))
  // Every env key must be a world manifest both catalogues can share.
  const known = new Set(totala.environments.map((e) => e.env))
  for (const e of tak) {
    assert.ok(known.has(e.env), `TA:K env ${e.env} reuses a shipped world manifest`)
  }
})

test('view3d config (game3d injection)', () => {
  for (const g of GAMES) {
    const v = g.view3d
    assert.ok(v, `${g.id}: view3d present`)
    assert.ok(Array.isArray(v.teamSides) && v.teamSides.length >= 8, `${g.id}: team sides`)
    assert.equal(v.teamSides[0].rgb, null, `${g.id}: side 0 is the no-recolour sentinel`)
    for (const s of v.teamSides) {
      assert.ok(s.key && s.label && s.swatchCss, `${g.id}: side ${s.side} shape`)
    }
    assert.ok(v.projectileFallbackColors && v.projectileFallbackColors.laser, `${g.id}: projectile hues`)
  }
  assert.equal(totala.view3d.teamSides[0].label, 'Blue (ARM)')
  assert.equal(takingdoms.view3d.teamSides[0].label, 'Blue', 'TA:K strips faction flavour')
  for (const g of GAMES) {
    const v = g.view3d
    assert.ok(Array.isArray(v.lodHidePatterns) && v.lodHidePatterns.every((re) => re instanceof RegExp),
      `${g.id}: LOD patterns are regexes`)
  }
})
