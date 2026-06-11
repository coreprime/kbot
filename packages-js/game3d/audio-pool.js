// audio-pool.js
//
// Central registry for every sound the studio plays.  All `new Audio()`
// calls go through `AudioPool.play()`; the pool stores metadata about
// each live entry (stem, source position, volume, scheduled duration)
// and exposes them via `entries()` for the Audio inspector panel.
//
// Two reasons it exists:
//
//   1.  **Sim-speed playback** — every frame the pool sets each live
//       audio element's `playbackRate` from the runtime's playbackRate
//       so slow-mo / fast-forward apply to sound playback the same
//       way they apply to particle motion and weapon firing.  Browser
//       clamps audio.playbackRate to ~[0.0625, 16]; below 0.5 / above
//       4 the pitch shift is severe — but that's the desired effect
//       for a true slow-mo bullet-time feel.
//
//   2.  **Pause/resume parity** — when the runtime pauses, every live
//       audio element is paused; on resume, they resume.  Without the
//       pool the unit sounds would keep going while the rest of the
//       simulation froze, which feels broken.
//
// One pool instance per ModelViewer.  Disposed (all audio stopped) on
// viewer teardown so the next unit-load starts silent.

import { AUDIO_DEDUP_WINDOW_MS } from './performance.js'

let _nextId = 1

export class AudioPool {
  constructor() {
    // entries is a Map keyed by a monotonic id.  Each value is an
    // AudioEntry: { id, stem, audio, kind, x, y, z, vol, startMs,
    // durationMs, source }.  Map preserves insertion order so the
    // inspector renders sounds chronologically.
    this.entries = new Map()
    this._paused = false
    this._playbackRate = 1
    // _onEntryCount: optional observer the inspector can subscribe to
    // for "count changed since last tick" — keeps the panel from
    // re-rendering when nothing's playing.
    this._onEntryCount = null
    // _lastPlayByStem: last wall-clock millisecond a given stem was
    // started.  When the same stem is requested again within
    // AUDIO_DEDUP_WINDOW_MS, play() short-circuits so a 40 Hz COB
    // tick that fires N identical sounds (multiple weapons / units
    // hitting the same shot frame) doesn't spawn N stacked <audio>
    // elements.  Entries don't get GC'd; the map size is bounded by
    // the number of distinct stems the unit ships with.
    this._lastPlayByStem = new Map()
  }

