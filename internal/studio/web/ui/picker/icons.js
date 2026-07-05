// icons.js
//
// Brand marks for the workspace picker. The Cavedog mark loads the real logo
// from /cavedog.png (drop the file in internal/studio/web/public/cavedog.png)
// and falls back to an original dog-head silhouette until that asset is present.

import { useState } from 'preact/hooks'
import { htm as html } from '@coreprime/kbot-ui/htm-bind'

// CavedogIcon — the Cavedog Entertainment logo from /cavedog.png; falls back to
// an original dog-head silhouette if that file isn't present.
export function CavedogIcon({ size = 16 }) {
  const [failed, setFailed] = useState(false)
  if (!failed) {
    return html`<img class="kb-cavedog" height=${size}
                     src="/cavedog.png" alt="Cavedog Entertainment"
                     onError=${() => setFailed(true)} />`
  }
  return html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" role="img"
         aria-label="All games" fill="currentColor">
      <path d="M3 4.5 C5.5 5.5 7 7 8 8.7 C10 7.8 14 7.8 16 8.7 C17 7 18.5 5.5 21 4.5
               C21 4.5 20 9.5 20 12.5 C20 17 16.4 20.5 12 20.5 C7.6 20.5 4 17 4 12.5
               C4 9.5 3 4.5 3 4.5 Z" />
    </svg>
  `
}
