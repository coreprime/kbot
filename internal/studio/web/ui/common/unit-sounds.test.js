// node --test coverage for the unit sound-event key rules.

import test from 'node:test'
import assert from 'node:assert/strict'
import { SOUND_EVENTS, eventSoundKeys, soundKeysFor, pickSoundKey } from './unit-sounds.js'

test('the game reads 23 events, including load, unload, cloak, uncloak and capture', () => {
  assert.equal(SOUND_EVENTS.length, 23)
  for (const e of ['load', 'unload', 'cloak', 'uncloak', 'capture', 'select', 'ok']) {
    assert.ok(SOUND_EVENTS.includes(e), e)
  }
})

test('an event gives its plain key, then KEY1, KEY2, ... to the first gap', () => {
  const sounds = { ok: 'a', ok1: 'b', ok2: 'c', ok4: 'd', select1: 'e' }
  assert.deepEqual(eventSoundKeys(sounds, 'ok'), ['ok', 'ok1', 'ok2'])
  assert.deepEqual(eventSoundKeys(sounds, 'select'), ['select1'], 'a missing plain key does not stop the numbers')
  assert.deepEqual(eventSoundKeys(sounds, 'cloak'), [])
  assert.deepEqual(eventSoundKeys(null, 'ok'), [])
})

test('event names and explicit keys expand in order without duplicates', () => {
  const sounds = { ok1: 'a', ok2: 'b', build: 'c', select: 'd', select1: 'e' }
  assert.deepEqual(soundKeysFor(sounds, ['ok', 'build']), ['ok1', 'ok2', 'build'])
  assert.deepEqual(soundKeysFor(sounds, ['select1', 'select']), ['select1', 'select'])
  assert.deepEqual(soundKeysFor(sounds, 'select'), ['select', 'select1'])
  assert.deepEqual(soundKeysFor(sounds, ['arrived', 'nope']), [])
})

test('a silent choice is a key like any other', () => {
  const sounds = { ok1: 'a', ok2: '' }
  assert.deepEqual(soundKeysFor(sounds, ['ok']), ['ok1', 'ok2'])
  assert.equal(pickSoundKey(sounds, ['ok'], () => 0.99), 'ok2')
  assert.equal(pickSoundKey(sounds, ['ok'], () => 0), 'ok1')
  assert.equal(pickSoundKey(sounds, ['cant'], () => 0), null)
})
