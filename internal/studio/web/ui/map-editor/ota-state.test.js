// node --test coverage for the map editor's .ota state helpers.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  otaValueError, cleanOTAText, firstOTAValueError, parseOTANumber,
  editorOTAState, newSchemaFrom,
} from './ota-state.js'

test('otaValueError applies the game\'s value rules', () => {
  assert.equal(otaValueError('Two ridges, one river.'), '')
  assert.equal(otaValueError('2-8'), '')
  assert.equal(otaValueError('[Schema {0}]'), '') // braces and brackets are plain text in a value
  assert.equal(otaValueError(''), '')
  assert.match(otaValueError('See http://tauniverse.com'), /comment/)
  assert.match(otaValueError('a /* b'), /comment/)
  assert.match(otaValueError('Two; three'), /';'/)
  assert.match(otaValueError('a\u0000b'), /NUL/)
  assert.match(otaValueError(' padded'), /space/)
})

test('cleanOTAText trims what the game trims', () => {
  assert.equal(cleanOTAText('  Rocky Road \t\r\n'), 'Rocky Road')
  assert.equal(cleanOTAText(undefined), '')
})

test('firstOTAValueError names the field', () => {
  assert.equal(firstOTAValueError({ 'Mission name': 'ok', Description: 'fine' }), '')
  assert.equal(firstOTAValueError({ 'Mission name': 'ok', Description: 'a;b' }), "Description: contains ';', which ends the value")
})

test('parseOTANumber keeps fractions only where the game reads them', () => {
  assert.equal(parseOTANumber('12.5', true), 12.5)
  assert.equal(parseOTANumber('12.5'), 12)
  assert.equal(parseOTANumber(''), 0)
  assert.equal(parseOTANumber('x', true), 0)
})

test('editorOTAState keeps a readable .ota and flags an unreadable one', () => {
  const fallback = {
    missionName: 'newmap', seaLevel: 63,
    schemas: [{ name: 'Default', startPositions: [{ number: 1, x: 1, z: 1 }] }],
  }
  assert.equal(editorOTAState(null, fallback), fallback)
  const ota = { missionName: 'Rocky', schemas: [], source: 'AAA=' }
  assert.equal(editorOTAState(ota, fallback), ota)
  const broken = editorOTAState({ error: 'no ]', source: 'QkFE', seaLevel: 25 }, fallback)
  assert.equal(broken.error, 'no ]')
  assert.equal(broken.source, 'QkFE')
  assert.equal(broken.seaLevel, 25)
  assert.deepEqual(broken.schemas[0].startPositions, [])
  assert.equal(fallback.schemas[0].startPositions.length, 1) // fallback untouched
})

test('newSchemaFrom drops the copied schema\'s file identity', () => {
  const proto = { name: '0', type: 'Network 1', surfaceMetal: 3, source: 0, startPositions: [{ number: 1, special: 0 }] }
  const s = newSchemaFrom(proto, { name: 'Network 1', type: 'Network 4', startPositions: [] })
  assert.equal(s.source, undefined)
  assert.equal(s.surfaceMetal, 3)
  assert.equal(s.type, 'Network 4')
  assert.deepEqual(s.startPositions, [])
  assert.equal(proto.source, 0)
  assert.equal(newSchemaFrom(undefined, { name: 'x' }).name, 'x')
})
