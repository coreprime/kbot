// icons.js
//
// Brand marks for the workspace picker. The KBot Studio emblem is original
// artwork; the Cavedog mark loads the real logo from /cavedog.png (drop the
// file in internal/studio/web/public/cavedog.png) and falls back to an
// original dog-head silhouette until that asset is present.

import { useState } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'

// KBotLogo — emblem + wordmark lockup for the picker header.
export function KBotLogo({ size = 34 }) {
  return html`
    <span class="picker-brand">
      <svg width=${size} height=${size} viewBox="0 0 48 48" role="img" aria-label="KBot Studio">
        <defs>
          <linearGradient id="kb-emblem" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#4d8bff" />
            <stop offset="1" stop-color="#2b5bd6" />
          </linearGradient>
        </defs>
        <line x1="24" y1="3" x2="24" y2="9" stroke="#7aa2ff" stroke-width="2" />
        <circle cx="24" cy="3" r="2.4" fill="#9db8ff" />
        <rect x="8" y="9" width="32" height="28" rx="8" fill="url(#kb-emblem)" />
        <rect x="13" y="16" width="22" height="11" rx="4" fill="#0e1422" />
        <circle cx="19" cy="21.5" r="2.6" fill="#7fe7ff" />
        <circle cx="29" cy="21.5" r="2.6" fill="#7fe7ff" />
        <rect x="18" y="37" width="12" height="4" rx="2" fill="#2b5bd6" />
      </svg>
      <span class="picker-wordmark"><b>KBot</b> Studio</span>
    </span>
  `
}

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
