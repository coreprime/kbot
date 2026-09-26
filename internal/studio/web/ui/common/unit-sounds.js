// unit-sounds.js
//
// Which of a unit's sounds the game plays for an event. The unit meta's
// `sounds` map (/api/studio/unit/{name}) holds exactly the keys the game reads
// from the unit's sound class: for each of its 23 events the plain key (ok)
// when present, then the numbered keys ok1, ok2, ... up to the first missing
// number. An empty value is a silent choice. The game picks one of an event's
// keys each time it plays the event.

// SOUND_EVENTS lists the events the game reads from a sound class, in its
// order.
export const SOUND_EVENTS = [
  'select', 'underattack', 'activate', 'deactivate', 'ok', 'arrived', 'cant',
  'unitcomplete', 'build', 'repair', 'working', 'load', 'unload', 'cloak',
  'uncloak', 'capture', 'count5', 'count4', 'count3', 'count2', 'count1',
  'count0', 'canceldestruct',
]

const EVENT_SET = new Set(SOUND_EVENTS)

// eventSoundKeys returns the keys of `sounds` the game plays for one event:
// the plain key when present, then event1, event2, ... up to the first
// missing number (a missing plain key does not stop the numbered ones).
export function eventSoundKeys(sounds, event) {
  const out = []
  if (!sounds || typeof sounds !== 'object') return out
  const has = (k) => Object.prototype.hasOwnProperty.call(sounds, k)
  if (has(event)) out.push(event)
  for (let n = 1; has(event + n); n++) out.push(event + n)
  return out
}

// soundKeysFor expands a list of event names — or explicit keys such as
// 'select2' — into the keys of `sounds` they stand for, in order and without
// duplicates: an event name gives all its keys (see eventSoundKeys), an
// explicit key itself when the map has it.
export function soundKeysFor(sounds, names) {
  const out = []
  const seen = new Set()
  const add = (k) => { if (!seen.has(k)) { seen.add(k); out.push(k) } }
  if (!sounds || typeof sounds !== 'object') return out
  for (const name of Array.isArray(names) ? names : [names]) {
    if (typeof name !== 'string' || !name) continue
    if (EVENT_SET.has(name)) {
      for (const k of eventSoundKeys(sounds, name)) add(k)
    } else if (Object.prototype.hasOwnProperty.call(sounds, name)) {
      add(name)
    }
  }
  return out
}

// pickSoundKey picks one of the keys soundKeysFor gives, uniformly (rng
// returns [0, 1)), or null when there are none. The picked key's value may be
// empty: a silent choice, which plays nothing.
export function pickSoundKey(sounds, names, rng = Math.random) {
  const keys = soundKeysFor(sounds, names)
  if (keys.length === 0) return null
  return keys[Math.min(keys.length - 1, Math.floor(rng() * keys.length))]
}
