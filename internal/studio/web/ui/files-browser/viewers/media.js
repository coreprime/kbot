// media.js
//
// Audio and video players.  Video (SMK/ZRB/BIK) is transcoded to MP4 on
// the server and scrubbed via Range requests; audio (WAV/MP3) is served
// raw and played by the native <audio> element.

import { htm as html } from '@kbot/ui/htm-bind'
import { videoURL, rawURL, extOf } from '../api.js'

// The MP4 download lives in the view bar's download menu (alongside the
// original bytes); this tab is purely the player.
export function VideoTab({ path, source, describe }) {
  const d = describe || {}
  return html`
    <div class="fx-viewer">
      ${d.videoWidth ? html`
        <div class="fx-ctl-row">
          <span class="fx-img-dims">${d.videoWidth}×${d.videoHeight}${d.videoFPS ? ` · ${d.videoFPS}fps` : ''}</span>
        </div>` : null}
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
