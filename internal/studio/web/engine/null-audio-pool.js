// null-audio-pool.js
//
// No-op AudioPool stub used by CobBinding when no concrete pool is
// injected.  The engine package must compile + run without any
// renderer / browser presence — a headless server simulating a match
// has no <audio> elements to drive, and a future second renderer
// (camera-overhead minimap, replay scrubber) might want to share
// the same engine instance with a single pool living elsewhere.
//
// Surface mirrors the game3d/audio-pool.js implementation closely
// enough that defensive `typeof pool.x === 'function'` checks at
// call sites all pass.  Each method is a fast no-op + returns the
// shape callers expect (null for play(), 0 for count(), empty for
// entries()).  No allocations beyond the singleton object itself.
//
// Inject a concrete pool via the CobBinding constructor option
// `audio` and/or the GameEngine constructor option `audioFactory`
// (called once per addUnit).

export class NullAudioPool {
  play() { return null }
  stop() {}
  stopAll() {}
  setPlaybackRate() {}
  setPaused() {}
  setSilenced() {}
  tick() {}
  dispose() {}
  count() { return 0 }
  each() {}
  // Inspector / Audio panel hooks iterate via `entries` to render
  // the per-stem rows.  Returning an empty Map keeps `.size` reads
  // and `for…of` iteration valid without any allocation churn.
  get entries() { return _EMPTY_MAP }
}

const _EMPTY_MAP = new Map()

// nullAudioPool — shared singleton for binding callers that don't
// bring their own.  No state is ever stored, so reusing one instance
// across every binding is safe.
export const nullAudioPool = new NullAudioPool()
