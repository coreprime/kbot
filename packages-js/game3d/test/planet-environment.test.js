// planet-environment.test.js — headless proof that a map's OTA planet
// keyword maps to a renderer environment preset, so an installed battlefield
// auto-selects a map-appropriate sky/cloud layer (fix #2: beyond-map
// background was reading blank instead of a sky). Pure function — runs under
// `node --test` with no DOM.
import test from 'node:test'
import assert from 'node:assert/strict'

import { planetEnvironment } from '../map-terrain.js'

test('planetEnvironment maps TA planet keywords to environment presets', () => {
  // The renderer's ENVIRONMENT_PRESETS keys these must land on.
  assert.equal(planetEnvironment('Acid'), 'marsh')
  assert.equal(planetEnvironment('Lava'), 'lava')
  assert.equal(planetEnvironment('Metal'), 'metal')
  assert.equal(planetEnvironment('Moon'), 'moon')
  assert.equal(planetEnvironment('Mars'), 'mars')
  assert.equal(planetEnvironment('Desert'), 'desert')
  assert.equal(planetEnvironment('Slate'), 'slate')
  assert.equal(planetEnvironment('Green'), 'greenworld')
  assert.equal(planetEnvironment('Water'), 'archipelago')
})

test('planetEnvironment is case-insensitive and substring-tolerant', () => {
  assert.equal(planetEnvironment('LAVA WORLD'), 'lava')
  assert.equal(planetEnvironment('temperate forest'), 'greenworld')
  assert.equal(planetEnvironment('red rock'), 'mars')
})

test('planetEnvironment returns null for unknown/empty so callers keep their default', () => {
  assert.equal(planetEnvironment(''), null)
  assert.equal(planetEnvironment(null), null)
  assert.equal(planetEnvironment(undefined), null)
  assert.equal(planetEnvironment('quxyzzy'), null)
})
