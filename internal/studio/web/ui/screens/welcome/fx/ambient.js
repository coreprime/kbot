// ambient.js
//
// One-shot "construction" cue on the welcome screen.  Plays once
// when the user first interacts with the page (autoplay gate),
// then stays silent — the looping ambient was too persistent so we
// reduced it to a single bookend that lines up with the dialog's
// "particles constructing the display" theme.
//
// Implementation goes through Web Audio (not HTMLAudioElement) for
// two reasons: TA's WAVs are 8-bit PCM at 11025 Hz and Chrome's
// <audio> element handles those unreliably (silent-decode bugs
// that vary by version); and AudioContext.resume() is the
// canonical way to satisfy the autoplay gate via a user gesture.
//
// No state, no host-context — only the DOM `$('#welcome-dialog')`
// query and standard Web Audio APIs.

import { $ } from '../../../host-context.js'

const WELCOME_AMBIENT_VOLUME = 0.18

export function wireWelcomeAmbient() {
  const wel = $('#welcome-dialog')
  if (!wel) return
  const AudioCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioCtor) return // older browsers — silently skip
  let ctx = null
  let buffer = null
  let activeSrc = null
  let kicked = false
  let visible = !wel.classList.contains('hidden')

  // Fetch + decode at boot so playback on first gesture is
  // instant.
  async function loadBuffer() {
    try {
      const resp = await fetch('/api/studio/sound/build1')
      if (!resp.ok) return
      const data = await resp.arrayBuffer()
      ctx = ctx || new AudioCtor()
      buffer = await new Promise((resolve, reject) => {
        // Use the callback form — Safari historically didn't
        // return a Promise from decodeAudioData even though the
        // modern signature does.  Either form works in Chrome /
        // Firefox.
        ctx.decodeAudioData(data, resolve, reject)
      })
    } catch { /* decode failed — silently no-op */ }
  }
  loadBuffer()

  function tryPlay() {
    if (!buffer || !ctx) return
    if (ctx.state === 'suspended') ctx.resume()
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    src.buffer = buffer
    gain.gain.value = WELCOME_AMBIENT_VOLUME
    src.connect(gain).connect(ctx.destination)
    src.start()
    activeSrc = src
    src.addEventListener('ended', () => { if (activeSrc === src) activeSrc = null })
  }
  function stop() {
    if (!activeSrc) return
    try { activeSrc.stop() } catch { /* already stopped */ }
    activeSrc = null
  }

  const onGesture = () => {
    if (kicked) return
    kicked = true
    if (visible) tryPlay()
  }
  // First user input anywhere in the page satisfies the autoplay
  // gate.
  for (const ev of ['pointerdown', 'pointermove', 'keydown']) {
    document.addEventListener(ev, onGesture, { once: true, passive: true })
  }

  // Stop on dialog hide so closing the welcome screen mid-play
  // cuts the sound cleanly.  No restart on re-show — it's a
  // one-shot bookend, not an ambient loop.
  const obs = new MutationObserver(() => {
    visible = !wel.classList.contains('hidden')
    if (!visible) stop()
  })
  obs.observe(wel, { attributes: true, attributeFilter: ['class'] })
}
