// music-panel.js
//
// Retro mini-jukebox.  Streams TA's music/ folder out of the VFS via
// /api/studio/music (list) + /api/studio/music/<filename> (stream).  Six
// controls:
//
//   ◀◀  Skip back     — wraps to the last track from track 1.
//    ▶   Play / Pause  — toggles between the two glyphs depending on
//                       the <audio> element's paused state.
//   ⏹  Stop           — pauses + rewinds the current track and snaps
//                       the play button back to ▶.
//    ▶▶  Skip forward  — wraps to track 1 from the last track.
//
// Under that, a marquee "Track X of N" label scrolls right-to-left so the
// panel keeps a bit of LED-readout charm even when the user hasn't picked
// a track yet.
//
// Visibility lifecycle:
//   * The panel defaults to CLOSED (panel-store loadVisible(...) returns
//     false the first time).  Opening it loads the track list lazily.
//   * Closing the panel pauses + rewinds the current track and the audio
//     element is left in its paused state — no leftover playback when
//     the user hides the overlay.
//   * Auto-advance: when the current track finishes the panel loads the
//     next index automatically so the jukebox plays through.
//
// Single global <audio> element is owned by this module so opening +
// closing the panel doesn't restart playback during the lifetime of the
// page — only an explicit Close (or Stop, or skipping past the end of
// the list) interrupts.

import { signal, effect } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel } from '@kbot/ui/floating-panel'
import { panelSignals, registerPanel } from '@kbot/ui/panel-store'

const PANEL_ID = 'mv-inspector-music'

// Pre-register the panel with defaultVisible=false so the FIRST touch of
// its visibility signal (whether from the FloatingPanel mount or from a
// menu's _PanelToggle) sees the closed state.  Persistence still wins on
// subsequent loads — if the user opens the panel and reloads, it comes
// back open.  Module-load side effect; the panel-store's _ensure short-
// circuits subsequent registers, so duplicate imports are safe.
registerPanel(PANEL_ID, { defaultVisible: false })

// Module-scoped player state — survives re-mounts so toggling the panel
// open / closed multiple times in a session doesn't snap the cursor back
// to track 0 on every open.
const _tracks       = signal([])     // string[] — basenames from the VFS
const _loadedOnce   = signal(false)  // become true after the first /list fetch
const _trackIndex   = signal(0)
const _isPlaying    = signal(false)  // mirrors <audio>.paused for the toggle

// The <audio> element.  Created on demand the first time something needs
// to drive it so a closed panel doesn't pay any DOM cost at all.  Module-
// scoped so cross-mounts (sandbox + unit editor) share the same player —
// switching tabs doesn't double up the audio.
let _audio = null
function _ensureAudio() {
  if (_audio) return _audio
  if (typeof Audio === 'undefined') return null
  _audio = new Audio()
  _audio.preload = 'none'
  _audio.addEventListener('play',  () => { _isPlaying.value = true })
  _audio.addEventListener('pause', () => { _isPlaying.value = false })
  // Auto-advance — the panel plays through the album rather than stopping
  // dead at the end of a track.  Wraps around so the jukebox cycles
  // forever until the user hits Stop or closes the panel.
  _audio.addEventListener('ended', () => {
    const n = _tracks.value.length
    if (n === 0) return
    _trackIndex.value = (_trackIndex.value + 1) % n
    _loadCurrent({ autoplay: true })
  })
  return _audio
}

async function _loadTrackList() {
  if (_loadedOnce.value) return
  try {
    const r = await fetch('/api/studio/music')
    if (!r.ok) { _loadedOnce.value = true; return }
    const j = await r.json()
    const list = Array.isArray(j && j.tracks) ? j.tracks : []
    _tracks.value = list
    _loadedOnce.value = true
  } catch {
    _loadedOnce.value = true
  }
}

function _loadCurrent({ autoplay } = {}) {
  const list = _tracks.value
  const a = _ensureAudio()
  if (!a || list.length === 0) return
  const idx = ((_trackIndex.value % list.length) + list.length) % list.length
  _trackIndex.value = idx
  const want = `/api/studio/music/${encodeURIComponent(list[idx])}`
  // Only re-assign src when it actually changes — assigning the same URL
  // resets currentTime to 0, which is the wrong thing during Play/Pause.
  if (a.src !== new URL(want, location.origin).href) {
    a.src = want
  }
  if (autoplay) {
    try { a.play().catch(() => {}) } catch { /* ignore */ }
  }
}

