// interface-status-bar.js
//
// The application footer status strip: a left-aligned status message,
// optional right-aligned hints, and an optional trailing copyright note.
// Uses the same `.statusbar` / `.hints` / `.copyright` classes as the
// studio shell so the look-and-feel is shared.
//
// Presentational only — the caller owns the message text.  `statusId`
// and `hintsId` let a host keep stable element ids on the status / hints
// spans when it updates them imperatively from outside the component
// tree (the studio mutates `#status` and `#app-hints` directly as the
// active tab or live cursor read-out changes).

import { htm as html } from './htm-bind.js'

export function InterfaceStatusBar({ status = '', hints, copyright, statusId, hintsId, children }) {
  return html`
    <footer class="statusbar">
      <span id=${statusId || undefined}>${status}</span>
      ${hints != null ? html`<span class="muted hints" id=${hintsId || undefined}>${hints}</span>` : null}
      ${children}
      ${copyright ? html`<span class="copyright">${copyright}</span>` : null}
    </footer>
  `
}
