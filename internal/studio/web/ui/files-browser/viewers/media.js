// media.js
//
// Audio and video players.  Video (SMK/ZRB/BIK) is transcoded to MP4 on
// the server and scrubbed via Range requests; audio (WAV/MP3) is served
// raw and played by the native <audio> element.

import { htm as html } from '/ui/common/htm-bind.js'
import { videoURL, rawURL, extOf, baseName } from '../api.js'

// mp4Name swaps the source extension for .mp4 so the transcoded download
// lands with a sensible filename (e.g. logos.zrb → logos.mp4).
function mp4Name(path) {
  const b = baseName(path) || 'video'
  const i = b.lastIndexOf('.')
  return `${i > 0 ? b.slice(0, i) : b}.mp4`
}

export function VideoTab({ path, source, describe }) {
  const d = describe || {}
  return html`
    <div class="fx-viewer">
      <div class="fx-ctl-row">
        ${d.videoWidth ? html`<span class="fx-img-dims">${d.videoWidth}×${d.videoHeight}${d.videoFPS ? ` · ${d.videoFPS}fps` : ''}</span>` : null}
        <a class="fx-ctl-btn" download=${mp4Name(path)} href=${videoURL(path, source)}>⬇ Download MP4</a>
      </div>
      <div class="fx-media-stage">
        <video class="fx-video" src=${videoURL(path, source)} controls autoplay loop></video>
      </div>
    </div>
  `
}

export function AudioTab({ path, source }) {
  const ext = extOf(path)
  const type = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'
  return html`
    <div class="fx-viewer fx-audio">
      <div class="fx-audio-art">🔊</div>
      <audio class="fx-audio-el" controls src=${rawURL(path, source)} type=${type}></audio>
    </div>
  `
}