async function _togglePlay() {
  const a = _ensureAudio()
  if (!a) return
  // Lazy first-load — if the user hits Play before the track list has
  // resolved (the panel was just opened and the fetch is still in
  // flight), kick the fetch off ourselves and wait for it so the first
  // click actually plays something instead of silently no-op'ing.
  if (_tracks.value.length === 0) {
    await _loadTrackList()
  }
  if (!a.src && _tracks.value.length > 0) _loadCurrent({ autoplay: false })
  if (a.paused) {
    try { a.play().catch(() => {}) } catch { /* ignore */ }
  } else {
    a.pause()
  }
}

function _stop() {
  const a = _ensureAudio()
  if (!a) return
  try { a.pause() } catch { /* ignore */ }
  try { a.currentTime = 0 } catch { /* ignore */ }
}

function _skip(delta) {
  const n = _tracks.value.length
  if (n === 0) return
  _trackIndex.value = ((_trackIndex.value + delta) % n + n) % n
  // Preserve whether we were playing — skipping during playback should
  // start the new track playing; skipping while paused should leave the
  // new track loaded but paused.
  const wasPlaying = !!(_audio && !_audio.paused)
  _loadCurrent({ autoplay: wasPlaying })
}

// Subscribe to the panel-store visibility signal up here in module scope
// so the Stop-on-close behaviour fires regardless of whether the panel
// body is mounted (FloatingPanel collapses the body when hidden).  When
// visible.value flips to false, kill playback so closing the overlay
// silences the jukebox.
let _visibilityWired = false
function _wireVisibility() {
  if (_visibilityWired) return
  _visibilityWired = true
  const { visible } = panelSignals(PANEL_ID)
  effect(() => {
    if (!visible.value && _audio && !_audio.paused) {
      try { _audio.pause() } catch { /* ignore */ }
    }
  })
}

// ── Marquee — CSS-driven retro scrolling label ─────────────────────────

function Marquee({ text }) {
  // Re-key on text so the animation restarts when the track index changes,
  // which gives the satisfying LED feel of "wipe and re-display".  Two
  // copies of the text inside the inner scroller create the seamless
  // wrap.
  return html`
    <div class="mv-music-marquee">
      <div class="mv-music-marquee-track" key=${text}>
        <span>${text}</span>
        <span>${text}</span>
      </div>
    </div>
  `
}

// ── Body ───────────────────────────────────────────────────────────────

function MusicBody() {
  const { visible } = panelSignals(PANEL_ID)
  const v = visible.value
  // Trigger a one-time fetch the first time the panel becomes visible.
  // Using useEffect rather than firing during render so the network call
  // is deferred to commit, and re-running it would be a no-op anyway
  // (the _loadedOnce guard short-circuits the second hit).
  useEffect(() => {
    if (v) {
      _wireVisibility()
      _loadTrackList()
    }
  }, [v])
  // Even when hidden, mount nothing — FloatingPanel handles the chrome.
  if (!v) return null
  const tracks = _tracks.value
  const idx    = _trackIndex.value
  const playing = _isPlaying.value
  const label = tracks.length === 0
    ? (_loadedOnce.value ? 'No tracks in /music' : 'Loading…')
    : `♫  Track ${idx + 1} of ${tracks.length}  ·  ${tracks[idx] || ''}  `
  const playGlyph = playing ? '⏸' : '▶'
  const playTitle = playing ? 'Pause' : 'Play'
  return html`
    <${Marquee} text=${label} />
    <div class="mv-music-controls">
      <button class="mv-music-btn" title="Skip back" onClick=${() => _skip(-1)}>⏮</button>
      <button class="mv-music-btn mv-music-btn-play" title=${playTitle}
              onClick=${_togglePlay}>${playGlyph}</button>
      <button class="mv-music-btn" title="Stop" onClick=${_stop}>⏹</button>
      <button class="mv-music-btn" title="Skip forward" onClick=${() => _skip(1)}>⏭</button>
    </div>
  `
}

// ── Panel root ─────────────────────────────────────────────────────────

export function MusicPanel() {
  // Pin a ref to the panel body so we can include the hidden <audio> as a
  // direct child — keeps the element alive across Preact re-renders so
  // playback survives signal updates that re-render the controls.
  const _audioHostRef = useRef(null)
  useEffect(() => {
    const a = _ensureAudio()
    if (a && _audioHostRef.current && !_audioHostRef.current.contains(a)) {
      _audioHostRef.current.appendChild(a)
    }
  }, [])
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Music">
      <div ref=${_audioHostRef} class="mv-music-audio-host"></div>
      <${MusicBody} />
    <//>
  `
}