  // play registers a new sound.  Returns the entry id (or 0 if the
  // browser refused to construct the Audio element, e.g. autoplay
  // policy on the very first interaction).  Options:
  //
  //   stem    — file stem under /api/studio/sound/ (no extension)
  //   pos     — optional [x, y, z] world coords of the sound source
  //   vol     — 0.0–1.0 playback volume; defaults to 0.7
  //   kind    — one of 'unit', 'weapon-fire', 'weapon-hit', 'ui',
  //             'cob'; defaults to 'unit'.  Used by the panel to
  //             group rows by category.
  //   source  — short human label for the panel ("ARMCOM walk",
  //             "Primary fire", etc.)
  //
  // The pool reads <audio>.duration once metadata loads and stores it
  // so the inspector can render a progress bar.  Until then duration
  // is null and the bar shows indeterminate.
  play(stem, opts = {}) {
    if (!stem) return 0
    // Stem dedup — reject identical stems requested within the
    // AUDIO_DEDUP_WINDOW_MS wall-clock band.  A 40 Hz COB tick can
    // fire the same fire / impact / ack sound multiple times in one
    // frame (multi-weapon burst, multi-unit volley) and the browser
    // happily stacks the resulting <audio> elements into a phaser-y
    // mess.  Threshold lives in performance.js so the user can tune
    // it without touching pool internals.
    const now = performance.now()
    const last = this._lastPlayByStem.get(stem) || 0
    if (now - last < AUDIO_DEDUP_WINDOW_MS) return 0
    this._lastPlayByStem.set(stem, now)
    let audio
    try {
      // Assign src as a property (not via the Audio(url) constructor): the
      // workspace URL shim in index.html rewrites /api/... paths through the
      // patched HTMLMediaElement src setter, which the constructor bypasses —
      // constructor-set URLs 404 at the hub root and the sound never plays.
      audio = new Audio()
      audio.src = `/api/studio/sound/${encodeURIComponent(stem)}`
    } catch {
      return 0
    }
    const vol = opts.vol != null ? Math.max(0, Math.min(1, +opts.vol)) : 0.7
    audio.volume = vol
    // Apply current sim-speed immediately so the very first frame of
    // playback matches the rest of the simulation.  Browser clamps
    // to its own valid range — we don't need to.
    try { audio.playbackRate = this._playbackRate } catch { /* ignore */ }
    const id = _nextId++
    const pos = Array.isArray(opts.pos) ? opts.pos : null
    const entry = {
      id,
      stem,
      audio,
      kind: opts.kind || 'unit',
      source: opts.source || stem,
      x: pos ? pos[0] : null,
      y: pos ? pos[1] : null,
      z: pos ? pos[2] : null,
      vol,
      startMs: performance.now(),
      durationMs: null,  // filled in by loadedmetadata
    }
    this.entries.set(id, entry)
    // Remove the entry when the clip finishes (or errors out) so the
    // map doesn't grow forever.  ended fires once even if the user
    // pauses + resumes.
    const drop = () => {
      this.entries.delete(id)
      if (this._onEntryCount) this._onEntryCount(this.entries.size)
    }
    audio.addEventListener('ended', drop)
    audio.addEventListener('error', drop)
    audio.addEventListener('loadedmetadata', () => {
      // duration is in seconds; the pool exposes ms for parity with
      // the rest of the studio's time fields.  guard against NaN /
      // Infinity which some short SFX assets report.
      const d = audio.duration
      if (typeof d === 'number' && isFinite(d) && d > 0) {
        entry.durationMs = d * 1000
      }
    })
    // Fire-and-forget — autoplay policy occasionally rejects on the
    // very first user interaction.  We still keep the entry in the
    // map until error/ended cleans it up, so the panel briefly shows
    // the attempted sound (helps debug "did my click trigger the
    // expected sound?").
    const p = audio.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
    if (this._onEntryCount) this._onEntryCount(this.entries.size)
    return id
  }

  // setPlaybackRate updates the sim-speed.  Applied to every live
  // entry immediately so a slider drag mid-playback is responsive.
  // Browsers vary on the valid range; we don't clamp here — Chromium
  // accepts ~0.0625 to 16, others may silently snap to [0.5, 4].
  setPlaybackRate(rate) {
    this._playbackRate = rate > 0 ? rate : 1
    for (const e of this.entries.values()) {
      try { e.audio.playbackRate = this._playbackRate } catch { /* ignore */ }
    }
  }

  // setPaused mirrors the runtime's pause state onto the live audio
  // elements.  Idempotent — calling setPaused(true) twice does NOT
  // re-pause already-paused audio (avoids a click).
  setPaused(p) {
    p = !!p
    if (p === this._paused) return
    this._paused = p
    for (const e of this.entries.values()) {
      try {
        if (p) e.audio.pause()
        else { const pr = e.audio.play(); if (pr && pr.catch) pr.catch(() => {}) }
      } catch { /* ignore */ }
    }
  }

  // tick refreshes the playbackRate from the runtime each frame.
  // Called from the binding's per-frame tick so the slider can move
  // without an extra event subscription.
  tick(playbackRate, paused) {
    if (playbackRate !== this._playbackRate) this.setPlaybackRate(playbackRate)
    if (paused !== this._paused) this.setPaused(paused)
  }

  // dispose stops every entry and clears the map.  Called by the
  // viewer on unit-load / tab-close so a new unit doesn't inherit
  // the previous tab's sound state.
  dispose() {
    for (const e of this.entries.values()) {
      try { e.audio.pause(); e.audio.src = '' } catch { /* ignore */ }
    }
    this.entries.clear()
  }

  // ── Inspector helpers ──────────────────────────────────────────

  // count returns live entry count.  Cheap O(1) Map.size lookup.
  count() { return this.entries.size }

  // each iterates live entries in insertion order so the panel
  // renders chronologically.  Receives the entry object directly.
  each(fn) {
    for (const e of this.entries.values()) fn(e)
  }
}
