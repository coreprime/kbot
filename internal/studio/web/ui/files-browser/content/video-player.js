// video-player.js
//
// Plays a TA video (Smacker / ZRB / Bink) via the MP4 transcode the
// render endpoint produces on demand.  The animated APNG thumbnail
// doubles as the poster frame so the pane shows motion before the user
// hits play and while the MP4 is still transcoding.

import { htm as html } from '/ui/common/htm-bind.js'

export function VideoPlayer({ path }) {
  const mp4 = `/api/vfs/${path}?format=mp4`
  const poster = `/api/vfs/${path}?format=apng`
  return html`
    <div class="files-viewer">
      <video class="files-video" controls preload="metadata" poster=${poster}>
        <source src=${mp4} type="video/mp4" />
      </video>
    </div>
  `
}
